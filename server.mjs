import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Stripe from 'stripe';
import { dotenvConfig } from './config.mjs';
import { getSuiUSDLiquidity, calculateHostPayout } from './deepbook.mjs';
import { generateICal, saveExternalCalendar, checkAvailability } from './ical.mjs';
import { Resend } from 'resend';
import { registerAIRoute } from './ai_route.mjs';
import { getZkLoginUrl, handleZkLoginCallback, getSession } from './auth.mjs';
import { initDB, pool } from './db.mjs';

dotenvConfig();

try { await initDB(); } catch (err) { console.error('DB init failed:', err.message); }

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

await registerAIRoute(fastify);

// ─── Health ───────────────────────────────────────────────────────────────────

fastify.get('/health', async () => {
  return { status: 'ok', app: 'ARIA Demo', network: process.env.SUI_NETWORK };
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

fastify.get('/auth/zklogin/init', async (request, reply) => {
  return getZkLoginUrl(request, reply);
});

fastify.get('/auth/zklogin/callback', async (request, reply) => {
  return handleZkLoginCallback(request, reply);
});

fastify.get('/auth/me', async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  return { address: session.suiAddress, email: session.email, name: session.name };
});

fastify.get('/auth/logout', async (request, reply) => {
  reply.clearCookie('aria_session');
  return { success: true };
});

// ─── Stripe ───────────────────────────────────────────────────────────────────

fastify.post('/payment/create-intent', async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  const { amount, propertyTitle } = request.body;
  const paymentIntent = await stripe.paymentIntents.create({
    amount: amount * 100,
    currency: 'usd',
    metadata: { property: propertyTitle, walletAddress: session.suiAddress, email: session.email }
  });
  return { clientSecret: paymentIntent.client_secret };
});

// ─── Booking Create ───────────────────────────────────────────────────────────

