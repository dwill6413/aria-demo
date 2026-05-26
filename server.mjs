import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Stripe from 'stripe';
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { dotenvConfig } from './config.mjs';
import { getSuiUSDLiquidity, calculateHostPayout } from './deepbook.mjs';
import { generateICal, saveExternalCalendar, checkAvailability } from './ical.mjs';
import { Resend } from 'resend';
import { registerAIRoute } from './ai_route.mjs';
import { getZkLoginUrl, handleZkLoginCallback, getSession } from './auth.mjs';
import { initDB, pool } from './db.mjs';

dotenvConfig();
await initDB();

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

  const checkIn    = new Date(checkInRaw);
  const checkOut   = new Date(checkOutRaw);
  const checkInStr  = checkIn.toISOString().split('T')[0];
  const checkOutStr = checkOut.toISOString().split('T')[0];

  // Double-booking guard
  try {
    const receiptsDir = join(process.cwd(), 'receipts');
    if (existsSync(receiptsDir)) {
      const files = readdirSync(receiptsDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const existing = JSON.parse(readFileSync(join(receiptsDir, file), 'utf8'));
          if (String(existing.propertyId) === String(propertyId) && existing.paymentStatus !== 'cancelled') {
            const exIn = new Date(existing.checkIn), exOut = new Date(existing.checkOut);
            const newIn = new Date(checkInStr), newOut = new Date(checkOutStr);
            if (newIn < exOut && newOut > exIn) {
              return reply.code(409).send({ error: 'Property not available for selected dates', conflicts: [{ checkIn: existing.checkIn, checkOut: existing.checkOut }] });
            }
          }
        } catch { /* skip unreadable files */ }
      }
    }
  } catch (err) {
    fastify.log.warn({ err }, 'Availability check failed');
  }

  const bookingRef    = `ARIA-${propertyId}-${Date.now()}`;
  const depositAmount = Math.round(totalAmount * 0.20);
  const pricePerNight = request.body.pricePerNight || Math.round(totalAmount / nights / 1.03 / 1.08);
  const subtotal      = pricePerNight * nights;
  const ariaFee       = Math.round(subtotal * 0.03);
  const taxes         = Math.round(subtotal * 0.08);
  const total         = subtotal + ariaFee + taxes;
  const hostPayout    = calculateHostPayout(subtotal);

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

  const receiptsDir = join(process.cwd(), 'receipts');
  try {
    if (!existsSync(receiptsDir)) mkdirSync(receiptsDir);
    writeFileSync(join(receiptsDir, `${bookingRef}.json`), JSON.stringify(receipt, null, 2));
  } catch (err) { fastify.log.warn({ err }, 'Local receipt save failed'); }

  let walrusBlobId = null, walrusObjectId = null;
  try {
    const walrusRes  = await fetch('https://publisher.walrus-testnet.walrus.space/v1/blobs?epochs=3', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from(JSON.stringify(receipt)) });
    const walrusData = await walrusRes.json();
    walrusBlobId   = walrusData?.newlyCreated?.blobObject?.blobId   ?? walrusData?.alreadyCertified?.blobId ?? null;
    walrusObjectId = walrusData?.newlyCreated?.blobObject?.id        ?? walrusData?.alreadyCertified?.eventOrObject?.Object?.objectId ?? null;
    writeFileSync(join(receiptsDir, `${bookingRef}.json`), JSON.stringify({ ...receipt, walrusBlobId, walrusObjectId }, null, 2));
  } catch (err) { fastify.log.warn({ err }, 'Walrus storage failed'); }

  try {
    const emailRows = [['Booking Ref',bookingRef],['Check-in',checkInStr],['Check-out',checkOutStr],['Nights',nights],['Price per night',receipt.breakdown.pricePerNight],['Subtotal',receipt.breakdown.subtotal],['ARIA Fee (3%)',receipt.breakdown.ariaFee],['Taxes (8%)',receipt.breakdown.taxes]];
    const rowsHtml  = emailRows.map(([l,v]) => `<tr><td style="color:#888;padding:6px 0">${l}</td><td style="text-align:right">${v}</td></tr>`).join('');
    const totalRow  = `<tr style="border-top:1px solid #333"><td style="padding:10px 0;font-weight:700">Total Paid</td><td style="text-align:right;font-weight:700;color:#00ff44">${receipt.breakdown.totalPaid}</td></tr>`;
    const walrusHtml = walrusBlobId ? `<div style="background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:20px"><p style="margin:0 0 8px;font-size:12px;color:#555">WALRUS RECEIPT — PERMANENT ON-CHAIN RECORD</p><p style="margin:0;font-size:11px;color:#00ff44;word-break:break-all;font-family:monospace">${walrusBlobId}</p></div>` : '';
    await resend.emails.send({ from: 'ARIA <onboarding@resend.dev>', to: session.email, subject: `Booking Confirmed — ${propertyTitle} | Ref: ${bookingRef}`, html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#00ff44;font-size:24px;margin:0 0 8px">✅ Booking Confirmed</h1><p style="color:#888;margin:0 0 24px">Your ARIA booking receipt — ${session.name}</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin-bottom:20px"><h2 style="margin:0 0 16px;font-size:18px">${propertyTitle}</h2><table style="width:100%;border-collapse:collapse">${rowsHtml}${totalRow}</table></div>${walrusHtml}<p style="color:#555;font-size:12px;text-align:center;margin:0">Powered by ARIA — Built on Sui | The Airbnb killer</p></div>` });
  } catch (err) { fastify.log.warn({ err }, 'Booking confirmation email failed'); }

  return { success: true, bookingRef, property: propertyTitle, nights, totalAmount: total, walletAddress: session.suiAddress, network: 'sui:testnet', message: 'Booking confirmed on Sui testnet', walrusBlobId, walrusObjectId };
});

