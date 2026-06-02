# ARIA — Technical Handoff Document
**Version:** 3.0 | **Updated:** June 02, 2026

Deeper technical details for developers or AI assistants continuing work on ARIA.
This version is reconciled against the code actually deployed to production.
For the full security change log with rationale, see `ARIA_REMEDIATION.md`.

## Architecture Overview

- **Frontend**: Next.js (Pages Router) + react-datepicker, deployed on Vercel
- **Backend**: Fastify (ESM) + PostgreSQL (node-postgres), deployed on Railway
- **Auth**: Google OAuth → zkLogin (derives a Sui wallet address)
- **AI agent**: Grok (xAI), via an OpenAI-compatible `fetch` call (no SDK)
- **Database**: PostgreSQL, 9 tables (see below)
- **Payments**: SuiUSD primary + Stripe fallback (create-intent only)
- **Storage**: Walrus for immutable receipts
- **Sessions**: Stored in PostgreSQL `sessions` table (always were — see note)

## Database Tables (9)

`properties`, `bookings`, `reviews`, `messages`, `hosts` (legacy/unused),
`tax_remittances`, `host_profiles`, `sessions`, `property_ical_feeds`.

`initDB()` in `db.mjs` now creates all of these idempotently (`IF NOT EXISTS`),
including `sessions` and `property_ical_feeds`, which were previously missing
from `initDB` and had to be created by hand. It also adds the
`deposit_release_walrus_blob_id` column and indexes on the common query filters.

## Key Technical Decisions

### Cross-Domain Auth
- Backend (Railway) and frontend (Vercel) live on different domains.
- Third-party cookies are unreliable cross-domain, so after the OAuth callback the
  session ID is passed to the frontend via a URL param (`?sid=`) and stored in
  `localStorage`.
- All authenticated requests send it as an `x-session-id` header (with the cookie
  as a fallback). See `authFetch()` in the frontend pages.
- **Known limitation:** the session token traveling in the URL is not ideal. The
  recommended future fix is a one-time code exchange so the token never appears in
  the URL. (Deferred — see "Deliberately Deferred" below.)

### Session Management
- Sessions are persisted in the `sessions` table and survive Railway restarts.
- Functions in `auth.mjs`: `getSession()`, `saveSession()`, `deleteSession()`,
  plus a periodic `purgeExpiredSessions()`.
- Session IDs are generated with `crypto.randomBytes(32)` (CSPRNG).
- Stored session data is minimal: `suiAddress`, `email`, `name`, `picture`,
  `createdAt`. The ephemeral private key and raw `id_token` are **not** persisted.

### Authoritative Pricing & Tax (catalog.mjs — NEW)
- `catalog.mjs` is the single source of truth for property prices (`PROPERTIES`)
  and `JURISDICTION_TAX_RATES`. Both `server.mjs` and `ai_route.mjs` import from it.
- Booking totals are computed server-side from the catalog; client-supplied prices
  are ignored. Catalog prices match the frontend display, so legitimate totals are
  unchanged.
- The frontend still keeps its own copy of the property/tax data for display
  (remaining duplication — see tech debt).

### Tax System
- Jurisdiction-based occupancy tax rates per property (was previously a flat 8%).
- Rates live in `catalog.mjs`. Backend duplication has been removed; the frontend
  copy remains.

## Security Hardening (June 2026)

All of the following are live in production:

1. **AI agent role is server-derived.** The Grok agent's host/guest role comes from
   the session (`HOST_ADDRESSES` or an approved `host_profiles` row), **not** the
   client `mode` flag. Host-only tools (`get_all_bookings`, `get_revenue_summary`,
   `get_all_messages`, `release_deposit`, `get_reviews`) are gated inside
   `executeTool()` so a forged tool call cannot escalate.
2. **Google JWT verification on callback.** `auth.mjs` verifies the token's RS256
   signature against Google's JWKS, checks `aud`/`iss`/`exp`, and confirms the
   token `nonce` matches the login attempt. (Uses Node's built-in `crypto` — no new
   dependency.)
3. **Server-side price validation.** `/booking/create` and the AI `create_booking`
   price from `catalog.mjs`; `/payment/create-intent` bounds-checks the amount.
4. **Object-level authorization (IDOR fixes).** Message read/send, review submit,
   and booking cancel verify the booking belongs to the caller (or that the caller
   is a host). `release_deposit` is scoped: superadmins may release any deposit; a
   regular approved host only for a property they manage.
