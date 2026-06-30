import Fastify from 'fastify';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import Stripe from 'stripe';
import { isValidTransactionDigest, isValidSuiAddress, parseToMist } from '@mysten/sui/utils';
import { dotenvConfig } from './config.mjs';
import { getSuiUSDLiquidity, calculateHostPayout } from './deepbook.mjs';
import { generateICal, saveExternalCalendar, checkAvailability, assertPublicHttpsUrl } from './ical.mjs';
import { Resend } from 'resend';
import { registerAIRoute } from './ai_route.mjs';
import { handleZkLoginCallback, getSession, deleteSession } from './auth.mjs';
import { initDB, pool } from './db.mjs';
import { getProperty, getAllProperties } from './catalog.mjs';
import { extractListingFields } from './listing_import.mjs';
import {
  verifyEscrowTransaction, autoReleaseEscrow,
  buildClaimDamageTransaction, buildDisputeClaimTransaction,
  verifyClaimDamageTransaction, verifyDisputeClaimTransaction,
  resolveDisputeEscrow, finalizeClaimEscrow,
  verifyBookingPaymentTransaction, releasePaymentEscrow,
  buildBookingPaymentTransaction, buildEscrowTransaction,
  verifyCheckinSignature,
  buildListForResaleTransaction, buildBuyResaleTransaction,
  buildCancelResaleListingTransaction, verifyBuyResaleTransaction,
  verifyListResaleTransaction, verifyCancelResaleTransaction,
  readResalePolicyObject, normalizeAddr,
  dollarsToUnits,
  buildSendTransaction, verifySendTransaction
} from './escrow.mjs';
import { createBooking, releaseDepositForBooking, cancelBooking, hostManagesBooking, getPropertyHostAddress, getResaleSettings } from './bookings.mjs';
import { pushToWalrus, pushImageToWalrus } from './walrus.mjs';
import { escapeHtml } from './emails.mjs';
import {
  bookingCreateSchema, paymentCreateIntentSchema, hostApplySchema, validateBody,
  claimDamageSchema, claimDamageConfirmSchema, disputeClaimSchema, disputeClaimConfirmSchema, resolveDisputeSchema,
  guestProfileSchema,
  resaleListSchema, resaleTransferConfirmSchema, resaleSettingsSchema,
  walletSendBuildSchema, walletSendConfirmSchema,
  accessInstructionsSchema,
  propertyCreateSchema, listingExtractSchema, listingBulkExtractSchema, listingPhotoSchema,
  messageSendSchema, reviewSubmitSchema
} from './validation.mjs';

dotenvConfig();

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

// B1 fix: isHost() used to read session.dbHostApproved, a flag that was only
// ever set transiently inside /auth/me and never persisted via saveSession —
// so on every other REST route it was undefined, and a host approved via
// host_profiles (but not in the HOST_ADDRESSES superadmin env list) failed
// isHost() on all REST host routes while still passing ai_route.mjs's
// resolveIsHost() (which is DB-backed). isHost() is now DB-backed too, so
// both paths agree. Callers must now `await isHost(session)`.
async function isHost(session) {
  if (!session?.email) return false;
  if (HOST_ADDRESSES.includes(session.email.toLowerCase())) return true;
  return checkDbHost(session.email);
}

