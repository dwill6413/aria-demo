# ARIA — Security/Quality Remediation Change Log

Tracks fixes landed against the findings in `ARIA_CODE_AUDIT.md` (dated June 16, 2026),
following the order in `ARIA_REMEDIATION_PLAN.md`. Each phase below is complete as of
this writing. Live-testnet end-to-end verification was skipped for each phase per
established precedent (this sandbox has no production DB/testnet credentials); each
fix was verified by direct code read-through instead.

---

## Phase 0 — Zero-risk cleanup

- Pinned `@mysten/sui` to an exact version (Finding #7).
- Decision deferred on zod (Finding #8) — resolved in Phase 5 below.
- Fixed hardcoded "8%" tax copy in `pages/host.jsx` to use real per-jurisdiction rates (Finding #10).
- Pointed/removed `getSuiUSDLiquidity`'s mainnet indexer URL (Finding #14).
- Added `0x` + length check on `payoutSuiAddress` in `pages/become-host.jsx` (Finding #19).

## Phase 1 — Server-side price recomputation + auth scoping

- `server.mjs`'s `/booking/create` and `/payment/create-intent` now recompute price/tax/total server-side from `catalog.mjs`, never trusting client-sent amounts (Finding #1).
- Ported property-scoped host authorization into the REST release-deposit path, matching `ai_route.mjs`'s already-correct scoping (Finding #4).

## Phase 2 — Consolidate duplicated sources of truth

- **2a**: `server.mjs` now imports `catalog.mjs` directly instead of an inline duplicate (Finding #3).
- **2b**: Extracted `bookings.mjs` (`createBooking()`) as the single implementation shared by `server.mjs`'s REST `/booking/create` and `ai_route.mjs`'s `create_booking` AI tool (Finding #5). This also closed a real gap: the AI-chat path previously never built an escrow transaction at all despite telling guests their deposit was held in one. `escrow.mjs` now holds the Sui escrow PTB helpers (`buildEscrowTransaction`, `verifyEscrowTransaction`, `autoReleaseEscrow`, `extractCreatedObjectId`), importable by both `bookings.mjs` and `server.mjs`. `pages/ai.jsx` got the same escrow-signing UI `pages/index.jsx` already had.
- **2c**: Extracted `lib/authFetch.js` (`getStoredSid`/`authFetch`), previously byte-for-byte duplicated across `pages/index.jsx`, `host.jsx`, `bookings.jsx`, `ai.jsx`, `become-host.jsx`, `messages.jsx` (Finding #15). All six pages now import from it.

## Phase 3 — Schema and process fixes

- **3a**: Added `sessions` and `property_ical_feeds` tables to `initDB()` in `db.mjs` — both were queried by `auth.mjs`/`ical.mjs` but never created, which would have crashed every login/iCal sync on a fresh database (Finding #2).
- **3b**: Added indexes on `bookings(wallet_address)`, `bookings(property_id)`, `messages(booking_ref)` (Finding #13). `bookings(booking_ref)` already had an implicit unique index via its column constraint.
- **3c**: Booking refs now include a `crypto.randomBytes(3)` hex suffix (`ARIA-<propertyId>-<timestamp>-<hex>`) instead of timestamp-only, removing the concurrent-request collision risk while keeping the existing human-readable prefix (Finding #12).

## Phase 4 — Scaling readiness

- Finding #9: `/bookings/history` and `/bookings/all` now return raw numeric `ariaFee`/`taxes` fields alongside the existing `totalAmount` and the formatted `breakdown.*` display strings. `pages/host.jsx`'s revenue totals (`totalRevenue`, `totalAriaFees`, `totalTaxes`, per-property `revenue`) now sum the raw fields instead of regex-parsing display strings.
- Finding #11 (in-process rate-limit counters / session-purge): **explicitly deferred**, per user decision. Railway currently runs a single instance, and the plan itself flags this as "not urgent... do not scale horizontally before it's done." Note for whoever scales this next: `@fastify/rate-limit` is registered without a shared store (`server.mjs`), so a second instance would get its own independent counters. Session purge itself is no longer an in-memory-state concern — Phase 3a made `sessions` a real Postgres table, so the existing hourly `setInterval` in `auth.mjs` is just redundant (harmless) cleanup across instances, not a correctness bug.

## Phase 5 — Test quality and hygiene

- Finding #6: `escrow.test.mjs` now imports the real `extractCreatedObjectId` from `escrow.mjs` instead of testing a hand-copied duplicate.
- Finding #8: zod adopted (user decision). New `validation.mjs` defines schemas for `/booking/create`, `/payment/create-intent`, `/host/apply`; each route validates `request.body` against its schema before reaching business logic, returning a 400 on failure. Existing business-logic checks (date ordering, nights range, propertyId range) are unchanged — zod only catches malformed shapes earlier.
- Finding #16: `/bookings/history` and `/bookings/all` now log caught errors via `fastify.log.error` instead of swallowing them silently.
- Finding #20/#21: no action — both are deliberate, understood tradeoffs (escaped-HTML markdown renderer in `pages/ai.jsx`; `localStorage` session id for cross-domain auth). Revisit only if chat-rendering needs or deployment topology change.

---

## Findings explicitly not actioned (and why)

| Finding | Status | Reason |
|---|---|---|
| #11 | Deferred | Not urgent at single-instance scale; revisit before adding a second Railway instance. |
| #20 | No action | Deliberate tradeoff, already safe (HTML-escaped before parsing). |
| #21 | No action | Deliberate tradeoff for cross-domain auth (Railway API + Vercel frontend). |

All other findings (#1–#10, #12–#19) are resolved as of this log.
