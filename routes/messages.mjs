// Extracted verbatim from server.mjs (R1 route-module split, July 1 2026).
import { pool } from '../db.mjs';
import { validateBody, messageSendSchema } from '../validation.mjs';
import { getAuthedSession, canAccessBookingThread } from '../authz.mjs';

export default async function messagesRoutes(fastify) {
// Messages — all thread routes are scoped to booking participants (R5).
fastify.post('/messages/send', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (validateBody(messageSendSchema, request, reply)) return;
  const { bookingRef, message } = request.body;
  const bk = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
  const booking = bk.rows[0];
  if (!booking) return reply.code(404).send({ error: 'Booking not found' });
  if (!(await canAccessBookingThread(session, booking))) return reply.code(403).send({ error: 'You are not a participant in this booking' });
  try {
    await pool.query(
      'INSERT INTO messages (booking_ref, from_name, from_email, message) VALUES ($1,$2,$3,$4)',
      [bookingRef, session.name, session.email, message]
    );
    return { success: true, message: 'Message sent.' };
  } catch (err) { return reply.code(500).send({ error: 'Failed to send message' }); }
});

fastify.get('/messages/:bookingRef', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  const { bookingRef } = request.params;
  const bk = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
  const booking = bk.rows[0];
  if (!booking) return reply.code(404).send({ error: 'Booking not found' });
  if (!(await canAccessBookingThread(session, booking))) return reply.code(403).send({ error: 'You are not a participant in this booking' });
  try {
    const result = await pool.query(
      'SELECT * FROM messages WHERE booking_ref = $1 ORDER BY created_at ASC',
      [bookingRef]
    );
    return { messages: result.rows.map(m => ({ from: m.from_name, email: m.from_email, message: m.message, timestamp: m.created_at })) };
  } catch (err) { return { messages: [] }; }
});

fastify.post('/messages/:bookingRef/read', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  return { success: true };
});

fastify.get('/messages/:bookingRef/count', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  const { bookingRef } = request.params;
  const bk = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
  const booking = bk.rows[0];
  if (!booking) return reply.code(404).send({ error: 'Booking not found' });
  if (!(await canAccessBookingThread(session, booking))) return reply.code(403).send({ error: 'You are not a participant in this booking' });
  try {
    const result = await pool.query(
      'SELECT COUNT(*) FROM messages WHERE booking_ref = $1 AND from_email != $2',
      [bookingRef, session.email]
    );
    return { count: parseInt(result.rows[0].count) };
  } catch (err) { return { count: 0 }; }
});
}