fastify.post('/booking/create', {
  config: {
    rateLimit: {
      max: 5,
      timeWindow: '15 minutes',
      errorResponseBuilder: () => ({ error: 'Too many booking attempts. Please wait 15 minutes and try again.' })
    }
  }
}, async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });

  const { propertyId, propertyTitle, nights, totalAmount } = request.body;
  const checkInRaw  = request.body.checkIn;
  const checkOutRaw = request.body.checkOut;

  if (!propertyId || !checkInRaw || !checkOutRaw)
    return reply.code(400).send({ error: 'propertyId, checkIn, and checkOut are required' });
  if (![1,2,3,4,5,6].includes(Number(propertyId)))
    return reply.code(400).send({ error: 'propertyId must be between 1 and 6' });
  if (isNaN(new Date(checkInRaw)) || isNaN(new Date(checkOutRaw)))
    return reply.code(400).send({ error: 'checkIn and checkOut must be valid dates (YYYY-MM-DD)' });
  if (new Date(checkOutRaw) <= new Date(checkInRaw))
    return reply.code(400).send({ error: 'checkOut must be after checkIn' });
  if (!nights || nights < 1 || nights > 90)
    return reply.code(400).send({ error: 'nights must be between 1 and 90' });
  if (!totalAmount || totalAmount <= 0)
    return reply.code(400).send({ error: 'totalAmount must be a positive number' });

  const checkInStr  = new Date(checkInRaw).toISOString().split('T')[0];
  const checkOutStr = new Date(checkOutRaw).toISOString().split('T')[0];

  // Double-booking guard
  try {
    const conflict = await pool.query(
      `SELECT booking_ref FROM bookings
       WHERE property_id = $1 AND payment_status != 'cancelled'
       AND check_in < $3 AND check_out > $2`,
      [propertyId, checkInStr, checkOutStr]
    );
    if (conflict.rows.length > 0) {
      return reply.code(409).send({ error: 'Property not available for selected dates' });
    }
  } catch (err) { fastify.log.warn({ err }, 'Availability check failed'); }

  const bookingRef    = `ARIA-${propertyId}-${Date.now()}`;
  const depositAmount = Math.round(totalAmount * 0.20);
  const pricePerNight = request.body.pricePerNight || Math.round(totalAmount / nights / 1.03 / 1.08);
  const subtotal      = pricePerNight * nights;
  const ariaFee       = Math.round(subtotal * 0.03);
  const taxes         = Math.round(subtotal * 0.08);
  const total         = subtotal + ariaFee + taxes;
  const hostPayout    = calculateHostPayout(subtotal);

  // Save to database
  try {
    await pool.query(
      `INSERT INTO bookings (booking_ref, property_id, property_title, wallet_address, guest_name, guest_email,
        check_in, check_out, nights, price_per_night, subtotal, aria_fee, taxes, total_amount,
        deposit_amount, payment_status, payment_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'confirmed','SuiUSD')`,
      [bookingRef, propertyId, propertyTitle, session.suiAddress, session.name, session.email,
       checkInStr, checkOutStr, nights, pricePerNight, subtotal, ariaFee, taxes, total, depositAmount]
    );
  } catch (err) { fastify.log.warn({ err }, 'DB booking save failed'); }

  // Walrus storage
  let walrusBlobId = null;
  try {
    const receipt = {
      bookingRef, app: 'ARIA Demo', network: 'sui:testnet',
      timestamp: new Date().toISOString(), property: propertyTitle, propertyId,
      checkIn: checkInStr, checkOut: checkOutStr, nights,
      breakdown: {
        pricePerNight: `$${pricePerNight}`, nights,
        subtotal: `$${subtotal}`, ariaFee: `$${ariaFee} (3%)`,
        taxes: `$${taxes} (8% occupancy tax)`, totalPaid: `$${total} SuiUSD`
      },
      hostPayout: { amount: `$${hostPayout.hostPayout} SuiUSD`, ariaFee: `$${hostPayout.ariaFee} SuiUSD`, settlementMethod: hostPayout.settlementMethod },
      walletAddress: session.suiAddress, guestName: session.name, guestEmail: session.email,
      paymentMethod: 'SuiUSD', paymentStatus: 'confirmed', depositAmount, depositStatus: 'held'
    };
    const walrusRes  = await fetch('https://publisher.walrus-testnet.walrus.space/v1/blobs?epochs=3', {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(JSON.stringify(receipt))
    });
    const walrusData = await walrusRes.json();
    walrusBlobId = walrusData?.newlyCreated?.blobObject?.blobId ?? walrusData?.alreadyCertified?.blobId ?? null;
    if (walrusBlobId) {
      await pool.query('UPDATE bookings SET walrus_blob_id = $1 WHERE booking_ref = $2', [walrusBlobId, bookingRef]);
    }
  } catch (err) { fastify.log.warn({ err }, 'Walrus storage failed'); }

  // Confirmation email
  try {
    const walrusHtml = walrusBlobId ? `<div style="background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:20px"><p style="margin:0 0 8px;font-size:12px;color:#555">WALRUS RECEIPT — PERMANENT ON-CHAIN RECORD</p><p style="margin:0;font-size:11px;color:#00ff44;word-break:break-all;font-family:monospace">${walrusBlobId}</p></div>` : '';
    await resend.emails.send({
      from: 'ARIA <onboarding@resend.dev>', to: session.email,
      subject: `Booking Confirmed — ${propertyTitle} | Ref: ${bookingRef}`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#00ff44;font-size:24px;margin:0 0 8px">✅ Booking Confirmed</h1><p style="color:#888;margin:0 0 24px">Your ARIA booking receipt — ${session.name}</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin-bottom:20px"><h2 style="margin:0 0 16px;font-size:18px">${propertyTitle}</h2><table style="width:100%;border-collapse:collapse"><tr><td style="color:#888;padding:6px 0">Booking Ref</td><td style="text-align:right">${bookingRef}</td></tr><tr><td style="color:#888;padding:6px 0">Check-in</td><td style="text-align:right">${checkInStr}</td></tr><tr><td style="color:#888;padding:6px 0">Check-out</td><td style="text-align:right">${checkOutStr}</td></tr><tr><td style="color:#888;padding:6px 0">Nights</td><td style="text-align:right">${nights}</td></tr><tr><td style="color:#888;padding:6px 0">Subtotal</td><td style="text-align:right">$${subtotal}</td></tr><tr><td style="color:#888;padding:6px 0">ARIA Fee (3%)</td><td style="text-align:right;color:#00ff44">$${ariaFee}</td></tr><tr><td style="color:#888;padding:6px 0">Taxes (8%)</td><td style="text-align:right">$${taxes}</td></tr><tr style="border-top:1px solid #333"><td style="padding:10px 0;font-weight:700">Total Paid</td><td style="text-align:right;font-weight:700;color:#00ff44">$${total} SuiUSD</td></tr></table></div>${walrusHtml}<p style="color:#555;font-size:12px;text-align:center;margin:0">Powered by ARIA — Built on Sui | The Airbnb killer</p></div>`
    });
  } catch (err) { fastify.log.warn({ err }, 'Booking confirmation email failed'); }

  return { success: true, bookingRef, property: propertyTitle, nights, totalAmount: total,
    walletAddress: session.suiAddress, network: 'sui:testnet',
    message: 'Booking confirmed on Sui testnet', walrusBlobId };
});

