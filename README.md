# ARIA — The Airbnb Killer
### Vacation Rentals Rebuilt on Sui Blockchain

> **Sui Overflow 2026 Submission** · Consumer App · DeFi · Infrastructure · AI + Blockchain

---

## What is ARIA?

ARIA is a full-stack vacation rental platform built natively on Sui blockchain. It replaces every centralized chokepoint in the $100B+ vacation rental industry with Sui primitives — instant settlement, tamper-proof receipts, on-chain escrow, and zero-friction onboarding.

**Airbnb charges 15%. ARIA charges 5%.**
**Airbnb takes 3–5 days to pay hosts. ARIA settles in under 1 second.**
**Airbnb stores receipts on centralized servers. ARIA stores them on Walrus — decentralized, tamper-proof, and independently verifiable.**

*Current testnet retention is ~53 days per Walrus blob (paid-epoch storage); long-term/permanent retention is a mainnet migration item, not yet live — see `walrus.mjs`.*

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
| **Walrus** | Every booking receipt — and each guest's encrypted identity — stored on Walrus; receipts are tamper-proof and publicly verifiable |
| **DeepBook** | Host payout calculations run through live on-chain liquidity pools |
| **Sui Escrow** | Two non-custodial per-booking escrows: a **deposit escrow** (refundable damage deposit) and a **payment escrow** (rental + ARIA fee + tax), both held as Sui objects and verifiable by both parties |
| **Seal** | Guests encrypt their identity (KYC-style PII) in-browser; only the host of an active booking can decrypt it, gated on-chain by `seal_approve`. ARIA never sees the plaintext |
| **SuiUSD** | All guest payments in stable USD — no crypto tax event, no swap volatility |

---

## Features

### Guest Experience
- 🔐 **zkLogin** — Sign in with Google, Sui wallet created automatically
- 🪪 **Identity Verification** (`/profile`) — Encrypt KYC-style PII in-browser with Seal, stored on Walrus; only your booking's host can decrypt it. Optional booking gate (`REQUIRE_GUEST_VERIFICATION`)
- 🏠 **Property Browse** — 6 properties with 5-photo galleries, live ratings, and pricing
- 📅 **Date Selection** — Live cost breakdown with subtotal, ARIA fee (5%), and occupancy tax
- ⚡ **One-signature Booking** — A single wallet signature funds **two** on-chain escrows (payment + refundable deposit) atomically; pre-sign panel shows exactly where each leg goes
- 💸 **Fee follows refund** — Cancel before check-in for a full refund of rental + fee + tax + deposit; at check-in the payment splits to host / ARIA / tax remittance
- 🧾 **Walrus Receipt** — Tamper-proof, independently verifiable receipt with blob ID in confirmation email (currently ~53-day testnet retention)
- 💬 **Secure Messaging** — Per-booking chat with read receipts and unread badges
- ⭐ **Reviews** — 1–5 star reviews displayed live on property cards
- 🤖 **AI Agent** — Book, cancel, message hosts, and manage reservations via natural language

### Host Experience
- 📊 **Dashboard** — 9-stat overview: revenue, fees, taxes, net earnings, deposits, messages, ratings
- 💰 **Revenue Summary** — Gross → ARIA fee (5%) → taxes (varies by jurisdiction) → net earnings, per-property breakdown
- 📅 **iCal Sync** — Two-way sync with Airbnb and VRBO to prevent double bookings
- 🔒 **Deposit Management** — Release damage deposits with one click, stored on Walrus
- 🪪 **View Guest Identity** — Decrypt a booking guest's verified identity in-browser via Seal (only for your own active bookings; logged in `pii_access_log`)
- 💸 **Automatic check-in payout** — A keeper cron releases each payment escrow's 3-way split (host / ARIA / tax) at check-in; no manual step
- 💬 **Inbox** — Unread message badges, per-booking threads
- 🏡 **AI Host Agent** — Revenue summaries, inbox scanning, deposit release via natural language

### On-Chain Audit Trail
Every booking lifecycle event generates a tamper-proof Walrus receipt (currently ~53-day testnet retention — see the note under "What is ARIA?"):
- `walrusBlobId` — Booking confirmed
- `cancellationWalrusBlobId` — Booking cancelled
- `depositReleaseWalrusBlobId` — Deposit released

### Security
- Global rate limiting — 100 requests/minute per IP; per-route limits (5 bookings/15min, 10 cancels/hour); AI chat per-request message/length caps
- Security headers — `@fastify/helmet` on the API (HSTS, nosniff, frame, referrer) + Next.js headers on the frontend
- Input validation (Zod) on all booking, cancel, deposit, and verification routes
- Server-authoritative pricing — subtotal/fee/tax recomputed from `catalog.mjs`; client amounts never trusted
- Non-custodial escrows — guest signs and submits; backend re-verifies on-chain (lag-free destination-authority checks) before trusting any digest
- DB integrity — unique index on one-review-per-booking, status CHECK enums, replay-guarded `settlement_digest`
- Seal PII access logging — every `/host/guest-identity` request recorded in `pii_access_log`
- Double-booking prevention via atomic insert under a per-property advisory lock

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

# Payments (card fallback to SuiUSD — hosted Stripe Checkout, see M6 in
# ARIA_ROADMAP.md). STRIPE_WEBHOOK_SECRET comes from the Stripe Dashboard's
# webhook endpoint config, pointed at POST /webhooks/stripe — required for
# card bookings to ever confirm; the route safely rejects all events without it.
STRIPE_SECRET_KEY=your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=your_stripe_webhook_signing_secret

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

| Feature | Airbnb / VRBO | A