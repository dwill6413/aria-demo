// Extracted verbatim from server.mjs (R1 route-module split, July 1 2026).
import { isValidTransactionDigest } from '@mysten/sui/utils';
import { pool } from '../db.mjs';
import { getProperty } from '../catalog.mjs';
import { verifyEscrowTransaction, buildClaimDamageTransaction, buildDisputeClaimTransaction, verifyClaimDamageTransaction, verifyDisputeClaimTransaction, resolveDisputeEscrow, verifyBookingPaymentTransaction, buildBookingPaymentTransaction, buildEscrowTransaction } from '../escrow.mjs';
import { createBooking, releaseDepositForBooking, cancelBooking, getPropertyHostAddress } from '../bookings.mjs';
import { pushToWalrus } from '../walrus.mjs';
import { escapeHtml } from '../emails.mjs';
import { bookingCreateSchema, validateBody, claimDamageSchema, claimDamageConfirmSchema, disputeClaimSchema, disputeClaimConfirmSchema, resolveDisputeSchema } from '../validation.mjs';
import { HOST_ADDRESSES, isHost, canManageProperty, getOwnedPropertyIds, canClaimAsHost, getAuthedSession } from '../authz.mjs';
import { resend, stripe } from '../services.mjs';

export default async function bookingsRoutes(fastify) {
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
      // M6: paymentMethod was never returned here, so the frontend's
      // `b.paymentMethod || 'SuiUSD'` fallback always fired — every booking
      // displayed as SuiUSD regardless of the actual payment_method column.
      // Currency label follows the same field so a card-paid booking's
      // breakdown says USD instead of the wrong (and non-existent) "SuiUSD".
      const currencyLabel = b.payment_method === 'stripe' ? 'USD' : 'SuiUSD';
      return {
        bookingRef: b.booking_ref, property: b.property_title, propertyId: b.property_id,
        checkIn: b.check_in, checkOut: b.check_out, nights: b.nights,
        totalAmount: b.total_amount, ariaFee: b.aria_fee, taxes: b.taxes, chargeAmount,
        paymentStatus: b.payment_status, paymentMethod: b.payment_method || 'SuiUSD',
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
          bookingTotal: `$${b.total_amount} ${currencyLabel}`,
          depositAmount: b.deposit_amount ? `$${b.deposit_amount} (refundable — no ARIA fee)` : null,
          totalCharged: `$${chargeAmount} ${currencyLabel}`,
          totalPaid: `$${b.total_amount} ${currencyLabel}`
        }
      };
    })};
  } catch (err) { fastify.log.error({ err }, '/bookings/history query failed'); return { bookings: [] }; }
});

// Bookings All — HOST ONLY, scoped to the requesting host's own properties
// (R6) — superadmins (HOST_ADDRESSES) still see everything.
fastify.get('/bookings/all', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  const ownedIds = await getOwnedPropertyIds(session);
  if (ownedIds && ownedIds.size === 0) return { bookings: [] };
  try {
    // Bounded (Codex review): cap the host bookings feed so one request can't
    // pull the whole table into memory. Proper offset/cursor pagination is a
    // follow-up (see roadmap tech debt). Tunable via BOOKINGS_ALL_LIMIT.
    const allLimit = Number(process.env.BOOKINGS_ALL_LIMIT || 500);
    const result = ownedIds
      ? await pool.query(
          'SELECT * FROM bookings WHERE property_id = ANY($1) ORDER BY created_at DESC LIMIT $2',
          [[...ownedIds], allLimit]
        )
      : await pool.query('SELECT * FROM bookings ORDER BY created_at DESC LIMIT $1', [allLimit]);
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
        checkedIn: b.checked_in === true, checkedInAt: b.checked_in_at || null,
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
}
