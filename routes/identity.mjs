// Extracted verbatim from server.mjs (R1 route-module split, July 1 2026).
import { pool } from '../db.mjs';
import { hostManagesBooking, confirmCardBooking } from '../bookings.mjs';
import { validateBody, guestProfileSchema } from '../validation.mjs';
import { isHost, getAuthedSession } from '../authz.mjs';

export default async function identityRoutes(fastify) {
// ─── Phase 2: guest PII (Walrus + Seal) ──────────────────────────────────────
// The guest encrypts their PII client-side with Seal (identity = their Sui
// address) and stores the ciphertext on Walrus; only the blob POINTER is sent
// here. No PII ever touches the backend.
fastify.post('/guest/profile', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (validateBody(guestProfileSchema, request, reply)) return;
  const { walrusBlobId, phoneVerified } = request.body;
  try {
    await pool.query(
      `INSERT INTO guest_verifications (sui_address, walrus_blob_id, phone_verified)
       VALUES ($1, $2, $3)
       ON CONFLICT (sui_address)
       DO UPDATE SET walrus_blob_id = EXCLUDED.walrus_blob_id,
                     phone_verified = EXCLUDED.phone_verified`,
      [session.suiAddress, walrusBlobId, phoneVerified === true]
    );
  } catch (err) {
    fastify.log.error({ err }, '/guest/profile: save failed');
    return reply.code(500).send({ error: 'Could not save your verification' });
  }
  return { success: true, verified: true, walrusBlobId };
});

fastify.get('/guest/profile', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  try {
    const r = await pool.query(
      'SELECT walrus_blob_id, phone_verified FROM guest_verifications WHERE sui_address = $1',
      [session.suiAddress]
    );
    if (r.rows.length === 0) return { verified: false, walrusBlobId: null };
    return { verified: true, walrusBlobId: r.rows[0].walrus_blob_id, phoneVerified: r.rows[0].phone_verified };
  } catch (err) {
    fastify.log.error({ err }, '/guest/profile: lookup failed');
    return reply.code(500).send({ error: 'Could not load your verification' });
  }
});

// Returns the pointer + on-chain handles a host needs to build the seal_approve
// dry-run PTB and decrypt the guest's PII client-side. The backend NEVER sees
// plaintext PII or decryption keys — it only confirms the caller is this
// booking's host and hands back the blob id + escrow object id. On-chain,
// escrow.move's seal_approve independently enforces sender == escrow.host, so
// this route is defense-in-depth, not the sole gate.
fastify.get('/host/guest-identity/:bookingRef', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });

  const { bookingRef } = request.params;
  if (!bookingRef || typeof bookingRef !== 'string' || !bookingRef.startsWith('ARIA-'))
    return reply.code(400).send({ error: 'A valid bookingRef is required' });

  let booking;
  try {
    const r = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
    booking = r.rows[0];
  } catch (err) {
    fastify.log.error({ err }, '/host/guest-identity: lookup failed');
    return reply.code(500).send({ error: 'Booking lookup failed' });
  }
  if (!booking) return reply.code(404).send({ error: 'Booking not found' });
  if (!(await hostManagesBooking(session, booking)))
    return reply.code(403).send({ error: 'You do not manage this booking' });
  // M6 follow-up (Seal/Stripe parity): a Stripe-paid booking never gets a
  // guest-signed escrow_object_id (no guest wallet transaction happens in the
  // card-payment path at all), so it falls back to
  // identity_attestation_object_id — a real BookingEscrow<T> object ARIA's
  // backend creates specifically to satisfy seal_approve's on-chain check
  // (see createIdentityAttestationEscrow in escrow.mjs and its call site in
  // bookings.mjs's confirmCardBooking). Either column is a real, on-chain
  // BookingEscrow<T> object with this booking's actual guest/host addresses —
  // seal_approve itself can't tell which path produced it, and doesn't need
  // to. SuiUSD bookings keep using escrow_object_id unchanged.
  const sealEscrowObjectId = booking.escrow_object_id || booking.identity_attestation_object_id;
  if (!sealEscrowObjectId)
    return reply.code(409).send({ error: 'No active escrow for this booking — identity access requires a live booking' });

  let gv;
  try {
    gv = await pool.query('SELECT walrus_blob_id FROM guest_verifications WHERE sui_address = $1', [booking.wallet_address]);
  } catch (err) {
    fastify.log.error({ err }, '/host/guest-identity: verification lookup failed');
    return reply.code(500).send({ error: 'Verification lookup failed' });
  }
  if (gv.rows.length === 0) return reply.code(404).send({ error: 'This guest has no stored identity' });

  // §5f: audit every identity-access request (the decrypt itself is client-side
  // and unobservable here). Non-blocking — a log failure must not deny access.
  try {
    await pool.query(
      'INSERT INTO pii_access_log (booking_ref, host_address, guest_address) VALUES ($1, $2, $3)',
      [bookingRef, session.suiAddress, booking.wallet_address]
    );
  } catch (err) { fastify.log.warn({ err, bookingRef }, '/host/guest-identity: access-log insert failed'); }

  return {
    blobId: gv.rows[0].walrus_blob_id,
    escrowObjectId: sealEscrowObjectId,
    guestAddress: booking.wallet_address,
  };
});
}
