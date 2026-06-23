import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import Stripe from 'stripe';
import { isValidTransactionDigest } from '@mysten/sui/utils';
import { dotenvConfig } from './config.mjs';
import { getSuiUSDLiquidity, calculateHostPayout } from './deepbook.mjs';
import { generateICal, saveExternalCalendar, checkAvailability, assertPublicHttpsUrl } from './ical.mjs';
import { Resend } from 'resend';
import { registerAIRoute } from './ai_route.mjs';
import { handleZkLoginCallback, getSession, deleteSession } from './auth.mjs';
import { initDB, pool } from './db.mjs';
import { PROPERTIES, JURISDICTION_TAX_RATES } from './catalog.mjs';
import {
  verifyEscrowTransaction, autoReleaseEscrow,
  buildClaimDamageTransaction, buildDisputeClaimTransaction,
  verifyClaimDamageTransaction, verifyDisputeClaimTransaction,
  resolveDisputeEscrow, finalizeClaimEscrow,
  verifyBookingPaymentTransaction, releasePaymentEscrow,
  buildBookingPaymentTransaction, buildEscrowTransaction
} from './escrow.mjs';
import { createBooking, releaseDepositForBooking, cancelBooking, hostManagesBooking, getPropertyHostAddress } from './bookings.mjs';
import { pushToWalrus } from './walrus.mjs';
import { escapeHtml } from './emails.mjs';
import {
  bookingCreateSchema, paymentCreateIntentSchema, hostApplySchema, validateBody,
  claimDamageSchema, claimDamageConfirmSchema, disputeClaimSchema, disputeClaimConfirmSchema, resolveDisputeSchema,
  guestProfileSchema
} from './validation.mjs';

dotenvConfig();

// ─── Sui Escrow Client ────────────────────────────────────────────────────────
// suiClient/autoReleaseKeypair setup and the escrow PTB build/verify/auto-release
// helpers moved to escrow.mjs (Phase 2b) so ai_route.mjs's create_booking tool
// can build the exact same guest-signed escrow transaction that this REST path
// already did — see escrow.mjs's header comment and bookings.mjs's
// createBooking() for why (the AI chat flow previously skipped escrow
// entirely while claiming the deposit was held in one).

try { await initDB(); } catch (err) { console.error('DB init failed:', err.message); }

// ─── Jurisdiction Tax Rates ───────────────────────────────────────────────────
// Single source of truth now imported from catalog.mjs (Phase 1/2 fix) — see
// PROPERTIES/JURISDICTION_TAX_RATES import above. Do not redefine these here.

// ─── Role-Based Access Control ────────────────────────────────────────────────
const HOST_ADDRESSES = (process.env.HOST_ADDRESSES || '').split(',').map(e => e.trim().toLowerCase());

function isHost(session) {
  if (!session?.email) return false;
  if (HOST_ADDRESSES.includes(session.email.toLowerCase())) return true;
  return session.dbHostApproved === true;
}

async function checkDbHost(email) {
  try {
    const result = await pool.query(
      `SELECT id FROM host_profiles WHERE email = $1 AND status = 'approved'`,
      [email.toLowerCase()]
    );
    return result.rows.length > 0;
  } catch { return false; }
}

// Property-scoped authorization for actions that mutate a specific booking
// (release deposit, tax remit/unremit, etc). Superadmins (HOST_ADDRESSES) may
// act on any property; an approved host may only act on properties they own
// in the `properties` table. Mirrors ai_route.mjs's release_deposit pattern
// (Finding #4 / Phase 1b) so the two booking-mutation paths can't diverge.
async function canManageProperty(session, propertyId) {
  if (HOST_ADDRESSES.includes((session?.email || '').toLowerCase())) return true;
  try {
    const r = await pool.query(
      'SELECT 1 FROM properties WHERE id = $1 AND host_address = $2',
      [propertyId, session?.suiAddress]
    );
    return r.rows.length > 0;
  } catch { return false; }
}

// P2 / Phase 1j: claim_damage asserts on-chain that the signer IS escrow.host
// — not just "manages the property" in the loose canManageProperty sense —
// so the booking's own host_sui_address (the address actually baked into its
// on-chain escrow object, recorded by createBooking) is the authoritative
// check. Superadmins (HOST_ADDRESSES) and canManageProperty are kept as
// fallbacks for forward-compatibility once the `properties` table is
// populated, but neither bypasses the on-chain assertion itself — if the
// caller isn't really escrow.host, the signed transaction simply fails
// on-chain with ENotHost when they try to submit it.
async function canClaimAsHost(session, booking) {
  if (HOST_ADDRESSES.includes((session?.email || '').toLowerCase())) return true;
  if (booking.host_sui_address && session?.suiAddress === booking.host_sui_address) return true;
  return canManageProperty(session, booking.property_id);
}

// R1: single source of the session-lookup boilerplate that was copy-pasted into
// ~28 routes. Returns the session, or sends the 401 and returns null (caller
// does `if (!session) return;`).
async function getAuthedSession(request, reply) {
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) { reply.code(401).send({ error: 'Not authenticated' }); return null; }
  const session = await getSession(sessionId);
  if (!session) { reply.code(401).send({ error: 'Session expired' }); return null; }
  return session;
}

// R5: a booking's message thread is visible only to its participants — the guest
// who booked, a host who manages the property, or a superadmin. Without this,
// any logged-in user could read/post to an arbitrary thread by bookingRef.
async function canAccessBookingThread(session, booking) {
  if (!booking) return false;
  if (booking.wallet_address === session?.suiAddress) return true;                 // guest
  if (HOST_ADDRESSES.includes((session?.email || '').toLowerCase())) return true;  // superadmin
  if (booking.host_sui_address && session?.suiAddress === booking.host_sui_address) return true; // demo host
  return canManageProperty(session, booking.property_id);                          // DB-mapped host
}

const resend = new Resend(process.env.RESEND_API_KEY);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const fastify = Fastify({ logger: true });

await fastify.register(cors, {
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
});

await fastify.register(cookie, {
  secret: process.env.SESSION_SECRET
});

await fastify.register(rateLimit, {
  global: true,
  max: 100,
  timeWindow: '1 minute',
  errorResponseBuilder: () => ({
    error: 'Too many requests. Please slow down and try again in a minute.'
  })
});

// §5f: security headers. This is a JSON API (the HTML/CSP live on the Next
// frontend — see next.config.mjs), so we disable CSP here and, crucially, keep
// the cross-origin resource policy OPEN: the Vercel frontend is a different
// origin and must be able to read API responses. The valuable headers helmet
// still sets: HSTS, X-Content-Type-Options (nosniff), X-Frame-Options,
// Referrer-Policy, X-DNS-Prefetch-Control, etc.
await fastify.register(helmet, {
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
});

await registerAIRoute(fastify);

// Health
fastify.get('/health', async () => {
  return { status: 'ok', app: 'ARIA Demo', network: process.env.SUI_NETWORK };
});

// Properties — authoritative price/tax data from catalog.mjs (Phase 2a fix).
// Public/read-only: this is the same price/tax info already hardcoded into
// the frontend bundles today, so exposing it isn't a new disclosure. The
// frontend pages (index.jsx, host.jsx) fetch this at load and merge it into
// their local display-only arrays (images, ratings, location, beds/baths,
// tags) so price/title/tax-rate have one source of truth instead of three.
fastify.get('/properties', async () => {
  const properties = Object.entries(PROPERTIES).map(([id, p]) => {
    const jurisdiction = JURISDICTION_TAX_RATES[Number(id)];
    return {
      id: Number(id),
      title: p.title,
      price: p.price,
      taxRate: jurisdiction?.rate ?? 0.08,
      taxName: jurisdiction?.name ?? 'Occupancy Tax',
    };
  });
  return { properties };
});

// Auth
// Ephemeral key + nonce generation moved client-side (lib/zklogin.js) — the
// backend no longer issues the Google OAuth URL itself. This is now a POST
// because the frontend sends {id_token, nonce} as a JSON body rather than
// the GET query+state pattern used when the backend minted the state blob.
fastify.post('/auth/zklogin/callback', async (request, reply) => {
  return handleZkLoginCallback(request, reply);
});