// ─── Booking Cancel ───────────────────────────────────────────────────────────

fastify.post('/booking/cancel', {
  config: {
    rateLimit: {
      max: 10, timeWindow: '1 hour',
      errorResponseBuilder: () => ({ error: 'Too many cancellation attempts. Please wait and try again.' })
    }
  }
}, async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });

  const { bookingRef } = request.body;
  if (!bookingRef || typeof bookingRef !== 'string' || !bookingRef.startsWith('ARIA-'))
    return reply.code(400).send({ error: 'A valid bookingRef is required' });

  try {
    const result = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Booking not found' });
    const booking = result.rows[0];
    if (booking.wallet_address !== session.suiAddress) return reply.code(403).send({ error: 'Not your booking' });
    if (booking.payment_status === 'cancelled') return reply.code(400).send({ error: 'Already cancelled' });

    const today = new Date(); today.setHours(0,0,0,0);
    const depositAutoReleased = today < new Date(booking.check_in);
    const cancelledAt = new Date().toISOString();

    await pool.query(
      `UPDATE bookings SET payment_status='cancelled', cancelled_at=$1, deposit_status=$2 WHERE booking_ref=$3`,
      [cancelledAt, depositAutoReleased ? 'released' : 'held', bookingRef]
    );

    const cancellationWalrusBlobId = await pushToWalrus({ ...booking, walrusReceiptType: 'cancellation', cancellationTimestamp: cancelledAt });
    if (cancellationWalrusBlobId) {
      await pool.query('UPDATE bookings SET cancellation_walrus_blob_id=$1 WHERE booking_ref=$2', [cancellationWalrusBlobId, bookingRef]);
    }

    try {
      const depositNote = depositAutoReleased
        ? `<div style="background:#0a1a0a;border:1px solid #1a4a1a;border-radius:6px;padding:10px;margin-top:10px"><p style="color:#00ff44;font-size:12px;font-weight:600;margin:0 0 4px">🔓 Security deposit auto-released</p><p style="color:#888;font-size:12px;margin:0">Your damage deposit has been automatically returned since you cancelled before check-in.</p></div>`
        : `<div style="background:#0a0a1a;border:1px solid #1a1a3a;border-radius:6px;padding:10px;margin-top:10px"><p style="color:#4a9eff;font-size:12px;font-weight:600;margin:0 0 4px">🔒 Security deposit pending release</p><p style="color:#888;font-size:12px;margin:0">Your deposit will be reviewed and released by the host.</p></div>`;
      await resend.emails.send({
        from: 'ARIA <onboarding@resend.dev>', to: booking.guest_email,
        subject: `Booking Cancelled — ${booking.property_title} | Ref: ${bookingRef}`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#ff4444;font-size:24px;margin:0 0 8px">❌ Booking Cancelled</h1><p style="color:#888;margin:0 0 24px">Your cancellation confirmation — ${booking.guest_name}</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin-bottom:20px"><h2 style="margin:0 0 16px;font-size:18px">${booking.property_title}</h2>${depositNote}</div><p style="color:#555;font-size:12px;text-align:center;margin:0">Powered by ARIA — Built on Sui</p></div>`
      });
    } catch (err) { fastify.log.warn({ err }, 'Cancellation email failed'); }

    return { success: true, bookingRef, depositAutoReleased, cancellationWalrusBlobId,
      message: depositAutoReleased ? 'Booking cancelled. Deposit auto-released.' : 'Booking cancelled. Deposit pending host review.' };
  } catch (err) {
    return reply.code(500).send({ error: 'Failed to cancel booking' });
  }
});

