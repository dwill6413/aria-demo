// ─── ARIA Native AI Route ─────────────────────────────────────────────────────
// POST /api/ai/chat
//
// Uses plain fetch() to call xAI's Grok API — no npm packages needed.
// xAI's API is OpenAI-compatible so the request/response format is identical.
//
// Accepts: { messages, mode } from the frontend
//   messages = full conversation history [{ role, content }]
//   mode     = UI hint only — the actual host/guest role is decided SERVER-SIDE
// ─────────────────────────────────────────────────────────────────────────────

import { calculateHostPayout } from './deepbook.mjs';
import { pool } from './db.mjs';
import { getSession } from './auth.mjs';
import { PROPERTIES, JURISDICTION_TAX_RATES } from './catalog.mjs';

const GROK_MODEL   = 'grok-3-latest';
const XAI_BASE_URL = 'https://api.x.ai/v1/chat/completions';

const HOST_ADDRESSES = (process.env.HOST_ADDRESSES || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// Tools that may only ever be executed by a verified host.
const HOST_ONLY_TOOLS = new Set(['get_all_bookings', 'get_revenue_summary', 'get_all_messages', 'release_deposit', 'get_reviews']);

// Resolve host status from the session itself — NEVER from the client `mode`.
async function resolveIsHost(session) {
  if (!session?.email) return false;
  if (HOST_ADDRESSES.includes(session.email.toLowerCase())) return true;
  try {
    const r = await pool.query(
      `SELECT id FROM host_profiles WHERE email = $1 AND status = 'approved'`,
      [session.email.toLowerCase()]
    );
    return r.rows.length > 0;
  } catch { return false; }
}

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
  const active = (bookings || []).filter(b => b.payment_status !== 'cancelled');
  const bkSummary = active.length > 0
    ? active.map(b => `- ${b.property_title} (ref: ${b.booking_ref}, ${b.check_in} to ${b.check_out}, ${b.nights} nights, $${b.total_amount} SuiUSD)`).join('\n')
    : 'No active bookings yet.';

  return `You are ARIA Assistant, an AI agent built into ARIA — a vacation rental platform on Sui blockchain. You can take real actions: book properties, cancel bookings, fetch booking history, read and send messages.

IMPORTANT RULES:
- Always confirm details with the user BEFORE calling create_booking or cancel_booking
- Cost formula: subtotal = pricePerNight * nights. ARIA fee = subtotal * 0.03. Taxes vary by property location (see below). Total = subtotal + ariaFee + taxes.
- Security deposit = 20% of total. The deposit is FULLY REFUNDABLE after checkout and is held separately in Sui escrow.
- Always show the COMPLETE breakdown before booking:
    • Price per night
    • Subtotal (nights × price)
    • ARIA fee (3%)
    • Occupancy tax (rate varies by jurisdiction — see below)
    • Total charge
    • Refundable security deposit (20% of total) — held in Sui escrow, returned after checkout
    • Grand total due at checkout (total + deposit)
- Make it clear the deposit is NOT an extra cost — it is returned after a successful stay
- Dates must be YYYY-MM-DD format. Pass pricePerNight as the exact property price.
- Be conversational and friendly

JURISDICTION TAX RATES (use these for accurate tax calculations):
1. Oceanfront Villa (Miami Beach, FL) — 13.00% (6% FL sales + 7% Miami-Dade tourist tax)
2. Downtown Loft (Austin, TX) — 17.00% (6% TX state + 11% City of Austin HOT)
3. Mountain Cabin (Asheville, NC) — 13.00% (6.75% NC sales + 6% Buncombe County occupancy)
4. Desert Retreat (Scottsdale, AZ) — 8.05% (AZ state + city Transaction Privilege Tax)
5. Lake House (Lake Tahoe, CA) — 10.00% (Placer County Transient Occupancy Tax)
6. Historic Brownstone (Brooklyn, NY) — 14.75% (4% NY state + 4.5% local + 5.875% NYC hotel occupancy)

ABOUT ARIA: 3% fee vs 15% Airbnb. Instant Sui settlement. Walrus receipts. SuiUSD payments. Refundable damage deposits held in Sui escrow.

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

CANCELLATION POLICY: Full refund 24+ hours before check-in. 50% within 24 hours. Security deposit auto-released on cancellation before check-in.`;
}