fastify.get('/auth/me', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;

  if (!HOST_ADDRESSES.includes(session.email.toLowerCase()) && !session.dbHostApproved) {
    session.dbHostApproved = await checkDbHost(session.email);
  }

  let hostStatus = null;
  try {
    const hp = await pool.query(
      'SELECT status FROM host_profiles WHERE email = $1',
      [session.email.toLowerCase()]
    );
    if (hp.rows.length > 0) hostStatus = hp.rows[0].status;
  } catch {}

  // Phase 2f: whether this guest has completed identity verification (a
  // guest_verifications row), so the frontend can gate booking + prompt /profile.
  let hasGuestProfile = false;
  try {
    const gv = await pool.query('SELECT 1 FROM guest_verifications WHERE sui_address = $1', [session.suiAddress]);
    hasGuestProfile = gv.rows.length > 0;
  } catch {}

  return {
    address: session.suiAddress,
    email: session.email,
    name: session.name,
    isHost: isHost(session),
    hostStatus,
    hasGuestProfile
  };
});

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
  if (!isHost(session)) return reply.code(403).send({ error: 'Host access required' });

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
  if (!booking.escrow_object_id)
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
    escrowObjectId: booking.escrow_object_id,
    guestAddress: booking.wallet_address,
  };
});

fastify.get('/auth/logout', async (request, reply) => {
  // Revoke server-side, not just the cookie: a copied aria_session (cookie or the
  // x-session-id fallback) must stop working immediately on logout, not linger
  // until expiry. deleteSession removes the Postgres session row.
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (sessionId) {
    try { await deleteSession(sessionId); }
    catch (err) { fastify.log.warn({ err }, '/auth/logout: session row delete failed'); }
  }
  reply.clearCookie('aria_session');
  return { success: true };
});

// Stripe
fastify.post('/payment/create-intent', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (validateBody(paymentCreateIntentSchema, request, reply)) return;

  const { propertyId } = request.body;
  const nights = Number(request.body.nights);
  const prop = PROPERTIES[Number(propertyId)];
  if (!prop) return reply.code(400).send({ error: 'propertyId must be between 1 and 6' });
  if (!nights || nights < 1 || nights > 90)
    return reply.code(400).send({ error: 'nights must be between 1 and 90' });

  // Server-authoritative charge total — mirrors /booking/create's math.
  // Never trust a client-sent `amount` for a real Stripe charge (Finding #1).
  const jurisdiction  = JURISDICTION_TAX_RATES[Number(propertyId)] || { rate: 0.08, name: 'Unknown' };
  const subtotal      = prop.price * nights;
  const ariaFee       = Math.round(subtotal * 0.03);
  const taxes         = Math.round(subtotal * jurisdiction.rate);
  const bookingTotal  = subtotal + ariaFee + taxes;
  const depositAmount = Math.round(bookingTotal * 0.20);
  const chargeAmount  = bookingTotal + depositAmount;

  const paymentIntent = await stripe.paymentIntents.create({
    amount: chargeAmount * 100,
    currency: 'usd',
    metadata: { property: prop.title, propertyId: String(propertyId), walletAddress: session.suiAddress, email: session.email }
  });
  return { clientSecret: paymentIntent.client_secret, chargeAmount };
});

// Booking Create
fastify.post('/booking/create', {
  config: {
    rateLimit: {
      max: 5,
      timeWindow: '15 minutes',
      errorResponseBuilder: () => ({ error: 'Too many booking attempts. Please wait 15 minutes and try again.' })
    }
  }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (validateBody(bookingCreateSchema, request, reply)) return;

  // Only propertyId + dates are taken from the client. Any client-sent
  // propertyTitle/pricePerNight/nights/totalAmount is ignored — createBooking
  // (bookings.mjs) recomputes all of it from PROPERTIES/JURISDICTION_TAX_RATES
  // (Finding #1 / Phase 1a). Phase 2b: this is now the same shared function
  // ai_route.mjs's create_booking tool calls, so the two paths can't diverge.
  const { propertyId } = request.body;
  const result = await createBooking({
    propertyId, checkIn: request.body.checkIn, checkOut: request.body.checkOut, session, logger: fastify.log
  });

  if (result.error) {
    const status = result.status
      || (result.error === 'Property not available for selected dates' ? 409 : 400);
    return reply.code(status).send(result);
  }
  return result;
});

// Guest reports the digest of the escrow transaction they signed and
// submitted themselves (directly to Sui, via their zkLogin signature). This
// route is the ONLY place allowed to write escrow_object_id / flip
// deposit_status to 'held' — it re-derives both from the chain itself
// (verifyEscrowTransaction) rather than trusting the client's claim, because
// /tax/summary joins against this same bookings row for host tax records.
fastify.post('/booking/:bookingRef/escrow/confirm', {
  config: {
    rateLimit: {
      max: 10, timeWindow: '15 minutes',
      errorResponseBuilder: () => ({ error: 'Too many escrow confirmation attempts. Please wait and try again.' })
    }
  }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;

  const { bookingRef } = request.params;
  const { digest } = request.body || {};
  if (!digest || typeof digest !== 'string' || !isValidTransactionDigest(digest)) {
    return reply.code(400).send({ error: 'A valid transaction digest is required' });
  }

  let booking;
  try {
    const result = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
    booking = result.rows[0];
  } catch (err) {
    fastify.log.error({ err }, 'Booking lookup failed');
    return reply.code(500).send({ error: 'Booking lookup failed' });
  }
  if (!booking) return reply.code(404).send({ error: 'Booking not found' });
  if (booking.wallet_address !== session.suiAddress) {
    return reply.code(403).send({ error: 'This booking does not belong to your account' });
  }
  // Phase 1h.5: a booking built with the combined payment+deposit PTB carries a
  // payment_release_ms; its confirm verifies BOTH escrows. Legacy deposit-only
  // bookings (no payment escrow) keep the original single-escrow path below.
  const isCombined = booking.payment_release_ms != null;

  if (booking.deposit_status === 'held' && (!isCombined || booking.payment_escrow_status === 'held')) {
    return reply.code(200).send({ success: true, escrowObjectId: booking.escrow_object_id, paymentEscrowObjectId: booking.payment_escrow_object_id, alreadyConfirmed: true });
  }

  if (isCombined) {
    let v;
    try {
      v = await verifyBookingPaymentTransaction(digest, {
        sender: session.suiAddress,
        host: booking.host_sui_address || undefined,
        bookingRef,
        subtotal: booking.subtotal,
        ariaFee: booking.aria_fee,
        taxes: booking.taxes,
        depositAmount: booking.deposit_amount,
        releaseMs: String(booking.payment_release_ms),
      });
    } catch (err) {
      fastify.log.error({ err, digest, bookingRef }, 'On-chain booking-payment verification failed');
      return reply.code(502).send({ error: 'Could not verify the transaction on-chain. It may still be processing — try again shortly.' });
    }
    if (!v.ok) {
      fastify.log.warn({ bookingRef, digest, reason: v.reason, retryable: !!v.retryable }, 'Booking-payment verification rejected');
      return reply.code(v.retryable ? 503 : 400).send({ error: v.reason || 'Booking transaction could not be verified', retryable: !!v.retryable });
    }
    try {
      // settlement_digest is UNIQUE (partial index) — a duplicate means this
      // on-chain tx already confirmed another booking (replay) → PG 23505.
      await pool.query(
        `UPDATE bookings SET escrow_object_id=$1, deposit_status='held',
           payment_escrow_object_id=$2, payment_escrow_status='held', settlement_digest=$3
         WHERE booking_ref=$4 AND wallet_address=$5`,
        [v.depositEscrowId, v.paymentEscrowId, digest, bookingRef, session.suiAddress]
      );
    } catch (err) {
      if (err?.code === '23505') {
        return reply.code(409).send({ error: 'This transaction has already been used to confirm a booking.' });
      }
      fastify.log.error({ err, bookingRef }, 'Failed to persist verified escrow ids');
      return reply.code(500).send({ error: 'Verified on-chain but failed to save — contact support' });
    }
    fastify.log.info({ bookingRef, paymentEscrowId: v.paymentEscrowId, depositEscrowId: v.depositEscrowId, digest }, 'Booking payment + deposit verified on-chain and recorded');
    return { success: true, escrowObjectId: v.depositEscrowId, paymentEscrowObjectId: v.paymentEscrowId };
  }

  let verification;
  try {
    // Pass the booking's own authoritative values so verifyEscrowTransaction
    // can confirm the on-chain escrow really matches THIS booking (guest, host,
    // ref, funded amount) — not just that some object was created by the guest.
    verification = await verifyEscrowTransaction(digest, {
      sender: session.suiAddress,
      host: booking.host_sui_address || undefined,
      bookingRef,
      depositAmount: booking.deposit_amount,
    });
  } catch (err) {
    fastify.log.error({ err, digest, bookingRef }, 'On-chain escrow verification failed');
    return reply.code(502).send({ error: 'Could not verify the transaction on-chain. It may still be processing — try again shortly.' });
  }

  if (!verification.ok) {
    fastify.log.warn({ bookingRef, digest, reason: verification.reason, retryable: !!verification.retryable }, 'Escrow verification rejected');
    // Review finding #1: a retryable result means the created object isn't
    // queryable yet (read-after-write lag) — return 503 so the client retries and
    // the booking stays pending, rather than marking the deposit held on weak
    // evidence (tx-success + sender only). Genuine mismatches stay a hard 400.
    const code = verification.retryable ? 503 : 400;
    return reply.code(code).send({ error: verification.reason || 'Escrow transaction could not be verified', retryable: !!verification.retryable });
  }

  try {
    await pool.query(
      `UPDATE bookings SET escrow_object_id=$1, deposit_status='held' WHERE booking_ref=$2 AND wallet_address=$3`,
      [verification.escrowId, bookingRef, session.suiAddress]
    );
  } catch (err) {
    fastify.log.error({ err, bookingRef }, 'Failed to persist verified escrow id');
    return reply.code(500).send({ error: 'Verified on-chain but failed to save — contact support' });
  }

  fastify.log.info({ bookingRef, escrowId: verification.escrowId, digest }, 'Escrow verified on-chain and recorded');
  return { success: true, escrowObjectId: verification.escrowId };
});

