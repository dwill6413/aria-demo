// ─── Shared Booking Creation (Phase 2b/2c) ────────────────────────────────────
// Single implementation of "create a booking" used by both server.mjs's REST
// POST /booking/create and ai_route.mjs's create_booking AI tool. Previously
// these were two hand-synchronized copies of the same logic that had already
// drifted: the REST path built a guest-signed escrow transaction (the P0b
// non-custodial flow) and the AI-tool path did not, despite telling guests
// their deposit was "held in Sui escrow." This module is the fix — both call
// sites now go through the exact same pricing, persistence, escrow-build, and
// notification logic, so they can't diverge again by accident.
//
// This also folds in Phase 2c's pushToWalrus/email-template extraction for the
// booking-creation path specifically: there is now exactly one definition of
// each instead of one per call site.

import crypto from 'node:crypto';
import { pool } from './db.mjs';
import { PROPERTIES, JURISDICTION_TAX_RATES } from './catalog.mjs';
import { calculateHostPayout } from './deepbook.mjs';
import {
  buildEscrowTransaction, autoReleaseKeypair, autoReleaseEscrow,
  buildBookingPaymentTransaction, refundPaymentEscrow, refundDepositEscrow,
} from './escrow.mjs';
import { Resend } from 'resend';
import { pushToWalrus } from './walrus.mjs';
import { escapeHtml } from './emails.mjs';

const resend = new Resend(process.env.RESEND_API_KEY);

// ── P2 / Phase 1i: production host address lookup ──────────────────────────
// Replaces the old "stand in with the backend signer's own address" testnet
// placeholder. Looks up the real host for a property from catalog.mjs's
// hostAddress field (see catalog.mjs comment), then prefers that host's
// host_profiles.payout_sui_address (where they actually want deposit-release
// funds to land) over their login sui_address, since the two can differ. If
// no hostAddress is configured for the property yet (still true for all 6
// demo properties until a real host is approved and wired in), falls back to
// the auto-release key's address — the exact same placeholder behavior as
// before this function existed, just now centralized in one place instead of
// inlined in createBooking.
export async function getPropertyHostAddress(propertyId, logger = console) {
  const configuredHost = PROPERTIES[Number(propertyId)]?.hostAddress;
  if (!configuredHost) {
    // P2 / Finding #8: the 6 demo properties have no real host wired in yet,
    // so the escrow's on-chain `host` used to fall back to the backend's
    // auto-release key address — an address no human holds, which made
    // claim_damage (asserts sender == escrow.host) impossible to ever exercise
    // end-to-end. Prefer an operator-set DEMO_HOST_ADDRESS so a real wallet can
    // act as host for the demo flow; only fall back to the auto-release key (or
    // null) when neither is configured.
    const demoHost = (process.env.DEMO_HOST_ADDRESS || '').trim();
    if (demoHost) return demoHost;
    return autoReleaseKeypair ? autoReleaseKeypair.toSuiAddress() : null;
  }
  try {
    const result = await pool.query(
      'SELECT payout_sui_address FROM host_profiles WHERE sui_address = $1',
      [configuredHost]
    );
    return result.rows[0]?.payout_sui_address || configuredHost;
  } catch (err) {
    logger?.warn?.({ err, propertyId }, 'host_profiles payout address lookup failed — using configured hostAddress directly');
    return configuredHost;
  }
}

// ── Phase 2c: per-listing resale settings read-through ─────────────────────
// Rail 1 (host opt-in) + Rail 2 (premium cap) live on the `properties` row and
// are baked into the booking's on-chain ResalePolicy at booking time (later
// listing changes only affect future bookings — see ARIA_PHASE2C_PLAN §4). The
// 6 demo properties have no `properties` row by default, so a missing row means
// transfer DISABLED — the safe default. Returns { transferAllowed, maxPremiumBps }.
export async function getResaleSettings(propertyId, logger = console) {
  // Resale is globally gated: never report transfer-allowed unless the flag is on,
  // so the create_resale_policy moveCall stays omitted on pre-v6 packages.
  if (process.env.RESALE_ENABLED !== 'true') return { transferAllowed: false, maxPremiumBps: 0 };
  try {
    const r = await pool.query(
      'SELECT transfer_allowed, max_resale_premium_bps FROM property_resale_settings WHERE property_id = $1',
      [Number(propertyId)]
    );
    const row = r.rows[0];
    if (!row) return { transferAllowed: false, maxPremiumBps: 0 };
    return {
      transferAllowed: row.transfer_allowed === true,
      maxPremiumBps: Math.max(0, Number(row.max_resale_premium_bps) || 0),
    };
  } catch (err) {
    logger?.warn?.({ err, propertyId }, 'getResaleSettings lookup failed — defaulting to transfer disabled');
    return { transferAllowed: false, maxPremiumBps: 0 };
  }
}

