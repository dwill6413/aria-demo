// Background keeper sweeps, extracted verbatim from server.mjs (R1 split,
// July 1 2026). Called once from server.mjs after routes are registered:
// startSweeps(fastify) — the param is the Fastify instance (used for .log).
import { pool } from './db.mjs';
import { autoReleaseEscrow, finalizeClaimEscrow, releasePaymentEscrow, buildEscrowTransaction } from './escrow.mjs';
import { createBooking, cancelBooking, cancelPendingCardBooking } from './bookings.mjs';
import { escapeHtml } from './emails.mjs';
import { resend, stripe } from './services.mjs';

export function startSweeps(fastify) {
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

// M6 fallback sweep: releases a Stripe-pending booking that never received
// EITHER a checkout.session.completed OR checkout.session.expired webhook —
// e.g. this server was down when Stripe tried to deliver it. Longer TTL than
// the Checkout Session's own 30-minute expiry (see /payment/create-intent)
// so this only fires when that expiry webhook itself went missing, not as
// the normal path (that's cancelPendingCardBooking, driven by the webhook).
const STRIPE_ABANDONED_TTL_MS = Number(process.env.STRIPE_ABANDONED_TTL_MS || 60 * 60 * 1000); // 1 hour
async function runStripeAbandonedSweep() {
  try {
    const result = await pool.query(
      `UPDATE bookings SET payment_status='cancelled', cancelled_at=NOW()
       WHERE payment_method='stripe' AND payment_status='pending'
       AND created_at < NOW() - ($1 || ' milliseconds')::interval`,
      [STRIPE_ABANDONED_TTL_MS]
    );
    if (result.rowCount > 0) fastify.log.info({ count: result.rowCount }, 'Stripe abandoned-booking fallback sweep released stale pending bookings');
  } catch (err) {
    fastify.log.error({ err }, 'Stripe abandoned-booking fallback sweep query failed');
  }
}
let _stripeAbandonedSweepRunning = false;
async function guardedStripeAbandonedSweep() {
  if (_stripeAbandonedSweepRunning) return;
  _stripeAbandonedSweepRunning = true;
  try { await runStripeAbandonedSweep(); }
  catch (err) { fastify.log.error({ err }, 'Stripe abandoned-booking sweep crashed'); }
  finally { _stripeAbandonedSweepRunning = false; }
}
setInterval(guardedStripeAbandonedSweep, ABANDONED_BOOKING_SWEEP_INTERVAL_MS);
setTimeout(guardedStripeAbandonedSweep, 25_000);
}
