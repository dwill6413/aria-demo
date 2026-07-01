// Extracted verbatim from server.mjs (R1 route-module split, July 1 2026).
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { pool } from '../db.mjs';
import { getProperty } from '../catalog.mjs';
import { verifyCheckinSignature } from '../escrow.mjs';
import { hostManagesBooking } from '../bookings.mjs';
import { validateBody, accessInstructionsSchema } from '../validation.mjs';
import { isHost, canManageProperty, getAuthedSession } from '../authz.mjs';

// ─── Self check-in encryption (P4) ───────────────────────────────────────────
// AES-256-GCM. Key = CHECKIN_KEY env var (64 hex chars = 32 bytes).
// Stored format: iv_hex:ciphertext_hex:tag_hex (all colon-separated hex).
// Backend-mediated reveal: ARIA decrypts on the server and returns plaintext
// only to the authenticated booking guest within the check-in window.
// TODO: migrate to Seal seal_approve_checkin (on-chain time gate, fully
// non-custodial) once the Move contract is upgraded for that hook.
function encryptInstructions(plaintext) {
  const keyHex = process.env.CHECKIN_KEY || '';
  if (keyHex.length !== 64) throw new Error('CHECKIN_KEY must be 64 hex chars (32 bytes)');
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${ct.toString('hex')}:${tag.toString('hex')}`;
}

function decryptInstructions(blob) {
  const keyHex = process.env.CHECKIN_KEY || '';
  if (keyHex.length !== 64) throw new Error('CHECKIN_KEY not configured');
  const [ivHex, ctHex, tagHex] = blob.split(':');
  const key = Buffer.from(keyHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(ctHex, 'hex')) + decipher.final('utf8');
}

export default async function checkinRoutes(fastify) {
// ── Self check-in: access instructions (P4) ─────────────────────────────────

// PUT /host/property/:propertyId/access-instructions
// Host saves check-in type + access instructions (encrypted before storing).
fastify.put('/host/property/:propertyId/access-instructions', {
  config: { rateLimit: { max: 30, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many updates.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  if (validateBody(accessInstructionsSchema, request, reply)) return;

  const propertyId = Number(request.params.propertyId);
  const { checkInType, instructions } = request.body;

  // Verify this host owns the property (catalog or DB).
  if (!(await canManageProperty(session, propertyId)))
    return reply.code(403).send({ error: 'You do not own this property' });
  const prop = await getProperty(propertyId, fastify.log);
  if (!prop) return reply.code(404).send({ error: 'Property not found' });

  let encrypted = null;
  if (checkInType === 'self' && instructions?.trim()) {
    try {
      encrypted = encryptInstructions(instructions.trim());
    } catch (err) {
      fastify.log.error({ err }, 'access-instructions: encryption failed');
      return reply.code(500).send({ error: 'Could not encrypt access instructions — check CHECKIN_KEY configuration.' });
    }
  }

  try {
    await pool.query(
      `INSERT INTO property_checkin_settings (property_id, check_in_type, access_instructions_encrypted, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (property_id) DO UPDATE SET check_in_type=$2, access_instructions_encrypted=$3, updated_at=NOW()`,
      [propertyId, checkInType, encrypted]
    );
  } catch (err) {
    fastify.log.error({ err, propertyId }, 'access-instructions: update failed');
    return reply.code(500).send({ error: 'Could not save access instructions' });
  }
  fastify.log.info({ propertyId, checkInType, hasInstructions: !!encrypted }, 'Access instructions updated');
  return { success: true, checkInType };
});

// GET /host/property/:propertyId/access-instructions
// Host reads their own plaintext instructions back (for editing).
fastify.get('/host/property/:propertyId/access-instructions', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });

  const propertyId = Number(request.params.propertyId);
  if (!(await canManageProperty(session, propertyId)))
    return reply.code(403).send({ error: 'You do not own this property' });
  const prop = await getProperty(propertyId, fastify.log);
  if (!prop) return reply.code(404).send({ error: 'Property not found' });

  const cs = await pool.query(
    `SELECT check_in_type, access_instructions_encrypted FROM property_checkin_settings WHERE property_id=$1`,
    [propertyId]
  );
  const row = cs.rows[0];
  let instructions = '';
  if (row?.access_instructions_encrypted) {
    try { instructions = decryptInstructions(row.access_instructions_encrypted); }
    catch (err) { fastify.log.error({ err, propertyId }, 'access-instructions: decryption failed'); }
  }
  return { checkInType: row?.check_in_type || 'front_desk', instructions };
});

// POST /booking/:bookingRef/checkin
// Guest-side check-in. Verifies: authenticated guest, correct wallet, active
// booking, within check-in window. For self check-in, decrypts and returns
// the property's access instructions. Marks booking checked_in=true.
fastify.post('/booking/:bookingRef/checkin', {
  config: { rateLimit: { max: 20, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many check-in attempts.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;

  const { bookingRef } = request.params;
  const bk = await pool.query(
    `SELECT b.*, COALESCE(cs.check_in_type, 'front_desk') AS check_in_type, cs.access_instructions_encrypted
     FROM bookings b
     LEFT JOIN property_checkin_settings cs ON cs.property_id = b.property_id
     WHERE b.booking_ref = $1`, [bookingRef]
  );
  const booking = bk.rows[0];
  if (!booking) return reply.code(404).send({ error: 'Booking not found' });
  if (booking.wallet_address !== session.suiAddress)
    return reply.code(403).send({ error: 'This is not your booking' });
  if (booking.cancelled_at)
    return reply.code(400).send({ error: 'This booking has been cancelled' });
  if (booking.deposit_status !== 'held' && booking.payment_status !== 'confirmed')
    return reply.code(400).send({ error: 'Booking is not in an active state' });

  // Time gate: allow check-in from 2 hours before the check-in date (midnight UTC)
  // through the end of the check-out date.
  const checkInMs = Date.parse(booking.check_in);
  const checkOutMs = Date.parse(booking.check_out) + 24 * 60 * 60 * 1000;
  const now = Date.now();
  const GRACE_MS = 2 * 60 * 60 * 1000; // 2h early grace
  if (now < checkInMs - GRACE_MS)
    return reply.code(400).send({ error: `Check-in opens on ${new Date(checkInMs).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}. Come back closer to your arrival.` });
  if (now > checkOutMs)
    return reply.code(400).send({ error: 'Your stay has ended — check-in is no longer available.' });

  // Mark checked_in (idempotent — guests can re-open instructions anytime).
  if (!booking.checked_in) {
    try {
      await pool.query(
        `UPDATE bookings SET checked_in=true, checked_in_at=NOW() WHERE booking_ref=$1`,
        [bookingRef]
      );
    } catch (err) {
      fastify.log.error({ err, bookingRef }, 'checkin: status update failed');
    }
  }

  const checkInType = booking.check_in_type || 'front_desk';

  if (checkInType === 'self') {
    let instructions = '';
    if (booking.access_instructions_encrypted) {
      try { instructions = decryptInstructions(booking.access_instructions_encrypted); }
      catch (err) {
        fastify.log.error({ err, bookingRef }, 'checkin: decryption failed');
        return reply.code(500).send({ error: 'Could not retrieve access instructions — please contact your host.' });
      }
    }
    fastify.log.info({ bookingRef, guest: session.suiAddress }, 'Self check-in: instructions revealed');
    return { success: true, checkInType: 'self', instructions, property: booking.property_title };
  }

  // Front-desk: signal the frontend to open the BookingPass QR modal.
  fastify.log.info({ bookingRef, guest: session.suiAddress }, 'Front-desk check-in initiated');
  return { success: true, checkInType: 'front_desk', property: booking.property_title };
});

// BookingPass check-in verify (Phase 1) — a scanner (front desk / lock operator)
// posts the guest's presented payload; we prove it's a fresh, wallet-signed
// presentation by the booking's own guest, for an active on-chain booking the
// scanning host manages. Host-gated (only the property's side scans).
fastify.post('/checkin/verify', {
  config: {
    rateLimit: {
      max: 60, timeWindow: '1 minute',
      errorResponseBuilder: () => ({ error: 'Too many check-in scans. Slow down.' })
    }
  }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host/scanner access required' });

  // The scanner forwards exactly what it scanned (base64 JSON of the signed
  // payload). Decode + shape-check before trusting anything in it.
  let payload;
  try {
    const raw = request.body?.token;
    if (!raw || typeof raw !== 'string') return reply.code(400).send({ valid: false, reason: 'No pass payload presented' });
    payload = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return reply.code(400).send({ valid: false, reason: 'Unreadable pass — not a valid ARIA check-in code' });
  }
  const { bookingRef, ts, nonce, address, signature } = payload || {};
  if (!bookingRef || !ts || !nonce || !address || !signature)
    return reply.code(400).send({ valid: false, reason: 'Incomplete pass payload' });

  // Freshness — a rotating pass is only valid for a short window, so a screenshot
  // or photographed QR goes stale. Reject old AND future timestamps.
  const CHECKIN_WINDOW_MS = Number(process.env.CHECKIN_WINDOW_MS || 90_000);
  const skew = Date.now() - Number(ts);
  if (!Number.isFinite(skew) || skew > CHECKIN_WINDOW_MS || skew < -30_000)
    return reply.code(400).send({ valid: false, reason: 'Pass expired — ask the guest to refresh their check-in code' });

  // Cryptographic proof-of-control: the payload is signed by the wallet it claims.
  const sig = await verifyCheckinSignature({ bookingRef, ts, nonce, address, signature });
  if (!sig.ok) return reply.code(400).send({ valid: false, reason: sig.reason });

  let booking;
  try {
    const r = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
    booking = r.rows[0];
  } catch (err) {
    fastify.log.error({ err }, '/checkin/verify: lookup failed');
    return reply.code(500).send({ valid: false, reason: 'Lookup failed' });
  }
  if (!booking) return reply.code(404).send({ valid: false, reason: 'No such booking' });
  // The signer must BE the booking's guest, the scanning host must manage it,
  // and it must be a real, active, on-chain-escrow-backed booking.
  if (String(booking.wallet_address).toLowerCase() !== String(address).toLowerCase())
    return reply.code(403).send({ valid: false, reason: 'This pass was not issued to this booking' });
  if (!(await hostManagesBooking(session, booking)))
    return reply.code(403).send({ valid: false, reason: 'You do not manage this property' });
  if (booking.payment_status === 'cancelled')
    return reply.code(400).send({ valid: false, reason: 'Booking is cancelled' });
  if (!booking.escrow_object_id)
    return reply.code(400).send({ valid: false, reason: 'Booking not funded on-chain — no valid pass' });

  fastify.log.info({ bookingRef, guest: address }, '/checkin/verify: valid pass presented');
  return {
    valid: true, bookingRef, guestName: booking.guest_name, property: booking.property_title,
    checkIn: booking.check_in, checkOut: booking.check_out, nights: booking.nights,
  };
});
}