// ─── Booking Cancel ───────────────────────────────────────────────────────────

fastify.post('/booking/cancel', {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: '1 hour',
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
    return reply.code(400).send({ error: 'A valid bookingRef is required (e.g. ARIA-1-1234567890)' });

  try {
    const filePath = join(process.cwd(), 'receipts', bookingRef + '.json');
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'Booking not found' });
    const booking = JSON.parse(readFileSync(filePath, 'utf8'));
    if (booking.walletAddress !== session.suiAddress) return reply.code(403).send({ error: 'Not your booking' });
    if (booking.paymentStatus === 'cancelled') return reply.code(400).send({ error: 'Already cancelled' });

    booking.paymentStatus = 'cancelled';
    booking.cancelledAt   = new Date().toISOString();

    const today = new Date(); today.setHours(0,0,0,0);
    const depositAutoReleased = today < new Date(booking.checkIn);
    if (depositAutoReleased) {
      booking.depositStatus     = 'released';
      booking.depositReleasedAt = new Date().toISOString();
      booking.depositNote       = 'Auto-released on pre-check-in cancellation';
    }

    writeFileSync(join(process.cwd(), 'receipts', bookingRef + '.json'), JSON.stringify(booking, null, 2));

    const cancellationWalrusBlobId = await pushToWalrus({ ...booking, walrusReceiptType: 'cancellation', cancellationTimestamp: booking.cancelledAt });
    if (cancellationWalrusBlobId) {
      booking.cancellationWalrusBlobId = cancellationWalrusBlobId;
      writeFileSync(join(process.cwd(), 'receipts', bookingRef + '.json'), JSON.stringify(booking, null, 2));
    }

    try {
      const refundAmount = booking.breakdown?.totalPaid || `$${booking.totalAmount} SuiUSD`;
      const depositNote  = depositAutoReleased
        ? `<div style="background:#0a1a0a;border:1px solid #1a4a1a;border-radius:6px;padding:10px;margin-top:10px"><p style="color:#00ff44;font-size:12px;font-weight:600;margin:0 0 4px">🔓 Security deposit auto-released</p><p style="color:#888;font-size:12px;margin:0">Your damage deposit has been automatically returned since you cancelled before check-in.</p></div>`
        : `<div style="background:#0a0a1a;border:1px solid #1a1a3a;border-radius:6px;padding:10px;margin-top:10px"><p style="color:#4a9eff;font-size:12px;font-weight:600;margin:0 0 4px">🔒 Security deposit pending release</p><p style="color:#888;font-size:12px;margin:0">Your deposit will be reviewed and released by the host.</p></div>`;
      const walrusHtml = cancellationWalrusBlobId ? `<div style="background:#111;border:1px solid #222;border-radius:8px;padding:12px;margin-bottom:16px"><p style="margin:0 0 6px;font-size:11px;color:#555">CANCELLATION RECEIPT — PERMANENT ON-CHAIN RECORD</p><p style="margin:0;font-size:11px;color:#00ff44;word-break:break-all;font-family:monospace">${cancellationWalrusBlobId}</p></div>` : '';
      await resend.emails.send({ from: 'ARIA <onboarding@resend.dev>', to: booking.guestEmail, subject: `Booking Cancelled — ${booking.property} | Ref: ${bookingRef}`, html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#ff4444;font-size:24px;margin:0 0 8px">❌ Booking Cancelled</h1><p style="color:#888;margin:0 0 24px">Your cancellation confirmation — ${booking.guestName}</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin-bottom:20px"><h2 style="margin:0 0 16px;font-size:18px">${booking.property}</h2><table style="width:100%;border-collapse:collapse"><tr><td style="color:#888;padding:6px 0">Booking Ref</td><td style="text-align:right">${bookingRef}</td></tr><tr><td style="color:#888;padding:6px 0">Check-in</td><td style="text-align:right">${booking.checkIn}</td></tr><tr><td style="color:#888;padding:6px 0">Check-out</td><td style="text-align:right">${booking.checkOut}</td></tr><tr><td style="color:#888;padding:6px 0">Nights</td><td style="text-align:right">${booking.nights}</td></tr><tr style="border-top:1px solid #333"><td style="padding:10px 0;font-weight:700">Refund Amount</td><td style="text-align:right;font-weight:700;color:#00ff44">${refundAmount}</td></tr></table>${depositNote}</div>${walrusHtml}<div style="background:#1a0a0a;border:1px solid #3a1a1a;border-radius:8px;padding:16px;margin-bottom:20px"><p style="color:#ff6666;font-size:13px;font-weight:600;margin:0 0 6px">Refund Policy</p><p style="color:#888;font-size:13px;margin:0;line-height:1.6">Full refund processed within 24 hours. Refund will be returned to your original SuiUSD wallet address.</p></div><p style="color:#555;font-size:12px;text-align:center;margin:0">Powered by ARIA — Built on Sui | The Airbnb killer</p></div>` });
    } catch (err) { fastify.log.warn({ err }, 'Cancellation email failed'); }

    return { success: true, bookingRef, depositAutoReleased, cancellationWalrusBlobId, message: depositAutoReleased ? 'Booking cancelled. Deposit auto-released. Full refund within 24 hours.' : 'Booking cancelled. Full refund within 24 hours. Deposit pending host review.' };
  } catch (err) {
    return reply.code(500).send({ error: 'Failed to cancel booking' });
  }
});

