// ─── ARIA Native AI Route ─────────────────────────────────────────────────────
// POST /api/ai/chat
//
// Uses plain fetch() to call xAI's Grok API — no npm packages needed.
// xAI's API is OpenAI-compatible so the request/response format is identical.
//
// Accepts: { messages, mode } from the frontend
//   messages = full conversation history [{ role, content }]
//   mode     = "guest" or "host"
// ─────────────────────────────────────────────────────────────────────────────

import { join } from 'path';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { calculateHostPayout } from './deepbook.mjs';

const GROK_MODEL   = 'grok-3-latest';
const XAI_BASE_URL = 'https://api.x.ai/v1/chat/completions';

// ─── Tool definitions ─────────────────────────────────────────────────────────

const GUEST_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_bookings',
      description: 'Get the current guest booking history from ARIA.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_booking',
      description: 'Book a property on ARIA for the guest. Always confirm details with the user before calling this.',
      parameters: {
        type: 'object',
        properties: {
          propertyId:    { type: 'number', description: 'Property ID (1-6)' },
          propertyTitle: { type: 'string', description: 'Property name' },
          checkIn:       { type: 'string', description: 'Check-in date YYYY-MM-DD' },
          checkOut:      { type: 'string', description: 'Check-out date YYYY-MM-DD' },
          nights:        { type: 'number', description: 'Number of nights' },
          pricePerNight: { type: 'number', description: 'Price per night in USD' },
          totalAmount:   { type: 'number', description: 'Total including ARIA fee and taxes' }
        },
        required: ['propertyId', 'propertyTitle', 'checkIn', 'checkOut', 'nights', 'pricePerNight', 'totalAmount']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancel_booking',
      description: 'Cancel an existing booking. Always confirm with the user first.',
      parameters: {
        type: 'object',
        properties: {
          bookingRef: { type: 'string', description: 'Booking reference e.g. ARIA-1-1234567890' }
        },
        required: ['bookingRef']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_messages',
      description: 'Read the message thread for a specific booking.',
      parameters: {
        type: 'object',
        properties: {
          bookingRef: { type: 'string', description: 'Booking reference' }
        },
        required: ['bookingRef']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Send a message to the host for a specific booking.',
      parameters: {
        type: 'object',
        properties: {
          bookingRef: { type: 'string', description: 'Booking reference' },
          message:    { type: 'string', description: 'Message to send' }
        },
        required: ['bookingRef', 'message']
      }
    }
  }
];

const HOST_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_all_bookings',
      description: 'Get ALL bookings across all properties on the platform.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_revenue_summary',
      description: 'Calculate a revenue summary — gross, ARIA fees, taxes, net earnings, per-property breakdown.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_all_messages',
      description: 'Scan all bookings for recent guest messages.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_messages',
      description: 'Read the full message thread for a specific booking.',
      parameters: {
        type: 'object',
        properties: {
          bookingRef: { type: 'string', description: 'Booking reference' }
        },
        required: ['bookingRef']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: 'Send a message to a guest for a specific booking.',
      parameters: {
        type: 'object',
        properties: {
          bookingRef: { type: 'string', description: 'Booking reference' },
          message:    { type: 'string', description: 'Message to send to guest' }
        },
        required: ['bookingRef', 'message']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'release_deposit',
      description: 'Release the damage deposit back to the guest. Always confirm with the host first.',
      parameters: {
        type: 'object',
        properties: {
          bookingRef: { type: 'string', description: 'Booking reference' }
        },
        required: ['bookingRef']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_reviews',
      description: 'Get all guest reviews across all properties.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancel_booking',
      description: 'Cancel a booking. Always confirm with the host first.',
      parameters: {
        type: 'object',
        properties: {
          bookingRef: { type: 'string', description: 'Booking reference' }
        },
        required: ['bookingRef']
      }
    }
  }
];

// ─── System prompts ───────────────────────────────────────────────────────────

