# ARIA — AI Assistant Handoff Document
## For: Any experienced developer continuing or taking over this project
## Last Updated: May 29, 2026
## Owner: Cecil Williams (cwilliams36092@gmail.com)
## GitHub: https://github.com/dwill6413/aria-demo (public repo)

---

## WHAT IS ARIA?

ARIA is a vacation rental platform built on the Sui blockchain. The core pitch: **Airbnb but with 3% fees** (vs Airbnb's ~15%), **instant on-chain settlement**, and **refundable security deposits held in Sui smart contract escrow** — not by ARIA. Every booking generates a permanent immutable receipt stored on Walrus (Sui's decentralized storage). Guests log in with Google — **no crypto wallet or seed phrase needed** — powered by zkLogin.

This is currently a **demo / hackathon project** running on **Sui testnet** and **Walrus testnet** with simulated SuiUSD payments. It is deployed and functional.

**Live URLs**
- Frontend: https://aria-demo-psi.vercel.app
- Backend: https://aria-demo-production-e590.up.railway.app
- Health: https://aria-demo-production-e590.up.railway.app/health
- GitHub: https://github.com/dwill6413/aria-demo

---

## TECH STACK

| Layer              | Technology                          | Notes |
|--------------------|-------------------------------------|-------|
| Frontend           | Next.js (React)                     | Deployed on Vercel |
| Backend            | Fastify (Node.js ESM)               | Deployed on Railway |
| Database           | PostgreSQL                          | Railway managed, 8 tables |
| Auth               | Google OAuth → zkLogin              | Sui wallet derived from Google login; no seed phrase |
| Blockchain         | Sui testnet                         | SuiUSD (simulated) + DeepBook + Walrus |
| Receipt storage    | Walrus testnet                      | Immutable booking + cancellation receipts |
| Email              | Resend API                          | `onboarding@resend.dev` sender |
| Payments           | SuiUSD (primary) + Stripe fallback  | Stripe for card payments |
| AI Agent           | Grok `grok-3-latest` (xAI)          | NOT Anthropic — uses xAI REST API |
| Package manager    | pnpm                                | **Always use pnpm** |

**Important libraries**: `@mysten/sui`, `@mysten/walrus`, `@mysten/deepbook-v3`, `pg`, `@fastify/cookie`, `@fastify/rate-limit`, `resend`, `stripe`, `zod`, `ical-generator`.

---

## PROJECT FILE MAP (Current)

```
aria-demo/
├── server.mjs              # Fastify backend — ALL API routes + middleware
├── auth.mjs                # zkLogin flow + Postgres session management
├── ai_route.mjs            # Grok AI agent + tool definitions + executor
├── db.mjs                  # PostgreSQL pool + initDB() table creation
├── ical.mjs                # iCal export/import (async)
├── deepbook.mjs            # DeepBook integration + host payout helpers
├── config.mjs              # dotenv loader
├── railway.json            # Railway build/start config
├── vercel.json
├── next.config.mjs
└── pages/
    ├── index.jsx           # Main listings + booking modal + tax calc
    ├── bookings.jsx        # Guest booking history
    ├── host.jsx            # Host dashboard (RBAC protected)
    ├── messages.jsx        # Messaging UI
    ├── ai.jsx              # AI agent chat interface
    ├── become-host.jsx     # Host application form
    ├── terms.jsx           # Terms of Service
    └── auth/zklogin/
        └── callback.jsx    # OAuth callback handler
```

**Note**: The `pages/` directory contains the core user-facing pages listed above. The structure follows standard Next.js pages router conventions.

---

## DATABASE TABLES (Accurate as of May 29, 2026)

All tables created in `db.mjs` via `initDB()`.