// ─── Release Deposit ──────────────────────────────────────────────────────────

fastify.post('/booking/release-deposit', {
  config: {
    rateLimit: {
      max: 10,
      timeWindow: '1 hour',
      errorResponseBuilder: () => ({ error: 'Too many deposit release attempts. Please wait and try again.' })
    }
  }
}, async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });

  const { bookingRef } = request.body;
  if (!bookingRef || typeof bookingRef !== 'string' || !bookingRef.startsWith('ARIA-'))
    return reply.code(400).send({ error: 'A valid bookingRef is required (e.g. ARIA-1-1234567890)' });

  try {
    const filePath = join(process.cwd(), 'receipts', bookingRef + '.json');
    if (!existsSync(filePath)) return reply.code(404).send({ error: 'Booking not found' });
    const booking = JSON.parse(readFileSync(filePath, 'utf8'));
    if (booking.depositStatus === 'released') return reply.code(400).send({ error: 'Deposit already released' });
    booking.depositStatus     = 'released';
    booking.depositReleasedAt = new Date().toISOString();
    writeFileSync(filePath, JSON.stringify(booking, null, 2));

    const depositReleaseWalrusBlobId = await pushToWalrus({ ...booking, walrusReceiptType: 'deposit_release', depositReleaseTimestamp: booking.depositReleasedAt });
    if (depositReleaseWalrusBlobId) {
      booking.depositReleaseWalrusBlobId = depositReleaseWalrusBlobId;
      writeFileSync(filePath, JSON.stringify(booking, null, 2));
    }

    return { success: true, bookingRef, depositReleaseWalrusBlobId, message: 'Deposit released to guest.' };
  } catch (err) {
    return reply.code(500).send({ error: 'Failed to release deposit' });
  }
});

// ─── Walrus helper ────────────────────────────────────────────────────────────

async function pushToWalrus(data) {
  try {
    const res  = await fetch('https://publisher.walrus-testnet.walrus.space/v1/blobs?epochs=3', { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from(JSON.stringify(data)) });
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
    const receiptsDir = join(process.cwd(), 'receipts');
    if (!existsSync(receiptsDir)) return { bookings: [] };
    const files = readdirSync(receiptsDir).filter(f => f.endsWith('.json'));
    const bookings = files.map(f => { try { return JSON.parse(readFileSync(join(receiptsDir, f), 'utf8')); } catch { return null; } }).filter(b => b && b.walletAddress === session.suiAddress).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return { bookings };
  } catch (err) { return { bookings: [] }; }
});

