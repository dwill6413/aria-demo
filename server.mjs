import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Stripe from 'stripe';
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { dotenvConfig } from './config.mjs';
import { getSuiUSDLiquidity, calculateHostPayout } from './deepbook.mjs';
import { generateICal, saveExternalCalendar, checkAvailability } from './ical.mjs';
import { Resend } from 'resend';
import { registerAIRoute } from './ai_route.mjs';
import { getZkLoginUrl, handleZkLoginCallback, getSession } from './auth.mjs';
import { initDB, pool } from './db.mjs';

dotenvConfig();

// ─── Sui Escrow Client ────────────────────────────────────────────────────────
const suiClient = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('testnet') });
let deployerKeypair = null;
try {
  if (process.env.ARIA_DEPLOYER_KEY) {
    const { secretKey } = decodeSuiPrivateKey(process.env.ARIA_DEPLOYER_KEY);
    deployerKeypair = Ed25519Keypair.fromSecretKey(secretKey);
    console.log('Sui deployer keypair loaded:', deployerKeypair.toSuiAddress());
  }
} catch (err) {
  console.warn('ARIA_DEPLOYER_KEY invalid or missing — escrow transactions disabled:', err.message);
}

try { await initDB(); } catch (err) { console.error('DB init failed:', err.message); }

// ─── On-Chain Escrow Helpers ──────────────────────────────────────────────────

// Creates a BookingEscrow shared object on Sui testnet.
// The deployer signs the transaction; guestAddr is recorded explicitly in the contract.
// depositMist: use depositAmount (dollars) * 1000 as a symbolic testnet amount.
// For testnet testing, expiry is set to 5 minutes from now so auto_release
// can be triggered quickly. Change to checkoutMs + FIVE_DAYS_MS for mainnet.
async function createEscrowOnChain(bookingRef, guestAddr, hostAddr, depositAmount, checkOutStr) {
  if (!deployerKeypair || !process.env.ESCROW_PACKAGE_ID) return null;
  try {
    const depositMist = BigInt(depositAmount) * 1000n; // symbolic testnet amount

    // TESTNET: short expiry for easy testing (5 minutes from now)
    // MAINNET: const expiryMs = BigInt(new Date(checkOutStr + 'T00:00:00Z').getTime()) + 432_000_000n;
    const expiryMs = BigInt(Date.now()) + 300_000n; // 5 minutes

    const tx = new Transaction();
    tx.setSender(deployerKeypair.toSuiAddress());

    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(depositMist)]);

    tx.moveCall({
      target: `${process.env.ESCROW_PACKAGE_ID}::${process.env.ESCROW_MODULE_NAME || 'escrow'}::create_escrow`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx.pure.string(bookingRef),
        tx.pure.address(guestAddr),
        tx.pure.address(hostAddr),
        tx.pure.address(deployerKeypair.toSuiAddress()), // arbitrator
        tx.pure.u64(expiryMs),
        coin,
        tx.object('0x6'), // Sui Clock object
      ],
    });

    const result = await suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: deployerKeypair,
      options: { showObjectChanges: true },
    });

    // Extract the shared BookingEscrow object ID from the result
    const escrowObj = result.objectChanges?.find(
      c => c.type === 'created' && c.objectType?.includes('BookingEscrow')
    );
    return escrowObj?.objectId ?? null;
  } catch (err) {
    console.warn('createEscrowOnChain failed (non-blocking):', err.message);
    return null;
  }
}

// Calls auto_release on an existing BookingEscrow object.
// Callable by anyone after expiry — deployer calls it on the host's behalf.
async function autoReleaseEscrow(escrowObjectId) {
  if (!deployerKeypair || !escrowObjectId || !process.env.ESCROW_PACKAGE_ID) return false;
  try {
    const tx = new Transaction();
    tx.setSender(deployerKeypair.toSuiAddress());

    tx.moveCall({
      target: `${process.env.ESCROW_PACKAGE_ID}::${process.env.ESCROW_MODULE_NAME || 'escrow'}::auto_release`,
      typeArguments: ['0x2::sui::SUI'],
      arguments: [
        tx.object(escrowObjectId),
        tx.object('0x6'), // Sui Clock object
      ],
    });

    await suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: deployerKeypair,
    });
    return true;
  } catch (err) {
    console.warn('autoReleaseEscrow failed (non-blocking):', err.message);
    return false;
  }
}