function buildHostSystemPrompt(session) {
  return `You are ARIA Host Assistant — an AI agent for property hosts on ARIA, a vacation rental platform on Sui blockchain.

You have FULL access to host operations. You can fetch all bookings, calculate revenue, read/reply to guest messages, release damage deposits, cancel bookings, and pull guest reviews.

IMPORTANT RULES:
- Always confirm before release_deposit or cancel_booking
- When showing revenue, break it down: gross → ARIA fee (3%) → taxes → net earnings
- Be proactive — if asked about messages, check them; if asked about revenue, compute it live
- Format numbers as USD. Be clear and concise. You are talking to the HOST.

JURISDICTION TAX RATES for your properties:
1. Oceanfront Villa (Miami Beach, FL) — 13.00%
2. Downtown Loft (Austin, TX) — 17.00%
3. Mountain Cabin (Asheville, NC) — 13.00%
4. Desert Retreat (Scottsdale, AZ) — 8.05%
5. Lake House (Lake Tahoe, CA) — 10.00%
6. Historic Brownstone (Brooklyn, NY) — 14.75%

ABOUT ARIA: 3% fee vs 15% Airbnb. Instant Sui settlement. Walrus receipts. SuiUSD. Refundable damage deposits held in Sui escrow.

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

// ─── Grok API call ────────────────────────────────────────────────────────────

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

// ─── Walrus helper ────────────────────────────────────────────────────────────

async function pushToWalrus(data) {
  try {
    const res = await fetch('https://publisher.walrus-testnet.walrus.space/v1/blobs?epochs=3', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(JSON.stringify(data))
    });
    const json = await res.json();
    return json?.newlyCreated?.blobObject?.blobId ?? json?.alreadyCertified?.blobId ?? null;
  } catch (err) {
    console.warn('Walrus push failed:', err.message);
    return null;
  }
}

// ─── Tool executor ────────────────────────────────────────────────────────────
// `isHost` is resolved server-side by the route handler and passed in. Every
// host-only tool is gated here too, so a forged tool call can't escalate.

async function executeTool(toolName, toolInput, session, isHost) {
  try {

    if (HOST_ONLY_TOOLS.has(toolName) && !isHost) {
      return JSON.stringify({ error: 'Host access required' });
    }

    // ── Guest: get own bookings from Postgres ─────────────────────────────────
    if (toolName === 'get_bookings') {
      const result = await pool.query(
        'SELECT * FROM bookings WHERE wallet_address = $1 ORDER BY created_at DESC',
        [session.suiAddress]
      );
      return JSON.stringify(result.rows);
    }

    // ── Guest: create booking in Postgres ─────────────────────────────────────
    if (toolName === 'create_booking') {
      const { propertyId, checkIn, checkOut } = toolInput;
      const nights = Number(toolInput.nights);

      // Server-authoritative property + price — ignore any client-supplied price.
      const prop = PROPERTIES[Number(propertyId)];
      if (!prop) return JSON.stringify({ error: 'Invalid propertyId (must be 1-6)' });
      if (!nights || nights < 1 || nights > 90) return JSON.stringify({ error: 'nights must be between 1 and 90' });

      const propertyTitle = prop.title;
      const pricePerNight = prop.price;

      // Double-booking guard
      const conflict = await pool.query(
        `SELECT booking_ref FROM bookings
         WHERE property_id = $1 AND payment_status != 'cancelled'
         AND check_in < $3 AND check_out > $2`,
        [propertyId, checkIn, checkOut]
      );
      if (conflict.rows.length > 0) {
        return JSON.stringify({ error: 'Property not available for selected dates', conflicts: conflict.rows });
      }

      const jurisdiction  = JURISDICTION_TAX_RATES[Number(propertyId)] || { rate: 0.08, name: 'Unknown', breakdown: '8% occupancy tax' };
      const bookingRef    = `ARIA-${propertyId}-${Date.now()}`;
      const subtotal      = pricePerNight * nights;
      const ariaFee       = Math.round(subtotal * 0.03);
      const taxes         = Math.round(subtotal * jurisdiction.rate);
      const total         = subtotal + ariaFee + taxes;
      const depositAmount = Math.round(total * 0.20);
      const hostPayout    = calculateHostPayout(subtotal);
      const taxPct        = (jurisdiction.rate * 100).toFixed(2);

      // Insert into Postgres
      await pool.query(
        `INSERT INTO bookings (booking_ref, property_id, property_title, wallet_address, guest_name, guest_email,
          check_in, check_out, nights, price_per_night, subtotal, aria_fee, taxes, total_amount,
          deposit_amount, payment_status, payment_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'confirmed','SuiUSD')`,
        [bookingRef, propertyId, propertyTitle, session.suiAddress, session.name, session.email,
         checkIn, checkOut, nights, pricePerNight, subtotal, ariaFee, taxes, total, depositAmount]
      );

      // Push to Walrus
      const walrusBlobId = await pushToWalrus({
        bookingRef, app: 'ARIA Demo', network: 'sui:testnet',
        timestamp: new Date().toISOString(), property: propertyTitle, propertyId,
        checkIn, checkOut, nights,
        breakdown: {
          pricePerNight: `$${pricePerNight}`, nights,
          subtotal: `$${subtotal}`, ariaFee: `$${ariaFee} (3%)`,
          taxes: `$${taxes} (${taxPct}% — ${jurisdiction.name})`,
          totalPaid: `$${total} SuiUSD`
        },
        hostPayout: {
          amount: `$${hostPayout.hostPayout} SuiUSD`,
          ariaFee: `$${hostPayout.ariaFee} SuiUSD`,
          settlementMethod: hostPayout.settlementMethod
        },
        jurisdiction: jurisdiction.name, jurisdictionBreakdown: jurisdiction.breakdown,
        walletAddress: session.suiAddress, guestName: session.name, guestEmail: session.email,
        paymentMethod: 'SuiUSD', paymentStatus: 'confirmed', depositAmount, depositStatus: 'held'
      });
      if (walrusBlobId) {
        await pool.query('UPDATE bookings SET walrus_blob_id = $1 WHERE booking_ref = $2', [walrusBlobId, bookingRef]);
      }

      // Confirmation email
      try {
        const { Resend } = await import('resend');
        const resend    = new Resend(process.env.RESEND_API_KEY);
        const emailRows = [
          ['Booking Ref',     bookingRef],
          ['Check-in',        checkIn],
          ['Check-out',       checkOut],
          ['Nights',          nights],
          ['Price per night', `$${pricePerNight}`],
          ['Subtotal',        `$${subtotal}`],
          ['ARIA Fee (3%)',   `$${ariaFee}`],
          [`Taxes (${taxPct}% — ${jurisdiction.name})`, `$${taxes}`],
        ];
        const rowsHtml   = emailRows.map(([l, v]) => `<tr><td style="color:#888;padding:6px 0">${l}</td><td style="text-align:right">${v}</td></tr>`).join('');
        const totalRow   = `<tr style="border-top:1px solid #333"><td style="padding:10px 0;font-weight:700">Total Charged</td><td style="text-align:right;font-weight:700;color:#00ff44">$${total} SuiUSD</td></tr>`;
        const depositRow = `<tr><td style="color:#4a9eff;padding:6px 0">Refundable Deposit (held in escrow)</td><td style="text-align:right;color:#4a9eff">$${depositAmount} SuiUSD</td></tr>`;
        const walrusHtml = walrusBlobId
          ? `<div style="background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:20px"><p style="margin:0 0 8px;font-size:12px;color:#555">WALRUS RECEIPT — PERMANENT ON-CHAIN RECORD</p><p style="margin:0;font-size:11px;color:#00ff44;word-break:break-all;font-family:monospace">${walrusBlobId}</p></div>`
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
              <table style="width:100%;border-collapse:collapse">${rowsHtml}${totalRow}${depositRow}</table>
              <p style="color:#555;font-size:12px;margin:12px 0 0;line-height:1.6">The security deposit is held in Sui escrow and will be automatically returned after your checkout.</p>
            </div>
            ${walrusHtml}
            <p style="color:#555;font-size:12px;text-align:center;margin:0">Powered by ARIA — Built on Sui | The Airbnb killer</p>
          </div>`
        });
      } catch (emailErr) {
        console.warn('AI booking email failed:', emailErr.message);
      }

      return JSON.stringify({
        success: true, bookingRef, property: propertyTitle,
        checkIn, checkOut, nights, totalAmount: total,
        depositAmount, jurisdiction: jurisdiction.name,
        taxRate: `${taxPct}%`,
        depositNote: 'Refundable security deposit held in Sui escrow — returned after checkout',
        network: 'sui:testnet', walrusBlobId,
        message: 'Booking confirmed and saved! Confirmation email sent.'
      });
    }

    // ── Cancel booking in Postgres ────────────────────────────────────────────
    if (toolName === 'cancel_booking') {
      const result = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [toolInput.bookingRef]);
      if (result.rows.length === 0) return JSON.stringify({ error: 'Booking not found' });
      const booking = result.rows[0];
      // A guest may only cancel their own booking; a host may cancel any.
      if (!isHost && booking.wallet_address !== session.suiAddress) return JSON.stringify({ error: 'Not your booking' });
      if (booking.payment_status === 'cancelled') return JSON.stringify({ error: 'Already cancelled' });

      const today = new Date(); today.setHours(0, 0, 0, 0);
      const depositAutoReleased = today < new Date(booking.check_in);
      const cancelledAt = new Date().toISOString();

      await pool.query(
        `UPDATE bookings SET payment_status='cancelled', cancelled_at=$1, deposit_status=$2 WHERE booking_ref=$3`,
        [cancelledAt, depositAutoReleased ? 'released' : 'held', toolInput.bookingRef]
      );

      const cancellationWalrusBlobId = await pushToWalrus({
        ...booking, walrusReceiptType: 'cancellation', cancellationTimestamp: cancelledAt
      });
      if (cancellationWalrusBlobId) {
        await pool.query('UPDATE bookings SET cancellation_walrus_blob_id=$1 WHERE booking_ref=$2',
          [cancellationWalrusBlobId, toolInput.bookingRef]);
      }

      try {
        const { Resend } = await import('resend');
        const resend = new Resend(process.env.RESEND_API_KEY);
        const depositNote = depositAutoReleased
          ? `<div style="background:#0a1a0a;border:1px solid #1a4a1a;border-radius:6px;padding:10px;margin-top:10px"><p style="color:#00ff44;font-size:12px;font-weight:600;margin:0 0 4px">🔓 Security deposit auto-released</p><p style="color:#888;font-size:12px;margin:0">Your $${booking.deposit_amount} deposit has been automatically returned since you cancelled before check-in.</p></div>`
          : `<div style="background:#0a0a1a;border:1px solid #1a1a3a;border-radius:6px;padding:10px;margin-top:10px"><p style="color:#4a9eff;font-size:12px;font-weight:600;margin:0 0 4px">🔒 Security deposit pending release</p><p style="color:#888;font-size:12px;margin:0">Your deposit will be reviewed and released by the host.</p></div>`;
        await resend.emails.send({
          from: 'ARIA <onboarding@resend.dev>',
          to: booking.guest_email,
          subject: `Booking Cancelled — ${booking.property_title} | Ref: ${toolInput.bookingRef}`,
          html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px">
            <h1 style="color:#ff4444;font-size:24px;margin:0 0 8px">❌ Booking Cancelled</h1>
            <p style="color:#888;margin:0 0 24px">Your cancellation confirmation — ${booking.guest_name}</p>
            <div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin-bottom:20px">
              <h2 style="margin:0 0 16px;font-size:18px">${booking.property_title}</h2>
              <table style="width:100%;border-collapse:collapse">
                <tr><td style="color:#888;padding:6px 0">Booking Ref</td><td style="text-align:right">${toolInput.bookingRef}</td></tr>
                <tr><td style="color:#888;padding:6px 0">Check-in</td><td style="text-align:right">${booking.check_in}</td></tr>
                <tr><td style="color:#888;padding:6px 0">Check-out</td><td style="text-align:right">${booking.check_out}</td></tr>
                <tr><td style="color:#888;padding:6px 0">Nights</td><td style="text-align:right">${booking.nights}</td></tr>
                <tr style="border-top:1px solid #333"><td style="padding:10px 0;font-weight:700">Refund Amount</td><td style="text-align:right;font-weight:700;color:#00ff44">$${booking.total_amount} SuiUSD</td></tr>
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
        console.warn('AI cancellation email failed:', emailErr.message);
      }

      return JSON.stringify({
        success: true, bookingRef: toolInput.bookingRef, depositAutoReleased,
        message: depositAutoReleased
          ? 'Booking cancelled. Deposit auto-released.'
          : 'Booking cancelled. Deposit pending host review.'
      });
    }

    // ── Host: get all bookings from Postgres ──────────────────────────────────
    if (toolName === 'get_all_bookings') {
      const result = await pool.query('SELECT * FROM bookings ORDER BY created_at DESC');
      return JSON.stringify(result.rows);
    }

    // ── Host: revenue summary from Postgres ───────────────────────────────────
    if (toolName === 'get_revenue_summary') {
      const result = await pool.query(`SELECT * FROM bookings WHERE payment_status != 'cancelled'`);
      const bookings = result.rows;
      const byProperty = {};
      let totalGross = 0, totalFees = 0, totalTaxes = 0, totalNet = 0, totalDeposits = 0;
      bookings.forEach(b => {
        const subtotal = Number(b.subtotal) || 0;
        const fee      = Number(b.aria_fee) || 0;
        const tax      = Number(b.taxes) || 0;
        const jur      = JURISDICTION_TAX_RATES[Number(b.property_id)] || { rate: 0.08, name: 'Unknown' };
        totalGross += Number(b.total_amount) || 0;
        totalFees  += fee;
        totalTaxes += tax;
        totalNet   += subtotal - fee;
        if (b.deposit_status === 'held') totalDeposits += Number(b.deposit_amount) || 0;
        const prop = b.property_title || 'Unknown';
        if (!byProperty[prop]) byProperty[prop] = { bookings: 0, gross: 0, net: 0, jurisdiction: jur.name, taxRate: `${(jur.rate * 100).toFixed(2)}%` };
        byProperty[prop].bookings++;
        byProperty[prop].gross += Number(b.total_amount) || 0;
        byProperty[prop].net   += subtotal - fee;
      });
      return JSON.stringify({ totalBookings: bookings.length, totalGross, totalFees, totalTaxes, totalNet, totalDepositsHeld: totalDeposits, byProperty });
    }

    // ── Get messages for a booking (guest must own it; host may read any) ──────
    if (toolName === 'get_messages') {
      if (!isHost) {
        const bk = await pool.query('SELECT wallet_address FROM bookings WHERE booking_ref = $1', [toolInput.bookingRef]);
        if (bk.rows.length === 0) return JSON.stringify({ error: 'Booking not found' });
        if (bk.rows[0].wallet_address !== session.suiAddress) return JSON.stringify({ error: 'Not your booking' });
      }
      const result = await pool.query(
        'SELECT * FROM messages WHERE booking_ref = $1 ORDER BY created_at ASC',
        [toolInput.bookingRef]
      );
      return JSON.stringify(result.rows);
    }

    // ── Host: scan all message threads (single query — no N+1) ────────────────
    if (toolName === 'get_all_messages') {
      const rows = await pool.query(`
        SELECT m.*, b.property_title, b.guest_name
        FROM messages m
        JOIN bookings b ON b.booking_ref = m.booking_ref
        ORDER BY b.created_at DESC, m.created_at ASC
      `);
      const byRef = new Map();
      for (const r of rows.rows) {
        if (!byRef.has(r.booking_ref)) {
          byRef.set(r.booking_ref, {
            bookingRef: r.booking_ref, property: r.property_title, guestName: r.guest_name,
            messageCount: 0, latestMessage: null, allMessages: []
          });
        }
        const t = byRef.get(r.booking_ref);
        const msg = { id: r.id, booking_ref: r.booking_ref, from_name: r.from_name, from_email: r.from_email, message: r.message, created_at: r.created_at };
        t.allMessages.push(msg);
        t.latestMessage = msg;
        t.messageCount++;
      }
      const threads = Array.from(byRef.values());
      return JSON.stringify(threads.length > 0 ? threads : 'No messages found.');
    }

    // ── Send message (guest must own the booking; host may message any) ───────
    if (toolName === 'send_message') {
      if (!isHost) {
        const bk = await pool.query('SELECT wallet_address FROM bookings WHERE booking_ref = $1', [toolInput.bookingRef]);
        if (bk.rows.length === 0) return JSON.stringify({ error: 'Booking not found' });
        if (bk.rows[0].wallet_address !== session.suiAddress) return JSON.stringify({ error: 'Not your booking' });
      }
      await pool.query(
        'INSERT INTO messages (booking_ref, from_name, from_email, message) VALUES ($1,$2,$3,$4)',
        [toolInput.bookingRef, session.name, session.email, toolInput.message]
      );
      return JSON.stringify({ success: true, message: 'Message sent.' });
    }

    // ── Host: release deposit in Postgres ─────────────────────────────────────
    if (toolName === 'release_deposit') {
      const result = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [toolInput.bookingRef]);
      if (result.rows.length === 0) return JSON.stringify({ error: 'Booking not found' });
      const booking = result.rows[0];

      // Superadmins may release any; a regular approved host only their own property.
      if (!HOST_ADDRESSES.includes((session.email || '').toLowerCase())) {
        const owns = await pool.query('SELECT 1 FROM properties WHERE id = $1 AND host_address = $2', [booking.property_id, session.suiAddress]);
        if (owns.rows.length === 0) return JSON.stringify({ error: 'You do not manage this property' });
      }

      if (booking.deposit_status === 'released') return JSON.stringify({ error: 'Deposit already released' });
      await pool.query(
        `UPDATE bookings SET deposit_status='released' WHERE booking_ref=$1`,
        [toolInput.bookingRef]
      );
      const walrusBlobId = await pushToWalrus({
        ...booking, walrusReceiptType: 'deposit_release', depositReleaseTimestamp: new Date().toISOString()
      });
      if (walrusBlobId) {
        await pool.query('UPDATE bookings SET deposit_release_walrus_blob_id=$1 WHERE booking_ref=$2',
          [walrusBlobId, toolInput.bookingRef]);
      }
      return JSON.stringify({ success: true, bookingRef: toolInput.bookingRef, message: 'Deposit released to guest.' });
    }

    // ── Host: get all reviews from Postgres ───────────────────────────────────
    if (toolName === 'get_reviews') {
      const result = await pool.query('SELECT * FROM reviews ORDER BY created_at DESC');
      return JSON.stringify(result.rows);
    }

    return JSON.stringify({ error: `Unknown tool: ${toolName}` });

  } catch (err) {
    console.error('Tool execution error:', err);
    return JSON.stringify({ error: err.message });
  }
}