// Escrow Rebuild — resume signing a booking whose escrow was never funded.
// A booking is created (payment_status='confirmed') BEFORE the guest signs the
// escrow PTB; the original unsigned bytes live only in ephemeral homepage React
// state, so navigating away strands the booking (deposit_status='pending', no
// escrow, but it still blocks the dates). This rebuilds the same combined PTB on
// demand so My Bookings can offer a "Complete payment" action. Guest-owned and
// only for 'pending' deposits — a fresh release_time is computed since the
// original 5-min testnet window has likely passed.
fastify.post('/booking/:bookingRef/escrow/rebuild', {
  config: {
    rateLimit: {
      max: 10, timeWindow: '15 minutes',
      errorResponseBuilder: () => ({ error: 'Too many attempts. Please wait and try again.' })
    }
  }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;

  const { bookingRef } = request.params;
  if (!bookingRef || typeof bookingRef !== 'string' || !bookingRef.startsWith('ARIA-'))
    return reply.code(400).send({ error: 'A valid bookingRef is required' });

  let booking;
  try {
    const r = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
    booking = r.rows[0];
  } catch (err) {
    fastify.log.error({ err, bookingRef }, '/escrow/rebuild: lookup failed');
    return reply.code(500).send({ error: 'Booking lookup failed' });
  }
  if (!booking) return reply.code(404).send({ error: 'Booking not found' });
  if (booking.wallet_address !== session.suiAddress)
    return reply.code(403).send({ error: 'This booking does not belong to your account' });
  if (booking.payment_status === 'cancelled')
    return reply.code(400).send({ error: 'This booking was cancelled' });
  if (booking.deposit_status === 'held')
    return reply.code(200).send({ alreadyConfirmed: true });
  if (booking.deposit_status !== 'pending')
    return reply.code(400).send({ error: `Booking is not resumable (status: ${booking.deposit_status})` });

  const hostAddr = await getPropertyHostAddress(booking.property_id, fastify.log);
  if (!hostAddr) return reply.code(503).send({ error: 'Host address not configured for this property' });

  // Fresh release window — the original (now + 5min testnet) has likely lapsed,
  // and create_payment_escrow asserts release_time is in the future.
  const releaseMs = Date.now() + 300_000;
  const useCombined = !!(process.env.ARIA_FEE_ADDRESS && process.env.ARIA_TAX_REMITTANCE_ADDRESS);
  let built;
  try {
    built = useCombined
      ? await buildBookingPaymentTransaction(bookingRef, session.suiAddress, hostAddr,
          { subtotal: booking.subtotal, ariaFee: booking.aria_fee, taxes: booking.taxes, depositAmount: booking.deposit_amount, releaseMs }, fastify.log)
      : await buildEscrowTransaction(bookingRef, session.suiAddress, hostAddr, booking.deposit_amount, fastify.log);
  } catch (err) {
    fastify.log.error({ err, bookingRef }, '/escrow/rebuild: build failed');
  }
  if (!built?.txBytes)
    return reply.code(503).send({ error: 'Could not rebuild the escrow transaction. Please try again.' });

  try {
    if (useCombined) {
      await pool.query('UPDATE bookings SET host_sui_address=$1, payment_release_ms=$2 WHERE booking_ref=$3',
        [hostAddr, String(releaseMs), bookingRef]);
    } else {
      await pool.query('UPDATE bookings SET host_sui_address=$1 WHERE booking_ref=$2', [hostAddr, bookingRef]);
    }
  } catch (err) { fastify.log.warn({ err, bookingRef }, '/escrow/rebuild: persist failed'); }

  const chargeAmount = (booking.total_amount || 0) + (booking.deposit_amount || 0);
  return {
    bookingRef, property: booking.property_title,
    escrowTxBytes: built.txBytes, paymentEscrowBuilt: useCombined,
    subtotal: booking.subtotal, ariaFee: booking.aria_fee, taxes: booking.taxes,
    depositAmount: booking.deposit_amount, chargeAmount,
  };
});

// Booking Cancel — delegates to the shared cancelBooking() service (R2 + M1:
// releases the on-chain escrow on cancel; no more stranded deposits).
fastify.post('/booking/cancel', {
  config: {
    rateLimit: {
      max: 10, timeWindow: '1 hour',
      errorResponseBuilder: () => ({ error: 'Too many cancellation attempts. Please wait and try again.' })
    }
  }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  const { bookingRef } = request.body;
  // No isHost bypass: cancelBooking self-authorizes (guest owns it, or host
  // manages the property) so a host can't cancel another tenant's booking.
  const result = await cancelBooking({ bookingRef, session, logger: fastify.log });
  if (result.error) return reply.code(result.status || 400).send({ error: result.error });
  return result;
});

// Release Deposit — HOST ONLY
fastify.post('/booking/release-deposit', {
  config: {
    rateLimit: {
      max: 10, timeWindow: '1 hour',
      errorResponseBuilder: () => ({ error: 'Too many deposit release attempts.' })
    }
  }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!isHost(session)) return reply.code(403).send({ error: 'Host access required' });

  const { bookingRef } = request.body;
  if (!bookingRef || typeof bookingRef !== 'string' || !bookingRef.startsWith('ARIA-'))
    return reply.code(400).send({ error: 'A valid bookingRef is required' });

  try {
    const result = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Booking not found' });
    const booking = result.rows[0];
    if (!(await canManageProperty(session, booking.property_id)))
      return reply.code(403).send({ error: 'You do not manage this property' });

    // Shared release logic (Findings #4/#5): enforces the released/claim-flow
    // guards, the post-checkout timing gate, and — when an escrow exists — only
    // marks the deposit released if auto_release actually succeeds on-chain.
    const release = await releaseDepositForBooking(booking, { logger: fastify.log });
    if (release.error) return reply.code(release.status || 400).send({ error: release.error });

    const depositReleaseWalrusBlobId = await pushToWalrus({ ...booking, walrusReceiptType: 'deposit_release', depositReleaseTimestamp: new Date().toISOString() });

    return { success: true, bookingRef, depositReleaseWalrusBlobId, message: `Deposit of $${booking.deposit_amount} released to guest.` };
  } catch (err) {
    return reply.code(500).send({ error: 'Failed to release deposit' });
  }
});