| Table              | Purpose & Key Columns |
|--------------------|-----------------------|
| `properties`       | Listings. `id` (SERIAL PK), `host_address` (TEXT NOT NULL), `title`, `description`, `location`, `price` (INTEGER), `beds`, `baths`, `tag`, `images` (TEXT[]), `active` (BOOLEAN DEFAULT true), `created_at` (TIMESTAMPTZ) |
| `bookings`         | Core booking records. `id` (SERIAL PK), `booking_ref` (TEXT UNIQUE NOT NULL), `property_id`, `property_title`, `wallet_address`, `guest_name`, `guest_email`, `check_in` (DATE), `check_out` (DATE), `nights`, `price_per_night`, `subtotal`, `aria_fee`, `taxes`, `total_amount`, `deposit_amount`, `deposit_status` (DEFAULT 'held'), `payment_status`, `payment_method` (DEFAULT 'SuiUSD'), `walrus_blob_id`, `cancellation_walrus_blob_id`, `cancelled_at`, `created_at` |
| `reviews`          | Guest reviews. `id`, `property_id`, `booking_ref`, `guest_name`, `guest_email`, `rating`, `review`, `created_at` |
| `messages`         | Per-booking messaging. `id`, `booking_ref`, `from_name`, `from_email`, `message`, `created_at` |
| `hosts`            | **Legacy table** — `id`, `sui_address` (UNIQUE), `email`, `name`, `approved` (BOOLEAN DEFAULT false), `created_at` |
| `host_profiles`    | Current host applications & approvals (rich schema). `id`, `sui_address` (UNIQUE NOT NULL), `email`, `name`, `phone`, `property_address`, `city`, `state`, `zip`, `country` (DEFAULT 'US'), `jurisdiction`, `str_permit`, `payout_sui_address`, `payout_notes`, `status` (DEFAULT 'pending'), `approved_at`, `approved_by`, `terms_agreed`, `terms_agreed_at`, `compliance_confirmed`, `created_at`, `updated_at` |
| `property_ical_feeds` | External calendar feeds per property (`property_id`, `platform`, `ical_url`, `updated_at`) |
| `tax_remittances`  | Tax tracking. `id`, `booking_ref` (UNIQUE), `property_id`, `property_title`, `tax_amount`, `jurisdiction`, `remitted_at`, `remitted_by`, `notes`, `created_at` |
| `sessions`         | **Auth sessions** (see Auth section). `id` (varchar), `data` (JSONB with user + Sui info), `expires_at` (TIMESTAMPTZ) |

**All tables** use `SERIAL PRIMARY KEY` and have `created_at TIMESTAMPTZ DEFAULT NOW()`. Appropriate `UNIQUE` constraints exist on `booking_ref` and `sui_address` fields.

---

## THE SINGLE MOST IMPORTANT THING TO UNDERSTAND: AUTH & SESSIONS

**Sessions are stored in PostgreSQL** (the `sessions` table). There is **no local file-based session storage** of any kind.

**Full login flow (cross-domain between Vercel frontend and Railway backend):**
1. User clicks Sign In → `/auth/zklogin/init` → Railway redirects to Google.
2. `GOOGLE_CALLBACK_URL` **MUST** be set in Railway to: `https://aria-demo-psi.vercel.app/auth/zklogin/callback`
3. Google redirects back to the Vercel callback page with `#id_token=...&state=...` in the URL hash.
4. `pages/auth/zklogin/callback.jsx` extracts hash params → POSTs them to Railway.
5. Railway creates a new session record in Postgres (24-hour expiration) and redirects to Vercel with `?auth=success&sid=SESSION_ID`.
6. Frontend reads the `sid` query param → `localStorage.setItem('aria_sid', sid)`.
7. Every subsequent API call uses a wrapper (`authFetch()`) that reads from localStorage and adds the `x-session-id` header.
8. Backend extracts: `const sessionId = request.cookies.aria_session || request.headers['x-session-id']`
9. Protected routes must do: `const session = await getSession(sessionId)`

**getSession implementation** (in `auth.mjs`):
- Performs `SELECT data FROM sessions WHERE id = $1 AND expires_at > NOW()`
- Returns the parsed JSON `data` object or `null` if expired/missing
- A background `purgeExpiredSessions()` job runs every hour via `setInterval`

**Critical rules for any new developer:**
- Every single `getSession()` call in `server.mjs` **must** be awaited. There are 20+ call sites.
- If login breaks, check in this order:
  1. `GOOGLE_CALLBACK_URL` points to the Vercel domain (not Railway)
  2. `FRONTEND_URL` is correctly set
  3. The callback URL is registered in Google Cloud Console
  4. All `getSession()` calls use `await`

The `aria_session` cookie is HttpOnly and signed with `SESSION_SECRET`.

---

## RBAC (ROLE-BASED ACCESS CONTROL)

Two tiers of access:

1. **Superadmin**: The user's email is listed in the `HOST_ADDRESSES` environment variable (comma-separated list). Full access to everything.
2. **Approved host**: The `isHost(session)` helper returns true. This checks:
   - Email is in `HOST_ADDRESSES`, **or**
   - `session.dbHostApproved === true` (populated by a lookup against `host_profiles.status = 'approved'`)

Host-only routes return HTTP 403 for non-hosts:
- `/bookings/all`
- `/reviews/all`
- `/booking/release-deposit`
- `/tax/summary`, `/tax/remit`, `/tax/unremit`
- `/host/applications`, `/host/approve`