// S4 fix: listing images[] was only length-checked (<2000 chars) before being
// stored and later rendered in <img src> — a host could store a data:/
// javascript:/arbitrary-scheme URL there. Restrict to https: URLs only.
function isSafeImageUrl(u) {
  if (typeof u !== 'string' || u.length === 0 || u.length >= 2000) return false;
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
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
// — either a host-imported row in the `properties` table, OR one of the 6
// fixed catalog demo properties whose hostAddress has been configured in
// catalog.mjs (PROPERTIES[id].hostAddress). Previously this only checked the
// `properties` table, so a real host configured for a fixed catalog
// property could never manage their own listing (Gap #2 of the catalog/db
// parity audit — the inverse of "imported listings missing functionality").
// Mirrors ai_route.mjs's release_deposit pattern (Finding #4 / Phase 1b) so
// the two booking-mutation paths can't diverge.
async function canManageProperty(session, propertyId) {
  if (HOST_ADDRESSES.includes((session?.email || '').toLowerCase())) return true;
  if (!session?.suiAddress) return false;
  try {
    // getProperty() already resolves hostAddress for BOTH sources — the
    // fixed catalog's PROPERTIES[id].hostAddress and a host-imported row's
    // host_address column — so a single check covers both cases.
    const prop = await getProperty(propertyId, fastify.log);
    return !!(prop?.hostAddress && normalizeAddr(prop.hostAddress) === normalizeAddr(session.suiAddress));
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
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']
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
// Phase 3a: now backed by catalog.mjs's getAllProperties(), which merges the
// 6 fixed demo properties with any active host-created rows from the
// `properties` table (imported via Airbnb/VRBO or entered manually — see
// POST /host/properties below). Dynamic rows additionally carry the cosmetic
// fields (location/beds/baths/images/tag) that the fixed 6 keep client-side
// in PROPERTY_DISPLAY, since there's no local fallback for an id the frontend
// doesn't already know about — pages/index.jsx and host.jsx read these to
// render a card for a property they've never seen before.
fastify.get('/properties', async () => {
  const all = await getAllProperties();
  const properties = all.map(p => ({
    id: p.id,
    title: p.title,
    price: p.price,
    taxRate: p.taxRate,
    taxName: p.taxName,
    // source lets the frontend tell a fixed demo property (catalog.mjs, ids
    // 1-6) apart from a host-created DB row, even when their ids collide —
    // the `properties` table's SERIAL starts at 1 too, so the first listing
    // a host ever creates gets id=1, same as the Oceanfront Villa demo
    // property. Without this flag the frontend's PROPERTY_DISPLAY merge
    // (host.jsx/index.jsx) matches by id alone and overlays the wrong
    // catalog's location/beds/baths/tag/image onto the new listing's
    // title/price. See ARIA_ROADMAP.md tech debt backlog.
    source: p.source,
    // maxGuests is now set for both the fixed catalog (catalog.mjs PROPERTIES)
    // and host-created DB rows, so it's surfaced unconditionally — the guest
    // count stepper in the booking modal needs the cap for every property,
    // not just imported listings.
    maxGuests: p.maxGuests,
    ...(p.source === 'db' ? {
      location: p.location, beds: p.beds, baths: p.baths,
      tag: p.tag, images: p.images, description: p.description,
    } : {}),
  }));
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
    isHost: await isHost(session),
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
  const prop = await getProperty(propertyId);
  if (!prop) return reply.code(400).send({ error: 'Unknown propertyId' });
  if (!nights || nights < 1 || nights > 90)
    return reply.code(400).send({ error: 'nights must be between 1 and 90' });

  // Server-authoritative charge total — mirrors /booking/create's math.
  // Never trust a client-sent `amount` for a real Stripe charge (Finding #1).
  const jurisdiction  = { rate: prop.taxRate, name: prop.taxName };
  const subtotal      = prop.price * nights;
  const ariaFee       = Math.round(subtotal * 0.05);
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
  const { propertyId, guests } = request.body;
  const result = await createBooking({
    propertyId, checkIn: request.body.checkIn, checkOut: request.body.checkOut, guests, session, logger: fastify.log
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
           payment_escrow_object_id=$2, payment_escrow_status='held', settlement_digest=$3,
           booking_pass_object_id=$4, resale_policy_object_id=$5
         WHERE booking_ref=$6 AND wallet_address=$7`,
        [v.depositEscrowId, v.paymentEscrowId, digest, v.bookingPassId || null, v.resalePolicyId || null, bookingRef, session.suiAddress]
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
  // and create_payment_escrow asserts release_time is in the future. Honors
  // PAYMENT_RELEASE_OFFSET_MS (same as createBooking) so a rebuilt booking gets
  // the same release horizon — relevant for the resale demo window.
  const releaseMs = Date.now() + (
    Number.isFinite(Number(process.env.PAYMENT_RELEASE_OFFSET_MS))
      ? Math.max(60_000, Number(process.env.PAYMENT_RELEASE_OFFSET_MS)) : 300_000);
  // Tax leg now rides with the host (rental+tax combined) — see escrow.mjs —
  // so the only gate for building the combined payment escrow is the fee wallet.
  const useCombined = !!process.env.ARIA_FEE_ADDRESS;
  let built;
  try {
    built = useCombined
      ? await buildBookingPaymentTransaction(bookingRef, session.suiAddress, hostAddr,
          { subtotal: booking.subtotal, ariaFee: booking.aria_fee, taxes: booking.taxes, depositAmount: booking.deposit_amount, releaseMs,
            propertyId: Number(booking.property_id), checkInMs: Date.parse(booking.check_in), checkOutMs: Date.parse(booking.check_out) }, fastify.log)
      : await buildEscrowTransaction(bookingRef, session.suiAddress, hostAddr, booking.deposit_amount, fastify.log);
  } catch (err) {
    fastify.log.error({ err, bookingRef }, '/escrow/rebuild: build failed');
  }
  if (!built?.txBytes)
    return reply.code(503).send({
      error: built?.errorMessage || 'Could not rebuild the escrow transaction. Please try again.',
      code: built?.errorCode || 'build_failed',
    });

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
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });

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
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#ffaa00;font-size:24px;margin:0 0 8px">⚠️ Damage Claim Filed</h1><p style="color:#888;margin:0 0 24px">${escapeHtml(booking.guest_name)}, the host has filed a damage claim against your security deposit.</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin-bottom:20px"><h2 style="margin:0 0 16px;font-size:18px">${escapeHtml(booking.property_title)}</h2><p style="color:#888;font-size:13px;margin:0 0 6px">Claim amount: <span style="color:#ffaa00">$${claimAmount}</span> of your $${booking.deposit_amount} deposit</p>${reason ? `<p style="color:#888;font-size:13px;margin:0">Reason: ${escapeHtml(reason)}</p>` : ''}</div><p style="color:#555;font-size:12px;line-height:1.6">If you disagree with this claim, you can dispute it from your bookings page and ARIA will review and resolve the split.</p><p style="color:#555;font-size:12px;text-align:center;margin:24px 0 0">Powered by ARIA — Built on Sui</p></div>`
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
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#ff4444;font-size:24px;margin:0 0 8px">🚩 Dispute Filed</h1><p style="color:#888;margin:0 0 24px">A guest has disputed a damage claim — review needed.</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px"><p style="color:#888;font-size:13px;margin:0 0 6px">Booking: ${escapeHtml(bookingRef)} — ${escapeHtml(booking.property_title)}</p><p style="color:#888;font-size:13px;margin:0 0 6px">Claim amount: $${booking.claim_amount} of $${booking.deposit_amount}</p>${reason ? `<p style="color:#888;font-size:13px;margin:0">Guest's reason: ${escapeHtml(reason)}</p>` : ''}</div></div>`
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
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#00ff44;font-size:24px;margin:0 0 8px">✅ Dispute Resolved</h1><p style="color:#888;margin:0 0 24px">${escapeHtml(booking.guest_name)}, ARIA has reviewed your dispute.</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px"><p style="color:#888;font-size:13px;margin:0 0 6px">Returned to you: <span style="color:#00ff44">$${guestAmount}</span></p><p style="color:#888;font-size:13px;margin:0">Kept by host: $${hostAmount}</p></div></div>`
      });
    } catch (err) { fastify.log.warn({ err }, 'Resolution email failed'); }

    return { success: true, bookingRef, guestAmount, hostAmount, depositStatus: finalStatus };
  } catch (err) {
    fastify.log.error({ err, bookingRef }, '/booking/resolve-dispute failed');
    return reply.code(500).send({ error: 'Failed to resolve dispute' });
  }
});

// ── Phase 2c: guardrailed resale market ─────────────────────────────────────
// Non-custodial build+confirm pairs, mirroring the claim/dispute flow. Every
// guardrail is enforced ON-CHAIN (escrow.move's list_for_resale / buy_resale);
// these routes re-check the same conditions off-chain for clean UX errors, gate
// Rail 4 (buyer Seal identity) before building the buy PTB, and — crucially —
// never write Postgres until the signed tx is verified on-chain. The whole
// feature is dormant unless RESALE_ENABLED=true (same playbook as 2a's flag).
// No-transfer window for the off-chain pre-check. The authoritative window is
// baked per-policy on-chain (create_resale_policy); this mirrors the same env
// createBooking uses so the pre-check matches a testnet-shortened window. Default 48h.
const RESALE_WINDOW_MS = Number.isFinite(Number(process.env.RESALE_WINDOW_MS))
  ? Math.max(0, Number(process.env.RESALE_WINDOW_MS)) : 172_800_000;
const MAX_RESALE_HOPS   = 1;           // one hop — must match MAX_RESALE_HOPS
const ARIA_RESALE_BPS   = 1000;        // 10% of upcharge — must match ARIA_RESALE_BPS
const HOST_RESALE_BPS   = 4500;        // 45% of upcharge — must match HOST_RESALE_BPS
const BPS_DENOM         = 10000;

function resaleEnabled(reply) {
  if (process.env.RESALE_ENABLED === 'true') return true;
  reply.code(403).send({ error: 'Resale is not enabled' });
  return false;
}

// Face value (dollars) = full booking charge: stay total + deposit. Mirrors the
// on-chain face = deposit_escrow.amount + payment_total (both ×1000 units).
function bookingFaceDollars(b) {
  return (b.total_amount || 0) + (b.deposit_amount || 0);
}

// Shared guard: a booking that is currently resaleable by this seller. Returns
// { booking } or { error, status }.
async function loadResaleableBooking(bookingRef, session) {
  if (!bookingRef || typeof bookingRef !== 'string' || !bookingRef.startsWith('ARIA-'))
    return { error: 'A valid bookingRef is required', status: 400 };
  let booking;
  try {
    const r = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
    booking = r.rows[0];
  } catch (err) {
    fastify.log.error({ err, bookingRef }, 'resale: booking lookup failed');
    return { error: 'Booking lookup failed', status: 500 };
  }
  if (!booking) return { error: 'Booking not found', status: 404 };
  if (booking.wallet_address !== session.suiAddress)
    return { error: 'This booking does not belong to your account', status: 403 };
  return { booking };
}

// GET /resale/listings — open resale market (buyer browse). Lists bookings with
// resale_listed=true, with the face/ask/premium and a seller reputation signal
// (Rail 5: how many resales this wallet has previously sold — a flip count).
fastify.get('/resale/listings', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!resaleEnabled(reply)) return;
  try {
    const r = await pool.query(
      `SELECT b.*, COALESCE(s.flips, 0) AS seller_flips
         FROM bookings b
         LEFT JOIN (SELECT seller_address, COUNT(*) AS flips FROM resales GROUP BY seller_address) s
           ON s.seller_address = b.wallet_address
        WHERE b.resale_listed = true
        ORDER BY b.check_in ASC
        LIMIT 200`
    );
    const propIds = [...new Set(r.rows.map(b => Number(b.property_id)))];
    const propEntries = await Promise.all(propIds.map(id => getProperty(id, fastify.log)));
    const propById = new Map(propIds.map((id, i) => [id, propEntries[i]]));
    const listings = r.rows.map(b => {
      const face = bookingFaceDollars(b);
      const ask = b.resale_ask_price || face;
      const jur = propById.get(Number(b.property_id)) || { taxName: 'Occupancy Tax' };
      return {
        bookingRef: b.booking_ref, property: b.property_title, propertyId: b.property_id,
        checkIn: b.check_in, checkOut: b.check_out, nights: b.nights,
        faceValue: face, askPrice: ask, upcharge: Math.max(0, ask - face),
        sellerFlips: Number(b.seller_flips) || 0,
        isOwnListing: b.wallet_address === session.suiAddress,
        taxName: jur.name,
      };
    });
    return { listings };
  } catch (err) {
    fastify.log.error({ err }, '/resale/listings query failed');
    return { listings: [] };
  }
});