// ─── Release Deposit ──────────────────────────────────────────────────────────

fastify.post('/booking/release-deposit', {
  config: {
    rateLimit: {
      max: 10, timeWindow: '1 hour',
      errorResponseBuilder: () => ({ error: 'Too many deposit release attempts.' })
    }
  }
}, async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });

  const { bookingRef } = request.body;
  if (!bookingRef || typeof bookingRef !== 'string' || !bookingRef.startsWith('ARIA-'))
    return reply.code(400).send({ error: 'A valid bookingRef is required' });

  try {
    const result = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Booking not found' });
    const booking = result.rows[0];
    if (booking.deposit_status === 'released') return reply.code(400).send({ error: 'Deposit already released' });

    await pool.query('UPDATE bookings SET deposit_status=$1 WHERE booking_ref=$2', ['released', bookingRef]);

    const depositReleaseWalrusBlobId = await pushToWalrus({ ...booking, walrusReceiptType: 'deposit_release', depositReleaseTimestamp: new Date().toISOString() });

    return { success: true, bookingRef, depositReleaseWalrusBlobId, message: 'Deposit released to guest.' };
  } catch (err) {
    return reply.code(500).send({ error: 'Failed to release deposit' });
  }
});

// ─── Walrus helper ────────────────────────────────────────────────────────────

async function pushToWalrus(data) {
  try {
    const res  = await fetch('https://publisher.walrus-testnet.walrus.space/v1/blobs?epochs=3', {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(JSON.stringify(data))
    });
    const json = await res.json();
    return json?.newlyCreated?.blobObject?.blobId ?? json?.alreadyCertified?.blobId ?? null;
  } catch (err) { fastify.log.warn({ err }, 'Walrus push failed'); return null; }
}

// ─── Bookings History (guest) ─────────────────────────────────────────────────

fastify.get('/bookings/history', async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  try {
    const result = await pool.query(
      'SELECT * FROM bookings WHERE wallet_address = $1 ORDER BY created_at DESC',
      [session.suiAddress]
    );
    return { bookings: result.rows.map(b => ({
      bookingRef: b.booking_ref, property: b.property_title, propertyId: b.property_id,
      checkIn: b.check_in, checkOut: b.check_out, nights: b.nights,
      totalAmount: b.total_amount, paymentStatus: b.payment_status,
      depositStatus: b.deposit_status, walrusBlobId: b.walrus_blob_id,
      timestamp: b.created_at, walletAddress: b.wallet_address,
      breakdown: {
        pricePerNight: `$${b.price_per_night}`, nights: b.nights,
        subtotal: `$${b.subtotal}`, ariaFee: `$${b.aria_fee} (3%)`,
        taxes: `$${b.taxes} (8% occupancy tax)`, totalPaid: `$${b.total_amount} SuiUSD`
      }
    }))};
  } catch (err) { return { bookings: [] }; }
});

// ─── Bookings All (host) ──────────────────────────────────────────────────────

fastify.get('/bookings/all', async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  try {
    const result = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC');
    return { bookings: result.rows.map(b => ({
      bookingRef: b.booking_ref, property: b.property_title, propertyId: b.property_id,
      checkIn: b.check_in, checkOut: b.check_out, nights: b.nights,
      totalAmount: b.total_amount, paymentStatus: b.payment_status,
      depositStatus: b.deposit_status, walrusBlobId: b.walrus_blob_id,
      guestName: b.guest_name, guestEmail: b.guest_email,
      walletAddress: b.wallet_address, timestamp: b.created_at,
      breakdown: {
        pricePerNight: `$${b.price_per_night}`, nights: b.nights,
        subtotal: `$${b.subtotal}`, ariaFee: `$${b.aria_fee} (3%)`,
        taxes: `$${b.taxes} (8% occupancy tax)`, totalPaid: `$${b.total_amount} SuiUSD`
      }
    }))};
  } catch (err) { return { bookings: [] }; }
});

// ─── DeepBook ─────────────────────────────────────────────────────────────────

fastify.get('/deepbook/payout/:amount', async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  const amount = parseFloat(request.params.amount);
  if (!amount || amount <= 0) return reply.code(400).send({ error: 'Invalid amount' });
  const liquidity = await getSuiUSDLiquidity(amount);
  const payout    = calculateHostPayout(amount);
  return { ...payout, liquidity, timestamp: new Date().toISOString() };
});