Superadmin-only routes additionally require the email to be in `HOST_ADDRESSES`.

---

## BOOKING FLOW & CALCULATIONS

**Frontend calculation** (in `pages/index.jsx`):
- `subtotal = pricePerNight * nights`
- `ariaFee = subtotal * 0.03`
- `taxes = subtotal * jurisdictionRate` (looked up from `JURISDICTION_TAX_RATES`)
- `bookingTotal = subtotal + ariaFee + taxes`
- `deposit = bookingTotal * 0.20`
- `chargeTotal = bookingTotal + deposit`

Backend (`/booking/create`):
- Performs availability conflict check
- Inserts into `bookings` table
- Writes immutable receipt to Walrus
- Sends confirmation email via Resend (includes full itemization + Walrus blob ID)
- Returns booking reference immediately

Security deposit is conceptually held in Sui escrow (simulated on testnet) and is fully refundable upon cancellation before check-in or after successful checkout.

---

## JURISDICTION TAX RATES — CRITICAL DUPLICATION WARNING

**Hardcoded constant exists in THREE separate files.** Any change must be made in all three locations:

- `pages/index.jsx`
- `server.mjs`
- `ai_route.mjs`

Current rates (as of May 29, 2026):

| Property ID | Location                  | Rate   | Jurisdiction Name          |
|-------------|---------------------------|--------|----------------------------|
| 1           | Miami Beach, FL           | 13.00% | Miami-Dade County, FL      |
| 2           | Austin, TX                | 17.00% | City of Austin, TX         |
| 3           | Asheville, NC             | 13.00% | Buncombe County, NC        |
| 4           | Scottsdale, AZ            | 8.05%  | City of Scottsdale, AZ     |
| 5           | Lake Tahoe, CA            | 10.00% | Placer County, CA          |
| 6           | Brooklyn, NY              | 14.75% | New York City, NY          |

**Planned improvement**: Integrate TaxJar API so the rate is looked up dynamically per booking using the property address. When this is implemented, remove the `JURISDICTION_TAX_RATES` constant from all three files.

---

## AI AGENT (`ai_route.mjs`)

- **Model**: `grok-3-latest` via the xAI API (`https://api.x.ai/v1/chat/completions`)
- **Auth**: Requires `XAI_API_KEY` environment variable
- **Endpoint**: `POST /api/ai/chat` — accepts `{ messages: [], mode: 'guest' | 'host' }`
- **Agentic loop**: Up to **10 iterations**. The model can call tools; results are appended to the conversation history and the model is called again until it returns a final message with no tool calls.

**Guest mode tools**:
- `get_bookings`
- `create_booking` (with confirmation step)
- `cancel_booking`
- `get_messages`
- `send_message`

**Host mode tools**:
- `get_all_bookings`
- `get_revenue_summary`
- `get_all_messages`
- `get_messages`
- `send_message`
- `release_deposit`
- `get_reviews`
- `cancel_booking`

All tools execute real database queries via the shared `pool`. The agent has access to the authenticated user's session data.

---

## ICAL SYNC (`ical.mjs`)

Both key functions are **async**:

- `generateICal(propertyId)` — async function that queries the `bookings` table for non-cancelled bookings and generates a standards-compliant `.ics` file.
- `saveExternalCalendar(propertyId, platform, icalUrl)` — async function that upserts into `property_ical_feeds` and returns the current set of feeds for that property.

**Always use `await`** when calling these from `server.mjs`.

Availability checking (`/availability/:propertyId`) combines internal bookings with external iCal feeds to detect conflicts.

---

## EMAIL (Resend)

All transactional emails are sent through the Resend API using `RESEND_API_KEY`.

Current triggered emails:
- Booking confirmation (full itemized breakdown + Walrus blob ID)
- Booking cancellation (includes deposit release status)
- Host application received (notifies applicant + admin)
- Host approved (welcomes new host with dashboard link)

Sender identity: `ARIA <onboarding@resend.dev>`

---

## ENVIRONMENT VARIABLES

**Railway backend (expected):**
- `DATABASE_URL` (auto-provided by Railway Postgres)
- `XAI_API_KEY`
- `RESEND_API_KEY`
- `STRIPE_SECRET_KEY`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_CALLBACK_URL` → **Must** be `https://aria-demo-psi.vercel.app/auth/zklogin/callback`
- `FRONTEND_URL` → **Must** be `https://aria-demo-psi.vercel.app`
- `SESSION_SECRET` (used to sign HttpOnly cookies)
- `HOST_ADDRESSES` (comma-separated list of superadmin emails)
- `SUI_NETWORK` = `testnet`
- `PORT`

