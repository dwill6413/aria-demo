// Extracted verbatim from server.mjs (R1 route-module split, July 1 2026).
import { pool } from '../db.mjs';
import { getProperty } from '../catalog.mjs';
import { isHost, canManageProperty, getOwnedPropertyIds, getAuthedSession } from '../authz.mjs';

export default async function taxRoutes(fastify) {
// ─── Tax Routes — HOST ONLY ───────────────────────────────────────────────────

// Scoped to the requesting host's own properties (R6) — superadmins still see
// tax data platform-wide.
fastify.get('/tax/summary', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  const ownedIds = await getOwnedPropertyIds(session);
  if (ownedIds && ownedIds.size === 0) {
    return { bookings: [], summary: { totalCollected: 0, totalRemitted: 0, totalOutstanding: 0, bookingCount: 0, remittedCount: 0, pendingCount: 0 } };
  }
  try {
    const result = ownedIds
      ? await pool.query(`
          SELECT b.booking_ref, b.property_id, b.property_title, b.guest_name, b.guest_email,
            b.check_in, b.check_out, b.nights, b.subtotal, b.taxes, b.total_amount,
            b.payment_status, b.created_at,
            tr.id AS remittance_id, tr.remitted_at, tr.remitted_by, tr.jurisdiction, tr.notes
          FROM bookings b
          LEFT JOIN tax_remittances tr ON b.booking_ref = tr.booking_ref
          WHERE b.payment_status != 'cancelled' AND b.property_id = ANY($1)
          ORDER BY b.created_at DESC
        `, [[...ownedIds]])
      : await pool.query(`
      SELECT b.booking_ref, b.property_id, b.property_title, b.guest_name, b.guest_email,
        b.check_in, b.check_out, b.nights, b.subtotal, b.taxes, b.total_amount,
        b.payment_status, b.created_at,
        tr.id AS remittance_id, tr.remitted_at, tr.remitted_by, tr.jurisdiction, tr.notes
      FROM bookings b
      LEFT JOIN tax_remittances tr ON b.booking_ref = tr.booking_ref
      WHERE b.payment_status != 'cancelled'
      ORDER BY b.created_at DESC
    `);
    const rows = result.rows;
    const totalCollected   = rows.reduce((sum, r) => sum + (r.taxes || 0), 0);
    const totalRemitted    = rows.filter(r => r.remittance_id).reduce((sum, r) => sum + (r.taxes || 0), 0);
    const totalOutstanding = totalCollected - totalRemitted;
    const taxPropIds = [...new Set(rows.map(r => Number(r.property_id)))];
    const taxPropEntries = await Promise.all(taxPropIds.map(id => getProperty(id, fastify.log)));
    const taxPropById = new Map(taxPropIds.map((id, i) => [id, taxPropEntries[i]]));
    return {
      bookings: rows.map(r => {
        const jur = taxPropById.get(Number(r.property_id)) || { taxRate: 0.08, taxName: 'Unknown' };
        return {
          bookingRef: r.booking_ref, propertyId: r.property_id, property: r.property_title,
          guestName: r.guest_name, guestEmail: r.guest_email,
          checkIn: r.check_in, checkOut: r.check_out, nights: r.nights,
          subtotal: r.subtotal, taxAmount: r.taxes || 0, totalAmount: r.total_amount,
          taxRate: `${(jur.taxRate * 100).toFixed(2)}%`, jurisdiction: jur.taxName,
          bookedAt: r.created_at, remitted: !!r.remittance_id,
          remittedAt: r.remitted_at || null, remittedBy: r.remitted_by || null,
          notes: r.notes || null,
        };
      }),
      summary: {
        totalCollected, totalRemitted, totalOutstanding,
        bookingCount: rows.length,
        remittedCount: rows.filter(r => r.remittance_id).length,
        pendingCount: rows.filter(r => !r.remittance_id).length,
      }
    };
  } catch (err) { fastify.log.error(err); return reply.code(500).send({ error: 'Failed to fetch tax summary' }); }
});

fastify.post('/tax/remit', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  const { bookingRef, jurisdiction, notes } = request.body;
  if (!bookingRef || typeof bookingRef !== 'string' || !bookingRef.startsWith('ARIA-'))
    return reply.code(400).send({ error: 'A valid bookingRef is required' });
  try {
    const bkResult = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1 AND payment_status != $2', [bookingRef, 'cancelled']);
    if (bkResult.rows.length === 0) return reply.code(404).send({ error: 'Booking not found or is cancelled' });
    const booking = bkResult.rows[0];
    if (!(await canManageProperty(session, booking.property_id)))
      return reply.code(403).send({ error: 'You do not manage this property' });
    const propForRemit = await getProperty(booking.property_id, fastify.log);
    const jur = { name: propForRemit?.taxName || jurisdiction || 'Unknown' };
    const existing = await pool.query('SELECT id FROM tax_remittances WHERE booking_ref = $1', [bookingRef]);
    if (existing.rows.length > 0) return reply.code(400).send({ error: 'Taxes already marked as remitted for this booking' });
    await pool.query(
      `INSERT INTO tax_remittances (booking_ref, property_id, property_title, tax_amount, jurisdiction, remitted_at, remitted_by, notes)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7)`,
      [bookingRef, booking.property_id, booking.property_title, booking.taxes || 0, jurisdiction || jur.name, session.email, notes || null]
    );
    return { success: true, bookingRef, taxAmount: booking.taxes || 0, remittedBy: session.email, remittedAt: new Date().toISOString() };
  } catch (err) { fastify.log.error(err); return reply.code(500).send({ error: 'Failed to record tax remittance' }); }
});

fastify.post('/tax/unremit', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  const { bookingRef } = request.body;
  if (!bookingRef) return reply.code(400).send({ error: 'bookingRef is required' });
  try {
    const bkResult = await pool.query('SELECT property_id FROM bookings WHERE booking_ref = $1', [bookingRef]);
    if (bkResult.rows.length === 0) return reply.code(404).send({ error: 'Booking not found' });
    if (!(await canManageProperty(session, bkResult.rows[0].property_id)))
      return reply.code(403).send({ error: 'You do not manage this property' });

    const result = await pool.query('DELETE FROM tax_remittances WHERE booking_ref = $1 RETURNING *', [bookingRef]);
    if (result.rows.length === 0) return reply.code(404).send({ error: 'No remittance record found' });
    return { success: true, bookingRef };
  } catch (err) { return reply.code(500).send({ error: 'Failed to remove remittance record' }); }
});
}