// ─── iCal ─────────────────────────────────────────────────────────────────────

fastify.get('/ical/:propertyId', async (request, reply) => {
  const { propertyId } = request.params;
  const propertyTitles = { '1': 'Oceanfront Villa', '2': 'Downtown Loft', '3': 'Mountain Cabin', '4': 'Desert Retreat', '5': 'Lake House', '6': 'Historic Brownstone' };
  const icalData = generateICal(propertyId, propertyTitles[propertyId] || 'Property ' + propertyId);
  reply.header('Content-Type', 'text/calendar; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="aria-property-${propertyId}.ics"`);
  return reply.send(icalData);
});

fastify.post('/ical/import', async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  const { propertyId, platform, icalUrl } = request.body;
  if (!propertyId || !platform || !icalUrl) return reply.code(400).send({ error: 'propertyId, platform and icalUrl required' });
  const saved = saveExternalCalendar(propertyId, platform, icalUrl);
  return { success: true, message: `${platform} calendar synced for property ${propertyId}`, calendars: saved };
});

fastify.get('/availability/:propertyId', async (request, reply) => {
  const { propertyId } = request.params;
  const { checkIn, checkOut } = request.query;
  if (!checkIn || !checkOut) return reply.code(400).send({ error: 'checkIn and checkOut required' });
  const availability = await checkAvailability(propertyId, checkIn, checkOut);
  return { propertyId, checkIn, checkOut, ...availability };
});

// ─── Messages ─────────────────────────────────────────────────────────────────

fastify.post('/messages/send', async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  const { bookingRef, message } = request.body;
  if (!bookingRef || !message) return reply.code(400).send({ error: 'bookingRef and message required' });
  try {
    await pool.query(
      'INSERT INTO messages (booking_ref, from_name, from_email, message) VALUES ($1,$2,$3,$4)',
      [bookingRef, session.name, session.email, message]
    );
    return { success: true, message: 'Message sent.' };
  } catch (err) { return reply.code(500).send({ error: 'Failed to send message' }); }
});

fastify.get('/messages/:bookingRef', async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  const { bookingRef } = request.params;
  try {
    const result = await pool.query(
      'SELECT * FROM messages WHERE booking_ref = $1 ORDER BY created_at ASC',
      [bookingRef]
    );
    return { messages: result.rows.map(m => ({ from: m.from_name, email: m.from_email, message: m.message, timestamp: m.created_at })) };
  } catch (err) { return { messages: [] }; }
});

fastify.post('/messages/:bookingRef/read', async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  return { success: true };
});

fastify.get('/messages/:bookingRef/count', async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  const { bookingRef } = request.params;
  try {
    const result = await pool.query(
      'SELECT COUNT(*) FROM messages WHERE booking_ref = $1 AND from_email != $2',
      [bookingRef, session.email]
    );
    return { count: parseInt(result.rows[0].count) };
  } catch (err) { return { count: 0 }; }
});

// ─── Reviews ──────────────────────────────────────────────────────────────────

fastify.post('/reviews/submit', async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  const { propertyId, bookingRef, rating, review } = request.body;
  if (!propertyId || !bookingRef || !rating || !review) return reply.code(400).send({ error: 'All fields required' });
  if (rating < 1 || rating > 5) return reply.code(400).send({ error: 'Rating must be 1-5' });
  try {
    const existing = await pool.query('SELECT id FROM reviews WHERE booking_ref = $1', [bookingRef]);
    if (existing.rows.length > 0) return reply.code(400).send({ error: 'Already reviewed' });
    await pool.query(
      'INSERT INTO reviews (property_id, booking_ref, guest_name, guest_email, rating, review) VALUES ($1,$2,$3,$4,$5,$6)',
      [propertyId, bookingRef, session.name, session.email, rating, review]
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
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  try {
    const result = await pool.query('SELECT * FROM reviews ORDER BY created_at DESC');
    return { reviews: result.rows };
  } catch (err) { return { reviews: [] }; }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT || '3001');
await fastify.listen({ port, host: '0.0.0.0' });
console.log('ARIA API running on port ' + port);