// ── P2 / Phase 1j: Claim / Dispute / Resolution routes ─────────────────────
// Non-custodial build+confirm pairs for claim-damage (host-signed) and
// dispute-claim (guest-signed), mirroring /booking/create + escrow/confirm.
// resolve-dispute is the one exception — ARIA itself signs that call with the
// narrowly-scoped arbitrator key (see escrow.mjs's resolveDisputeEscrow
// comment), so it has no separate confirm step; it executes immediately like
// /booking/release-deposit does.

// Claim Damage (build) — HOST ONLY. Returns unsigned tx bytes for the host to
// sign client-side; nothing is written to Postgres until the host reports the
// digest to /booking/claim-damage/confirm below.
fastify.post('/booking/claim-damage', {
  config: {
    rateLimit: { max: 10, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many claim attempts.' }) }
  }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (validateBody(claimDamageSchema, request, reply)) return;

  const { bookingRef, reason } = request.body;
  const claimAmount = Number(request.body.claimAmount);
  if (!bookingRef.startsWith('ARIA-')) return reply.code(400).send({ error: 'A valid bookingRef is required' });
  if (!Number.isFinite(claimAmount) || claimAmount <= 0) return reply.code(400).send({ error: 'claimAmount must be a positive number' });

  try {
    const result = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Booking not found' });
    const booking = result.rows[0];

    if (!(await canClaimAsHost(session, booking))) return reply.code(403).send({ error: 'You do not manage this property' });
    if (!booking.escrow_object_id) return reply.code(400).send({ error: 'No on-chain escrow exists for this booking yet' });
    if (booking.deposit_status !== 'held') return reply.code(400).send({ error: `Deposit is not in a claimable state (status: ${booking.deposit_status})` });

    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (today < new Date(booking.check_out)) return reply.code(400).send({ error: 'Cannot file a claim before checkout' });
    if (claimAmount > booking.deposit_amount) return reply.code(400).send({ error: 'claimAmount cannot exceed the deposit amount' });

    const built = await buildClaimDamageTransaction(booking.escrow_object_id, session.suiAddress, claimAmount, fastify.log);
    if (!built?.txBytes) return reply.code(502).send({ error: 'Could not build the claim transaction — escrow may not be configured correctly' });

    return { success: true, claimTxBytes: built.txBytes, claimAmount, reason,
      message: 'Sign this transaction in your wallet, then report the digest to /booking/claim-damage/confirm' };
  } catch (err) {
    fastify.log.error({ err, bookingRef }, '/booking/claim-damage failed');
    return reply.code(500).send({ error: 'Failed to build claim transaction' });
  }
});

// Claim Damage (confirm) — re-verifies the signed tx on-chain before writing
// claim_amount/claim_reason and flipping deposit_status='claimed', same
// trust model as /booking/:bookingRef/escrow/confirm.
fastify.post('/booking/claim-damage/confirm', {
  config: {
    rateLimit: { max: 10, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many claim confirmation attempts.' }) }
  }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (validateBody(claimDamageConfirmSchema, request, reply)) return;

  const { bookingRef, digest } = request.body;
  if (!isValidTransactionDigest(digest)) return reply.code(400).send({ error: 'A valid transaction digest is required' });

  try {
    const result = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Booking not found' });
    const booking = result.rows[0];
    if (!(await canClaimAsHost(session, booking))) return reply.code(403).send({ error: 'You do not manage this property' });
    if (booking.deposit_status === 'claimed') return reply.code(200).send({ success: true, alreadyConfirmed: true });

    const verification = await verifyClaimDamageTransaction(digest, session.suiAddress, booking.escrow_object_id);
    if (!verification.ok) return reply.code(400).send({ error: verification.reason || 'Claim transaction could not be verified' });

    // P1-2: record the ON-CHAIN claim amount the host actually signed (decoded
    // lag-free from the claim_damage tx), NOT a client-supplied body value — a
    // client could otherwise post a different amount and make the DB/guest email
    // misstate the real claim. buildClaimDamageTransaction uses claimMist =
    // dollars * 1000, so divide back to dollars.
    if (verification.claimAmountMist == null) {
      return reply.code(400).send({ error: 'Could not read the claim amount from the on-chain transaction. Please retry in a moment.' });
    }
    const claimAmount = Number(verification.claimAmountMist) / 1000;
    const reason = request.body.reason ?? null;
    await pool.query(
      `UPDATE bookings SET deposit_status='claimed', claim_amount=$1, claim_reason=$2, claimed_at=NOW() WHERE booking_ref=$3`,
      [claimAmount || null, reason, bookingRef]
    );

    try {
      await resend.emails.send({
        from: 'ARIA <onboarding@resend.dev>', to: booking.guest_email,
        subject: `Damage Claim Filed — ${booking.property_title} | Ref: ${bookingRef}`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#ffaa00;font-size:24px;margin:0 0 8px">⚠️ Damage Claim Filed</h1><p style="color:#888;margin:0 0 24px">${booking.guest_name}, the host has filed a damage claim against your security deposit.</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin-bottom:20px"><h2 style="margin:0 0 16px;font-size:18px">${booking.property_title}</h2><p style="color:#888;font-size:13px;margin:0 0 6px">Claim amount: <span style="color:#ffaa00">$${claimAmount}</span> of your $${booking.deposit_amount} deposit</p>${reason ? `<p style="color:#888;font-size:13px;margin:0">Reason: ${escapeHtml(reason)}</p>` : ''}</div><p style="color:#555;font-size:12px;line-height:1.6">If you disagree with this claim, you can dispute it from your bookings page and ARIA will review and resolve the split.</p><p style="color:#555;font-size:12px;text-align:center;margin:24px 0 0">Powered by ARIA — Built on Sui</p></div>`
      });
    } catch (err) { fastify.log.warn({ err }, 'Claim notification email failed'); }

    return { success: true, bookingRef, claimAmount };
  } catch (err) {
    fastify.log.error({ err, bookingRef }, '/booking/claim-damage/confirm failed');
    return reply.code(500).send({ error: 'Failed to confirm claim' });
  }
});

// Dispute Claim (build) — GUEST ONLY. Returns unsigned tx bytes for the guest
// to sign client-side.
fastify.post('/booking/dispute-claim', {
  config: {
    rateLimit: { max: 10, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many dispute attempts.' }) }
  }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (validateBody(disputeClaimSchema, request, reply)) return;

  const { bookingRef, reason } = request.body;
  if (!bookingRef.startsWith('ARIA-')) return reply.code(400).send({ error: 'A valid bookingRef is required' });

  try {
    const result = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Booking not found' });
    const booking = result.rows[0];
    if (booking.wallet_address !== session.suiAddress) return reply.code(403).send({ error: 'Not your booking' });
    if (booking.deposit_status !== 'claimed') return reply.code(400).send({ error: `Nothing to dispute (status: ${booking.deposit_status})` });

    const built = await buildDisputeClaimTransaction(booking.escrow_object_id, session.suiAddress, fastify.log);
    if (!built?.txBytes) return reply.code(502).send({ error: 'Could not build the dispute transaction' });

    return { success: true, disputeTxBytes: built.txBytes, reason,
      message: 'Sign this transaction in your wallet, then report the digest to /booking/dispute-claim/confirm' };
  } catch (err) {
    fastify.log.error({ err, bookingRef }, '/booking/dispute-claim failed');
    return reply.code(500).send({ error: 'Failed to build dispute transaction' });
  }
});

// Dispute Claim (confirm) — re-verifies on-chain, flips deposit_status to
// 'disputed', and notifies ARIA admin (HOST_ADDRESSES[0]) to resolve it via
// /booking/resolve-dispute.
fastify.post('/booking/dispute-claim/confirm', {
  config: {
    rateLimit: { max: 10, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many dispute confirmation attempts.' }) }
  }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (validateBody(disputeClaimConfirmSchema, request, reply)) return;

  const { bookingRef, digest } = request.body;
  if (!isValidTransactionDigest(digest)) return reply.code(400).send({ error: 'A valid transaction digest is required' });

  try {
    const result = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Booking not found' });
    const booking = result.rows[0];
    if (booking.wallet_address !== session.suiAddress) return reply.code(403).send({ error: 'Not your booking' });
    if (booking.deposit_status === 'disputed') return reply.code(200).send({ success: true, alreadyConfirmed: true });

    const verification = await verifyDisputeClaimTransaction(digest, session.suiAddress, booking.escrow_object_id);
    if (!verification.ok) return reply.code(400).send({ error: verification.reason || 'Dispute transaction could not be verified' });

    const reason = request.body.reason ?? null;
    await pool.query(
      `UPDATE bookings SET deposit_status='disputed', dispute_reason=$1, disputed_at=NOW() WHERE booking_ref=$2`,
      [reason, bookingRef]
    );

    try {
      await resend.emails.send({
        from: 'ARIA <onboarding@resend.dev>', to: HOST_ADDRESSES[0] || 'cwilliams36092@gmail.com',
        subject: `Deposit Dispute Filed — ${booking.property_title} | Ref: ${bookingRef}`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#ff4444;font-size:24px;margin:0 0 8px">🚩 Dispute Filed</h1><p style="color:#888;margin:0 0 24px">A guest has disputed a damage claim — review needed.</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px"><p style="color:#888;font-size:13px;margin:0 0 6px">Booking: ${bookingRef} — ${booking.property_title}</p><p style="color:#888;font-size:13px;margin:0 0 6px">Claim amount: $${booking.claim_amount} of $${booking.deposit_amount}</p>${reason ? `<p style="color:#888;font-size:13px;margin:0">Guest's reason: ${escapeHtml(reason)}</p>` : ''}</div></div>`
      });
    } catch (err) { fastify.log.warn({ err }, 'Dispute admin notification email failed'); }

    return { success: true, bookingRef };
  } catch (err) {
    fastify.log.error({ err, bookingRef }, '/booking/dispute-claim/confirm failed');
    return reply.code(500).send({ error: 'Failed to confirm dispute' });
  }
});

// Resolve Dispute — SUPERADMIN ONLY (HOST_ADDRESSES). This is the one
// claim/dispute action ARIA's backend signs directly (see escrow.mjs's
// resolveDisputeEscrow) rather than building an unsigned tx for someone else
// to sign — the contract requires the caller to BE escrow.arbitrator, and
// ARIA itself is meant to fill that role per the roadmap's dispute design.
// Gated to HOST_ADDRESSES (not isHost/canManageProperty) since this is ARIA's
// own arbitration decision, not a per-property host action.
fastify.post('/booking/resolve-dispute', {
  config: {
    rateLimit: { max: 20, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many resolution attempts.' }) }
  }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!HOST_ADDRESSES.includes((session.email || '').toLowerCase()))
    return reply.code(403).send({ error: 'Superadmin access required' });
  if (validateBody(resolveDisputeSchema, request, reply)) return;

  const { bookingRef } = request.body;
  const guestAmount = Number(request.body.guestAmount);
  const hostAmount = Number(request.body.hostAmount);
  if (!Number.isFinite(guestAmount) || guestAmount < 0 || !Number.isFinite(hostAmount) || hostAmount < 0)
    return reply.code(400).send({ error: 'guestAmount and hostAmount must be non-negative numbers' });

  try {
    const result = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Booking not found' });
    const booking = result.rows[0];
    if (booking.deposit_status !== 'disputed') return reply.code(400).send({ error: `Booking is not disputed (status: ${booking.deposit_status})` });
    if (guestAmount + hostAmount !== booking.deposit_amount)
      return reply.code(400).send({ error: `guestAmount + hostAmount must equal the deposit ($${booking.deposit_amount})` });

    const resolved = await resolveDisputeEscrow(booking.escrow_object_id, guestAmount, hostAmount);
    if (!resolved) return reply.code(502).send({ error: 'On-chain resolution failed — escrow.arbitrator may not match ARIA_ARBITRATOR_KEY for this booking' });

    // Full forfeiture to host vs. any return to the guest are both
    // meaningfully different outcomes worth distinguishing in deposit_status
    // (see ARIA_ROADMAP.md's deposit_status enum extension); exact dollar
    // amounts are recorded in resolved_guest_amount/resolved_host_amount
    // regardless of which bucket this falls into.
    const finalStatus = guestAmount === 0 ? 'forfeited' : 'released';
    await pool.query(
      `UPDATE bookings SET deposit_status=$1, resolved_guest_amount=$2, resolved_host_amount=$3, resolved_at=NOW() WHERE booking_ref=$4`,
      [finalStatus, guestAmount, hostAmount, bookingRef]
    );

    try {
      await resend.emails.send({
        from: 'ARIA <onboarding@resend.dev>', to: booking.guest_email,
        subject: `Dispute Resolved — ${booking.property_title} | Ref: ${bookingRef}`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#00ff44;font-size:24px;margin:0 0 8px">✅ Dispute Resolved</h1><p style="color:#888;margin:0 0 24px">${booking.guest_name}, ARIA has reviewed your dispute.</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px"><p style="color:#888;font-size:13px;margin:0 0 6px">Returned to you: <span style="color:#00ff44">$${guestAmount}</span></p><p style="color:#888;font-size:13px;margin:0">Kept by host: $${hostAmount}</p></div></div>`
      });
    } catch (err) { fastify.log.warn({ err }, 'Resolution email failed'); }

    return { success: true, bookingRef, guestAmount, hostAmount, depositStatus: finalStatus };
  } catch (err) {
    fastify.log.error({ err, bookingRef }, '/booking/resolve-dispute failed');
    return reply.code(500).send({ error: 'Failed to resolve dispute' });
  }
});

// Walrus push helper now lives in walrus.mjs (R3) and is imported above.

// Bookings History — guest (own bookings only)
fastify.get('/bookings/history', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  try {
    const result = await pool.query(
      'SELECT * FROM bookings WHERE wallet_address = $1 ORDER BY created_at DESC',
      [session.suiAddress]
    );
    return { bookings: result.rows.map(b => {
      const chargeAmount = (b.total_amount || 0) + (b.deposit_amount || 0);
      const jur = JURISDICTION_TAX_RATES[Number(b.property_id)] || { rate: 0.08, name: 'Occupancy Tax' };
      return {
        bookingRef: b.booking_ref, property: b.property_title, propertyId: b.property_id,
        checkIn: b.check_in, checkOut: b.check_out, nights: b.nights,
        totalAmount: b.total_amount, ariaFee: b.aria_fee, taxes: b.taxes, chargeAmount,
        paymentStatus: b.payment_status,
        depositAmount: b.deposit_amount, depositStatus: b.deposit_status,
        walrusBlobId: b.walrus_blob_id,
        cancellationWalrusBlobId: b.cancellation_walrus_blob_id,
        timestamp: b.created_at, walletAddress: b.wallet_address,
        // ariaFee/taxes above are raw numeric fields for callers that need to
        // compute (e.g. pages/host.jsx revenue summaries — Finding #9). The
        // breakdown.* strings below remain purely for display.
        breakdown: {
          pricePerNight: `$${b.price_per_night}`, nights: b.nights,
          subtotal: `$${b.subtotal}`,
          ariaFee: `$${b.aria_fee} (3% of subtotal only)`,
          taxes: `$${b.taxes} (${(jur.rate * 100).toFixed(2)}% — ${jur.name})`,
          bookingTotal: `$${b.total_amount} SuiUSD`,
          depositAmount: `$${b.deposit_amount} (refundable — no ARIA fee)`,
          totalCharged: `$${chargeAmount} SuiUSD`,
          totalPaid: `$${b.total_amount} SuiUSD`
        }
      };
    })};
  } catch (err) { fastify.log.error({ err }, '/bookings/history query failed'); return { bookings: [] }; }
});

// Bookings All — HOST ONLY
fastify.get('/bookings/all', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!isHost(session)) return reply.code(403).send({ error: 'Host access required' });
  try {
    const result = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC');
    return { bookings: result.rows.map(b => {
      const chargeAmount = (b.total_amount || 0) + (b.deposit_amount || 0);
      const jur = JURISDICTION_TAX_RATES[Number(b.property_id)] || { rate: 0.08, name: 'Occupancy Tax' };
      return {
        bookingRef: b.booking_ref, property: b.property_title, propertyId: b.property_id,
        checkIn: b.check_in, checkOut: b.check_out, nights: b.nights,
        totalAmount: b.total_amount, ariaFee: b.aria_fee, taxes: b.taxes, chargeAmount,
        paymentStatus: b.payment_status,
        depositAmount: b.deposit_amount, depositStatus: b.deposit_status,
        walrusBlobId: b.walrus_blob_id,
        cancellationWalrusBlobId: b.cancellation_walrus_blob_id,
        guestName: b.guest_name, guestEmail: b.guest_email,
        walletAddress: b.wallet_address, timestamp: b.created_at,
        jurisdiction: jur.name,
        // ariaFee/taxes above are raw numeric fields — host.jsx revenue
        // summaries sum these directly instead of regex-parsing the display
        // strings in breakdown.* (Finding #9).
        breakdown: {
          pricePerNight: `$${b.price_per_night}`, nights: b.nights,
          subtotal: `$${b.subtotal}`,
          ariaFee: `$${b.aria_fee} (3% of subtotal only)`,
          taxes: `$${b.taxes} (${(jur.rate * 100).toFixed(2)}% — ${jur.name})`,
          bookingTotal: `$${b.total_amount} SuiUSD`,
          depositAmount: `$${b.deposit_amount} (refundable — no ARIA fee)`,
          totalCharged: `$${chargeAmount} SuiUSD`,
          totalPaid: `$${b.total_amount} SuiUSD`
        }
      };
    })};
  } catch (err) { fastify.log.error({ err }, '/bookings/all query failed'); return { bookings: [] }; }
});

// DeepBook
fastify.get('/deepbook/payout/:amount', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  const amount = parseFloat(request.params.amount);
  if (!amount || amount <= 0) return reply.code(400).send({ error: 'Invalid amount' });
  const liquidity = await getSuiUSDLiquidity(amount);
  const payout    = calculateHostPayout(amount);
  return { ...payout, liquidity, timestamp: new Date().toISOString() };
});

