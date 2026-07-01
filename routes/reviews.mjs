// Extracted verbatim from server.mjs (R1 route-module split, July 1 2026).
import { pool } from '../db.mjs';
import { pushToWalrus } from '../walrus.mjs';
import { validateBody, reviewSubmitSchema } from '../validation.mjs';
import { isHost, getOwnedPropertyIds, getAuthedSession } from '../authz.mjs';

export default async function reviewsRoutes(fastify) {
// Reviews
fastify.post('/reviews/submit', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (validateBody(reviewSubmitSchema, request, reply)) return;
  const { bookingRef, rating, review } = request.body;
  if (rating < 1 || rating > 5) return reply.code(400).send({ error: 'Rating must be 1-5' });
  try {
    // Verifiable reviews: the review must be for the CALLER'S OWN booking (property
    // derived from the booking row, never client-supplied), and that booking must
    // be a real, on-chain-escrow-backed, non-cancelled stay — so a review is
    // provably from someone who actually committed funds for that reservation, not
    // a drive-by. (REQUIRE_STAY_COMPLETED additionally gates on checkout having
    // passed; off by default so future-dated demo bookings stay reviewable.)
    const bk = await pool.query(
      `SELECT property_id, property_title, wallet_address, payment_status, escrow_object_id,
              settlement_digest, check_in, check_out
       FROM bookings WHERE booking_ref = $1`, [bookingRef]);
    const booking = bk.rows[0];
    if (!booking) return reply.code(404).send({ error: 'Booking not found' });
    if (booking.wallet_address !== session.suiAddress) return reply.code(403).send({ error: 'You can only review your own bookings' });
    if (booking.payment_status === 'cancelled') return reply.code(400).send({ error: 'You cannot review a cancelled booking' });
    if (!booking.escrow_object_id) return reply.code(400).send({ error: 'Only completed, on-chain-escrow-backed stays can be reviewed — this booking was never funded on-chain' });
    if (process.env.REQUIRE_STAY_COMPLETED === 'true') {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (today < new Date(booking.check_out)) return reply.code(400).send({ error: 'You can review after your stay (checkout has not passed yet)' });
    }
    const existing = await pool.query('SELECT id FROM reviews WHERE booking_ref = $1', [bookingRef]);
    if (existing.rows.length > 0) return reply.code(400).send({ error: 'Already reviewed' });

    // Write the review to Walrus as an immutable attestation tied to the on-chain
    // booking, then store the proof (settlement_ref = the settlement tx digest or
    // the escrow object id) so each review is independently auditable.
    const settlementRef = booking.settlement_digest || booking.escrow_object_id;
    let reviewBlobId = null;
    try {
      reviewBlobId = await pushToWalrus({
        type: 'aria-verified-review', bookingRef, propertyId: booking.property_id,
        property: booking.property_title, guest: session.suiAddress, rating, review,
        escrowObjectId: booking.escrow_object_id, settlementDigest: booking.settlement_digest || null,
        checkIn: booking.check_in, checkOut: booking.check_out, reviewedAt: new Date().toISOString(),
      }, fastify.log);
    } catch (err) { fastify.log.warn({ err, bookingRef }, 'reviews/submit: Walrus attestation failed (non-blocking)'); }

    await pool.query(
      `INSERT INTO reviews (property_id, booking_ref, guest_name, guest_email, rating, review, verified, settlement_ref, review_walrus_blob_id)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8)`,
      [booking.property_id, bookingRef, session.name, session.email, rating, review, settlementRef, reviewBlobId]
    );
    return { success: true, message: 'Verified review submitted.', verified: true, walrusBlobId: reviewBlobId };
  } catch (err) { fastify.log.error({ err }, 'reviews/submit failed'); return reply.code(500).send({ error: 'Failed to submit review' }); }
});

fastify.get('/reviews/:propertyId', async (request, reply) => {
  const { propertyId } = request.params;
  try {
    const result = await pool.query(
      'SELECT * FROM reviews WHERE property_id = $1 ORDER BY created_at DESC',
      [propertyId]
    );
    const reviews = result.rows.map(r => ({
      rating: r.rating, review: r.review, guestName: r.guest_name, timestamp: r.created_at,
      verified: r.verified === true, walrusBlobId: r.review_walrus_blob_id,
    }));
    const averageRating = reviews.length ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1) : 0;
    const verifiedCount = reviews.filter(r => r.verified).length;
    return { reviews, averageRating: parseFloat(averageRating), count: reviews.length, verifiedCount };
  } catch (err) { return { reviews: [], averageRating: 0, count: 0 }; }
});

// Scoped to the requesting host's own properties (R6) — superadmins still see
// every review.
fastify.get('/reviews/all', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  const ownedIds = await getOwnedPropertyIds(session);
  if (ownedIds && ownedIds.size === 0) return { reviews: [] };
  try {
    const result = ownedIds
      ? await pool.query('SELECT * FROM reviews WHERE property_id = ANY($1) ORDER BY created_at DESC', [[...ownedIds]])
      : await pool.query('SELECT * FROM reviews ORDER BY created_at DESC');
    // Map to the camelCase shape host.jsx renders (the raw snake_case rows left
    // guestName/timestamp/bookingRef/propertyId undefined in the UI), and surface
    // the verified-review proof fields.
    return { reviews: result.rows.map(r => ({
      propertyId: r.property_id, bookingRef: r.booking_ref, guestName: r.guest_name,
      rating: r.rating, review: r.review, timestamp: r.created_at,
      verified: r.verified === true, settlementRef: r.settlement_ref, walrusBlobId: r.review_walrus_blob_id,
    })) };
  } catch (err) { fastify.log.error({ err }, '/reviews/all query failed'); return { reviews: [] }; }
});
}