// ─── Jurisdiction Tax Rates ───────────────────────────────────────────────────
const JURISDICTION_TAX_RATES = {
  1: { rate: 0.13,   name: 'Miami-Dade County, FL',  breakdown: '6% FL sales tax + 7% Miami-Dade tourist tax' },
  2: { rate: 0.17,   name: 'City of Austin, TX',      breakdown: '6% TX state HOT + 11% City of Austin HOT' },
  3: { rate: 0.13,   name: 'Buncombe County, NC',     breakdown: '6.75% NC sales tax + 6% Buncombe County occupancy tax' },
  4: { rate: 0.0805, name: 'City of Scottsdale, AZ',  breakdown: 'AZ state + city Transaction Privilege Tax combined' },
  5: { rate: 0.10,   name: 'Placer County, CA',       breakdown: '10% Transient Occupancy Tax (Tahoe area)' },
  6: { rate: 0.1475, name: 'New York City, NY',        breakdown: '4% NY state + 4.5% local sales tax + 5.875% NYC hotel occupancy tax' },
};

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

// Health
fastify.get('/health', async () => {
  return { status: 'ok', app: 'ARIA Demo', network: process.env.SUI_NETWORK };
});

// Auth
fastify.get('/auth/zklogin/init', async (request, reply) => {
  return getZkLoginUrl(request, reply);
});

fastify.get('/auth/zklogin/callback', async (request, reply) => {
  return handleZkLoginCallback(request, reply);
});

fastify.get('/auth/me', async (request, reply) => {
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });

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

  return {
    address: session.suiAddress,
    email: session.email,
    name: session.name,
    isHost: isHost(session),
    hostStatus
  };
});

fastify.get('/auth/logout', async (request, reply) => {
  reply.clearCookie('aria_session');
  return { success: true };
});