// ── Shared deposit-release logic (Findings #4 and #5) ──────────────────────
// Single authoritative implementation of "release this booking's deposit back
// to the guest," used by BOTH server.mjs's REST /booking/release-deposit and
// ai_route.mjs's release_deposit AI tool. Previously the AI path was a weaker
// copy: it flipped deposit_status='released' in Postgres with NO checkout
// timing gate, NO claim/dispute guard, and NO on-chain auto_release call at
// all — so a host using the chat agent could "release" a deposit before the
// inspection window closed and without anything happening on-chain. And both
// paths flipped the DB even when the on-chain release failed, so Postgres
// could read 'released' while the coin was still locked in escrow.
//
// This helper fixes both: it enforces the same guards as the REST route AND,
// crucially, only writes deposit_status='released' if the on-chain auto_release
// actually succeeded (when an escrow object exists). Callers remain responsible
// for their own authorization check before calling this — it assumes the caller
// is already permitted to manage this booking. Returns { ok: true } on success
// or { error, status } on any guard/chain failure.
export async function releaseDepositForBooking(booking, { logger = console } = {}) {
  if (booking.deposit_status === 'released') {
    return { error: 'Deposit already released', status: 400 };
  }
  if (['claimed', 'disputed', 'forfeited'].includes(booking.deposit_status)) {
    return { error: `Deposit is in the claim/dispute flow (status: ${booking.deposit_status}) — use /booking/resolve-dispute instead`, status: 400 };
  }
  // Only releasable after checkout — releasing early would skip the host's
  // 5-day inspection window entirely (Phase 3 item 1).
  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (today < new Date(booking.check_out)) {
    return { error: 'Deposit cannot be released before checkout', status: 400 };
  }

  // If an on-chain escrow exists, the on-chain release is authoritative — do
  // NOT mark the deposit released in Postgres unless auto_release actually
  // succeeded on-chain, or the DB and chain would diverge (Finding #5).
  if (booking.escrow_object_id) {
    const released = await autoReleaseEscrow(booking.escrow_object_id);
    if (!released) {
      logger?.warn?.({ bookingRef: booking.booking_ref }, 'On-chain escrow release failed — leaving deposit_status unchanged');
      return { error: 'On-chain escrow release failed — the deposit is still locked on-chain (it may not have reached its release time yet). Please try again later.', status: 502 };
    }
    logger?.info?.({ bookingRef: booking.booking_ref, escrowObjectId: booking.escrow_object_id }, 'Escrow released on-chain');
  }

  await pool.query('UPDATE bookings SET deposit_status=$1 WHERE booking_ref=$2', ['released', booking.booking_ref]);
  return { ok: true };
}