function buildGuestSystemPrompt(session, bookings) {
  const active = (bookings || []).filter(b => b.paymentStatus !== 'cancelled');
  const bkSummary = active.length > 0
    ? active.map(b => `- ${b.property} (ref: ${b.bookingRef}, ${b.checkIn} to ${b.checkOut}, ${b.nights} nights, ${b.breakdown?.totalPaid || '$' + b.totalAmount})`).join('\n')
    : 'No active bookings yet.';

  return `You are ARIA Assistant, an AI agent built into ARIA — a vacation rental platform on Sui blockchain. You can take real actions: book properties, cancel bookings, fetch booking history, read and send messages.

IMPORTANT RULES:
- Always confirm details with the user BEFORE calling create_booking or cancel_booking
- Cost formula: subtotal = pricePerNight * nights. ARIA fee = subtotal * 0.03. Taxes = subtotal * 0.08. Total = subtotal + ariaFee + taxes
- Always show the full breakdown: subtotal, ARIA fee (3%), occupancy tax (8%), and total before booking
- Dates must be YYYY-MM-DD format. Pass pricePerNight as the exact property price.
- Be conversational and friendly

ABOUT ARIA: 3% fee vs 15% Airbnb. Instant Sui settlement. Walrus receipts. SuiUSD payments. Damage deposits in Sui escrow.

CURRENT USER: ${session.name} (${session.email})
Wallet: ${session.suiAddress}

ACTIVE BOOKINGS:
${bkSummary}

AVAILABLE PROPERTIES:
1. Oceanfront Villa — Miami Beach, FL — $285/night (id:1)
2. Downtown Loft — Austin, TX — $145/night (id:2)
3. Mountain Cabin — Asheville, NC — $195/night (id:3)
4. Desert Retreat — Scottsdale, AZ — $225/night (id:4)
5. Lake House — Lake Tahoe, CA — $320/night (id:5)
6. Historic Brownstone — Brooklyn, NY — $175/night (id:6)

CANCELLATION POLICY: Full refund 24+ hours before check-in. 50% within 24 hours.`;
}

function buildHostSystemPrompt(session) {
  return `You are ARIA Host Assistant — an AI agent for property hosts on ARIA, a vacation rental platform on Sui blockchain.

You have FULL access to host operations. You can fetch all bookings, calculate revenue, read/reply to guest messages, release damage deposits, cancel bookings, and pull guest reviews.

IMPORTANT RULES:
- Always confirm before release_deposit or cancel_booking
- When showing revenue, break it down: gross → ARIA fee (3%) → taxes (8%) → net earnings
- Be proactive — if asked about messages, check them; if asked about revenue, compute it live
- Format numbers as USD. Be clear and concise. You are talking to the HOST.

ABOUT ARIA: 3% fee vs 15% Airbnb. Instant Sui settlement. Walrus receipts. SuiUSD. Damage deposits in Sui escrow.

HOST USER: ${session.name} (${session.email})
Wallet: ${session.suiAddress}

YOUR 6 PROPERTIES:
1. Oceanfront Villa — Miami Beach, FL — $285/night (id:1)
2. Downtown Loft — Austin, TX — $145/night (id:2)
3. Mountain Cabin — Asheville, NC — $195/night (id:3)
4. Desert Retreat — Scottsdale, AZ — $225/night (id:4)
5. Lake House — Lake Tahoe, CA — $320/night (id:5)
6. Historic Brownstone — Brooklyn, NY — $175/night (id:6)`;
}

// ─── Grok API call (plain fetch — no npm packages) ────────────────────────────

async function callGrok(messages, tools) {
  const res = await fetch(XAI_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.XAI_API_KEY}`
    },
    body: JSON.stringify({
      model: GROK_MODEL,
      messages,
      tools,
      tool_choice: 'auto',
      max_tokens: 2000
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Grok API error ${res.status}: ${err}`);
  }

  return res.json();
}