// iCal
fastify.get('/ical/:propertyId', async (request, reply) => {
  const { propertyId } = request.params;
  const propertyTitles = { '1': 'Oceanfront Villa', '2': 'Downtown Loft', '3': 'Mountain Cabin', '4': 'Desert Retreat', '5': 'Lake House', '6': 'Historic Brownstone' };
  const icalData = await generateICal(propertyId, propertyTitles[propertyId] || 'Property ' + propertyId);
  reply.header('Content-Type', 'text/calendar; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="aria-property-${propertyId}.ics"`);
  return reply.send(icalData);
});

fastify.post('/ical/import', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  const { propertyId, platform, icalUrl } = request.body;
  if (!propertyId || !platform || !icalUrl) return reply.code(400).send({ error: 'propertyId, platform and icalUrl required' });
  // Review finding #2 (SSRF + authz): only a host who manages this property may
  // register a feed URL the server will later fetch, and the URL must be a public
  // https endpoint (assertPublicHttpsUrl blocks internal/metadata addresses).
  if (!isHost(session)) return reply.code(403).send({ error: 'Host access required' });
  if (!(await canManageProperty(session, propertyId))) return reply.code(403).send({ error: 'You do not manage this property' });
  try {
    await assertPublicHttpsUrl(icalUrl);
  } catch (err) {
    return reply.code(400).send({ error: `Invalid iCal URL: ${err.message}` });
  }
  const saved = await saveExternalCalendar(propertyId, platform, icalUrl);
  return { success: true, message: `${platform} calendar synced for property ${propertyId}`, calendars: saved };
});

