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

import { pool } from './db.mjs';
import { getSession } from './auth.mjs';
import { PROPERTIES, JURISDICTION_TAX_RATES } from './catalog.mjs';
import { createBooking, releaseDepositForBooking, cancelBooking } from './bookings.mjs';
import { pushToWalrus } from './walrus.mjs';

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
      description: 'Book a property on ARIA for the guest. Always confirm details with the user before calling this. Price, nights, fees, and taxes are computed server-side from propertyId/checkIn/checkOut — you do not need to (and should not) supply them.',
      parameters: {
        type: 'object',
        properties: {
          propertyId: { type: 'number', description: 'Property ID (1-6)' },
          checkIn:    { type: 'string', description: 'Check-in date YYYY-MM-DD' },
          checkOut:   { type: 'string', description: 'Check-out date YYYY-MM-DD' }
        },
        required: ['propertyId', 'checkIn', 'checkOut']
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

// R4: property + tax prompt blocks generated from catalog.mjs so the AI never
// quotes a price/tax that has drifted from what createBooking() actually charges.
function catalogPromptSections() {
  const props = Object.entries(PROPERTIES).map(([id, p]) => {
    const j = JURISDICTION_TAX_RATES[Number(id)];
    const loc = j?.name ? ` — ${j.name}` : '';
    return `${id}. ${p.title} — $${p.price}/night${loc} (id:${id})`;
  }).join('\n');
  const taxes = Object.entries(JURISDICTION_TAX_RATES).map(([id, j]) =>
    `${id}. ${PROPERTIES[Number(id)]?.title || 'Property ' + id} — ${(j.rate * 100).toFixed(2)}% (${j.breakdown})`
  ).join('\n');
  return { props, taxes };
}

function buildGuestSystemPrompt(session, bookings) {
  const active = (bookings || []).filter(b => b.payment_status !== 'cancelled');
  const bkSummary = active.length > 0
    ? active.map(b => `- ${b.property_title} (ref: ${b.booking_ref}, ${b.check_in} to ${b.check_out}, ${b.nights} nights, $${b.total_amount} SuiUSD)`).join('\n')
    : 'No active bookings yet.';

  const { props, taxes } = catalogPromptSections();

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
${taxes}

ABOUT ARIA: 3% fee vs 15% Airbnb. Instant Sui settlement. Walrus receipts. SuiUSD payments. Refundable damage deposits held in Sui escrow.

CURRENT USER: ${session.name} (${session.email})
Wallet: ${session.suiAddress}

ACTIVE BOOKINGS:
${bkSummary}

AVAILABLE PROPERTIES:
${props}

CANCELLATION POLICY: Full refund 24+ hours before check-in. 50% within 24 hours. Security deposit auto-released on cancellation before check-in.`;
}

function buildHostSystemPrompt(session) {
  const { props, taxes } = catalogPromptSections();
  return `You are ARIA Host Assistant — an AI agent for property hosts on ARIA, a vacation rental platform on Sui blockchain.

You have FULL access to host operations. You can fetch all bookings, calculate revenue, read/reply to guest messages, release damage deposits, cancel bookings, and pull guest reviews.

IMPORTANT RULES:
- Always confirm before release_deposit or cancel_booking
- When showing revenue, break it down: gross → ARIA fee (3%) → taxes → net earnings
- Be proactive — if asked about messages, check them; if asked about revenue, compute it live
- Format numbers as USD. Be clear and concise. You are talking to the HOST.

JURISDICTION TAX RATES for your properties:
${taxes}

ABOUT ARIA: 3% fee vs 15% Airbnb. Instant Sui settlement. Walrus receipts. SuiUSD. Refundable damage deposits held in Sui escrow.

HOST USER: ${session.name} (${session.email})
Wallet: ${session.suiAddress}

YOUR 6 PROPERTIES:
${props}`;
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
// pushToWalrus now lives in walrus.mjs (R3) and is imported above.

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

    // ── Guest: create booking ──────────────────────────────────────────────────
    // Phase 2b: delegates to the same createBooking() in bookings.mjs that
    // server.mjs's REST /booking/create uses, instead of a hand-maintained
    // copy. This also closes a real gap: the old copy here never built an
    // escrow transaction at all, yet still told the guest their deposit was
    // "held in Sui escrow" — createBooking() now builds the same guest-signed
    // escrow PTB the REST flow does, and returns escrowTxBytes for the
    // frontend (pages/ai.jsx) to have the guest sign via zkLogin, exactly
    // like pages/index.jsx already does after a REST-created booking.
    // Date-derived nights (not the LLM's stated `nights`) decide stay length —
    // see createBooking's comment on why client/LLM-supplied nights aren't trusted.
    if (toolName === 'create_booking') {
      const { propertyId, checkIn, checkOut } = toolInput;
      const result = await createBooking({ propertyId, checkIn, checkOut, session });
      return JSON.stringify(result);
    }

    // ── Cancel booking in Postgres ────────────────────────────────────────────
    // ── Cancel booking — delegates to the shared cancelBooking() service ──────
    // (R2 + M1) identical logic to REST /booking/cancel, including on-chain escrow
    // release. Guest cancels their own; a host (isHost) may cancel any.
    if (toolName === 'cancel_booking') {
      const result = await cancelBooking({ bookingRef: toolInput.bookingRef, session, isHost });
      return JSON.stringify(result.error ? { error: result.error } : result);
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

    // ── Host: release deposit ─────────────────────────────────────────────────
    // Findings #4/#5: this used to be a weaker copy of the REST release path —
    // no checkout gate, no claim/dispute guard, no on-chain auto_release. It now
    // delegates to the SAME releaseDepositForBooking() helper server.mjs's REST
    // route uses, so the two paths enforce identical guards and both only mark
    // the deposit released when the on-chain release actually succeeds.
    if (toolName === 'release_deposit') {
      const result = await pool.query('SELECT * FROM bookings WHERE booking_ref = $1', [toolInput.bookingRef]);
      if (result.rows.length === 0) return JSON.stringify({ error: 'Booking not found' });
      const booking = result.rows[0];

      // Superadmins may release any; a regular approved host only their own property.
      if (!HOST_ADDRESSES.includes((session.email || '').toLowerCase())) {
        const owns = await pool.query('SELECT 1 FROM properties WHERE id = $1 AND host_address = $2', [booking.property_id, session.suiAddress]);
        if (owns.rows.length === 0) return JSON.stringify({ error: 'You do not manage this property' });
      }

      const release = await releaseDepositForBooking(booking);
      if (release.error) return JSON.stringify({ error: release.error });

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
    // Captures the structured result of a successful create_booking tool call
    // so the frontend (pages/ai.jsx) can render a "sign to lock deposit in
    // escrow" button — the model's own reply is plain text and can't carry
    // escrowTxBytes, so it rides alongside `response` in the HTTP result below.
    let booking = null;

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

        if (toolName === 'create_booking') {
          try {
            const parsed = JSON.parse(result);
            if (parsed.success && parsed.escrowTxBytes) {
              booking = { bookingRef: parsed.bookingRef, escrowTxBytes: parsed.escrowTxBytes, property: parsed.property, depositAmount: parsed.depositAmount };
            }
          } catch {}
        }

        apiMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: result
        });
      }
    }

    return booking ? { response: finalText, booking } : { response: finalText };
  });
}