export async function registerAIRoute(fastify) {
  fastify.post('/api/ai/chat', async (request, reply) => {

    const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
    if (!sessionId) return reply.code(401).send({ error: 'Not authenticated' });
    const session = await getSession(sessionId);
    if (!session) return reply.code(401).send({ error: 'Session expired' });

    const { messages } = request.body;
    if (!messages || !Array.isArray(messages)) return reply.code(400).send({ error: 'messages array required' });

    // Role is decided here from the verified session — NOT from request.body.mode.
    const isHost = await resolveIsHost(session);
    const tools  = isHost ? HOST_TOOLS : GUEST_TOOLS;

    let guestBookings = [];
    if (!isHost) {
      try {
        const result = await pool.query(
          'SELECT * FROM bookings WHERE wallet_address = $1 ORDER BY created_at DESC',
          [session.suiAddress]
        );
        guestBookings = result.rows;
      } catch {}
    }

    const systemPrompt = isHost
      ? buildHostSystemPrompt(session)
      : buildGuestSystemPrompt(session, guestBookings);

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

      if (!toolCalls || toolCalls.length === 0) {
        finalText = choice.message.content || '';
        break;
      }

      apiMessages.push({
        role: 'assistant',
        content: choice.message.content || null,
        tool_calls: toolCalls
      });

      for (const toolCall of toolCalls) {
        const toolName  = toolCall.function.name;
        const toolInput = JSON.parse(toolCall.function.arguments);
        const result    = await executeTool(toolName, toolInput, session, isHost);

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
