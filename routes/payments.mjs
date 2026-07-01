// Extracted verbatim from server.mjs (R1 route-module split, July 1 2026).
import { pool } from '../db.mjs';
import { createPendingCardBooking, confirmCardBooking, cancelPendingCardBooking } from '../bookings.mjs';
import { paymentCreateIntentSchema, validateBody } from '../validation.mjs';
import { getAuthedSession } from '../authz.mjs';
import { stripe } from '../services.mjs';

export default async function paymentsRoutes(fastify) {
// Stripe Checkout (M6, July 2026) — card-payment fallback to the SuiUSD
// escrow flow. The old version created a PaymentIntent and handed back its
// clientSecret, but the frontend never actually loaded Stripe.js or called
// confirmCardPayment — it just faked a success state locally, so a booking
// could show as paid with no card ever having been charged. Fixed by
// switching to hosted Stripe Checkout (guest is redirected to Stripe's own
// page — no card data ever touches ARIA) and only trusting a real,
// signature-verified webhook event (POST /webhooks/stripe below) to mark the
// booking paid. This also fixes a second bug: the old route only took
// {propertyId, nights} and never recorded which dates were being booked.
fastify.post('/payment/create-intent', {
  config: {
    rateLimit: {
      max: 5,
      timeWindow: '15 minutes',
      errorResponseBuilder: () => ({ error: 'Too many payment attempts. Please wait 15 minutes and try again.' })
    }
  }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (validateBody(paymentCreateIntentSchema, request, reply)) return;

  const { propertyId, checkIn, checkOut, guests } = request.body;
  const result = await createPendingCardBooking({ propertyId, checkIn, checkOut, guests, session, logger: fastify.log });
  if (result.error) {
    return reply.code(result.status || 400).send({
      error: result.error,
      ...(result.needsVerification ? { needsVerification: true } : {}),
      ...(result.conflicts ? { conflicts: result.conflicts } : {})
    });
  }

  const { bookingRef, propertyTitle, nights, bookingTotal } = result;
  const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  // Must match lib/pricing.js's getCardTotal exactly — that's what the guest
  // saw on the "Pay with Card" button before clicking. Stripe's own
  // processing cost (~2.9% + $0.30) is passed through rather than absorbed,
  // same policy the pre-existing (but previously unwired) pricing.js formula
  // already encoded; toFixed(2) first so both sides round identically.
  const cardTotalDollars = Number((bookingTotal * 1.029 + 0.30).toFixed(2));

  let checkoutSession;
  try {
    checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: session.email || undefined,
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: `${propertyTitle} — ${nights} night${nights > 1 ? 's' : ''}` },
          unit_amount: Math.round(cardTotalDollars * 100),
        },
        quantity: 1,
      }],
      metadata: { bookingRef, propertyId: String(propertyId), walletAddress: session.suiAddress },
      success_url: `${frontendUrl}/bookings?stripe=success&ref=${encodeURIComponent(bookingRef)}`,
      cancel_url: `${frontendUrl}/listing/${propertyId}?stripe=cancelled`,
      // 30 min: enough time to fill out a card form, short enough that a
      // guest who abandons it doesn't hold these dates for long. The
      // abandoned-card-booking sweep below is the fallback if this session's
      // own checkout.session.expired webhook is somehow missed.
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });
  } catch (err) {
    fastify.log.error({ err, bookingRef }, 'Stripe Checkout Session creation failed');
    // Release the dates we just held — no point leaving a pending booking with no way to pay it.
    try {
      await pool.query(`UPDATE bookings SET payment_status='failed', cancelled_at=NOW() WHERE booking_ref=$1 AND payment_status='pending'`, [bookingRef]);
    } catch (cleanupErr) { fastify.log.warn({ cleanupErr, bookingRef }, 'Failed to release booking after Stripe session error'); }
    return reply.code(502).send({ error: 'Could not start the card payment. Please try again.' });
  }

  try {
    await pool.query(`UPDATE bookings SET stripe_checkout_session_id=$1 WHERE booking_ref=$2`, [checkoutSession.id, bookingRef]);
  } catch (err) { fastify.log.warn({ err, bookingRef }, 'Failed to persist stripe_checkout_session_id'); }

  return { url: checkoutSession.url, bookingRef };
});

// POST /webhooks/stripe (M6) — the only thing that can move a card-paid
// booking to 'confirmed' or release its held dates on expiry. Registered as
// its own encapsulated plugin so the raw-buffer content-type parser below
// applies ONLY to this route; every other route in the app keeps Fastify's
// normal JSON parsing untouched (Fastify plugin registration is encapsulated
// by default — a content-type parser added on the child `instance` here
// doesn't leak to the parent `fastify` app). Signature verification
// (stripe.webhooks.constructEvent) needs the exact raw bytes Stripe signed;
// a body Fastify already JSON-parsed and re-serialized would not match.
await fastify.register(async function stripeWebhookPlugin(instance) {
  instance.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    done(null, body);
  });

  instance.post('/webhooks/stripe', async (request, reply) => {
    const sig = request.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!webhookSecret) {
      fastify.log.error('STRIPE_WEBHOOK_SECRET is not set — refusing all Stripe webhook events');
      return reply.code(500).send({ error: 'Webhook not configured' });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(request.body, sig, webhookSecret);
    } catch (err) {
      fastify.log.warn({ err: err.message }, 'Stripe webhook signature verification failed');
      return reply.code(400).send({ error: 'Invalid signature' });
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const cs = event.data.object;
          // Not expanded at session-create time, so this is a plain string id.
          const paymentIntentId = typeof cs.payment_intent === 'string' ? cs.payment_intent : (cs.payment_intent?.id || null);
          const result = await confirmCardBooking({ stripeCheckoutSessionId: cs.id, stripePaymentIntentId: paymentIntentId, logger: fastify.log });
          if (result.error) fastify.log.error({ result, sessionId: cs.id }, 'confirmCardBooking failed for a verified webhook event');
          break;
        }
        case 'checkout.session.expired': {
          const cs = event.data.object;
          await cancelPendingCardBooking({ stripeCheckoutSessionId: cs.id, logger: fastify.log });
          break;
        }
        default:
          // Stripe sends many event types we don't act on — ack and move on
          // rather than treating "unrecognized" as an error.
          fastify.log.info({ type: event.type }, 'Unhandled Stripe webhook event type');
      }
    } catch (err) {
      fastify.log.error({ err, type: event.type }, 'Stripe webhook handler crashed');
      // 500 (not 200) so Stripe retries — confirmCardBooking/cancelPendingCardBooking
      // are idempotent, so a retry is safe.
      return reply.code(500).send({ error: 'Webhook handler error' });
    }

    return reply.code(200).send({ received: true });
  });
});
}
