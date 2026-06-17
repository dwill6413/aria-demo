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
import { buildEscrowTransaction, autoReleaseKeypair } from './escrow.mjs';
import { Resend } from 'resend';

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

// Pushes a JSON receipt to Walrus testnet and returns the resulting blobId,
// or null if the push fails (non-blocking — a booking is still valid without
// a Walrus receipt, it just loses the permanent off-chain audit copy).
async function pushBookingReceiptToWalrus(receipt, logger = console) {
  try {
    const walrusRes  = await fetch('https://publisher.walrus-testnet.walrus.space/v1/blobs?epochs=3', {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(JSON.stringify(receipt))
    });
    const walrusData = await walrusRes.json();
    return walrusData?.newlyCreated?.blobObject?.blobId ?? walrusData?.alreadyCertified?.blobId ?? null;
  } catch (err) {
    logger?.warn?.({ err }, 'Walrus storage failed');
    return null;
  }
}

function buildConfirmationEmailHtml({ propertyTitle, bookingRef, checkIn, checkOut, nights, subtotal, ariaFee, taxes, taxPct, jurisdictionName, bookingTotal, depositAmount, walrusBlobId, guestName }) {
  const walrusHtml = walrusBlobId
    ? `<div style="background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:20px"><p style="margin:0 0 8px;font-size:12px;color:#555">WALRUS RECEIPT — PERMANENT ON-CHAIN RECORD</p><p style="margin:0;font-size:11px;color:#00ff44;word-break:break-all;font-family:monospace">${walrusBlobId}</p></div>`
    : '';
  return `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px">
    <h1 style="color:#00ff44;font-size:24px;margin:0 0 8px">✅ Booking Confirmed</h1>
    <p style="color:#888;margin:0 0 24px">Your ARIA booking receipt — ${guestName}</p>
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

  const checkInStr  = new Date(checkIn).toISOString().split('T')[0];
  const checkOutStr = new Date(checkOut).toISOString().split('T')[0];

  // Server-authoritative nights — derived from the dates themselves, never
  // trusted from a client/LLM-supplied `nights` field, so a tampered or
  // mis-stated value can't desync the stay length from what's actually booked.
  const nights = Math.round((new Date(checkOutStr) - new Date(checkInStr)) / (1000 * 60 * 60 * 24));
  if (!nights || nights < 1 || nights > 90) {
    return { error: 'Stay length must be between 1 and 90 nights' };
  }

  try {
    const conflict = await pool.query(
      `SELECT booking_ref FROM bookings
       WHERE property_id = $1 AND payment_status != 'cancelled'
       AND check_in < $3 AND check_out > $2`,
      [propertyId, checkInStr, checkOutStr]
    );
    if (conflict.rows.length > 0) {
      return { error: 'Property not available for selected dates', conflicts: conflict.rows };
    }
  } catch (err) { logger?.warn?.({ err }, 'Availability check failed'); }

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

  try {
    await pool.query(
      `INSERT INTO bookings (booking_ref, property_id, property_title, wallet_address, guest_name, guest_email,
        check_in, check_out, nights, price_per_night, subtotal, aria_fee, taxes, total_amount,
        deposit_amount, payment_status, payment_method, deposit_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'confirmed','SuiUSD','pending')`,
      [bookingRef, propertyId, propertyTitle, session.suiAddress, session.name, session.email,
       checkInStr, checkOutStr, nights, pricePerNight, subtotal, ariaFee, taxes, bookingTotal, depositAmount]
    );
  } catch (err) { logger?.warn?.({ err }, 'DB booking save failed'); }

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
  const walrusBlobId = await pushBookingReceiptToWalrus(receipt, logger);
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
  let escrowTxBytes = null;
  try {
    const hostAddr = await getPropertyHostAddress(propertyId, logger);
    if (hostAddr) {
      const built = await buildEscrowTransaction(bookingRef, session.suiAddress, hostAddr, depositAmount, logger);
      if (built?.txBytes) {
        escrowTxBytes = built.txBytes;
        // Recorded so /booking/claim-damage can verify the caller is really
        // this booking's host without re-deriving the lookup (and so the
        // record reflects the address actually baked into the on-chain
        // escrow object, even if catalog.mjs's mapping changes later).
        try {
          await pool.query('UPDATE bookings SET host_sui_address = $1 WHERE booking_ref = $2', [hostAddr, bookingRef]);
        } catch (err) { logger?.warn?.({ err, bookingRef }, 'Failed to persist host_sui_address'); }
      } else {
        logger?.warn?.({ bookingRef }, 'buildEscrowTransaction returned null');
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
    escrowTxBytes
  };
}
