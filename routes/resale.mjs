// Extracted verbatim from server.mjs (R1 route-module split, July 1 2026).
import { isValidTransactionDigest } from '@mysten/sui/utils';
import { pool } from '../db.mjs';
import { getProperty } from '../catalog.mjs';
import { buildListForResaleTransaction, buildBuyResaleTransaction, buildCancelResaleListingTransaction, verifyBuyResaleTransaction, verifyListResaleTransaction, verifyCancelResaleTransaction, readResalePolicyObject, normalizeAddr, dollarsToUnits } from '../escrow.mjs';
import { createBooking, getResaleSettings } from '../bookings.mjs';
import { pushToWalrus } from '../walrus.mjs';
import { validateBody, resaleListSchema, resaleTransferConfirmSchema } from '../validation.mjs';
import { getAuthedSession } from '../authz.mjs';

// R1 split note: module-scope (not inside the plugin) because routes/host.mjs's
// resale-settings route also caps maxPremiumBps at this. Pure constant — must
// match BPS_DENOM in escrow.move. The env-derived consts stay inside the plugin
// below so they're read at registration time (after dotenvConfig()).
export const BPS_DENOM = 10000;

export default async function resaleRoutes(fastify) {
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
}