fastify.get('/availability/:propertyId', async (request, reply) => {
  const { propertyId } = request.params;
  const { checkIn, checkOut } = request.query;
  if (!checkIn || !checkOut) return reply.code(400).send({ error: 'checkIn and checkOut required' });
  const availability = await checkAvailability(propertyId, checkIn, checkOut);
  return { propertyId, checkIn, checkOut, ...availability };
});

// Messages — all thread routes are scoped to booking participants (R5).
fastify.post('/messages/send', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  const { bookingRef, message } = request.body;
  if (!bookingRef || !message) return reply.code(400).send({ error: 'bookingRef and message required' });
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

// Reviews
fastify.post('/reviews/submit', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  const { bookingRef, rating, review } = request.body;
  if (!bookingRef || !rating || !review) return reply.code(400).send({ error: 'bookingRef, rating and review are required' });
  if (rating < 1 || rating > 5) return reply.code(400).send({ error: 'Rating must be 1-5' });
  try {
    // Review finding #3: the review must be for the CALLER'S OWN booking, and the
    // property is derived from the booking row — never a client-supplied value.
    const bk = await pool.query('SELECT property_id, wallet_address FROM bookings WHERE booking_ref = $1', [bookingRef]);
    const booking = bk.rows[0];
    if (!booking) return reply.code(404).send({ error: 'Booking not found' });
    if (booking.wallet_address !== session.suiAddress) return reply.code(403).send({ error: 'You can only review your own bookings' });
    const existing = await pool.query('SELECT id FROM reviews WHERE booking_ref = $1', [bookingRef]);
    if (existing.rows.length > 0) return reply.code(400).send({ error: 'Already reviewed' });
    await pool.query(
      'INSERT INTO reviews (property_id, booking_ref, guest_name, guest_email, rating, review) VALUES ($1,$2,$3,$4,$5,$6)',
      [booking.property_id, bookingRef, session.name, session.email, rating, review]
    );
    return { success: true, message: 'Review submitted.' };
  } catch (err) { return reply.code(500).send({ error: 'Failed to submit review' }); }
});

fastify.get('/reviews/:propertyId', async (request, reply) => {
  const { propertyId } = request.params;
  try {
    const result = await pool.query(
      'SELECT * FROM reviews WHERE property_id = $1 ORDER BY created_at DESC',
      [propertyId]
    );
    const reviews = result.rows;
    const averageRating = reviews.length ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1) : 0;
    return { reviews, averageRating: parseFloat(averageRating), count: reviews.length };
  } catch (err) { return { reviews: [], averageRating: 0, count: 0 }; }
});

fastify.get('/reviews/all', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!isHost(session)) return reply.code(403).send({ error: 'Host access required' });
  try {
    const result = await pool.query('SELECT * FROM reviews ORDER BY created_at DESC');
    return { reviews: result.rows };
  } catch (err) { return { reviews: [] }; }
});

// ─── Tax Routes — HOST ONLY ───────────────────────────────────────────────────