// POST /pass/:bookingRef/list-resale — SELLER lists (build). Returns the unsigned
// list_for_resale PTB; nothing is written until /list-resale/confirm.
fastify.post('/pass/:bookingRef/list-resale', {
  config: { rateLimit: { max: 10, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many listing attempts.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!resaleEnabled(reply)) return;
  if (validateBody(resaleListSchema, request, reply)) return;

  const { bookingRef } = request.params;
  const askPrice = Number(request.body.askPrice);
  if (!Number.isFinite(askPrice) || askPrice <= 0)
    return reply.code(400).send({ error: 'askPrice must be a positive number' });

  const { booking, error, status } = await loadResaleableBooking(bookingRef, session);
  if (error) return reply.code(status).send({ error });

  // On-chain prerequisites (the contract re-asserts all of these).
  if (!booking.resale_policy_object_id)
    return reply.code(400).send({ error: 'This booking is not resaleable — the host did not enable transfer when it was booked' });
  if (!booking.escrow_object_id || !booking.payment_escrow_object_id || !booking.booking_pass_object_id)
    return reply.code(400).send({ error: 'This booking has no live escrow/pass to resell yet' });
  if (booking.deposit_status !== 'held' || booking.payment_escrow_status !== 'held')
    return reply.code(400).send({ error: 'Both escrows must be active to list for resale' });
  if (booking.resale_listed)
    return reply.code(409).send({ error: 'This booking is already listed for resale' });

  // Self-heal: list_for_resale burns the BookingPass and flips the on-chain
  // ResalePolicy in the SAME tx that the seller signs — before the backend
  // ever sees /list-resale/confirm. If a prior attempt signed+submitted
  // successfully but confirm never completed (a transient verify error, a
  // dropped response, the tab closing), Postgres never learned about it and
  // booking_pass_object_id still points at an object that's now gone.
  // Rebuilding a fresh PTB against it would fail forever with "Object not
  // found" — so check the policy's live on-chain state FIRST and reconcile
  // directly if it shows this seller already listed it, instead of looping
  // on a dead rebuild.
  const policyState = await readResalePolicyObject(booking.resale_policy_object_id, { logger: fastify.log });
  if (policyState?.fields?.listed) {
    if (normalizeAddr(policyState.fields.seller) !== normalizeAddr(session.suiAddress)) {
      return reply.code(409).send({ error: 'This booking pass was already listed on-chain by a different signer' });
    }
    const onChainAsk = Number(policyState.fields.ask_price) / 1000;
    try {
      await pool.query(
        `UPDATE bookings SET resale_listed=true, resale_ask_price=$1 WHERE booking_ref=$2 AND wallet_address=$3`,
        [Math.round(onChainAsk) || bookingFaceDollars(booking), bookingRef, session.suiAddress]
      );
    } catch (err) {
      fastify.log.error({ err, bookingRef }, 'list-resale: self-heal persist failed');
      return reply.code(500).send({ error: 'This listing already succeeded on-chain but saving it failed — contact support' });
    }
    fastify.log.info({ bookingRef }, 'list-resale: self-healed from a prior unconfirmed listing');
    return { success: true, alreadyListed: true, askPrice: onChainAsk, faceValue: bookingFaceDollars(booking) };
  }

  if ((booking.resale_count || 0) >= MAX_RESALE_HOPS)
    return reply.code(400).send({ error: 'This booking has already been resold (one resale per booking)' });

  const releaseMs = Number(booking.payment_release_ms);
  if (releaseMs && Date.now() + RESALE_WINDOW_MS >= releaseMs)
    return reply.code(400).send({ error: 'Resale closes 48 hours before check-in' });

  // Rail 2 price cap (face .. face*(1+cap)). The cap baked on-chain governs; this
  // mirrors the host's current setting for a clean pre-check.
  const face = bookingFaceDollars(booking);
  if (askPrice < face)
    return reply.code(400).send({ error: `Ask price cannot be below face value ($${face})` });
  const { maxPremiumBps } = await getResaleSettings(booking.property_id, fastify.log);
  if ((askPrice - face) * BPS_DENOM > face * maxPremiumBps) {
    const maxAsk = face + Math.floor(face * maxPremiumBps / BPS_DENOM);
    return reply.code(400).send({ error: `Ask price exceeds the host's resale cap (max $${maxAsk})` });
  }

  let built;
  try {
    built = await buildListForResaleTransaction(session.suiAddress, {
      depositEscrowId: booking.escrow_object_id,
      paymentEscrowId: booking.payment_escrow_object_id,
      policyId: booking.resale_policy_object_id,
      passId: booking.booking_pass_object_id,
      askPriceUnits: dollarsToUnits(askPrice).toString(),
    }, fastify.log);
  } catch (err) {
    fastify.log.error({ err, bookingRef }, '/list-resale build failed');
  }
  if (!built?.txBytes)
    return reply.code(502).send({ error: 'Could not build the listing transaction' });

  return { success: true, listTxBytes: built.txBytes, askPrice, faceValue: face,
    message: 'Sign this transaction in your wallet, then report the digest to /pass/:bookingRef/list-resale/confirm' };
});

// POST /pass/:bookingRef/list-resale/confirm — verify on-chain, then flip
// resale_listed=true + record the ask. The pass was burned in the signed tx.
fastify.post('/pass/:bookingRef/list-resale/confirm', {
  config: { rateLimit: { max: 10, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many confirmation attempts.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!resaleEnabled(reply)) return;
  if (validateBody(resaleTransferConfirmSchema, request, reply)) return;

  const { bookingRef } = request.params;
  const { digest } = request.body;
  if (!isValidTransactionDigest(digest)) return reply.code(400).send({ error: 'A valid transaction digest is required' });

  const { booking, error, status } = await loadResaleableBooking(bookingRef, session);
  if (error) return reply.code(status).send({ error });
  if (booking.resale_listed) return reply.code(200).send({ success: true, alreadyListed: true });

  const askPrice = Number(request.body.askPrice ?? booking.resale_ask_price);
  let v;
  try {
    v = await verifyListResaleTransaction(digest, session.suiAddress, booking.resale_policy_object_id, fastify.log);
  } catch (err) {
    fastify.log.error({ err, digest, bookingRef }, 'list-resale verification failed');
    return reply.code(503).send({ error: 'Could not verify the listing on-chain — it may still be processing.', retryable: true });
  }
  if (!v.ok) {
    fastify.log.warn({ bookingRef, digest, reason: v.reason, retryable: !!v.retryable }, 'List-resale verification rejected');
    return reply.code(v.retryable ? 503 : 400).send({ error: v.reason || 'Listing could not be verified on-chain', retryable: !!v.retryable });
  }

  try {
    await pool.query(
      `UPDATE bookings SET resale_listed=true, resale_ask_price=$1 WHERE booking_ref=$2 AND wallet_address=$3`,
      [Number.isFinite(askPrice) && askPrice > 0 ? Math.round(askPrice) : bookingFaceDollars(booking), bookingRef, session.suiAddress]
    );
  } catch (err) {
    fastify.log.error({ err, bookingRef }, 'list-resale: persist failed');
    return reply.code(500).send({ error: 'Verified on-chain but failed to save — contact support' });
  }
  fastify.log.info({ bookingRef, digest }, 'Resale listing verified on-chain and recorded');
  return { success: true, bookingRef };
});

// POST /pass/:bookingRef/cancel-resale — SELLER unlists (build). Remints the pass.
fastify.post('/pass/:bookingRef/cancel-resale', {
  config: { rateLimit: { max: 10, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many attempts.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!resaleEnabled(reply)) return;

  const { bookingRef } = request.params;
  const { booking, error, status } = await loadResaleableBooking(bookingRef, session);
  if (error) return reply.code(status).send({ error });
  if (!booking.resale_listed) return reply.code(400).send({ error: 'This booking is not currently listed' });
  if (!booking.resale_policy_object_id) return reply.code(400).send({ error: 'No resale policy for this booking' });

  // Self-heal (same reasoning as /list-resale above): if a prior cancel
  // already landed on-chain but confirm never persisted it, the policy
  // already shows listed=false even though Postgres still thinks it's live.
  const cancelPolicyState = await readResalePolicyObject(booking.resale_policy_object_id, { logger: fastify.log });
  if (cancelPolicyState?.fields && cancelPolicyState.fields.listed === false) {
    try {
      await pool.query(
        `UPDATE bookings SET resale_listed=false, resale_ask_price=NULL WHERE booking_ref=$1 AND wallet_address=$2`,
        [bookingRef, session.suiAddress]
      );
    } catch (err) {
      fastify.log.error({ err, bookingRef }, 'cancel-resale: self-heal persist failed');
      return reply.code(500).send({ error: 'This cancellation already succeeded on-chain but saving it failed — contact support' });
    }
    fastify.log.info({ bookingRef }, 'cancel-resale: self-healed from a prior unconfirmed cancel');
    return { success: true, alreadyUnlisted: true };
  }

  let built;
  try {
    built = await buildCancelResaleListingTransaction(session.suiAddress, booking.resale_policy_object_id, fastify.log);
  } catch (err) {
    fastify.log.error({ err, bookingRef }, '/cancel-resale build failed');
  }
  if (!built?.txBytes) return reply.code(502).send({ error: 'Could not build the cancel transaction' });
  return { success: true, cancelTxBytes: built.txBytes,
    message: 'Sign this transaction in your wallet, then report the digest to /pass/:bookingRef/cancel-resale/confirm' };
});

// POST /pass/:bookingRef/cancel-resale/confirm — verify on-chain, clear listing.
fastify.post('/pass/:bookingRef/cancel-resale/confirm', {
  config: { rateLimit: { max: 10, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many confirmation attempts.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!resaleEnabled(reply)) return;
  if (validateBody(resaleTransferConfirmSchema, request, reply)) return;

  const { bookingRef } = request.params;
  const { digest } = request.body;
  if (!isValidTransactionDigest(digest)) return reply.code(400).send({ error: 'A valid transaction digest is required' });

  const { booking, error, status } = await loadResaleableBooking(bookingRef, session);
  if (error) return reply.code(status).send({ error });
  if (!booking.resale_listed) return reply.code(200).send({ success: true, alreadyUnlisted: true });

  let v;
  try {
    v = await verifyCancelResaleTransaction(digest, session.suiAddress, booking.resale_policy_object_id, fastify.log);
  } catch (err) {
    fastify.log.error({ err, digest, bookingRef }, 'cancel-resale verification failed');
    return reply.code(503).send({ error: 'Could not verify the cancel on-chain — it may still be processing.', retryable: true });
  }
  if (!v.ok) {
    fastify.log.warn({ bookingRef, digest, reason: v.reason, retryable: !!v.retryable }, 'Cancel-resale verification rejected');
    return reply.code(v.retryable ? 503 : 400).send({ error: v.reason || 'Cancel could not be verified on-chain', retryable: !!v.retryable });
  }

  try {
    await pool.query(
      `UPDATE bookings SET resale_listed=false, resale_ask_price=NULL WHERE booking_ref=$1 AND wallet_address=$2`,
      [bookingRef, session.suiAddress]
    );
  } catch (err) {
    fastify.log.error({ err, bookingRef }, 'cancel-resale: persist failed');
    return reply.code(500).send({ error: 'Verified on-chain but failed to save — contact support' });
  }
  return { success: true, bookingRef };
});

// POST /pass/:bookingRef/transfer/build — BUYER buys a listed booking (build).
// Rail 4 gate: the buyer MUST have completed identity verification first, so the
// host can see who's actually staying after the swap.
fastify.post('/pass/:bookingRef/transfer/build', {
  config: { rateLimit: { max: 10, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many purchase attempts.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!resaleEnabled(reply)) return;

  const { bookingRef } = request.params;
  if (!bookingRef || !bookingRef.startsWith('ARIA-')) return reply.code(400).send({ error: 'A valid bookingRef is required' });

  let booking;
  try {
    const r = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
    booking = r.rows[0];
  } catch (err) {
    fastify.log.error({ err, bookingRef }, 'transfer/build lookup failed');
    return reply.code(500).send({ error: 'Booking lookup failed' });
  }
  if (!booking) return reply.code(404).send({ error: 'Listing not found' });
  if (!booking.resale_listed) return reply.code(409).send({ error: 'This booking is no longer listed for resale' });
  if (booking.wallet_address === session.suiAddress) return reply.code(400).send({ error: 'You cannot buy your own listing' });
  if ((booking.resale_count || 0) >= MAX_RESALE_HOPS) return reply.code(400).send({ error: 'This booking has already been resold' });

  const releaseMs = Number(booking.payment_release_ms);
  if (releaseMs && Date.now() + RESALE_WINDOW_MS >= releaseMs)
    return reply.code(400).send({ error: 'Resale closes 48 hours before check-in' });

  // Rail 4 — mandatory buyer Seal identity. Without a guest_verifications row the
  // host could never see who is actually staying after the swap.
  try {
    const gv = await pool.query('SELECT 1 FROM guest_verifications WHERE sui_address = $1', [session.suiAddress]);
    if (!gv.rows.length)
      return reply.code(400).send({ error: 'Complete identity verification before buying a resale', needsVerification: true });
  } catch (err) {
    fastify.log.error({ err }, 'transfer/build: buyer verification check failed');
    return reply.code(503).send({ error: 'Could not verify your identity status. Please try again.' });
  }

  const askPrice = Number(booking.resale_ask_price) || bookingFaceDollars(booking);
  let built;
  try {
    built = await buildBuyResaleTransaction(session.suiAddress, {
      depositEscrowId: booking.escrow_object_id,
      paymentEscrowId: booking.payment_escrow_object_id,
      policyId: booking.resale_policy_object_id,
      askPriceUnits: dollarsToUnits(askPrice).toString(),
    }, fastify.log);
  } catch (err) {
    fastify.log.error({ err, bookingRef }, 'transfer/build failed');
  }
  if (!built?.txBytes) return reply.code(502).send({ error: 'Could not build the purchase transaction' });

  const face = bookingFaceDollars(booking);
  return { success: true, buyTxBytes: built.txBytes, askPrice, faceValue: face, upcharge: Math.max(0, askPrice - face),
    message: 'Sign this transaction in your wallet, then report the digest to /pass/:bookingRef/transfer/confirm' };
});

// POST /pass/:bookingRef/transfer/confirm — verify the buy on-chain, then:
// record the resale (with the ARIA/host/seller split), bump resale_count, swap
// the booking to the buyer (Seal identity follows — Rail 4), repoint the pass,
// and store the immutable resale receipt on Walrus.
fastify.post('/pass/:bookingRef/transfer/confirm', {
  config: { rateLimit: { max: 10, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many confirmation attempts.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!resaleEnabled(reply)) return;
  if (validateBody(resaleTransferConfirmSchema, request, reply)) return;

  const { bookingRef } = request.params;
  const { digest } = request.body;
  if (!isValidTransactionDigest(digest)) return reply.code(400).send({ error: 'A valid transaction digest is required' });

  let booking;
  try {
    const r = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
    booking = r.rows[0];
  } catch (err) {
    fastify.log.error({ err, bookingRef }, 'transfer/confirm lookup failed');
    return reply.code(500).send({ error: 'Booking lookup failed' });
  }
  if (!booking) return reply.code(404).send({ error: 'Listing not found' });
  // Idempotency: if the buyer already owns it and it's no longer listed, the
  // swap already landed (e.g. a retried confirm).
  if (!booking.resale_listed && booking.wallet_address === session.suiAddress)
    return reply.code(200).send({ success: true, alreadyTransferred: true });
  if (booking.wallet_address === session.suiAddress)
    return reply.code(400).send({ error: 'You cannot buy your own listing' });

  let v;
  try {
    v = await verifyBuyResaleTransaction(digest, session.suiAddress, booking.escrow_object_id, booking.payment_escrow_object_id);
  } catch (err) {
    fastify.log.error({ err, digest, bookingRef }, 'transfer/confirm verification failed');
    return reply.code(502).send({ error: 'Could not verify the purchase on-chain — it may still be processing.' });
  }
  if (!v.ok) return reply.code(400).send({ error: v.reason || 'Purchase could not be verified on-chain' });

  // Split (records only — on-chain payout is authoritative). face/sale in dollars.
  const seller = booking.wallet_address;
  const face = bookingFaceDollars(booking);
  const sale = Number(booking.resale_ask_price) || face;
  const upcharge = Math.max(0, sale - face);
  const ariaCut = Math.floor(upcharge * ARIA_RESALE_BPS / BPS_DENOM);
  const hostCut = Math.floor(upcharge * HOST_RESALE_BPS / BPS_DENOM);
  const sellerCut = sale - ariaCut - hostCut;

  // Replay guard: one resales row per on-chain tx (UNIQUE partial index on tx_digest).
  try {
    await pool.query(
      `INSERT INTO resales (booking_ref, seller_address, buyer_address, face_amount, sale_price, aria_cut, host_cut, seller_cut, tx_digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [bookingRef, seller, session.suiAddress, face, sale, ariaCut, hostCut, sellerCut, digest]
    );
  } catch (err) {
    if (err?.code === '23505') return reply.code(409).send({ error: 'This transaction has already been used to confirm a resale.' });
    fastify.log.error({ err, bookingRef }, 'transfer/confirm: resales insert failed');
    return reply.code(500).send({ error: 'Verified on-chain but failed to record — contact support' });
  }

  // Swap the booking to the buyer: wallet_address + guest contact follow the new
  // holder, so host PII access (Seal: seal_approve gates on escrow.guest, now the
  // buyer) resolves the buyer's identity. original_wallet_address preserves
  // provenance. Repoint the pass to the freshly minted one.
  try {
    await pool.query(
      `UPDATE bookings SET wallet_address=$1, guest_name=$2, guest_email=$3,
         resale_listed=false, resale_ask_price=NULL,
         resale_count = COALESCE(resale_count,0) + 1,
         booking_pass_object_id = COALESCE($4, booking_pass_object_id)
       WHERE booking_ref=$5`,
      [session.suiAddress, session.name, session.email, v.newPassId || null, bookingRef]
    );
  } catch (err) {
    fastify.log.error({ err, bookingRef }, 'transfer/confirm: booking swap update failed');
    return reply.code(500).send({ error: 'Resale recorded but booking reassignment failed — contact support' });
  }

  // Immutable resale receipt on Walrus (non-blocking).
  const resaleWalrusBlobId = await pushToWalrus(
    { ...booking, walrusReceiptType: 'resale', resaleSeller: seller, resaleBuyer: session.suiAddress,
      resaleFaceValue: face, resaleSalePrice: sale, resaleAriaCut: ariaCut, resaleHostCut: hostCut,
      resaleSellerCut: sellerCut, resaleTimestamp: new Date().toISOString() }, fastify.log
  );
  if (resaleWalrusBlobId) {
    try { await pool.query('UPDATE bookings SET resale_walrus_blob_id=$1 WHERE booking_ref=$2', [resaleWalrusBlobId, bookingRef]); }
    catch (err) { fastify.log.warn({ err, bookingRef }, 'transfer/confirm: walrus blob id update failed'); }
  }

  fastify.log.info({ bookingRef, seller, buyer: session.suiAddress, sale, ariaCut, hostCut, sellerCut, digest }, 'Resale verified on-chain and recorded');
  return { success: true, bookingRef, faceValue: face, salePrice: sale, ariaCut, hostCut, sellerCut, resaleWalrusBlobId };
});

// ── Plain wallet send (P3) ───────────────────────────────────────────────────
// Lets a user move SUI out of their ARIA zkLogin wallet to ANY address — their
// own Sui Wallet, an exchange, another testnet address — without installing an
// external wallet extension. Same non-custodial build -> sign -> submit ->
// confirm path as escrow/resale above: the backend only assembles the PTB;
// the user's own browser session (via zkLogin) signs and submits it directly
// to a public Sui fullnode. ARIA's backend never holds a key that can move it.
fastify.post('/wallet/send/build', {
  config: { rateLimit: { max: 20, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many send attempts.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (validateBody(walletSendBuildSchema, request, reply)) return;

  const { toAddress } = request.body;
  if (!isValidSuiAddress(toAddress)) return reply.code(400).send({ error: 'Enter a valid Sui address (0x followed by 64 hex characters).' });
  if (normalizeAddr(toAddress) === normalizeAddr(session.suiAddress))
    return reply.code(400).send({ error: 'You cannot send to your own wallet address.' });

  let amountMist;
  try {
    amountMist = parseToMist(String(request.body.amount));
  } catch {
    return reply.code(400).send({ error: 'Enter a valid SUI amount.' });
  }
  if (amountMist <= 0n) return reply.code(400).send({ error: 'Amount must be greater than 0.' });

  const built = await buildSendTransaction(session.suiAddress, { toAddress, amountMist }, fastify.log);
  if (!built?.txBytes) {
    return reply.code(502).send({
      error: built?.errorMessage || 'Could not build the send transaction.',
      errorCode: built?.errorCode || 'build_failed',
    });
  }
  return { success: true, sendTxBytes: built.txBytes,
    message: 'Sign this transaction in your wallet, then report the digest to /wallet/send/confirm' };
});

// POST /wallet/send/confirm — independently verify the transfer on-chain
// (never trust the client's reported digest at face value — same posture as
// every other confirm route above), then record it in wallet_sends purely as
// an audit trail. Unlike resales/bookings, nothing else in the app reads this
// row back to drive state, so a failed insert doesn't block the user's
// success: the transfer already landed on-chain regardless.
fastify.post('/wallet/send/confirm', {
  config: { rateLimit: { max: 20, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many confirmation attempts.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (validateBody(walletSendConfirmSchema, request, reply)) return;

  const { digest, toAddress } = request.body;
  if (!isValidTransactionDigest(digest)) return reply.code(400).send({ error: 'A valid transaction digest is required' });
  if (!isValidSuiAddress(toAddress)) return reply.code(400).send({ error: 'Enter a valid Sui address.' });

  let amountMist;
  try {
    amountMist = parseToMist(String(request.body.amount));
  } catch {
    return reply.code(400).send({ error: 'Enter a valid SUI amount.' });
  }

  let v;
  try {
    v = await verifySendTransaction(digest, session.suiAddress, toAddress, amountMist, fastify.log);
  } catch (err) {
    fastify.log.error({ err, digest }, 'wallet/send/confirm verification failed');
    return reply.code(503).send({ error: 'Could not verify the send on-chain — it may still be processing.', retryable: true });
  }
  if (!v.ok) {
    return reply.code(v.retryable ? 503 : 400).send({ error: v.reason || 'Send could not be verified on-chain', retryable: !!v.retryable });
  }

  try {
    await pool.query(
      `INSERT INTO wallet_sends (from_address, to_address, amount_mist, tx_digest) VALUES ($1,$2,$3,$4)`,
      [session.suiAddress, toAddress, amountMist.toString(), digest]
    );
  } catch (err) {
    if (err?.code === '23505') return { success: true, digest, alreadyRecorded: true };
    fastify.log.error({ err, digest }, 'wallet/send/confirm: audit insert failed');
  }
  fastify.log.info({ from: session.suiAddress, to: toAddress, amountMist: amountMist.toString(), digest }, 'Wallet send verified on-chain');
  return { success: true, digest };
});

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

  // Verify this host owns the property.
  const pr = await pool.query('SELECT host_address FROM properties WHERE id = $1', [propertyId]);
  if (!pr.rows[0]) return reply.code(404).send({ error: 'Property not found' });
  if (normalizeAddr(pr.rows[0].host_address) !== normalizeAddr(session.suiAddress))
    return reply.code(403).send({ error: 'You do not own this property' });

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
      `UPDATE properties SET check_in_type=$1, access_instructions_encrypted=$2 WHERE id=$3`,
      [checkInType, encrypted, propertyId]
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
  const pr = await pool.query('SELECT host_address, check_in_type, access_instructions_encrypted FROM properties WHERE id=$1', [propertyId]);
  if (!pr.rows[0]) return reply.code(404).send({ error: 'Property not found' });
  if (normalizeAddr(pr.rows[0].host_address) !== normalizeAddr(session.suiAddress))
    return reply.code(403).send({ error: 'You do not own this property' });

  const row = pr.rows[0];
  let instructions = '';
  if (row.access_instructions_encrypted) {
    try { instructions = decryptInstructions(row.access_instructions_encrypted); }
    catch (err) { fastify.log.error({ err, propertyId }, 'access-instructions: decryption failed'); }
  }
  return { checkInType: row.check_in_type || 'front_desk', instructions };
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
    `SELECT b.*, p.check_in_type, p.access_instructions_encrypted
     FROM bookings b
     LEFT JOIN properties p ON p.id = b.property_id
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

// ── Host resale settings (Rail 1 opt-in + Rail 2 cap) ───────────────────────
// GET returns the host's per-listing settings; POST upserts them. Stored in
// property_resale_settings keyed by catalog property_id (the demo listings have
// no `properties` row). Read at booking time by getResaleSettings.
fastify.get('/host/resale-settings', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  try {
    const r = await pool.query('SELECT property_id, transfer_allowed, max_resale_premium_bps FROM property_resale_settings');
    const settings = {};
    for (const row of r.rows) settings[row.property_id] = { transferAllowed: row.transfer_allowed === true, maxPremiumBps: Number(row.max_resale_premium_bps) || 0 };
    return { settings, resaleEnabled: process.env.RESALE_ENABLED === 'true' };
  } catch (err) {
    fastify.log.error({ err }, '/host/resale-settings query failed');
    return reply.code(500).send({ error: 'Could not load resale settings' });
  }
});

fastify.post('/host/property/:propertyId/resale-settings', {
  config: { rateLimit: { max: 30, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many settings updates.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  if (validateBody(resaleSettingsSchema, request, reply)) return;

  const propertyId = Number(request.params.propertyId);
  if (!Number.isInteger(propertyId) || !(await getProperty(propertyId)))
    return reply.code(400).send({ error: 'Unknown propertyId' });
  // Property-scoped: a non-superadmin host may only set their own listings.
  if (!(await canManageProperty(session, propertyId)) && !HOST_ADDRESSES.includes((session.email || '').toLowerCase()))
    return reply.code(403).send({ error: 'You do not manage this property' });

  const transferAllowed = request.body.transferAllowed === true;
  let maxPremiumBps = Math.round(Number(request.body.maxPremiumBps ?? 0));
  if (!Number.isFinite(maxPremiumBps) || maxPremiumBps < 0) maxPremiumBps = 0;
  if (maxPremiumBps > BPS_DENOM) maxPremiumBps = BPS_DENOM; // cap at 100%

  try {
    await pool.query(
      `INSERT INTO property_resale_settings (property_id, host_address, transfer_allowed, max_resale_premium_bps, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (property_id) DO UPDATE
         SET host_address=EXCLUDED.host_address, transfer_allowed=EXCLUDED.transfer_allowed,
             max_resale_premium_bps=EXCLUDED.max_resale_premium_bps, updated_at=NOW()`,
      [propertyId, session.suiAddress, transferAllowed, maxPremiumBps]
    );
  } catch (err) {
    fastify.log.error({ err, propertyId }, '/host/property/resale-settings upsert failed');
    return reply.code(500).send({ error: 'Could not save resale settings' });
  }
  return { success: true, propertyId, transferAllowed, maxPremiumBps };
});

// Walrus push helper now lives in walrus.mjs (R3) and is imported above.

// ── Phase 3a: host-created listings ───────────────────────────────────────────
// Three routes, in the order a host actually uses them:
//   1. POST /host/listings/extract       — paste one listing's text -> AI draft (no DB write)
//   2. POST /host/listings/bulk-extract  — paste many at once -> array of drafts (no DB write)
//   3. POST /host/properties             — host reviews/edits a draft (or types one from
//                                           scratch) and this is what actually persists it.
// Extraction never touches the DB; only #3 does, and #3 doesn't care whether
// its input came from extraction or a blank form — same validation either way.
// This keeps "AI-paste" a thin convenience layer over manual entry rather than
// a separate trust path.

fastify.post('/host/listings/extract', {
  config: { rateLimit: { max: 30, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many import attempts. Try again later.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  if (validateBody(listingExtractSchema, request, reply)) return;

  const { text, url } = request.body;
  const draft = await extractListingFields(text, url, fastify.log);
  if (draft.error) return reply.code(422).send({ error: draft.error });
  return { draft };
});

fastify.post('/host/listings/bulk-extract', {
  config: { rateLimit: { max: 5, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many bulk import attempts. Try again later.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  if (validateBody(listingBulkExtractSchema, request, reply)) return;

  const { listings } = request.body;
  // Sequential, not Promise.all — a host's "dozens or hundreds" of pasted
  // listings should not fan out into dozens of simultaneous Grok calls from
  // one request; this trades a bit of latency for not hammering the xAI rate
  // limit (and for clearer per-item error attribution if one block is junk).
  const results = [];
  for (const { text, url } of listings) {
    const draft = await extractListingFields(text, url, fastify.log);
    results.push(draft.error ? { error: draft.error } : { draft });
  }
  return { results, succeeded: results.filter(r => !r.error).length, failed: results.filter(r => r.error).length };
});

fastify.post('/host/listings/photo', {
  config: { rateLimit: { max: 100, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many photo uploads. Try again later.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  if (validateBody(listingPhotoSchema, request, reply)) return;

  const match = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(request.body.dataUrl);
  if (!match) return reply.code(400).send({ error: 'dataUrl must be a base64-encoded PNG, JPEG, WEBP, or GIF image' });

  let buffer;
  try { buffer = Buffer.from(match[2], 'base64'); }
  catch { return reply.code(400).send({ error: 'Could not decode image data' }); }
  if (buffer.length > 6 * 1024 * 1024) return reply.code(400).send({ error: 'Image is too large (max 6MB)' });

  const url = await pushImageToWalrus(buffer, fastify.log);
  if (!url) return reply.code(502).send({ error: 'Could not upload image — try again' });
  return { url };
});

fastify.post('/host/properties', {
  config: { rateLimit: { max: 50, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many listings created. Try again later.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  if (validateBody(propertyCreateSchema, request, reply)) return;

  const {
    title, description, location, price, beds, baths, maxGuests, tag, images,
    taxRate, taxJurisdiction, taxBreakdown, sourceUrl, importSource
  } = request.body;

  // Never trust a host-declared number as-is, even though this is a draft the
  // host themselves typed/edited — same principle as catalog.mjs's fixed
  // prices: server clamps, server is authoritative, always. taxRate is capped
  // to [0, 0.20] per db.mjs's Phase 3a comment so a typo (or a bad-faith host)
  // can't inflate every future booking's tax line for this listing.
  const cleanPrice = Math.max(0, Math.round(Number(price) || 0));
  const cleanBeds = Math.min(50, Math.max(1, Math.round(Number(beds) || 1)));
  const cleanBaths = Math.min(50, Math.max(1, Math.round(Number(baths) || 1)));
  const cleanMaxGuests = Math.min(100, Math.max(1, Math.round(Number(maxGuests) || cleanBeds * 2)));
  let cleanTaxRate = Number(taxRate);
  if (!Number.isFinite(cleanTaxRate)) cleanTaxRate = 0.08;
  cleanTaxRate = Math.min(0.20, Math.max(0, cleanTaxRate));
  const cleanImages = Array.isArray(images) ? images.slice(0, 20).filter(isSafeImageUrl) : [];

  if (cleanPrice <= 0) return reply.code(400).send({ error: 'price must be greater than 0' });

  try {
    const r = await pool.query(
      `INSERT INTO properties
         (host_address, title, description, location, price, beds, baths, tag, images,
          tax_rate, tax_jurisdiction, tax_breakdown, max_guests, source_url, import_source, host_email, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true)
       RETURNING *`,
      [
        session.suiAddress, title.trim(), (description || '').trim(), location.trim(), cleanPrice,
        cleanBeds, cleanBaths, (tag || 'New Listing').trim(), cleanImages,
        cleanTaxRate, (taxJurisdiction || 'Unknown').trim(), (taxBreakdown || `${(cleanTaxRate * 100).toFixed(2)}% occupancy tax (host-declared)`).trim(),
        cleanMaxGuests, (sourceUrl || null), (importSource || 'manual'), (session.email || null)
      ]
    );
    const row = r.rows[0];
    fastify.log.info({ propertyId: row.id, host: session.suiAddress, importSource: row.import_source }, 'New host listing created');
    return reply.code(201).send({
      success: true,
      property: {
        id: row.id, title: row.title, description: row.description, location: row.location,
        price: row.price, beds: row.beds, baths: row.baths, maxGuests: row.max_guests,
        tag: row.tag, images: row.images || [], taxRate: Number(row.tax_rate), taxName: row.tax_jurisdiction,
        sourceUrl: row.source_url, importSource: row.import_source
      }
    });
  } catch (err) {
    fastify.log.error({ err }, '/host/properties insert failed');
    return reply.code(500).send({ error: 'Could not create listing' });
  }
});

// PATCH /host/properties/:id — edit a host-created listing. Same schema and
// clamping as create (propertyCreateSchema), since a bad-faith edit is just
// as dangerous as a bad-faith create. Scoped to rows in the `properties`
// table only — there is no DB row to edit for the 6 fixed catalog
// properties (catalog.mjs, ids 1-6, code-only), so an id that doesn't match
// an active row owned by this host 404s rather than silently no-opping.
fastify.patch('/host/properties/:id', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  if (validateBody(propertyCreateSchema, request, reply)) return;

  const propertyId = Number(request.params.id);
  if (!Number.isInteger(propertyId)) return reply.code(400).send({ error: 'Invalid property id' });

  const {
    title, description, location, price, beds, baths, maxGuests, tag, images,
    taxRate, taxJurisdiction, taxBreakdown, sourceUrl
  } = request.body;

  const cleanPrice = Math.max(0, Math.round(Number(price) || 0));
  const cleanBeds = Math.min(50, Math.max(1, Math.round(Number(beds) || 1)));
  const cleanBaths = Math.min(50, Math.max(1, Math.round(Number(baths) || 1)));
  const cleanMaxGuests = Math.min(100, Math.max(1, Math.round(Number(maxGuests) || cleanBeds * 2)));
  let cleanTaxRate = Number(taxRate);
  if (!Number.isFinite(cleanTaxRate)) cleanTaxRate = 0.08;
  cleanTaxRate = Math.min(0.20, Math.max(0, cleanTaxRate));
  const cleanImages = Array.isArray(images) ? images.slice(0, 20).filter(isSafeImageUrl) : [];

  if (cleanPrice <= 0) return reply.code(400).send({ error: 'price must be greater than 0' });

  try {
    const existing = await pool.query('SELECT host_address FROM properties WHERE id = $1 AND active = true', [propertyId]);
    if (!existing.rows.length) return reply.code(404).send({ error: 'Listing not found' });
    if (normalizeAddr(existing.rows[0].host_address) !== normalizeAddr(session.suiAddress)) {
      return reply.code(403).send({ error: 'You do not own this listing' });
    }

    const r = await pool.query(
      `UPDATE properties SET
         title = $1, description = $2, location = $3, price = $4, beds = $5, baths = $6,
         tag = $7, images = $8, tax_rate = $9, tax_jurisdiction = $10, tax_breakdown = $11,
         max_guests = $12, source_url = $13
       WHERE id = $14
       RETURNING *`,
      [
        title.trim(), (description || '').trim(), location.trim(), cleanPrice,
        cleanBeds, cleanBaths, (tag || 'New Listing').trim(), cleanImages,
        cleanTaxRate, (taxJurisdiction || 'Unknown').trim(), (taxBreakdown || `${(cleanTaxRate * 100).toFixed(2)}% occupancy tax (host-declared)`).trim(),
        cleanMaxGuests, (sourceUrl || null), propertyId
      ]
    );
    const row = r.rows[0];
    fastify.log.info({ propertyId: row.id, host: session.suiAddress }, 'Host listing edited');
    return reply.send({
      success: true,
      property: {
        id: row.id, title: row.title, description: row.description, location: row.location,
        price: row.price, beds: row.beds, baths: row.baths, maxGuests: row.max_guests,
        tag: row.tag, images: row.images || [], taxRate: Number(row.tax_rate), taxName: row.tax_jurisdiction,
        sourceUrl: row.source_url, importSource: row.import_source
      }
    });
  } catch (err) {
    fastify.log.error({ err }, '/host/properties/:id update failed');
    return reply.code(500).send({ error: 'Could not update listing' });
  }
});

// PATCH /host/properties/:id/deactivate — soft-delete. Sets active=false
// rather than actually deleting the row, since getProperty()/getAllProperties
// (catalog.mjs) already filter on active=true everywhere — this is the same
// mechanism that's been there since Phase 3a, just newly exposed to hosts.
// Reversible in principle (no UI for that yet) and safe even if the listing
// has existing bookings, since bookings store a denormalized property_title
// at booking time and don't depend on the property row continuing to exist.
fastify.patch('/host/properties/:id/deactivate', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });

  const propertyId = Number(request.params.id);
  if (!Number.isInteger(propertyId)) return reply.code(400).send({ error: 'Invalid property id' });

  try {
    const existing = await pool.query('SELECT host_address FROM properties WHERE id = $1 AND active = true', [propertyId]);
    if (!existing.rows.length) return reply.code(404).send({ error: 'Listing not found' });
    if (normalizeAddr(existing.rows[0].host_address) !== normalizeAddr(session.suiAddress)) {
      return reply.code(403).send({ error: 'You do not own this listing' });
    }
    await pool.query('UPDATE properties SET active = false WHERE id = $1', [propertyId]);
    fastify.log.info({ propertyId, host: session.suiAddress }, 'Host listing deactivated');
    return reply.send({ success: true });
  } catch (err) {
    fastify.log.error({ err }, '/host/properties/:id/deactivate failed');
    return reply.code(500).send({ error: 'Could not deactivate listing' });
  }
});

// Bookings History — guest (own bookings only)
fastify.get('/bookings/history', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  try {
    const result = await pool.query(
      'SELECT * FROM bookings WHERE wallet_address = $1 ORDER BY created_at DESC',
      [session.suiAddress]
    );
    const histPropIds = [...new Set(result.rows.map(b => Number(b.property_id)))];
    const histPropEntries = await Promise.all(histPropIds.map(id => getProperty(id, fastify.log)));
    const histPropById = new Map(histPropIds.map((id, i) => [id, histPropEntries[i]]));
    return { bookings: result.rows.map(b => {
      const chargeAmount = (b.total_amount || 0) + (b.deposit_amount || 0);
      const jur = histPropById.get(Number(b.property_id)) || { taxRate: 0.08, taxName: 'Occupancy Tax' };
      return {
        bookingRef: b.booking_ref, property: b.property_title, propertyId: b.property_id,
        checkIn: b.check_in, checkOut: b.check_out, nights: b.nights,
        totalAmount: b.total_amount, ariaFee: b.aria_fee, taxes: b.taxes, chargeAmount,
        paymentStatus: b.payment_status,
        depositAmount: b.deposit_amount, depositStatus: b.deposit_status,
        bookingPassObjectId: b.booking_pass_object_id,
        walrusBlobId: b.walrus_blob_id,
        cancellationWalrusBlobId: b.cancellation_walrus_blob_id,
        timestamp: b.created_at, walletAddress: b.wallet_address,
        // Phase 2c resale state (display + gating for the My Bookings list/cancel
        // actions). resaleable = the host enabled transfer at booking time (a
        // ResalePolicy exists) and both escrows are still live.
        resaleable: !!b.resale_policy_object_id && b.deposit_status === 'held' && b.payment_escrow_status === 'held' && (b.resale_count || 0) < 1,
        resaleListed: b.resale_listed === true,
        resaleAskPrice: b.resale_ask_price,
        resaleCount: b.resale_count || 0,
        checkedIn: b.checked_in === true,
        checkedInAt: b.checked_in_at || null,
        faceValue: chargeAmount,
        originalWalletAddress: b.original_wallet_address,
        resaleWalrusBlobId: b.resale_walrus_blob_id,
        // ariaFee/taxes above are raw numeric fields for callers that need to
        // compute (e.g. pages/host.jsx revenue summaries — Finding #9). The
        // breakdown.* strings below remain purely for display.
        breakdown: {
          pricePerNight: `$${b.price_per_night}`, nights: b.nights,
          subtotal: `$${b.subtotal}`,
          ariaFee: `$${b.aria_fee} (5% of subtotal only)`,
          taxes: `$${b.taxes} (${(jur.taxRate * 100).toFixed(2)}% — ${jur.taxName})`,
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
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  try {
    // Bounded (Codex review): cap the host bookings feed so one request can't
    // pull the whole table into memory. Proper offset/cursor pagination is a
    // follow-up (see roadmap tech debt). Tunable via BOOKINGS_ALL_LIMIT.
    const allLimit = Number(process.env.BOOKINGS_ALL_LIMIT || 500);
    const result = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC LIMIT $1', [allLimit]);
    const allPropIds = [...new Set(result.rows.map(b => Number(b.property_id)))];
    const allPropEntries = await Promise.all(allPropIds.map(id => getProperty(id, fastify.log)));
    const allPropById = new Map(allPropIds.map((id, i) => [id, allPropEntries[i]]));
    return { bookings: result.rows.map(b => {
      const chargeAmount = (b.total_amount || 0) + (b.deposit_amount || 0);
      const jur = allPropById.get(Number(b.property_id)) || { taxRate: 0.08, taxName: 'Occupancy Tax' };
      return {
        bookingRef: b.booking_ref, property: b.property_title, propertyId: b.property_id,
        checkIn: b.check_in, checkOut: b.check_out, nights: b.nights,
        totalAmount: b.total_amount, ariaFee: b.aria_fee, taxes: b.taxes, chargeAmount,
        paymentStatus: b.payment_status,
        depositAmount: b.deposit_amount, depositStatus: b.deposit_status,
        bookingPassObjectId: b.booking_pass_object_id,
        walrusBlobId: b.walrus_blob_id,
        cancellationWalrusBlobId: b.cancellation_walrus_blob_id,
        guestName: b.guest_name, guestEmail: b.guest_email,
        walletAddress: b.wallet_address, timestamp: b.created_at,
        jurisdiction: jur.taxName,
        // ariaFee/taxes above are raw numeric fields — host.jsx revenue
        // summaries sum these directly instead of regex-parsing the display
        // strings in breakdown.* (Finding #9).
        breakdown: {
          pricePerNight: `$${b.price_per_night}`, nights: b.nights,
          subtotal: `$${b.subtotal}`,
          ariaFee: `$${b.aria_fee} (5% of subtotal only)`,
          taxes: `$${b.taxes} (${(jur.taxRate * 100).toFixed(2)}% — ${jur.taxName})`,
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
  // Previously a hardcoded map of only the 6 fixed catalog titles, so any
  // host-imported listing's exported .ics feed showed "Property {id}"
  // instead of its real title. getProperty() resolves both sources.
  const prop = await getProperty(propertyId, fastify.log);
  const icalData = await generateICal(propertyId, prop?.title || 'Property ' + propertyId);
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
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
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

fastify.get('/reviews/all', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  try {
    const result = await pool.query('SELECT * FROM reviews ORDER BY created_at DESC');
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

// ─── Tax Routes — HOST ONLY ───────────────────────────────────────────────────

fastify.get('/tax/summary', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
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
          jurisdiction, strPermit, payoutNotes, termsAgreed, complianceConfirmed } = request.body;
  // payout_sui_address is always session.suiAddress — never accepted from the
  // client — so a host can never end up with a payout destination that isn't
  // their own signing wallet (see validation.mjs comment for why).

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
       session.suiAddress, payoutNotes || null]
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

// Abandoned-booking sweep (Tech Debt Backlog item "Unsigned-booking trap"):
// createBooking() inserts the row and reserves the dates (the conflict check
// in createBooking only excludes payment_status='cancelled') the instant a
// guest starts checkout — but nothing on-chain happens until that guest signs
// and submits the escrow PTB from their own wallet. If they close the tab,
// lose connectivity, or just change their mind, the booking sits forever at
// deposit_status='pending' with escrow_object_id/payment_escrow_object_id
// both still null, blocking those dates for every other guest with no
// recourse short of a human finding and cancelling it manually.
// No funds are ever at risk here — by definition nothing was signed, so
// there's nothing to refund/release on-chain (same as the "nothing was ever
// locked on-chain" branch in cancelBooking) — this is purely a calendar
// hygiene sweep. The WHERE clause on the UPDATE re-checks the same
// disqualifying conditions as the SELECT so a guest who signs in the gap
// between the two queries simply doesn't match and is left alone (no row
// locking needed — createBooking's advisory lock only ever inserts new rows,
// it doesn't race against this UPDATE on an existing one).
async function runAbandonedBookingSweep() {
  const cutoff = new Date(Date.now() - ABANDONED_BOOKING_TTL_MS).toISOString();
  let stale;
  try {
    const result = await pool.query(
      `SELECT booking_ref, guest_email, guest_name, property_title, check_in, check_out FROM bookings
       WHERE payment_status = 'confirmed' AND deposit_status = 'pending'
       AND escrow_object_id IS NULL AND payment_escrow_object_id IS NULL
       AND created_at < $1`,
      [cutoff]
    );
    stale = result.rows;
  } catch (err) {
    fastify.log.error({ err }, 'Abandoned-booking sweep query failed');
    return;
  }

  for (const booking of stale) {
    let updated;
    try {
      const result = await pool.query(
        `UPDATE bookings SET payment_status='cancelled', cancelled_at=NOW(), deposit_status='released'
         WHERE booking_ref=$1 AND payment_status='confirmed' AND deposit_status='pending'
         AND escrow_object_id IS NULL AND payment_escrow_object_id IS NULL`,
        [booking.booking_ref]
      );
      updated = result.rowCount > 0;
    } catch (err) {
      fastify.log.error({ err, bookingRef: booking.booking_ref }, 'Abandoned-booking sweep: DB update failed');
      continue;
    }
    if (!updated) continue; // guest signed in the gap between SELECT and UPDATE — leave it alone
    fastify.log.info({ bookingRef: booking.booking_ref }, 'Abandoned-booking sweep: unsigned booking auto-cancelled, dates freed');

    if (booking.guest_email) {
      try {
        await resend.emails.send({
          from: 'ARIA <onboarding@resend.dev>', to: booking.guest_email,
          subject: `Booking Hold Expired — ${booking.property_title} | Ref: ${booking.booking_ref}`,
          html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#ffaa00;font-size:24px;margin:0 0 8px">⏳ Booking Hold Expired</h1><p style="color:#888;margin:0 0 24px">${escapeHtml(booking.guest_name || '')}</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin-bottom:20px"><h2 style="margin:0 0 16px;font-size:18px">${escapeHtml(booking.property_title)}</h2><table style="width:100%;border-collapse:collapse"><tr><td style="color:#888;padding:6px 0">Booking Ref</td><td style="text-align:right">${escapeHtml(booking.booking_ref)}</td></tr><tr><td style="color:#888;padding:6px 0">Check-in</td><td style="text-align:right">${booking.check_in}</td></tr><tr><td style="color:#888;padding:6px 0">Check-out</td><td style="text-align:right">${booking.check_out}</td></tr></table><p style="color:#888;font-size:12px;margin:16px 0 0;line-height:1.6">We held these dates while you completed checkout, but didn't see a signed payment within the hold window — no charge was ever made. The dates are now released back to the calendar. Feel free to book again whenever you're ready.</p></div><p style="color:#555;font-size:12px;text-align:center;margin:0">Powered by ARIA — Built on Sui</p></div>`
        });
      } catch (err) { fastify.log.warn({ err, bookingRef: booking.booking_ref }, 'Abandoned-booking sweep: notification email failed'); }
    }
  }
}

// Re-entrancy guards (Codex review, June 24 2026): the sweeps `await` each
// on-chain release serially, so a run can outlast its interval as volume grows;
// without a guard the next tick (or the startup timeout) would start a second
// concurrent pass over the same rows. These wrappers skip a tick if the prior
// run is still in flight. (Batching / a concurrency cap / a job queue are the
// scale follow-ups — see roadmap tech debt.)
let _autoSweepRunning = false;
let _checkInSweepRunning = false;
let _abandonedSweepRunning = false;
async function guardedAutoReleaseSweep() {
  if (_autoSweepRunning) { fastify.log.warn('Auto-release sweep already running — skipping this tick'); return; }
  _autoSweepRunning = true;
  try { await runAutoReleaseSweep(); }
  catch (err) { fastify.log.error({ err }, 'Auto-release sweep crashed'); }
  finally { _autoSweepRunning = false; }
}
async function guardedCheckInReleaseSweep() {
  if (_checkInSweepRunning) { fastify.log.warn('Check-in release sweep already running — skipping this tick'); return; }
  _checkInSweepRunning = true;
  try { await runCheckInReleaseSweep(); }
  catch (err) { fastify.log.error({ err }, 'Check-in release sweep crashed'); }
  finally { _checkInSweepRunning = false; }
}
async function guardedAbandonedBookingSweep() {
  if (_abandonedSweepRunning) { fastify.log.warn('Abandoned-booking sweep already running — skipping this tick'); return; }
  _abandonedSweepRunning = true;
  try { await runAbandonedBookingSweep(); }
  catch (err) { fastify.log.error({ err }, 'Abandoned-booking sweep crashed'); }
  finally { _abandonedSweepRunning = false; }
}

const AUTO_RELEASE_SWEEP_INTERVAL_MS = Number(process.env.AUTO_RELEASE_SWEEP_INTERVAL_MS || 60 * 60 * 1000); // hourly by default
setInterval(guardedAutoReleaseSweep, AUTO_RELEASE_SWEEP_INTERVAL_MS);
// Run once shortly after boot too, rather than waiting a full interval for the first sweep.
setTimeout(guardedAutoReleaseSweep, 30_000);

// Phase 1h.5: check-in release runs on the same cadence as the deposit sweep.
const CHECKIN_RELEASE_SWEEP_INTERVAL_MS = Number(process.env.CHECKIN_RELEASE_SWEEP_INTERVAL_MS || AUTO_RELEASE_SWEEP_INTERVAL_MS);
setInterval(guardedCheckInReleaseSweep, CHECKIN_RELEASE_SWEEP_INTERVAL_MS);
setTimeout(guardedCheckInReleaseSweep, 35_000);

// Abandoned-booking sweep: 15-minute TTL by default — long enough that a
// guest who steps away mid-signing can come back via
// POST /booking/:bookingRef/escrow/rebuild and still find their booking
// intact, short enough that an abandoned cart doesn't block a property's
// dates for long. Runs far more often than the other two sweeps (every 5
// minutes) since the whole point is freeing dates quickly, not waiting for
// an on-chain deadline.
const ABANDONED_BOOKING_TTL_MS = Number(process.env.ABANDONED_BOOKING_TTL_MS || 15 * 60 * 1000);
const ABANDONED_BOOKING_SWEEP_INTERVAL_MS = Number(process.env.ABANDONED_BOOKING_SWEEP_INTERVAL_MS || 5 * 60 * 1000);
setInterval(guardedAbandonedBookingSweep, ABANDONED_BOOKING_SWEEP_INTERVAL_MS);
setTimeout(guardedAbandonedBookingSweep, 20_000);

// ─── Start ────────────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT || '3001');
await fastify.listen({ port, host: '0.0.0.0' });
console.log('ARIA API running on port ' + port);