// ─── Bookings All (host) ──────────────────────────────────────────────────────

fastify.get('/bookings/all', async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  try {
    const receiptsDir = join(process.cwd(), 'receipts');
    if (!existsSync(receiptsDir)) return { bookings: [] };
    const files = readdirSync(receiptsDir).filter(f => f.endsWith('.json'));
    const bookings = files.map(f => { try { return JSON.parse(readFileSync(join(receiptsDir, f), 'utf8')); } catch { return null; } }).filter(Boolean).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return { bookings };
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
    const messagesDir = join(process.cwd(), 'messages');
    if (!existsSync(messagesDir)) mkdirSync(messagesDir);
    const filePath = join(messagesDir, bookingRef + '.json');
    const thread   = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : [];
    thread.push({ from: session.name, email: session.email, message, timestamp: new Date().toISOString() });
    writeFileSync(filePath, JSON.stringify(thread, null, 2));
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
    const filePath = join(process.cwd(), 'messages', bookingRef + '.json');
    if (!existsSync(filePath)) return { messages: [] };
    return { messages: JSON.parse(readFileSync(filePath, 'utf8')) };
  } catch (err) { return { messages: [] }; }
});

fastify.post('/messages/:bookingRef/read', async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  const { bookingRef } = request.params;
  try {
    const messagesDir = join(process.cwd(), 'messages');
    if (!existsSync(messagesDir)) mkdirSync(messagesDir);
    const safeEmail = session.email.replace(/[^a-zA-Z0-9]/g, '_');
    writeFileSync(join(messagesDir, `read-${safeEmail}-${bookingRef}.json`), JSON.stringify({ lastRead: new Date().toISOString() }));
    return { success: true };
  } catch (err) { return { success: false }; }
});

fastify.get('/messages/:bookingRef/count', async (request, reply) => {
  const sessionId = request.cookies.aria_session;
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  const { bookingRef } = request.params;
  try {
    const messagesDir = join(process.cwd(), 'messages');
    const filePath    = join(messagesDir, bookingRef + '.json');
    if (!existsSync(filePath)) return { count: 0 };
    const messages      = JSON.parse(readFileSync(filePath, 'utf8'));
    const otherMessages = messages.filter(m => m.email !== session.email);
    if (otherMessages.length === 0) return { count: 0 };
    const safeEmail = session.email.replace(/[^a-zA-Z0-9]/g, '_');
    const readFile  = join(messagesDir, `read-${safeEmail}-${bookingRef}.json`);
    if (!existsSync(readFile)) return { count: otherMessages.length };
    const { lastRead } = JSON.parse(readFileSync(readFile, 'utf8'));
    return { count: otherMessages.filter(m => new Date(m.timestamp) > new Date(lastRead)).length };
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
    const reviewsDir = join(process.cwd(), 'reviews');
    if (!existsSync(reviewsDir)) mkdirSync(reviewsDir);
    const filePath = join(reviewsDir, `property-${propertyId}.json`);
    const reviews  = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : [];
    if (reviews.find(r => r.bookingRef === bookingRef)) return reply.code(400).send({ error: 'Already reviewed' });
    reviews.push({ bookingRef, propertyId, rating, review, guestName: session.name, guestEmail: session.email, timestamp: new Date().toISOString() });
    writeFileSync(filePath, JSON.stringify(reviews, null, 2));
    return { success: true, message: 'Review submitted.' };
  } catch (err) { return reply.code(500).send({ error: 'Failed to submit review' }); }
});

fastify.get('/reviews/:propertyId', async (request, reply) => {
  const { propertyId } = request.params;
  try {
    const filePath = join(process.cwd(), 'reviews', `property-${propertyId}.json`);
    if (!existsSync(filePath)) return { reviews: [], averageRating: 0, count: 0 };
    const reviews       = JSON.parse(readFileSync(filePath, 'utf8'));
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
    const reviewsDir = join(process.cwd(), 'reviews');
    if (!existsSync(reviewsDir)) return { reviews: [] };
    const files = readdirSync(reviewsDir).filter(f => f.endsWith('.json'));
    const allReviews = files.flatMap(f => { try { return JSON.parse(readFileSync(join(reviewsDir, f), 'utf8')); } catch { return []; } }).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    return { reviews: allReviews };
  } catch (err) { return { reviews: [] }; }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT || '3001');
await fastify.listen({ port, host: '0.0.0.0' });
console.log('ARIA API running on port ' + port);
