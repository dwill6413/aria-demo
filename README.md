# ARIA — The Airbnb Killer
### Vacation Rentals Rebuilt on Sui Blockchain

> **Sui Overflow 2026 Submission** · Consumer App · DeFi · Infrastructure · AI + Blockchain

---

## What is ARIA?

ARIA is a full-stack vacation rental platform built natively on Sui blockchain. It replaces every centralized chokepoint in the $100B+ vacation rental industry with Sui primitives — instant settlement, tamper-proof receipts, on-chain escrow, and zero-friction onboarding.

**Airbnb charges 15%. ARIA charges 3%.**
**Airbnb takes 3–5 days to pay hosts. ARIA settles in under 1 second.**
**Airbnb stores receipts on centralized servers. ARIA stores them on Walrus — permanently, verifiably, immutably.**

---

## Live Demo

- **Frontend:** `http://localhost:3000`
- **Backend:** `http://localhost:3001`
- **Network:** Sui Testnet + Walrus Testnet

---

## Sui Technology Stack

| Primitive | How ARIA Uses It |
|---|---|
| **zkLogin** | Google OAuth creates a Sui wallet automatically — no seed phrase, no friction |
| **Walrus** | Every booking receipt stored permanently on-chain — tamper-proof and publicly verifiable |
| **DeepBook** | Host payout calculations run through live on-chain liquidity pools |
| **Sui Escrow** | Damage deposits held as Sui objects — verifiable by both parties, auto-released on cancellation |
| **SuiUSD** | All guest payments in stable USD — no crypto tax event, no swap volatility |

---

## Features

### Guest Experience
- 🔐 **zkLogin** — Sign in with Google, Sui wallet created automatically
- 🏠 **Property Browse** — 6 properties with 5-photo galleries, live ratings, and pricing
- 📅 **Date Selection** — Live cost breakdown with subtotal, ARIA fee (3%), and occupancy tax (8%)
- ⚡ **SuiUSD Booking** — Atomic transaction on Sui testnet, settles instantly
- 🧾 **Walrus Receipt** — Permanent on-chain receipt with blob ID in confirmation email
- ❌ **Cancellation** — Smart cancellation with auto deposit release before check-in
- 💬 **Secure Messaging** — Per-booking chat with read receipts and unread badges
- ⭐ **Reviews** — 1–5 star reviews displayed live on property cards
- 🤖 **AI Agent** — Book, cancel, message hosts, and manage reservations via natural language

### Host Experience
- 📊 **Dashboard** — 9-stat overview: revenue, fees, taxes, net earnings, deposits, messages, ratings
- 💰 **Revenue Summary** — Gross → ARIA fee (3%) → taxes (8%) → net earnings, per-property breakdown
- 📅 **iCal Sync** — Two-way sync with Airbnb and VRBO to prevent double bookings
- 🔒 **Deposit Management** — Release damage deposits with one click, stored on Walrus
- 💬 **Inbox** — Unread message badges, per-booking threads
- 🏡 **AI Host Agent** — Revenue summaries, inbox scanning, deposit release via natural language

### On-Chain Audit Trail
Every booking lifecycle event generates a permanent Walrus receipt:
- `walrusBlobId` — Booking confirmed
- `cancellationWalrusBlobId` — Booking cancelled
- `depositReleaseWalrusBlobId` — Deposit released

### Security
- Global rate limiting — 100 requests/minute per IP
- Critical route protection — 5 bookings/15min, 10 cancels/hour
- Input validation on all booking, cancel, and deposit routes
- Double-booking prevention via receipt-based overlap check with write-first pattern

---

## AI Agent (Powered by Grok)

ARIA has a native AI agent powered by xAI's Grok — **no API key required from users**. The agent runs server-side and has full access to ARIA's data and actions.

**Guest mode can:**
- Fetch booking history
- Create bookings (with cost breakdown confirmation)
- Cancel bookings
- Read and send messages

**Host mode can:**
- Get revenue summaries with per-property breakdown
- Scan all booking threads for unread messages
- Release damage deposits
- Pull all guest reviews
- Detect anomalies proactively

---

## How to Run Locally

### Prerequisites
- Node.js 18+
- pnpm (`npm install -g pnpm`)
- A Google Cloud project with OAuth credentials
- Resend account (free tier works)
- xAI API key (Grok)
- Stripe account (test mode)

### Setup

```bash
git clone https://github.com/dwill6413/aria-demo.git
cd aria-demo
pnpm install
```

Create a `.env` file in the project root:

```env
# Sui
SUI_NETWORK=testnet

# Google OAuth (zkLogin)
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret

# Session
SESSION_SECRET=any_long_random_string
FRONTEND_URL=http://localhost:3000

# Email
RESEND_API_KEY=your_resend_api_key

# Payments
STRIPE_SECRET_KEY=your_stripe_secret_key

# AI
XAI_API_KEY=your_xai_api_key

# Server
PORT=3001
```

### Run

```bash
# Terminal 1 — Backend
node server.mjs

# Terminal 2 — Frontend
pnpm dev
```

Open `http://localhost:3000`

---

## Project Structure

```
aria-demo/
├── pages/
│   ├── index.jsx          # Property listings + booking modal + photo gallery
│   ├── bookings.jsx        # Guest booking history with Walrus receipt links
│   ├── host.jsx           # Host dashboard — revenue, bookings, deposits, reviews
│   ├── messages.jsx        # Per-booking chat UI
│   └── ai.jsx             # Native Grok AI agent (guest + host modes)
├── server.mjs             # Fastify backend — all API routes
├── ai_route.mjs           # Native AI agent route (Grok via xAI)
├── auth.mjs               # zkLogin + Google OAuth + session management
├── deepbook.mjs           # DeepBook integration for host payout calculations
├── ical.mjs               # iCal export/import for anti-double-booking sync
└── config.mjs             # Environment configuration
```

---

## Why ARIA Beats Airbnb

| Feature | Airbnb / VRBO | ARIA |
|---|---|---|
| Platform fee | 12–15% | **3%** |
| Host payout speed | 3–5 days | **< 1 second** |
| Receipt storage | Centralized | **Walrus (permanent)** |
| Damage deposit | Platform escrow | **Sui escrow (on-chain)** |
| Login | Email/password | **zkLogin (Google → Sui wallet)** |
| Double booking | Manual sync | **Automated iCal + receipt guard** |
| AI agent | None | **Native Grok (guest + host)** |
| Audit trail | None | **3 Walrus receipts per booking** |

---

## Built By

**Cecil Williams** · Sui Overflow 2026
- Built in 4 days on Sui testnet
- Full working demo with real zkLogin, real Walrus receipts, real DeepBook

---

*Powered by ARIA — Built on Sui | The Airbnb Killer*