5. **XSS fix.** The AI chat output is HTML-escaped before rendering in
   `pages/ai.jsx` (it previously used `dangerouslySetInnerHTML` with no escaping).
6. **CSPRNG session IDs** and **minimal session storage** (see above).
7. **Honest booking writes.** A failed booking insert now returns 500 instead of
   silently reporting "confirmed."
8. **Performance.** The host `get_all_messages` N+1 loop is now a single JOIN, and
   `db.mjs` adds indexes for the common filters.

## Date Handling

- Calendar dates (`check_in` / `check_out`) are date-only values. The frontend
  renders them with a `fmtDay()` helper that formats from the Y-M-D parts, so they
  never shift across a timezone boundary. (A prior `new Date(str)` approach parsed
  them as UTC midnight and rolled back a day in negative-UTC zones.)
- Timestamps (`created_at`, `approved_at`, etc.) still use `fmtDate()` /
  `fmtDateTime()`, which are timezone-aware and correct for instants.
- Note: the **write** path in `index.jsx` uses `.toISOString()`, which is correct
  in negative-UTC zones but would shift for a user booking from a positive-UTC zone
  (Europe/Asia). Stored data has been verified correct; this is optional defensive
  hardening for later.

## Important Files

| File | Purpose | Notes |
|------|--------|-------|
| `server.mjs` | Main Fastify server | All routes, RBAC, `requireSession`/`requireHost`/`requireSuperadmin` helpers |
| `catalog.mjs` | **NEW** — prices + tax rates | Single source of truth; imported by server + AI route |
| `db.mjs` | Pool + `initDB()` | Creates all 9 tables, column, and indexes (idempotent) |
| `auth.mjs` | OAuth + sessions | JWT verification, CSPRNG IDs, Postgres-backed sessions |
| `ai_route.mjs` | Grok AI agent endpoint | Server-derived role, per-tool authz, server-side pricing |
| `deepbook.mjs` | Sui payout calculations | Queries mainnet indexer (cosmetic on testnet) |
| `ical.mjs` | iCal export/import + availability | |
| `pages/ai.jsx` | AI chat UI | HTML-escaped output |
| `pages/bookings.jsx`, `pages/host.jsx` | Guest/host dashboards | `fmtDay()` for calendar dates |

## Deliberately Deferred (known limitations, not oversights)

These were left unchanged on purpose to avoid breaking working behavior or existing
data. Each has a recommended follow-up:

1. **zkLogin salt is hardcoded `'0'`.** Changing it re-derives every user's Sui
   address and would orphan existing bookings. Follow-up: per-user secret salt with
   a migration.
2. **DB TLS is unverified** (`ssl: { rejectUnauthorized: false }`). Railway's cert
   doesn't validate against the default CA. Follow-up: supply Railway's CA and set
   `rejectUnauthorized: true`.
3. **Session token in the URL** (`?sid=`). Cross-domain login depends on it; the XSS
   fix removes the practical theft path. Follow-up: one-time code exchange.

## Current Technical Debt

1. **Properties**: still frontend-hardcoded; the `properties` table is empty.
   `catalog.mjs` holds prices server-side, but listings aren't DB-driven yet.
2. **Frontend tax/price duplication**: backend is centralized in `catalog.mjs`;
   the frontend still hardcodes its own copy. Ideal: frontend fetches from backend.
3. **Stripe**: create-intent only; webhooks missing.
4. **Error handling**: improved in key paths (booking insert, auth) but still
   inconsistent elsewhere.
5. **Testing**: no automated tests.
6. **Legacy**: the `hosts` table and the `@anthropic-ai/sdk` dependency are unused;
   `zod` is installed but not used for validation yet.

## Best Practices for Changes

- Always use `authFetch()` in the frontend.
- Use `requireSession` / `requireHost` / `requireSuperadmin` in `server.mjs`; never
  trust a client-supplied role or price.
- For the AI agent, gate host-only tools by the server-derived `isHost`, not the
  request body.
- Compute money and dates server-side; render calendar dates with `fmtDay()`.
- All `db.mjs` DDL must stay idempotent.
- Keep this doc and `ARIA_REMEDIATION.md` in sync when making major changes.

**Last major updates**: security hardening (AI authz, JWT verification, server-side
pricing, IDOR fixes, XSS), `catalog.mjs` added, schema/index fixes in `initDB`,
timezone-safe date display.

---
*Technical Handoff v3.0 — June 02, 2026*