// ─── Tool executor ────────────────────────────────────────────────────────────

async function executeTool(toolName, toolInput, session) {
  const receiptsDir = join(process.cwd(), 'receipts');
  const messagesDir = join(process.cwd(), 'messages');
  const reviewsDir  = join(process.cwd(), 'reviews');

  try {

    // ── Guest: get own bookings ───────────────────────────────────────────────
    if (toolName === 'get_bookings') {
      if (!existsSync(receiptsDir)) return JSON.stringify([]);
      const files = readdirSync(receiptsDir).filter(f => f.endsWith('.json'));
      const bookings = files
        .map(f => { try { return JSON.parse(readFileSync(join(receiptsDir, f), 'utf8')); } catch { return null; } })
        .filter(b => b && b.walletAddress === session.suiAddress)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      return JSON.stringify(bookings);
    }

    // ── Guest: create booking ─────────────────────────────────────────────────
    if (toolName === 'create_booking') {
      const { propertyId, propertyTitle, nights, pricePerNight, totalAmount, checkIn, checkOut } = toolInput;

      // Double-booking guard
      if (existsSync(receiptsDir)) {
        const files = readdirSync(receiptsDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          try {
            const existing = JSON.parse(readFileSync(join(receiptsDir, file), 'utf8'));
            if (String(existing.propertyId) === String(propertyId) && existing.paymentStatus !== 'cancelled') {
              const exIn  = new Date(existing.checkIn), exOut = new Date(existing.checkOut);
              const newIn = new Date(checkIn),          newOut = new Date(checkOut);
              if (newIn < exOut && newOut > exIn) {
                return JSON.stringify({ error: 'Property not available for selected dates', conflicts: [{ checkIn: existing.checkIn, checkOut: existing.checkOut }] });
              }
            }
          } catch {}
        }
      }

      const bookingRef    = `ARIA-${propertyId}-${Date.now()}`;
      const subtotal      = pricePerNight * nights;
      const ariaFee       = Math.round(subtotal * 0.03);
      const taxes         = Math.round(subtotal * 0.08);
      const total         = subtotal + ariaFee + taxes;
      const depositAmount = Math.round(total * 0.20);
      const hostPayout    = calculateHostPayout(subtotal);

      const receipt = {
        bookingRef, app: 'ARIA Demo', network: 'sui:testnet',
        timestamp: new Date().toISOString(), property: propertyTitle, propertyId,
        checkIn, checkOut, nights,
        breakdown: {
          pricePerNight: `$${pricePerNight}`, nights,
          subtotal: `$${subtotal}`, ariaFee: `$${ariaFee} (3%)`,
          taxes: `$${taxes} (8% occupancy tax)`, totalPaid: `$${total} SuiUSD`
        },
        hostPayout: {
          amount: `$${hostPayout.hostPayout} SuiUSD`,
          ariaFee: `$${hostPayout.ariaFee} SuiUSD`,
          settlementMethod: hostPayout.settlementMethod
        },
        walletAddress: session.suiAddress, guestName: session.name, guestEmail: session.email,
        paymentMethod: 'SuiUSD', paymentStatus: 'confirmed', depositAmount, depositStatus: 'held'
      };

      // Write receipt immediately to block race conditions
      if (!existsSync(receiptsDir)) mkdirSync(receiptsDir);
      writeFileSync(join(receiptsDir, `${bookingRef}.json`), JSON.stringify(receipt, null, 2));

      // Push to Walrus
      try {
        const walrusRes  = await fetch('https://publisher.walrus-testnet.walrus.space/v1/blobs?epochs=3', {
          method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' },
          body: Buffer.from(JSON.stringify(receipt))
        });
        const walrusData = await walrusRes.json();
        const walrusBlobId = walrusData?.newlyCreated?.blobObject?.blobId ?? walrusData?.alreadyCertified?.blobId ?? null;
        if (walrusBlobId) {
          receipt.walrusBlobId = walrusBlobId;
          writeFileSync(join(receiptsDir, `${bookingRef}.json`), JSON.stringify(receipt, null, 2));
        }
      } catch (walrusErr) {
        console.warn('AI booking Walrus push failed:', walrusErr.message);
      }

      // ── Confirmation email ────────────────────────────────────────────────
      // Sends the same styled email as the regular booking flow
      try {
        const { Resend } = await import('resend');
        const resend     = new Resend(process.env.RESEND_API_KEY);
        const emailRows  = [
          ['Booking Ref',     bookingRef],
          ['Check-in',        checkIn],
          ['Check-out',       checkOut],
          ['Nights',          nights],
          ['Price per night', `$${pricePerNight}`],
          ['Subtotal',        `$${subtotal}`],
          ['ARIA Fee (3%)',   `$${ariaFee} (3%)`],
          ['Taxes (8%)',      `$${taxes} (8% occupancy tax)`],
        ];
        const rowsHtml   = emailRows.map(([l, v]) => `<tr><td style="color:#888;padding:6px 0">${l}</td><td style="text-align:right">${v}</td></tr>`).join('');
        const totalRow   = `<tr style="border-top:1px solid #333"><td style="padding:10px 0;font-weight:700">Total Paid</td><td style="text-align:right;font-weight:700;color:#00ff44">$${total} SuiUSD</td></tr>`;
        const walrusHtml = receipt.walrusBlobId
          ? `<div style="background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:20px"><p style="margin:0 0 8px;font-size:12px;color:#555">WALRUS RECEIPT — PERMANENT ON-CHAIN RECORD</p><p style="margin:0;font-size:11px;color:#00ff44;word-break:break-all;font-family:monospace">${receipt.walrusBlobId}</p></div>`
          : '';
        await resend.emails.send({
          from: 'ARIA <onboarding@resend.dev>',
          to: session.email,
          subject: `Booking Confirmed — ${propertyTitle} | Ref: ${bookingRef}`,
          html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px">
            <h1 style="color:#00ff44;font-size:24px;margin:0 0 8px">✅ Booking Confirmed</h1>
            <p style="color:#888;margin:0 0 24px">Your ARIA booking receipt — ${session.name}</p>
            <div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin-bottom:20px">
              <h2 style="margin:0 0 16px;font-size:18px">${propertyTitle}</h2>
              <table style="width:100%;border-collapse:collapse">${rowsHtml}${totalRow}</table>
            </div>
            ${walrusHtml}
            <p style="color:#555;font-size:12px;text-align:center;margin:0">Powered by ARIA — Built on Sui | The Airbnb killer</p>
          </div>`
        });
      } catch (emailErr) {
        // Email failure never breaks the booking
        console.warn('AI booking email failed:', emailErr.message);
      }

      return JSON.stringify({
        success: true, bookingRef, property: propertyTitle,
        checkIn, checkOut, nights, totalAmount: total,
        network: 'sui:testnet', walrusBlobId: receipt.walrusBlobId,
        message: 'Booking confirmed on Sui testnet! Confirmation email sent.'
      });
    }

    // ── Cancel booking ────────────────────────────────────────────────────────
    if (toolName === 'cancel_booking') {
      const filePath = join(receiptsDir, toolInput.bookingRef + '.json');
      if (!existsSync(filePath)) return JSON.stringify({ error: 'Booking not found' });
      const booking = JSON.parse(readFileSync(filePath, 'utf8'));
      if (booking.paymentStatus === 'cancelled') return JSON.stringify({ error: 'Already cancelled' });
      booking.paymentStatus = 'cancelled';
      booking.cancelledAt   = new Date().toISOString();
      const today = new Date(); today.setHours(0,0,0,0);
      if (today < new Date(booking.checkIn)) {
        booking.depositStatus     = 'released';
        booking.depositReleasedAt = new Date().toISOString();
        booking.depositNote       = 'Auto-released on pre-check-in cancellation';
      }
      writeFileSync(filePath, JSON.stringify(booking, null, 2));

      // ── Cancellation email ────────────────────────────────────────────────
      try {
        const { Resend } = await import('resend');
        const resend          = new Resend(process.env.RESEND_API_KEY);
        const depositAutoReleased = booking.depositStatus === 'released' && booking.depositNote?.includes('Auto-released');
        const refundAmount    = booking.breakdown?.totalPaid || `$${booking.totalAmount} SuiUSD`;
        const depositNote     = depositAutoReleased
          ? `<div style="background:#0a1a0a;border:1px solid #1a4a1a;border-radius:6px;padding:10px;margin-top:10px"><p style="color:#00ff44;font-size:12px;font-weight:600;margin:0 0 4px">🔓 Security deposit auto-released</p><p style="color:#888;font-size:12px;margin:0">Your damage deposit has been automatically returned since you cancelled before check-in.</p></div>`
          : `<div style="background:#0a0a1a;border:1px solid #1a1a3a;border-radius:6px;padding:10px;margin-top:10px"><p style="color:#4a9eff;font-size:12px;font-weight:600;margin:0 0 4px">🔒 Security deposit pending release</p><p style="color:#888;font-size:12px;margin:0">Your deposit will be reviewed and released by the host.</p></div>`;
        await resend.emails.send({
          from: 'ARIA <onboarding@resend.dev>',
          to: booking.guestEmail,
          subject: `Booking Cancelled — ${booking.property} | Ref: ${toolInput.bookingRef}`,
          html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px">
            <h1 style="color:#ff4444;font-size:24px;margin:0 0 8px">❌ Booking Cancelled</h1>
            <p style="color:#888;margin:0 0 24px">Your cancellation confirmation — ${booking.guestName}</p>
            <div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin-bottom:20px">
              <h2 style="margin:0 0 16px;font-size:18px">${booking.property}</h2>
              <table style="width:100%;border-collapse:collapse">
                <tr><td style="color:#888;padding:6px 0">Booking Ref</td><td style="text-align:right">${toolInput.bookingRef}</td></tr>
                <tr><td style="color:#888;padding:6px 0">Check-in</td><td style="text-align:right">${booking.checkIn}</td></tr>
                <tr><td style="color:#888;padding:6px 0">Check-out</td><td style="text-align:right">${booking.checkOut}</td></tr>
                <tr><td style="color:#888;padding:6px 0">Nights</td><td style="text-align:right">${booking.nights}</td></tr>
                <tr style="border-top:1px solid #333"><td style="padding:10px 0;font-weight:700">Refund Amount</td><td style="text-align:right;font-weight:700;color:#00ff44">${refundAmount}</td></tr>
              </table>
              ${depositNote}
            </div>
            <div style="background:#1a0a0a;border:1px solid #3a1a1a;border-radius:8px;padding:16px;margin-bottom:20px">
              <p style="color:#ff6666;font-size:13px;font-weight:600;margin:0 0 6px">Refund Policy</p>
              <p style="color:#888;font-size:13px;margin:0;line-height:1.6">Full refund processed within 24 hours. Refund will be returned to your original SuiUSD wallet address.</p>
            </div>
            <p style="color:#555;font-size:12px;text-align:center;margin:0">Powered by ARIA — Built on Sui | The Airbnb killer</p>
          </div>`
        });
      } catch (emailErr) {
        // Email failure never breaks the cancellation
        console.warn('AI cancellation email failed:', emailErr.message);
      }

      return JSON.stringify({ success: true, bookingRef: toolInput.bookingRef, message: 'Booking cancelled. Cancellation confirmation email sent.' });
    }

    // ── Host: get all bookings ────────────────────────────────────────────────
    if (toolName === 'get_all_bookings') {
      if (!existsSync(receiptsDir)) return JSON.stringify([]);
      const files = readdirSync(receiptsDir).filter(f => f.endsWith('.json'));
      const bookings = files
        .map(f => { try { return JSON.parse(readFileSync(join(receiptsDir, f), 'utf8')); } catch { return null; } })
        .filter(Boolean)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      return JSON.stringify(bookings);
    }

    // ── Host: revenue summary ─────────────────────────────────────────────────
    if (toolName === 'get_revenue_summary') {
      if (!existsSync(receiptsDir)) return JSON.stringify({ totalBookings: 0, totalGross: 0, totalNet: 0, byProperty: {} });
      const files    = readdirSync(receiptsDir).filter(f => f.endsWith('.json'));
      const bookings = files
        .map(f => { try { return JSON.parse(readFileSync(join(receiptsDir, f), 'utf8')); } catch { return null; } })
        .filter(b => b && b.paymentStatus !== 'cancelled');
      const byProperty = {};
      let totalGross = 0, totalFees = 0, totalTaxes = 0, totalNet = 0, totalDeposits = 0;
      bookings.forEach(b => {
        const pricePer = b.breakdown?.pricePerNight ? parseInt(b.breakdown.pricePerNight.replace('$','')) : 0;
        const subtotal = pricePer * (b.nights || 1);
        const fee      = Math.round(subtotal * 0.03);
        const tax      = Math.round(subtotal * 0.08);
        totalGross += subtotal + fee + tax;
        totalFees  += fee;
        totalTaxes += tax;
        totalNet   += subtotal - fee;
        if (b.depositStatus === 'held') totalDeposits += (b.depositAmount || 0);
        const prop = b.property || 'Unknown';
        if (!byProperty[prop]) byProperty[prop] = { bookings: 0, gross: 0, net: 0 };
        byProperty[prop].bookings++;
        byProperty[prop].gross += subtotal + fee + tax;
        byProperty[prop].net   += subtotal - fee;
      });
      return JSON.stringify({ totalBookings: bookings.length, totalGross, totalFees, totalTaxes, totalNet, totalDepositsHeld: totalDeposits, byProperty });
    }

    // ── Get messages for a booking ────────────────────────────────────────────
    if (toolName === 'get_messages') {
      const filePath = join(messagesDir, toolInput.bookingRef + '.json');
      if (!existsSync(filePath)) return JSON.stringify([]);
      return readFileSync(filePath, 'utf8');
    }

    // ── Host: scan all message threads ────────────────────────────────────────
    if (toolName === 'get_all_messages') {
      if (!existsSync(receiptsDir)) return JSON.stringify('No bookings found.');
      const files    = readdirSync(receiptsDir).filter(f => f.endsWith('.json'));
      const bookings = files.map(f => { try { return JSON.parse(readFileSync(join(receiptsDir, f), 'utf8')); } catch { return null; } }).filter(Boolean);
      const threads  = [];
      for (const b of bookings) {
        const mPath = join(messagesDir, b.bookingRef + '.json');
        if (existsSync(mPath)) {
          const msgs = JSON.parse(readFileSync(mPath, 'utf8'));
          if (msgs.length > 0) threads.push({ bookingRef: b.bookingRef, property: b.property, guestName: b.guestName, messageCount: msgs.length, latestMessage: msgs[msgs.length - 1], allMessages: msgs });
        }
      }
      return JSON.stringify(threads.length > 0 ? threads : 'No messages found.');
    }

    // ── Send message ──────────────────────────────────────────────────────────
    if (toolName === 'send_message') {
      if (!existsSync(messagesDir)) mkdirSync(messagesDir);
      const filePath = join(messagesDir, toolInput.bookingRef + '.json');
      const thread   = existsSync(filePath) ? JSON.parse(readFileSync(filePath, 'utf8')) : [];
      thread.push({ from: session.name, email: session.email, message: toolInput.message, timestamp: new Date().toISOString() });
      writeFileSync(filePath, JSON.stringify(thread, null, 2));
      return JSON.stringify({ success: true, message: 'Message sent.' });
    }

    // ── Host: release deposit ─────────────────────────────────────────────────
    if (toolName === 'release_deposit') {
      const filePath = join(receiptsDir, toolInput.bookingRef + '.json');
      if (!existsSync(filePath)) return JSON.stringify({ error: 'Booking not found' });
      const booking = JSON.parse(readFileSync(filePath, 'utf8'));
      if (booking.depositStatus === 'released') return JSON.stringify({ error: 'Deposit already released' });
      booking.depositStatus     = 'released';
      booking.depositReleasedAt = new Date().toISOString();
      writeFileSync(filePath, JSON.stringify(booking, null, 2));
      return JSON.stringify({ success: true, bookingRef: toolInput.bookingRef, message: 'Deposit released to guest.' });
    }

    // ── Host: get all reviews ─────────────────────────────────────────────────
    if (toolName === 'get_reviews') {
      if (!existsSync(reviewsDir)) return JSON.stringify([]);
      const files = readdirSync(reviewsDir).filter(f => f.endsWith('.json'));
      const allReviews = files.flatMap(f => { try { return JSON.parse(readFileSync(join(reviewsDir, f), 'utf8')); } catch { return []; } });
      return JSON.stringify(allReviews);
    }

    return JSON.stringify({ error: `Unknown tool: ${toolName}` });

  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

// ─── Register route on Fastify ────────────────────────────────────────────────

export async function registerAIRoute(fastify) {
  fastify.post('/api/ai/chat', async (request, reply) => {

    // Must be logged in
    const sessionId = request.cookies.aria_session;
    if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
    const { getSession } = await import('./auth.mjs');
    const session = getSession(sessionId);
    if (!session) return reply.code(401).send({ error: 'Session expired' });

    const { messages, mode } = request.body;
    if (!messages || !Array.isArray(messages)) return reply.code(400).send({ error: 'messages array required' });

    const isHost = mode === 'host';
    const tools  = isHost ? HOST_TOOLS : GUEST_TOOLS;

    // Load guest bookings for system prompt context
    let guestBookings = [];
    if (!isHost) {
      try {
        const receiptsDir = join(process.cwd(), 'receipts');
        if (existsSync(receiptsDir)) {
          const files = readdirSync(receiptsDir).filter(f => f.endsWith('.json'));
          guestBookings = files
            .map(f => { try { return JSON.parse(readFileSync(join(receiptsDir, f), 'utf8')); } catch { return null; } })
            .filter(b => b && b.walletAddress === session.suiAddress);
        }
      } catch {}
    }

    const systemPrompt = isHost
      ? buildHostSystemPrompt(session)
      : buildGuestSystemPrompt(session, guestBookings);

    // ── Agentic loop ──────────────────────────────────────────────────────────
    // Keep calling Grok until it returns a plain text response with no tool calls.
    let apiMessages = [
      { role: 'system', content: systemPrompt },
      ...messages.map(m => ({ role: m.role, content: m.content }))
    ];
    let finalText  = '';
    let iterations = 0;

    while (iterations < 10) {
      iterations++;

      const data      = await callGrok(apiMessages, tools);
      const choice    = data.choices[0];
      const toolCalls = choice.message.tool_calls;

      // No tool calls — Grok is done, return the text
      if (!toolCalls || toolCalls.length === 0) {
        finalText = choice.message.content || '';
        break;
      }

      // Add the assistant's tool-call message to history
      apiMessages.push({
        role: 'assistant',
        content: choice.message.content || null,
        tool_calls: toolCalls
      });

      // Execute each tool and add results to history
      for (const toolCall of toolCalls) {
        const toolName  = toolCall.function.name;
        const toolInput = JSON.parse(toolCall.function.arguments);
        const result    = await executeTool(toolName, toolInput, session);

        apiMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result
        });
      }
    }

    return { response: finalText };
  });
}