// ── Shared cancellation logic (R2 + M1) ────────────────────────────────────
// One implementation of "cancel this booking," used by both server.mjs's REST
// POST /booking/cancel and ai_route.mjs's cancel_booking tool — previously ~60
// near-identical lines in each (Walrus push + DB update + Resend email) that had
// already drifted on host-auth rules.
//
// M1 (escrow-on-cancel gap): the old paths set deposit_status in Postgres but
// NEVER released the on-chain escrow. A pre-check-in cancel set status 'released'
// while the auto-release sweep only processes 'held' — so the guest's coin was
// stranded on-chain forever. This now attempts an on-chain release when an escrow
// is actually held: if auto_release succeeds (escrow past its on-chain expiry) the
// deposit is marked 'released'; if it can't release yet (pre-expiry — the contract
// has no pre-expiry refund path; see ROADMAP cancel_escrow), the status stays
// 'held' so the existing sweep releases it once expiry passes, rather than being
// flipped to 'released' and skipped. Either way the coin is no longer stranded.
//
// Returns true if this host session may act on this booking — a configured
// superadmin (HOST_ADDRESSES), the address baked into the booking's escrow as
// host, or a host_address on the booking's property. Mirrors server.mjs
// canClaimAsHost so host actions can't cross tenants.
const _HOST_ADDRESSES = (process.env.HOST_ADDRESSES || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
export async function hostManagesBooking(session, booking) {
  if (session?.email && _HOST_ADDRESSES.includes(session.email.toLowerCase())) return true;
  if (booking?.host_sui_address && session?.suiAddress === booking.host_sui_address) return true;
  try {
    const r = await pool.query('SELECT 1 FROM properties WHERE id = $1 AND host_address = $2', [booking?.property_id, session?.suiAddress]);
    return r.rows.length > 0;
  } catch { return false; }
}

// Auth: a guest may cancel only their own booking; a host may cancel only
// bookings for properties they actually manage — NOT any booking platform-wide.
// (Previously any approved host could cancel ANY booking: cross-tenant bug.)
export async function cancelBooking({ bookingRef, session, logger = console }) {
  if (!bookingRef || typeof bookingRef !== 'string' || !bookingRef.startsWith('ARIA-')) {
    return { error: 'A valid bookingRef is required', status: 400 };
  }
  let booking;
  try {
    const r = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
    booking = r.rows[0];
  } catch (err) {
    logger?.error?.({ err, bookingRef }, 'cancelBooking: lookup failed');
    return { error: 'Booking lookup failed', status: 500 };
  }
  if (!booking) return { error: 'Booking not found', status: 404 };
  const ownsAsGuest = booking.wallet_address === session.suiAddress;
  const managesAsHost = ownsAsGuest ? false : await hostManagesBooking(session, booking);
  if (!ownsAsGuest && !managesAsHost) {
    return { error: 'Not your booking', status: 403 };
  }
  if (booking.payment_status === 'cancelled') return { error: 'Already cancelled', status: 400 };
  if (['claimed', 'disputed', 'forfeited'].includes(booking.deposit_status)) {
    return { error: `Deposit is in the claim/dispute flow (status: ${booking.deposit_status}) — resolve that before cancelling`, status: 400 };
  }

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const beforeCheckIn = today < new Date(booking.check_in);
  const cancelledAt = new Date().toISOString();

  // M1: release the on-chain DEPOSIT escrow if one is actually held.
  let depositStatus = booking.deposit_status;
  let escrowReleased = false;
  if (booking.escrow_object_id && booking.deposit_status === 'held') {
    // Phase 1h.5: before check-in the arbitrator can refund the deposit
    // instantly via refund_deposit (v4), instead of stranding it until expiry.
    // Otherwise fall back to the permissionless auto_release (post-expiry only).
    if (beforeCheckIn) {
      escrowReleased = await refundDepositEscrow(booking.escrow_object_id);
      if (escrowReleased) logger?.info?.({ bookingRef }, 'cancelBooking: deposit refunded on-chain (pre-check-in)');
    }
    if (!escrowReleased) {
      escrowReleased = await autoReleaseEscrow(booking.escrow_object_id);
      if (escrowReleased) logger?.info?.({ bookingRef }, 'cancelBooking: escrow released on-chain');
    }
    if (escrowReleased) {
      depositStatus = 'released';
    } else {
      // Keep 'held' (NOT 'released') so the auto-release sweep picks it up once
      // the on-chain expiry passes — flipping to 'released' would make the sweep
      // skip it and strand the coin (the bug this fixes).
      logger?.warn?.({ bookingRef }, 'cancelBooking: on-chain release not yet possible — left held for the sweep');
    }
  } else if (!booking.escrow_object_id && beforeCheckIn) {
    // No escrow was ever funded/confirmed — nothing is locked on-chain.
    depositStatus = 'released';
  }

  // Phase 1h.5: refund the PAYMENT escrow (rental + ARIA fee + tax). Industry
  // standard "fee follows refund": a full refund is only owed before check-in.
  // After check-in the payment is no longer refundable — the check-in sweep
  // releases it to host/ARIA/tax instead.
  let paymentEscrowStatus = booking.payment_escrow_status;
  let paymentRefunded = false;
  if (booking.payment_escrow_object_id && booking.payment_escrow_status === 'held') {
    if (beforeCheckIn) {
      paymentRefunded = await refundPaymentEscrow(booking.payment_escrow_object_id);
      if (paymentRefunded) {
        paymentEscrowStatus = 'refunded';
        logger?.info?.({ bookingRef }, 'cancelBooking: payment refunded on-chain (pre-check-in)');
      } else {
        logger?.warn?.({ bookingRef }, 'cancelBooking: payment refund not possible — left held');
      }
    } else {
      logger?.info?.({ bookingRef }, 'cancelBooking: past check-in — payment not refundable, will release to host/ARIA/tax');
    }
  }

  try {
    await pool.query(
      `UPDATE bookings SET payment_status='cancelled', cancelled_at=$1, deposit_status=$2,
        payment_escrow_status=$3, payment_refunded_at=$4 WHERE booking_ref=$5`,
      [cancelledAt, depositStatus, paymentEscrowStatus, paymentRefunded ? cancelledAt : null, bookingRef]
    );
  } catch (err) {
    logger?.error?.({ err, bookingRef }, 'cancelBooking: DB update failed');
    return { error: 'Failed to cancel booking', status: 500 };
  }

  const cancellationWalrusBlobId = await pushToWalrus(
    { ...booking, walrusReceiptType: 'cancellation', cancellationTimestamp: cancelledAt }, logger
  );
  if (cancellationWalrusBlobId) {
    try {
      await pool.query('UPDATE bookings SET cancellation_walrus_blob_id=$1 WHERE booking_ref=$2', [cancellationWalrusBlobId, bookingRef]);
    } catch (err) { logger?.warn?.({ err, bookingRef }, 'cancelBooking: walrus blob id update failed'); }
  }

  const depositReleasedNow = depositStatus === 'released';
  try {
    const depositNote = depositReleasedNow
      ? `<div style="background:#0a1a0a;border:1px solid #1a4a1a;border-radius:6px;padding:10px;margin-top:10px"><p style="color:#00ff44;font-size:12px;font-weight:600;margin:0 0 4px">🔓 Security deposit released</p><p style="color:#888;font-size:12px;margin:0">Your $${booking.deposit_amount} deposit has been returned.</p></div>`
      : `<div style="background:#0a0a1a;border:1px solid #1a1a3a;border-radius:6px;padding:10px;margin-top:10px"><p style="color:#4a9eff;font-size:12px;font-weight:600;margin:0 0 4px">🔒 Security deposit pending release</p><p style="color:#888;font-size:12px;margin:0">Your $${booking.deposit_amount} deposit will be released after the inspection window.</p></div>`;
    await resend.emails.send({
      from: 'ARIA <onboarding@resend.dev>', to: booking.guest_email,
      subject: `Booking Cancelled — ${booking.property_title} | Ref: ${bookingRef}`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#ff4444;font-size:24px;margin:0 0 8px">❌ Booking Cancelled</h1><p style="color:#888;margin:0 0 24px">Your cancellation confirmation — ${escapeHtml(booking.guest_name)}</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin-bottom:20px"><h2 style="margin:0 0 16px;font-size:18px">${escapeHtml(booking.property_title)}</h2><table style="width:100%;border-collapse:collapse"><tr><td style="color:#888;padding:6px 0">Booking Ref</td><td style="text-align:right">${escapeHtml(bookingRef)}</td></tr><tr><td style="color:#888;padding:6px 0">Check-in</td><td style="text-align:right">${booking.check_in}</td></tr><tr><td style="color:#888;padding:6px 0">Check-out</td><td style="text-align:right">${booking.check_out}</td></tr></table>${depositNote}</div><p style="color:#555;font-size:12px;text-align:center;margin:0">Powered by ARIA — Built on Sui</p></div>`
    });
  } catch (err) { logger?.warn?.({ err, bookingRef }, 'cancelBooking: email failed'); }

  return {
    success: true, bookingRef,
    depositAutoReleased: depositReleasedNow,
    escrowReleased,
    depositStatus,
    paymentRefunded,
    paymentEscrowStatus,
    cancellationWalrusBlobId,
    message: depositReleasedNow
      ? (paymentRefunded
          ? 'Booking cancelled. Payment and deposit refunded in full.'
          : 'Booking cancelled. Deposit released.')
      : 'Booking cancelled. Deposit will be released after the inspection window.'
  };
}

function buildConfirmationEmailHtml({ propertyTitle, bookingRef, checkIn, checkOut, nights, subtotal, ariaFee, taxes, taxPct, jurisdictionName, bookingTotal, depositAmount, walrusBlobId, guestName }) {
  const walrusHtml = walrusBlobId
    ? `<div style="background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:20px"><p style="margin:0 0 8px;font-size:12px;color:#555">WALRUS RECEIPT — PERMANENT ON-CHAIN RECORD</p><p style="margin:0;font-size:11px;color:#00ff44;word-break:break-all;font-family:monospace">${walrusBlobId}</p></div>`
    : '';
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px">
    <h1 style="color:#00ff44;font-size:24px;margin:0 0 8px">✅ Booking Confirmed</h1>
    <p style="color:#888;margin:0 0 24px">Your ARIA booking receipt — ${escapeHtml(guestName)}</p>
    <div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin-bottom:20px">
      <h2 style="margin:0 0 16px;font-size:18px">${propertyTitle}</h2>
      <table style="width:100%;border-collapse:collapse">
        <tr><td style="color:#888;padding:6px 0">Booking Ref</td><td style="text-align:right">${bookingRef}</td></tr>
        <tr><td style="color:#888;padding:6px 0">Check-in</td><td style="text-align:right">${checkIn}</td></tr>
        <tr><td style="color:#888;padding:6px 0">Check-out</td><td style="text-align:right">${checkOut}</td></tr>
        <tr><td style="color:#888;padding:6px 0">Nights</td><td style="text-align:right">${nights}</td></tr>
        <tr><td style="color:#888;padding:6px 0">Subtotal</td><td style="text-align:right">$${subtotal}</td></tr>
        <tr><td style="color:#888;padding:6px 0">ARIA Fee (3% of subtotal only)</td><td style="text-align:right;color:#00ff44">$${ariaFee}</td></tr>
        <tr><td style="color:#888;padding:6px 0">Taxes (${taxPct}% — ${jurisdictionName})</td><td style="text-align:right">$${taxes}</td></tr>
        <tr style="border-top:1px solid #333"><td style="padding:8px 0;font-weight:700">Booking Total</td><td style="text-align:right;font-weight:700;color:#00ff44">$${bookingTotal} SuiUSD</td></tr>
        <tr><td style="color:#4a9eff;padding:6px 0">🔒 Refundable Security Deposit</td><td style="text-align:right;color:#4a9eff">$${depositAmount} SuiUSD</td></tr>
      </table>
      <p style="color:#555;font-size:12px;margin:12px 0 0;line-height:1.6">The $${depositAmount} deposit is locked into a Sui escrow contract once you sign the escrow transaction, and is returned after checkout. ARIA's 3% fee applies to your stay cost only — never to your deposit.</p>
    </div>
    ${walrusHtml}
    <p style="color:#555;font-size:12px;text-align:center;margin:0">Powered by ARIA — Built on Sui | The Airbnb killer</p>
  </div>`;
}

// createBooking — the one and only place booking-creation logic lives.
//
// Trusts ONLY propertyId, checkIn, checkOut, and the verified session from
// the caller. Everything that affects money (title, price, nights, fees,
// taxes, deposit) is recomputed here from catalog.mjs / the dates themselves
// — never taken from a client or an LLM tool-call argument (Finding #1).
//
// Returns { error } on validation/conflict failure (caller decides the HTTP
// status / tool-result shape), or the full booking result including
// escrowTxBytes on success.
export async function createBooking({ propertyId, checkIn, checkOut, session, logger = console }) {
  if (!propertyId || !checkIn || !checkOut) {
    return { error: 'propertyId, checkIn, and checkOut are required' };
  }
  const prop = PROPERTIES[Number(propertyId)];
  if (!prop) return { error: 'propertyId must be between 1 and 6' };
  if (isNaN(new Date(checkIn)) || isNaN(new Date(checkOut))) {
    return { error: 'checkIn and checkOut must be valid dates (YYYY-MM-DD)' };
  }
  if (new Date(checkOut) <= new Date(checkIn)) {
    return { error: 'checkOut must be after checkIn' };
  }

  // Phase 2e: identity-verification gate. Require the guest to have completed
  // PII verification (a guest_verifications row, written by /guest/profile after
  // they Seal-encrypt + Walrus-store their identity) before they can book.
  // Gated behind REQUIRE_GUEST_VERIFICATION so it stays dormant until the
  // profile UI is live and tested — flipping it on with no profiles would block
  // every booking. Applies to BOTH the REST and AI paths (both call this fn).
  if (process.env.REQUIRE_GUEST_VERIFICATION === 'true') {
    try {
      const v = await pool.query('SELECT 1 FROM guest_verifications WHERE sui_address = $1', [session.suiAddress]);
      if (!v.rows.length) {
        return { error: 'Complete identity verification first', status: 400, needsVerification: true };
      }
    } catch (err) {
      logger?.error?.({ err }, 'createBooking: guest verification check failed');
      return { error: 'Could not verify your identity status. Please try again.', status: 503 };
    }
  }

  const checkInStr  = new Date(checkIn).toISOString().split('T')[0];
  const checkOutStr = new Date(checkOut).toISOString().split('T')[0];

  // Server-authoritative nights — derived from the dates themselves, never
  // trusted from a client/LLM-supplied `nights` field, so a tampered or
  // mis-stated value can't desync the stay length from what's actually booked.
  const nights = Math.round((new Date(checkOutStr) - new Date(checkInStr)) / (1000 * 60 * 60 * 24));
  if (!nights || nights < 1 || nights > 90) {
    return { error: 'Stay length must be between 1 and 90 nights' };
  }

  const jurisdiction  = JURISDICTION_TAX_RATES[Number(propertyId)] || { rate: 0.08, name: 'Unknown', breakdown: '8% occupancy tax' };
  const propertyTitle = prop.title;
  const pricePerNight = prop.price;
  const subtotal       = pricePerNight * nights;
  const ariaFee        = Math.round(subtotal * 0.03);
  const taxes          = Math.round(subtotal * jurisdiction.rate);
  const bookingTotal   = subtotal + ariaFee + taxes;
  const depositAmount  = Math.round(bookingTotal * 0.20);
  const chargeAmount   = bookingTotal + depositAmount;
  const hostPayout     = calculateHostPayout(subtotal);
  const taxPct         = (jurisdiction.rate * 100).toFixed(2);
  // Phase 3c (Finding #12): timestamp-only refs could collide under concurrent
  // requests in the same millisecond. Keep the human-readable ARIA-<property>-
  // prefix but append a random hex suffix so collisions are cryptographically
  // implausible instead of merely "unlikely."
  const bookingRef     = `ARIA-${propertyId}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  // ── Atomic availability-check + insert (Findings #3 and #6) ────────────────
  // Two fixes in one transaction:
  //  • #6 (double-booking race): the old code ran the overlap check and the
  //    INSERT as two separate pool queries, so two concurrent requests for the
  //    same dates could both pass the check and both insert. A per-property
  //    transaction-scoped advisory lock serializes booking attempts for a given
  //    property, making check-then-insert atomic without a schema change.
  //  • #3 (silent "confirmed"): the old INSERT swallowed its error and let the
  //    function return success anyway — a guest would get a confirmed bookingRef
  //    that was never persisted. A failed insert now returns { error } so the
  //    caller sends a real failure instead of a phantom confirmation.
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [Number(propertyId)]);

    const conflict = await client.query(
      `SELECT booking_ref FROM bookings
       WHERE property_id = $1 AND payment_status != 'cancelled'
       AND check_in < $3 AND check_out > $2`,
      [propertyId, checkInStr, checkOutStr]
    );
    if (conflict.rows.length > 0) {
      await client.query('ROLLBACK');
      return { error: 'Property not available for selected dates', conflicts: conflict.rows };
    }

    await client.query(
      `INSERT INTO bookings (booking_ref, property_id, property_title, wallet_address, guest_name, guest_email,
        check_in, check_out, nights, price_per_night, subtotal, aria_fee, taxes, total_amount,
        deposit_amount, payment_status, payment_method, deposit_status, original_wallet_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'confirmed','SuiUSD','pending',$4)`,
      [bookingRef, propertyId, propertyTitle, session.suiAddress, session.name, session.email,
       checkInStr, checkOutStr, nights, pricePerNight, subtotal, ariaFee, taxes, bookingTotal, depositAmount]
    );
    await client.query('COMMIT');
  } catch (err) {
    if (client) { try { await client.query('ROLLBACK'); } catch {} }
    logger?.error?.({ err, bookingRef }, 'DB booking save failed');
    return { error: 'Could not save your booking. Please try again.', status: 503 };
  } finally {
    if (client) client.release();
  }

  const receipt = {
    bookingRef, app: 'ARIA Demo', network: 'sui:testnet',
    timestamp: new Date().toISOString(), property: propertyTitle, propertyId,
    checkIn: checkInStr, checkOut: checkOutStr, nights,
    breakdown: {
      pricePerNight: `$${pricePerNight}`, nights,
      subtotal: `$${subtotal}`,
      ariaFee: `$${ariaFee} (3% of subtotal — not charged on deposit)`,
      taxes: `$${taxes} (${taxPct}% — ${jurisdiction.name})`,
      bookingTotal: `$${bookingTotal} SuiUSD`,
      depositAmount: `$${depositAmount} (refundable, locked in Sui escrow once signed — no ARIA fee)`,
      chargeAmount: `$${chargeAmount} SuiUSD (total charged at booking)`
    },
    hostPayout: { amount: `$${hostPayout.hostPayout} SuiUSD`, ariaFee: `$${hostPayout.ariaFee} SuiUSD`, settlementMethod: hostPayout.settlementMethod },
    walletAddress: session.suiAddress, guestName: session.name, guestEmail: session.email,
    paymentMethod: 'SuiUSD', paymentStatus: 'confirmed',
    depositAmount, depositStatus: 'pending', chargeAmount,
    jurisdiction: jurisdiction.name, jurisdictionBreakdown: jurisdiction.breakdown
  };
  const walrusBlobId = await pushToWalrus(receipt, logger);
  if (walrusBlobId) {
    try {
      await pool.query('UPDATE bookings SET walrus_blob_id = $1 WHERE booking_ref = $2', [walrusBlobId, bookingRef]);
    } catch (err) { logger?.warn?.({ err }, 'Walrus blob id update failed'); }
  }

  // ── On-chain escrow tx build (non-blocking, NOT signed/executed here) ────
  // Non-custodial: the guest signs and submits this themselves from their
  // browser (lib/zklogin.js signTransactionWithZkLogin) regardless of whether
  // the booking originated from the REST flow (pages/index.jsx) or the AI
  // chat (pages/ai.jsx) — ARIA's backend never holds a key with authority
  // over this transaction. The booking row stays deposit_status='pending'
  // and escrow_object_id stays null until the guest reports a signed digest
  // to /booking/:bookingRef/escrow/confirm, which re-verifies on-chain.
  //
  // P2 / Phase 1i: real host lookup (see getPropertyHostAddress above) — no
  // longer the backend signer's own address standing in for every property.
  // Still falls back to that same placeholder when a demo property has no
  // configured host, so testnet behavior is unchanged until real hosts are
  // wired into catalog.mjs.
  // Phase 1h.5: when the ARIA treasury addresses are configured, build the
  // COMBINED PTB (payment escrow + deposit escrow, one guest signature). The
  // guest funds rental+fee+tax AND the deposit from their own wallet in a single
  // atomic tx. Falls back to the deposit-only build (P0b) when the fee/tax
  // wallets aren't set, so existing deployments keep working unchanged.
  let escrowTxBytes = null;
  let paymentEscrowBuilt = false;
  // Testnet: settle ~5 min out so the check-in release sweep is exercisable
  // without waiting for the real check-in date (mirrors the deposit's 5-min
  // testnet expiry window). MAINNET: set releaseMs to the real check-in
  // timestamp, e.g. Date.parse(checkInStr) [+ optional grace].
  const releaseMs = Date.now() + 300_000;
  try {
    const hostAddr = await getPropertyHostAddress(propertyId, logger);
    if (hostAddr) {
      const useCombined = !!(process.env.ARIA_FEE_ADDRESS && process.env.ARIA_TAX_REMITTANCE_ADDRESS);
      // Phase 2c: read the host's resale opt-in + cap (Rail 1/2). When enabled,
      // buildBookingPaymentTransaction adds the create_resale_policy moveCall so
      // this booking can later be resold under these terms. Dormant otherwise.
      const resale = await getResaleSettings(propertyId, logger);
      // No-transfer window before check-in (Rail 5), baked into the policy. Defaults
      // to 48h; set RESALE_WINDOW_MS (ms) lower on testnet so resale is exercisable
      // against the short 5-min testnet release_time. 0 disables the window entirely.
      const resaleWindowMs = Number.isFinite(Number(process.env.RESALE_WINDOW_MS))
        ? Math.max(0, Number(process.env.RESALE_WINDOW_MS)) : 172_800_000;
      const built = useCombined
        ? await buildBookingPaymentTransaction(bookingRef, session.suiAddress, hostAddr,
            { subtotal, ariaFee, taxes, depositAmount, releaseMs,
              propertyId: Number(propertyId), checkInMs: Date.parse(checkInStr), checkOutMs: Date.parse(checkOutStr),
              transferAllowed: resale.transferAllowed, maxPremiumBps: resale.maxPremiumBps,
              resaleWindowMs }, logger)
        : await buildEscrowTransaction(bookingRef, session.suiAddress, hostAddr, depositAmount, logger);
      if (built?.txBytes) {
        escrowTxBytes = built.txBytes;
        paymentEscrowBuilt = useCombined;
        // Persist the host address baked into the escrow object(s) (so
        // /booking/claim-damage can verify the caller is this booking's host),
        // and — for the combined path — the check-in release time the confirm
        // route compares against and the sweep releases on.
        try {
          if (useCombined) {
            await pool.query(
              'UPDATE bookings SET host_sui_address=$1, payment_release_ms=$2 WHERE booking_ref=$3',
              [hostAddr, String(releaseMs), bookingRef]
            );
          } else {
            await pool.query('UPDATE bookings SET host_sui_address=$1 WHERE booking_ref=$2', [hostAddr, bookingRef]);
          }
        } catch (err) { logger?.warn?.({ err, bookingRef }, 'Failed to persist host_sui_address/payment_release_ms'); }
      } else {
        logger?.warn?.({ bookingRef, useCombined }, 'Escrow tx build returned null');
      }
    }
  } catch (err) { logger?.warn?.({ err }, 'Escrow tx build failed (non-blocking)'); }

  try {
    await resend.emails.send({
      from: 'ARIA <onboarding@resend.dev>', to: session.email,
      subject: `Booking Confirmed — ${propertyTitle} | Ref: ${bookingRef}`,
      html: buildConfirmationEmailHtml({
        propertyTitle, bookingRef, checkIn: checkInStr, checkOut: checkOutStr, nights,
        subtotal, ariaFee, taxes, taxPct, jurisdictionName: jurisdiction.name,
        bookingTotal, depositAmount, walrusBlobId, guestName: session.name
      })
    });
  } catch (err) { logger?.warn?.({ err }, 'Booking confirmation email failed'); }

  return {
    success: true, bookingRef, property: propertyTitle,
    checkIn: checkInStr, checkOut: checkOutStr, nights,
    subtotal, ariaFee, taxes, bookingTotal, depositAmount, chargeAmount,
    jurisdiction: jurisdiction.name, taxRate: `${taxPct}%`,
    depositNote: escrowTxBytes
      ? 'Sign the escrow transaction in your wallet to lock in your refundable security deposit'
      : 'Refundable security deposit will be held in Sui escrow — no ARIA fee charged on deposit',
    walletAddress: session.suiAddress, network: 'sui:testnet',
    message: 'Booking confirmed on Sui testnet', walrusBlobId,
    escrowTxBytes,
    // True when escrowTxBytes is the COMBINED payment+deposit PTB (Phase 1h.5);
    // the frontend reports its digest to the same /escrow/confirm route, which
    // verifies both escrows. False = deposit-only legacy build.
    paymentEscrowBuilt
  };
}