fastify.get('/tax/summary', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!isHost(session)) return reply.code(403).send({ error: 'Host access required' });
  try {
    const result = await pool.query(`
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
    return {
      bookings: rows.map(r => {
        const jur = JURISDICTION_TAX_RATES[Number(r.property_id)] || { rate: 0.08, name: 'Unknown' };
        return {
          bookingRef: r.booking_ref, propertyId: r.property_id, property: r.property_title,
          guestName: r.guest_name, guestEmail: r.guest_email,
          checkIn: r.check_in, checkOut: r.check_out, nights: r.nights,
          subtotal: r.subtotal, taxAmount: r.taxes || 0, totalAmount: r.total_amount,
          taxRate: `${(jur.rate * 100).toFixed(2)}%`, jurisdiction: jur.name,
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
  if (!isHost(session)) return reply.code(403).send({ error: 'Host access required' });
  const { bookingRef, jurisdiction, notes } = request.body;
  if (!bookingRef || typeof bookingRef !== 'string' || !bookingRef.startsWith('ARIA-'))
    return reply.code(400).send({ error: 'A valid bookingRef is required' });
  try {
    const bkResult = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1 AND payment_status != $2', [bookingRef, 'cancelled']);
    if (bkResult.rows.length === 0) return reply.code(404).send({ error: 'Booking not found or is cancelled' });
    const booking = bkResult.rows[0];
    if (!(await canManageProperty(session, booking.property_id)))
      return reply.code(403).send({ error: 'You do not manage this property' });
    const jur = JURISDICTION_TAX_RATES[Number(booking.property_id)] || { name: jurisdiction || 'Unknown' };
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
  if (!isHost(session)) return reply.code(403).send({ error: 'Host access required' });
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

// ─── Host Onboarding Routes ───────────────────────────────────────────────────

fastify.get('/host/profile', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  try {
    const result = await pool.query('SELECT * FROM host_profiles WHERE sui_address = $1', [session.suiAddress]);
    if (result.rows.length === 0) return { profile: null };
    const p = result.rows[0];
    return { profile: {
      name: p.name, email: p.email, phone: p.phone,
      propertyAddress: p.property_address, city: p.city, state: p.state,
      zip: p.zip, country: p.country, jurisdiction: p.jurisdiction,
      strPermit: p.str_permit, payoutSuiAddress: p.payout_sui_address,
      payoutNotes: p.payout_notes, status: p.status,
      termsAgreed: p.terms_agreed, complianceConfirmed: p.compliance_confirmed,
      createdAt: p.created_at, updatedAt: p.updated_at
    }};
  } catch (err) { return reply.code(500).send({ error: 'Failed to fetch host profile' }); }
});

fastify.post('/host/apply', {
  config: { rateLimit: { max: 3, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many applications. Please wait and try again.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (validateBody(hostApplySchema, request, reply)) return;

  const { name, email, phone, propertyAddress, city, state, zip, country,
          jurisdiction, strPermit, payoutSuiAddress, payoutNotes, termsAgreed, complianceConfirmed } = request.body;

  if (!termsAgreed || !complianceConfirmed)
    return reply.code(400).send({ error: 'Terms agreement and compliance confirmation are required' });

  try {
    const existing = await pool.query('SELECT id, status FROM host_profiles WHERE sui_address = $1', [session.suiAddress]);
    if (existing.rows.length > 0) {
      const status = existing.rows[0].status;
      if (status === 'approved') return reply.code(400).send({ error: 'You are already an approved host' });
      if (status === 'pending') return reply.code(400).send({ error: 'Your application is already under review' });
    }

    await pool.query(
      `INSERT INTO host_profiles
        (sui_address, email, name, phone, property_address, city, state, zip, country,
         jurisdiction, str_permit, payout_sui_address, payout_notes,
         status, terms_agreed, terms_agreed_at, compliance_confirmed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',true,NOW(),true)
       ON CONFLICT (sui_address) DO UPDATE SET
         email=$2, name=$3, phone=$4, property_address=$5, city=$6, state=$7, zip=$8,
         country=$9, jurisdiction=$10, str_permit=$11, payout_sui_address=$12,
         payout_notes=$13, status='pending', terms_agreed=true, terms_agreed_at=NOW(),
         compliance_confirmed=true, updated_at=NOW()`,
      [session.suiAddress, email.toLowerCase(), name, phone || null,
       propertyAddress || null, city || null, state || null, zip || null, country || 'US',
       jurisdiction || null, strPermit || null,
       payoutSuiAddress || session.suiAddress, payoutNotes || null]
    );

    try {
      await resend.emails.send({
        from: 'ARIA <onboarding@resend.dev>',
        to: HOST_ADDRESSES[0] || 'cwilliams36092@gmail.com',
        subject: `New Host Application — ${name}`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#ffaa00;font-size:22px;margin:0 0 8px">🏡 New Host Application</h1><p style="color:#888;margin:0 0 20px">Someone wants to become an ARIA host.</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:20px;font-size:13px"><table style="width:100%;border-collapse:collapse"><tr><td style="color:#888;padding:5px 0">Name</td><td style="text-align:right">${escapeHtml(name)}</td></tr><tr><td style="color:#888;padding:5px 0">Email</td><td style="text-align:right">${escapeHtml(email)}</td></tr><tr><td style="color:#888;padding:5px 0">Sui Address</td><td style="text-align:right;font-family:monospace;font-size:11px">${session.suiAddress}</td></tr>${city ? `<tr><td style="color:#888;padding:5px 0">Location</td><td style="text-align:right">${escapeHtml(city)}${state ? ', ' + escapeHtml(state) : ''}</td></tr>` : ''}${strPermit ? `<tr><td style="color:#888;padding:5px 0">STR Permit</td><td style="text-align:right">${escapeHtml(strPermit)}</td></tr>` : ''}</table></div><p style="color:#888;font-size:12px;margin:0">To approve, use the ARIA admin API with their Sui address.</p></div>`
      });
    } catch (err) { fastify.log.warn({ err }, 'Admin notification email failed'); }

    try {
      await resend.emails.send({
        from: 'ARIA <onboarding@resend.dev>',
        to: email,
        subject: 'ARIA Host Application Received',
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#00ff44;font-size:24px;margin:0 0 8px">🏠 Host Application Received</h1><p style="color:#888;margin:0 0 24px">Thanks for applying to host on ARIA, ${escapeHtml(name)}.</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin-bottom:20px"><p style="margin:0 0 12px;font-size:14px;color:#ccc">Your application is under review. Here's what happens next:</p><ul style="color:#888;font-size:13px;line-height:1.8;padding-left:16px"><li>We'll review your application within 1–2 business days</li><li>You'll receive an email when your account is approved</li><li>Once approved, you can list properties and receive bookings</li></ul></div><p style="color:#555;font-size:12px;text-align:center;margin:0">Powered by ARIA — Built on Sui</p></div>`
      });
    } catch (err) { fastify.log.warn({ err }, 'Host application email failed'); }

    return { success: true, status: 'pending', message: 'Host application submitted. You will receive an email when approved.' };
  } catch (err) {
    fastify.log.error(err);
    return reply.code(500).send({ error: 'Failed to submit host application' });
  }
});

fastify.post('/host/approve', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!HOST_ADDRESSES.includes(session.email.toLowerCase()))
    return reply.code(403).send({ error: 'Superadmin access required' });

  const { suiAddress } = request.body;
  if (!suiAddress) return reply.code(400).send({ error: 'suiAddress is required' });

  try {
    const result = await pool.query(
      `UPDATE host_profiles SET status='approved', approved_at=NOW(), approved_by=$1, updated_at=NOW() WHERE sui_address=$2 RETURNING *`,
      [session.email, suiAddress]
    );
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Host profile not found' });
    const host = result.rows[0];

    try {
      await resend.emails.send({
        from: 'ARIA <onboarding@resend.dev>',
        to: host.email,
        subject: '🎉 Your ARIA Host Account is Approved!',
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#00ff44;font-size:24px;margin:0 0 8px">🎉 You're an ARIA Host!</h1><p style="color:#888;margin:0 0 24px">Congratulations ${escapeHtml(host.name)} — your host account has been approved.</p><div style="background:#0a1a0a;border:1px solid #1a3a1a;border-radius:8px;padding:20px;margin-bottom:20px"><p style="color:#00ff44;font-size:14px;font-weight:600;margin:0 0 8px">You can now:</p><ul style="color:#888;font-size:13px;line-height:1.8;padding-left:16px"><li>Access your Host Dashboard</li><li>Receive bookings from guests</li><li>Manage deposits and payouts</li><li>Track occupancy tax compliance</li></ul></div><a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}" style="display:block;background:#00ff44;color:#000;text-align:center;padding:14px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none;margin-bottom:20px">Go to ARIA →</a><p style="color:#555;font-size:12px;text-align:center;margin:0">Powered by ARIA — Built on Sui</p></div>`
      });
    } catch (err) { fastify.log.warn({ err }, 'Host approval email failed'); }

    return { success: true, message: `Host ${host.name} approved`, email: host.email };
  } catch (err) {
    return reply.code(500).send({ error: 'Failed to approve host' });
  }
});