**Vercel frontend:**
- `NEXT_PUBLIC_API_URL`
- `NEXT_PUBLIC_GOOGLE_CLIENT_ID`
- `STRIPE_PUBLISHABLE_KEY`

Environment variables are loaded via `config.mjs` using `dotenv`.

---

## KNOWN GOTCHAS (Read Before Making Changes)

1. **`getSession` is async** — Every protected route in `server.mjs` that calls it **must** await the result. This is the most common source of authentication bugs.
2. **AI uses Grok via xAI, not Anthropic** — The endpoint and SDK are for `https://api.x.ai/v1/chat/completions`. Do not confuse with the Anthropic SDK (which is present in package.json but not currently used for the agent).
3. **No local file storage** — Receipts (Walrus), messages, reviews, calendars, **and sessions** (Postgres) have all been migrated away from local JSON files. If you see `fs`, `readFileSync`, `writeFileSync`, `existsSync`, etc. in any `.mjs` file other than `config.mjs`, treat it as a regression bug and remove it.
4. **Tax rate constant is duplicated in three files** — `JURISDICTION_TAX_RATES` must be kept in sync across `pages/index.jsx`, `server.mjs`, and `ai_route.mjs` until TaxJar integration replaces it.
5. **Always use pnpm** — The project uses pnpm. Running `npm install` can corrupt the lockfile.
6. **`generateICal` and `saveExternalCalendar` are async** — Always await them in route handlers.
7. **Owner preference**: Cecil prefers **complete file rewrites** rather than small partial edits when making changes. This avoids merge conflicts and makes the final state of each file unambiguous.
8. **Commit message convention**: `"Fix/Add [component] — [short description of new behavior]"`

---

## CURRENT STATE & ASSUMPTIONS FOR INCOMING DEVELOPER

- The application is in a **demo / hackathon-ready state**. Core booking, messaging, AI agent, iCal sync, and host approval flows are functional on testnet.
- Properties are currently seeded (no full self-serve host property CRUD yet — this is on the roadmap).
- Payments use simulated SuiUSD on testnet + Stripe in test mode.
- All persistent data lives in PostgreSQL + Walrus. There is no local filesystem storage for application data.
- Cross-domain authentication (Vercel ↔ Railway) works via the documented localStorage + custom header pattern.
- The AI agent can perform real actions (create/cancel bookings, release deposits, etc.) via tool calling.
- Rate limiting is active globally (100 req/min) plus tighter limits on booking creation, cancellation, and host applications.
- The codebase is public on GitHub and uses conventional Next.js + Fastify structure.

An experienced developer should be able to understand the system, run it locally, and begin feature work or hardening within a few hours after reading this document.

---

## WHAT'S LEFT TO BUILD (Recommended Order)

**High priority / before wider use:**
- Rotate all secrets and API keys
- Purchase and configure custom domain (`stayaria.com` recommended)
- Add Walrus Sites deployment of the frontend for decentralized hosting
- Implement TaxJar integration and remove duplicated tax rate constant

**Next phase features:**
- Full host property CRUD (create, edit, deactivate listings)
- Transak or similar on-ramp (fiat → SuiUSD) for guests and off-ramp for hosts
- Migration from Sui testnet → mainnet + Walrus mainnet
- Mobile-first responsive improvements and better loading/error states
- Enhanced validation, monitoring, and structured logging
- Production hardening (proper error boundaries, rate limit tuning, input sanitization)

---

## SECURITY & HANDOFF CHECKLIST

Before handing off or deploying more widely, verify:

```bash
# Ensure no leftover AI assistant instruction files
ls CLAUDE.md .cursorrules 2>/dev/null || echo "Clean - no assistant rule files found"

pnpm audit --audit-level=high
git status
git diff HEAD
```

**Never commit or share raw `.env` files or full secret values.**

---

## HOW TO START WORKING ON ARIA

1. Read this entire document.
2. Clone the repository.
3. (Optional) Run locally:
   - `node server.mjs` for the backend
   - `pnpm dev` for the frontend
4. Run the security checklist above.
5. Confirm with the owner (Cecil) which specific area or feature to tackle first.
6. When editing code, prefer **complete file rewrites** for clarity.

---

This document is intended to allow an experienced developer to quickly understand the architecture, avoid common pitfalls, and continue development efficiently.

If you need additional supporting files (e.g., a shorter `CONTRIBUTING.md`, architecture diagrams, or database ERD), let the owner know.