// Stripe
fastify.post('/payment/create-intent', async (request, reply) => {
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  const { amount, propertyTitle } = request.body;
  const paymentIntent = await stripe.paymentIntents.create({
    amount: amount * 100,
    currency: 'usd',
    metadata: { property: propertyTitle, walletAddress: session.suiAddress, email: session.email }
  });
  return { clientSecret: paymentIntent.client_secret };
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
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
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

  const jurisdiction  = JURISDICTION_TAX_RATES[Number(propertyId)] || { rate: 0.08, name: 'Unknown', breakdown: '8% occupancy tax' };
  const pricePerNight = request.body.pricePerNight || Math.round(totalAmount / nights / 1.03 / (1 + jurisdiction.rate));
  const subtotal      = pricePerNight * nights;
  const ariaFee       = Math.round(subtotal * 0.03);
  const taxes         = Math.round(subtotal * jurisdiction.rate);
  const bookingTotal  = subtotal + ariaFee + taxes;
  const depositAmount = Math.round(bookingTotal * 0.20);
  const chargeAmount  = bookingTotal + depositAmount;
  const hostPayout    = calculateHostPayout(subtotal);
  const bookingRef    = `ARIA-${propertyId}-${Date.now()}`;

  try {
    await pool.query(
      `INSERT INTO bookings (booking_ref, property_id, property_title, wallet_address, guest_name, guest_email,
        check_in, check_out, nights, price_per_night, subtotal, aria_fee, taxes, total_amount,
        deposit_amount, payment_status, payment_method)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'confirmed','SuiUSD')`,
      [bookingRef, propertyId, propertyTitle, session.suiAddress, session.name, session.email,
       checkInStr, checkOutStr, nights, pricePerNight, subtotal, ariaFee, taxes, bookingTotal, depositAmount]
    );
  } catch (err) { fastify.log.warn({ err }, 'DB booking save failed'); }

  let walrusBlobId = null;
  try {
    const receipt = {
      bookingRef, app: 'ARIA Demo', network: 'sui:testnet',
      timestamp: new Date().toISOString(), property: propertyTitle, propertyId,
      checkIn: checkInStr, checkOut: checkOutStr, nights,
      breakdown: {
        pricePerNight: `$${pricePerNight}`, nights,
        subtotal: `$${subtotal}`,
        ariaFee: `$${ariaFee} (3% of subtotal — not charged on deposit)`,
        taxes: `$${taxes} (${(jurisdiction.rate * 100).toFixed(2)}% — ${jurisdiction.name})`,
        bookingTotal: `$${bookingTotal} SuiUSD`,
        depositAmount: `$${depositAmount} (refundable, held in Sui escrow — no ARIA fee)`,
        chargeAmount: `$${chargeAmount} SuiUSD (total charged at booking)`
      },
      hostPayout: { amount: `$${hostPayout.hostPayout} SuiUSD`, ariaFee: `$${hostPayout.ariaFee} SuiUSD`, settlementMethod: hostPayout.settlementMethod },
      walletAddress: session.suiAddress, guestName: session.name, guestEmail: session.email,
      paymentMethod: 'SuiUSD', paymentStatus: 'confirmed',
      depositAmount, depositStatus: 'held', chargeAmount,
      jurisdiction: jurisdiction.name, jurisdictionBreakdown: jurisdiction.breakdown
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

  // ── On-chain escrow creation (non-blocking) ──────────────────────────────
  // Uses the first HOST_ADDRESS as host for testnet.
  // Production: look up from host_profiles based on property_id.
  try {
    const hostAddr = HOST_ADDRESSES[0];
    if (hostAddr && hostAddr.startsWith('0x')) {
      const escrowObjectId = await createEscrowOnChain(
        bookingRef, session.suiAddress, hostAddr, depositAmount, checkOutStr
      );
      if (escrowObjectId) {
        await pool.query('UPDATE bookings SET escrow_object_id=$1 WHERE booking_ref=$2', [escrowObjectId, bookingRef]);
        fastify.log.info({ bookingRef, escrowObjectId }, 'Escrow created on-chain');
      }
    }
  } catch (err) { fastify.log.warn({ err }, 'On-chain escrow creation failed (non-blocking)'); }

  try {
    const taxPct     = (jurisdiction.rate * 100).toFixed(2);
    const walrusHtml = walrusBlobId ? `<div style="background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:20px"><p style="margin:0 0 8px;font-size:12px;color:#555">WALRUS RECEIPT</p><p style="margin:0;font-size:11px;color:#00ff44;word-break:break-all;font-family:monospace">${walrusBlobId}</p></div>` : '';
    await resend.emails.send({
      from: 'ARIA <onboarding@resend.dev>', to: session.email,
      subject: `Booking Confirmed — ${propertyTitle} | Ref: ${bookingRef}`,
      html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px">
        <h1 style="color:#00ff44;font-size:24px;margin:0 0 8px">✅ Booking Confirmed</h1>
        <p style="color:#888;margin:0 0 24px">Your ARIA booking receipt — ${session.name}</p>
        <div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin-bottom:20px">
          <h2 style="margin:0 0 16px;font-size:18px">${propertyTitle}</h2>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="color:#888;padding:6px 0">Booking Ref</td><td style="text-align:right">${bookingRef}</td></tr>
            <tr><td style="color:#888;padding:6px 0">Check-in</td><td style="text-align:right">${checkInStr}</td></tr>
            <tr><td style="color:#888;padding:6px 0">Check-out</td><td style="text-align:right">${checkOutStr}</td></tr>
            <tr><td style="color:#888;padding:6px 0">Nights</td><td style="text-align:right">${nights}</td></tr>
            <tr><td style="color:#888;padding:6px 0">Subtotal</td><td style="text-align:right">$${subtotal}</td></tr>
            <tr><td style="color:#888;padding:6px 0">ARIA Fee (3% of subtotal only)</td><td style="text-align:right;color:#00ff44">$${ariaFee}</td></tr>
            <tr><td style="color:#888;padding:6px 0">Taxes (${taxPct}% — ${jurisdiction.name})</td><td style="text-align:right">$${taxes}</td></tr>
            <tr style="border-top:1px solid #333"><td style="padding:8px 0;font-weight:700">Booking Total</td><td style="text-align:right;font-weight:700;color:#00ff44">$${bookingTotal} SuiUSD</td></tr>
            <tr><td style="color:#4a9eff;padding:6px 0">🔒 Refundable Security Deposit</td><td style="text-align:right;color:#4a9eff">$${depositAmount} SuiUSD</td></tr>
            <tr style="border-top:1px solid #444"><td style="padding:10px 0;font-weight:700;font-size:15px">Total Charged</td><td style="text-align:right;font-weight:700;font-size:15px;color:#fff">$${chargeAmount} SuiUSD</td></tr>
          </table>
          <p style="color:#555;font-size:12px;margin:12px 0 0;line-height:1.6">The $${depositAmount} deposit is held in Sui escrow and returned after checkout. ARIA's 3% fee applies to your stay cost only — never to your deposit.</p>
        </div>
        ${walrusHtml}
        <p style="color:#555;font-size:12px;text-align:center;margin:0">Powered by ARIA — Built on Sui | The Airbnb killer</p>
      </div>`
    });
  } catch (err) { fastify.log.warn({ err }, 'Booking confirmation email failed'); }

  return {
    success: true, bookingRef, property: propertyTitle, nights,
    bookingTotal, depositAmount, chargeAmount,
    jurisdiction: jurisdiction.name,
    depositNote: 'Refundable security deposit held in Sui escrow — no ARIA fee charged on deposit',
    walletAddress: session.suiAddress, network: 'sui:testnet',
    message: 'Booking confirmed on Sui testnet', walrusBlobId
  };
});

// Booking Cancel
fastify.post('/booking/cancel', {
  config: {
    rateLimit: {
      max: 10, timeWindow: '1 hour',
      errorResponseBuilder: () => ({ error: 'Too many cancellation attempts. Please wait and try again.' })
    }
  }
}, async (request, reply) => {
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
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
        ? `<div style="background:#0a1a0a;border:1px solid #1a4a1a;border-radius:6px;padding:10px;margin-top:10px"><p style="color:#00ff44;font-size:12px;font-weight:600;margin:0 0 4px">🔓 Security deposit auto-released</p><p style="color:#888;font-size:12px;margin:0">Your $${booking.deposit_amount} deposit has been automatically returned since you cancelled before check-in.</p></div>`
        : `<div style="background:#0a0a1a;border:1px solid #1a1a3a;border-radius:6px;padding:10px;margin-top:10px"><p style="color:#4a9eff;font-size:12px;font-weight:600;margin:0 0 4px">🔒 Security deposit pending release</p><p style="color:#888;font-size:12px;margin:0">Your $${booking.deposit_amount} deposit will be reviewed and released by the host.</p></div>`;
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

// Release Deposit — HOST ONLY
fastify.post('/booking/release-deposit', {
  config: {
    rateLimit: {
      max: 10, timeWindow: '1 hour',
      errorResponseBuilder: () => ({ error: 'Too many deposit release attempts.' })
    }
  }
}, async (request, reply) => {
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  if (!isHost(session)) return reply.code(403).send({ error: 'Host access required' });

  const { bookingRef } = request.body;
  if (!bookingRef || typeof bookingRef !== 'string' || !bookingRef.startsWith('ARIA-'))
    return reply.code(400).send({ error: 'A valid bookingRef is required' });

  try {
    const result = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [bookingRef]);
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Booking not found' });
    const booking = result.rows[0];
    if (booking.deposit_status === 'released') return reply.code(400).send({ error: 'Deposit already released' });

    // ── On-chain escrow release (non-blocking) ───────────────────────────────
    let escrowReleased = false;
    if (booking.escrow_object_id) {
      escrowReleased = await autoReleaseEscrow(booking.escrow_object_id);
      if (escrowReleased) {
        fastify.log.info({ bookingRef, escrowObjectId: booking.escrow_object_id }, 'Escrow released on-chain');
      } else {
        fastify.log.warn({ bookingRef }, 'On-chain escrow release failed — continuing with Postgres update');
      }
    }

    await pool.query('UPDATE bookings SET deposit_status=$1 WHERE booking_ref=$2', ['released', bookingRef]);

    const depositReleaseWalrusBlobId = await pushToWalrus({ ...booking, walrusReceiptType: 'deposit_release', depositReleaseTimestamp: new Date().toISOString() });

    return { success: true, bookingRef, depositReleaseWalrusBlobId, message: `Deposit of $${booking.deposit_amount} released to guest.` };
  } catch (err) {
    return reply.code(500).send({ error: 'Failed to release deposit' });
  }
});

// Walrus helper
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

// Bookings History — guest (own bookings only)
fastify.get('/bookings/history', async (request, reply) => {
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
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
        totalAmount: b.total_amount, chargeAmount,
        paymentStatus: b.payment_status,
        depositAmount: b.deposit_amount, depositStatus: b.deposit_status,
        walrusBlobId: b.walrus_blob_id,
        cancellationWalrusBlobId: b.cancellation_walrus_blob_id,
        timestamp: b.created_at, walletAddress: b.wallet_address,
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
  } catch (err) { return { bookings: [] }; }
});

// Bookings All — HOST ONLY
fastify.get('/bookings/all', async (request, reply) => {
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  if (!isHost(session)) return reply.code(403).send({ error: 'Host access required' });
  try {
    const result = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC');
    return { bookings: result.rows.map(b => {
      const chargeAmount = (b.total_amount || 0) + (b.deposit_amount || 0);
      const jur = JURISDICTION_TAX_RATES[Number(b.property_id)] || { rate: 0.08, name: 'Occupancy Tax' };
      return {
        bookingRef: b.booking_ref, property: b.property_title, propertyId: b.property_id,
        checkIn: b.check_in, checkOut: b.check_out, nights: b.nights,
        totalAmount: b.total_amount, chargeAmount,
        paymentStatus: b.payment_status,
        depositAmount: b.deposit_amount, depositStatus: b.deposit_status,
        walrusBlobId: b.walrus_blob_id,
        cancellationWalrusBlobId: b.cancellation_walrus_blob_id,
        guestName: b.guest_name, guestEmail: b.guest_email,
        walletAddress: b.wallet_address, timestamp: b.created_at,
        jurisdiction: jur.name,
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
  } catch (err) { return { bookings: [] }; }
});

// DeepBook
fastify.get('/deepbook/payout/:amount', async (request, reply) => {
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
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
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  const { propertyId, platform, icalUrl } = request.body;
  if (!propertyId || !platform || !icalUrl) return reply.code(400).send({ error: 'propertyId, platform and icalUrl required' });
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

// Messages
fastify.post('/messages/send', async (request, reply) => {
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
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
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
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
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  return { success: true };
});

fastify.get('/messages/:bookingRef/count', async (request, reply) => {
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
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

// Reviews
fastify.post('/reviews/submit', async (request, reply) => {
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
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
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  if (!isHost(session)) return reply.code(403).send({ error: 'Host access required' });
  try {
    const result = await pool.query('SELECT * FROM reviews ORDER BY created_at DESC');
    return { reviews: result.rows };
  } catch (err) { return { reviews: [] }; }
});

// ─── Tax Routes — HOST ONLY ───────────────────────────────────────────────────

fastify.get('/tax/summary', async (request, reply) => {
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
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
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  if (!isHost(session)) return reply.code(403).send({ error: 'Host access required' });
  const { bookingRef, jurisdiction, notes } = request.body;
  if (!bookingRef || typeof bookingRef !== 'string' || !bookingRef.startsWith('ARIA-'))
    return reply.code(400).send({ error: 'A valid bookingRef is required' });
  try {
    const bkResult = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1 AND payment_status != $2', [bookingRef, 'cancelled']);
    if (bkResult.rows.length === 0) return reply.code(404).send({ error: 'Booking not found or is cancelled' });
    const booking = bkResult.rows[0];
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
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
  if (!isHost(session)) return reply.code(403).send({ error: 'Host access required' });
  const { bookingRef } = request.body;
  if (!bookingRef) return reply.code(400).send({ error: 'bookingRef is required' });
  try {
    const result = await pool.query('DELETE FROM tax_remittances WHERE booking_ref = $1 RETURNING *', [bookingRef]);
    if (result.rows.length === 0) return reply.code(404).send({ error: 'No remittance record found' });
    return { success: true, bookingRef };
  } catch (err) { return reply.code(500).send({ error: 'Failed to remove remittance record' }); }
});

// ─── Host Onboarding Routes ───────────────────────────────────────────────────

fastify.get('/host/profile', async (request, reply) => {
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
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
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });

  const { name, email, phone, propertyAddress, city, state, zip, country,
          jurisdiction, strPermit, payoutSuiAddress, payoutNotes, termsAgreed, complianceConfirmed } = request.body;

  if (!name || !email || !termsAgreed || !complianceConfirmed)
    return reply.code(400).send({ error: 'Name, email, terms agreement, and compliance confirmation are required' });

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
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#ffaa00;font-size:22px;margin:0 0 8px">🏡 New Host Application</h1><p style="color:#888;margin:0 0 20px">Someone wants to become an ARIA host.</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:20px;font-size:13px"><table style="width:100%;border-collapse:collapse"><tr><td style="color:#888;padding:5px 0">Name</td><td style="text-align:right">${name}</td></tr><tr><td style="color:#888;padding:5px 0">Email</td><td style="text-align:right">${email}</td></tr><tr><td style="color:#888;padding:5px 0">Sui Address</td><td style="text-align:right;font-family:monospace;font-size:11px">${session.suiAddress}</td></tr>${city ? `<tr><td style="color:#888;padding:5px 0">Location</td><td style="text-align:right">${city}${state ? ', ' + state : ''}</td></tr>` : ''}${strPermit ? `<tr><td style="color:#888;padding:5px 0">STR Permit</td><td style="text-align:right">${strPermit}</td></tr>` : ''}</table></div><p style="color:#888;font-size:12px;margin:0">To approve, use the ARIA admin API with their Sui address.</p></div>`
      });
    } catch (err) { fastify.log.warn({ err }, 'Admin notification email failed'); }

    try {
      await resend.emails.send({
        from: 'ARIA <onboarding@resend.dev>',
        to: email,
        subject: 'ARIA Host Application Received',
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#00ff44;font-size:24px;margin:0 0 8px">🏠 Host Application Received</h1><p style="color:#888;margin:0 0 24px">Thanks for applying to host on ARIA, ${name}.</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin-bottom:20px"><p style="margin:0 0 12px;font-size:14px;color:#ccc">Your application is under review. Here's what happens next:</p><ul style="color:#888;font-size:13px;line-height:1.8;padding-left:16px"><li>We'll review your application within 1–2 business days</li><li>You'll receive an email when your account is approved</li><li>Once approved, you can list properties and receive bookings</li></ul></div><p style="color:#555;font-size:12px;text-align:center;margin:0">Powered by ARIA — Built on Sui</p></div>`
      });
    } catch (err) { fastify.log.warn({ err }, 'Host application email failed'); }

    return { success: true, status: 'pending', message: 'Host application submitted. You will receive an email when approved.' };
  } catch (err) {
    fastify.log.error(err);
    return reply.code(500).send({ error: 'Failed to submit host application' });
  }
});

fastify.post('/host/approve', async (request, reply) => {
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
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
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#00ff44;font-size:24px;margin:0 0 8px">🎉 You're an ARIA Host!</h1><p style="color:#888;margin:0 0 24px">Congratulations ${host.name} — your host account has been approved.</p><div style="background:#0a1a0a;border:1px solid #1a3a1a;border-radius:8px;padding:20px;margin-bottom:20px"><p style="color:#00ff44;font-size:14px;font-weight:600;margin:0 0 8px">You can now:</p><ul style="color:#888;font-size:13px;line-height:1.8;padding-left:16px"><li>Access your Host Dashboard</li><li>Receive bookings from guests</li><li>Manage deposits and payouts</li><li>Track occupancy tax compliance</li></ul></div><a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}" style="display:block;background:#00ff44;color:#000;text-align:center;padding:14px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none;margin-bottom:20px">Go to ARIA →</a><p style="color:#555;font-size:12px;text-align:center;margin:0">Powered by ARIA — Built on Sui</p></div>`
      });
    } catch (err) { fastify.log.warn({ err }, 'Host approval email failed'); }

    return { success: true, message: `Host ${host.name} approved`, email: host.email };
  } catch (err) {
    return reply.code(500).send({ error: 'Failed to approve host' });
  }
});

fastify.get('/host/applications', async (request, reply) => {
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
  const session = await getSession(sessionId);
  if (!session) return reply.code(401).send({ error: 'Session expired' });
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

// ─── Start ────────────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT || '3001');
await fastify.listen({ port, host: '0.0.0.0' });
console.log('ARIA API running on port ' + port);