fastify.get('/host/applications', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!HOST_ADDRESSES.includes(session.email.toLowerCase()))
    return reply.code(403).send({ error: 'Superadmin access required' });

  try {
    const result = await pool.query(
      `SELECT id, sui_address, name, email, phone, city, state, jurisdiction, str_permit, status, created_at, approved_at
       FROM host_profiles ORDER BY created_at DESC`
    );
    return { applications: result.rows };
  } catch (err) {
    return reply.code(500).send({ error: 'Failed to fetch applications' });
  }
});

// ─── P2 / Phase 1h: Auto-Release Cron Job ──────────────────────────────────
// Sui has no native cron (see escrow.mjs's autoReleaseEscrow comment) — some
// off-chain keeper has to actually watch the clock and submit auto_release
// once the 5-day inspection window closes, or expired escrows would sit
// forever unless a guest/host manually triggers /booking/release-deposit.
// Railway runs this service as a single always-on process, so an in-process
// interval is the simplest keeper — no separate cron service/infra needed.
// Booking eligibility mirrors the roadmap's spec exactly: checkout + 5 days
// has passed, deposit is still 'held', and an escrow actually exists. The
// Move contract's own expiry_ms assertion is the real authority on whether
// auto_release succeeds on-chain (on testnet that's 5 minutes from creation,
// not 5 days — see buildEscrowTransaction) — this query is just an
// optimization so the sweep doesn't bother calling on bookings nowhere near
// checkout yet. A booking that fails to release (e.g. RPC hiccup) simply
// stays 'held' and is retried on the next sweep.
async function runAutoReleaseSweep() {
  let bookings;
  try {
    const result = await pool.query(
      `SELECT booking_ref, escrow_object_id, deposit_amount FROM bookings
       WHERE deposit_status = 'held' AND escrow_object_id IS NOT NULL
       AND check_out + INTERVAL '5 days' < NOW()`
    );
    bookings = result.rows;
  } catch (err) {
    fastify.log.error({ err }, 'Auto-release sweep query failed');
    return;
  }

  for (const booking of bookings) {
    try {
      const released = await autoReleaseEscrow(booking.escrow_object_id);
      if (released) {
        await pool.query('UPDATE bookings SET deposit_status=$1 WHERE booking_ref=$2', ['released', booking.booking_ref]);
        fastify.log.info({ bookingRef: booking.booking_ref }, 'Auto-release sweep: deposit released');
      } else {
        fastify.log.warn({ bookingRef: booking.booking_ref }, 'Auto-release sweep: on-chain release failed, will retry next sweep');
      }
    } catch (err) {
      fastify.log.error({ err, bookingRef: booking.booking_ref }, 'Auto-release sweep: error releasing booking');
    }
  }

  // Finding #7 (CLAIMED deadlock): also finalize claims the guest never
  // responded to. Once the inspection window has passed and an escrow is still
  // 'claimed' (host filed a claim, guest neither accepted nor disputed), the
  // keeper calls the contract's permissionless finalize_claim so funds aren't
  // locked forever by a silent guest. On success the deposit is settled per the
  // claim split, so we mark it 'released' (the terminal "deposit settled"
  // status this app uses for a finalized escrow). Requires the v3 package
  // upgrade to be live; until then finalizeClaimEscrow returns false and these
  // simply stay 'claimed' and retry — no code change needed once it's deployed.
  let claimed;
  try {
    const result = await pool.query(
      `SELECT booking_ref, escrow_object_id FROM bookings
       WHERE deposit_status = 'claimed' AND escrow_object_id IS NOT NULL
       AND check_out + INTERVAL '5 days' < NOW()`
    );
    claimed = result.rows;
  } catch (err) {
    fastify.log.error({ err }, 'Claim-finalize sweep query failed');
    return;
  }

  for (const booking of claimed) {
    try {
      const finalized = await finalizeClaimEscrow(booking.escrow_object_id);
      if (finalized) {
        await pool.query('UPDATE bookings SET deposit_status=$1 WHERE booking_ref=$2', ['released', booking.booking_ref]);
        fastify.log.info({ bookingRef: booking.booking_ref }, 'Claim-finalize sweep: timed-out claim finalized');
      } else {
        fastify.log.warn({ bookingRef: booking.booking_ref }, 'Claim-finalize sweep: on-chain finalize failed (package may predate finalize_claim), will retry');
      }
    } catch (err) {
      fastify.log.error({ err, bookingRef: booking.booking_ref }, 'Claim-finalize sweep: error finalizing booking');
    }
  }
}

// Phase 1h.5: check-in release sweep. Sui has no native cron, so a keeper must
// submit time-based settlement (same pattern as the deposit's auto-release
// sweep above). Once a booking's payment escrow reaches its baked-in check-in
// time (payment_release_ms), release_payment splits the held funds to
// host / ARIA / tax. Permissionless on-chain, signed by the zero-privilege
// auto-release key. Cancelled-before-check-in bookings are already 'refunded',
// so only genuinely-due payments are swept.
async function runCheckInReleaseSweep() {
  let due;
  try {
    const result = await pool.query(
      `SELECT booking_ref, payment_escrow_object_id FROM bookings
       WHERE payment_escrow_status = 'held' AND payment_escrow_object_id IS NOT NULL
       AND payment_release_ms IS NOT NULL AND payment_release_ms <= $1`,
      [String(Date.now())]
    );
    due = result.rows;
  } catch (err) {
    fastify.log.error({ err }, 'Check-in release sweep query failed');
    return;
  }

  for (const booking of due) {
    try {
      const released = await releasePaymentEscrow(booking.payment_escrow_object_id);
      if (released) {
        await pool.query(
          `UPDATE bookings SET payment_escrow_status='released', payment_released_at=NOW() WHERE booking_ref=$1`,
          [booking.booking_ref]
        );
        fastify.log.info({ bookingRef: booking.booking_ref }, 'Check-in release sweep: payment released (host/ARIA/tax)');
      } else {
        fastify.log.warn({ bookingRef: booking.booking_ref }, 'Check-in release sweep: on-chain release failed, will retry next sweep');
      }
    } catch (err) {
      fastify.log.error({ err, bookingRef: booking.booking_ref }, 'Check-in release sweep: error releasing payment');
    }
  }
}

const AUTO_RELEASE_SWEEP_INTERVAL_MS = Number(process.env.AUTO_RELEASE_SWEEP_INTERVAL_MS || 60 * 60 * 1000); // hourly by default
setInterval(() => { runAutoReleaseSweep().catch(err => fastify.log.error({ err }, 'Auto-release sweep crashed')); }, AUTO_RELEASE_SWEEP_INTERVAL_MS);
// Run once shortly after boot too, rather than waiting a full interval for the first sweep.
setTimeout(() => { runAutoReleaseSweep().catch(err => fastify.log.error({ err }, 'Auto-release sweep crashed')); }, 30_000);

// Phase 1h.5: check-in release runs on the same cadence as the deposit sweep.
const CHECKIN_RELEASE_SWEEP_INTERVAL_MS = Number(process.env.CHECKIN_RELEASE_SWEEP_INTERVAL_MS || AUTO_RELEASE_SWEEP_INTERVAL_MS);
setInterval(() => { runCheckInReleaseSweep().catch(err => fastify.log.error({ err }, 'Check-in release sweep crashed')); }, CHECKIN_RELEASE_SWEEP_INTERVAL_MS);
setTimeout(() => { runCheckInReleaseSweep().catch(err => fastify.log.error({ err }, 'Check-in release sweep crashed')); }, 35_000);

// ─── Start ────────────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT || '3001');
await fastify.listen({ port, host: '0.0.0.0' });
console.log('ARIA API running on port ' + port);
