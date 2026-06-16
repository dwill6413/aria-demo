# ARIA Remediation Plan

Companion to `ARIA_CODE_AUDIT.md`. Organized into 5 phases, ordered so that each phase is safe to ship before the next starts, and nothing later depends on something earlier being skipped. Every phase ends with a "verify" step before moving on — per standing practice, nothing gets pushed to GitHub from this sandbox; all pushes happen from your own machine after you've reviewed the diff.

---

## Phase 0 — Zero-risk fixes (do first, ship same day)

No behavior change, no migration, no coordination needed. Pure cleanup.

| # | Fix | File(s) | Effort |
|---|-----|---------|--------|
| 7 | Pin `"@mysten/sui"` to the exact version currently resolved (`npm ls @mysten/sui`), matching the `^` style of every other dep | `package.json` | 5 min |
| 8 | Decide: adopt zod for request validation (used in Phase 2) or delete it from `package.json` | `package.json` | 5 min |
| 10 | Replace hardcoded "8%" tax copy with the actual per-jurisdiction rate pulled from the same data Phase 2 centralizes | `pages/host.jsx` | 15 min |
| 14 | Point `getSuiUSDLiquidity`'s indexer URL at testnet, or delete the function if confirmed unused | `deepbook.mjs` | 10 min |
| 19 | Add a basic `0x` + length check on `payoutSuiAddress` before submit | `pages/become-host.jsx` | 10 min |

**Verify:** `npm install` succeeds, app boots locally, no visual regressions on host dashboard.

---

## Phase 1 — Critical: stop trusting client-supplied money values

This is the one with real exposure. Do it before anything else that touches booking/payment code, so you're not building on top of the vulnerable path.

**1a. Server-side price recomputation (Finding #1)**
- Import `catalog.mjs` into `server.mjs`.
- In `/booking/create` and `/payment/create-intent`: take only `propertyId`, `checkIn`, `checkOut` (or `nights`) from the request body. Discard/ignore any client-sent `price`, `pricePerNight`, `totalAmount`, `amount`.
- Recompute price, tax, and total exactly the way `ai_route.mjs`'s `create_booking` tool already does — that code is your reference implementation, copy its logic rather than re-deriving it.
- Return the server-computed breakdown in the response so the UI still shows the right numbers (it currently shows what it sent, which is now irrelevant).

**1b. Authorization scoping (Finding #4)**
- Find every `server.mjs` route gated by a global host-boolean (`isHost` without a property match) that mutates state tied to a specific property (release-deposit, remit, approve, etc.).
- Port the pattern from `ai_route.mjs`'s `release_deposit`: check `properties.host_address === session.suiAddress` (or caller's email is in the global `HOST_ADDRESSES` list) before allowing the action.

**Verify (do this on testnet, live, before moving on):**
- Attempt a booking with a tampered `totalAmount` via curl/devtools — confirm the server ignores it and charges the correct recomputed amount.
- Confirm a host account can't release/remit/approve a booking on a property owned by a different host address.
- Run a normal booking end-to-end through the UI to confirm nothing broke for the happy path.

This phase touches money-handling code directly — test it live on testnet with a throwaway booking before considering it done, per your "let's test it live" standard.

---

## Phase 2 — Consolidate the duplicated sources of truth

Phase 1 only works long-term if there's one place pricing/property data lives. Do this right after Phase 1 so the fix doesn't get silently undone by the next price change.

**2a. Single pricing/property source (Finding #3)**
- `catalog.mjs` becomes the only place `PROPERTIES`/`JURISDICTION_TAX_RATES` are defined.
- `server.mjs`: already importing it after Phase 1 — delete the old inline duplicate.
- `ai_route.mjs`: already importing it (no change needed, this one was already correct).
- `pages/index.jsx` / `pages/host.jsx`: delete the hardcoded arrays; fetch property/pricing data from a new lightweight `GET /properties` endpoint (or pass it via `getServerSideProps`/`getStaticProps` if you want it baked at build time) instead of duplicating it client-side.

**2b. One shared booking-creation module (Finding #5)**
- Extract the booking-creation logic (validation, double-booking overlap check, price/tax computation from 1a) into one function, e.g. `bookings.mjs: createBooking(...)`.
- Have both `server.mjs`'s `/booking/create` and `ai_route.mjs`'s `create_booking` tool call it. This is what prevents a third future divergence between the two paths.

**2c. Smaller consolidations, same pattern, do in one pass:**
- Extract `pushToWalrus()` (Finding #17) into a shared module, import in both `server.mjs` and `ai_route.mjs`.
- Extract HTML email templates (Finding #18) into a shared templates module.
- Extract `getStoredSid`/`authFetch` (Finding #15) into `lib/api.js`, import in all six pages currently duplicating it.

**Verify:** grep for `PROPERTIES =` and `JURISDICTION_TAX_RATES =` repo-wide — should return exactly one definition site each (`catalog.mjs`). Full booking flow test again end-to-end.

---

## Phase 3 — Schema and process fixes

Independent of Phase 1/2; can run in parallel if you want to split this across two sessions, but is listed third because it's lower urgency than money/auth bugs.

**3a. Missing tables (Finding #2)**
- Add `CREATE TABLE IF NOT EXISTS sessions (...)` and `CREATE TABLE IF NOT EXISTS property_ical_feeds (...)` to `initDB()` in `db.mjs`, matching the columns each module already queries (`auth.mjs` for sessions, `ical.mjs` for the feeds table).
- Test against a throwaway/empty database to confirm `initDB()` now creates everything needed for a cold start — this is the actual regression test for this finding (a populated dev DB won't catch it).

**3b. Indexes (Finding #13)**
- Add indexes: `bookings(wallet_address)`, `bookings(property_id)`, `bookings(booking_ref)` (unique if refs are meant to be unique — also fixes part of Finding #12), `messages(booking_ref)`.

**3c. Booking ref collision (Finding #12)**
- Switch booking ref generation from timestamp-based to `crypto.randomBytes` or a Postgres-generated UUID. If existing refs follow a human-readable pattern (e.g. `ARIA-<propertyId>-<timestamp>`) you may want to keep the prefix and just replace the timestamp suffix with a random component, to avoid breaking the existing display format.

**Verify:** drop and recreate a scratch database, run `initDB()`, confirm no errors and all expected tables/indexes exist (`\dt` / `\di` in psql).

---

## Phase 4 — Scaling readiness (do before adding a second server instance)

Not urgent at current scale, but should land before you ever set Railway to run more than one instance.

- Finding #11: move rate-limit counters and session-purge from in-process (`setInterval`, in-memory maps) to Postgres-backed (a `last_request_at` style table, or a scheduled job) or Redis if you add one. A single-instance deploy can ship without this; do not scale horizontally before it's done.
- Finding #9: have the booking-history API return raw numeric fields (`totalPaidCents` or similar) alongside the formatted display strings; update `pages/host.jsx`'s revenue calculations to sum the numeric fields instead of parsing display strings.

**Verify:** load-test with two local instances pointed at the same DB, confirm rate limits are now shared/correct across both.

---

## Phase 5 — Test quality and hygiene

Lowest urgency, but cheap and prevents future regressions from going unnoticed.

- Finding #6: export the real `extractCreatedObjectId` from `server.mjs` and import it into `escrow.test.mjs`, deleting the hand-copied duplicate.
- Finding #8 (if you chose "adopt" in Phase 0): add zod schemas for `/booking/create`, `/payment/create-intent`, `/host/apply` request bodies — this also hardens Phase 1's input handling.
- Finding #16: add error logging (not just swallowing) in `/bookings/history` and `/bookings/all`'s catch blocks.
- Finding #20 / #21: no action needed now — both are deliberate, already-understood tradeoffs (escaped-HTML markdown renderer, `localStorage` for cross-domain session id). Revisit only if the deployment topology or chat-rendering needs change.

---

## Suggested order of operations

1. Phase 0 (same session, low risk)
2. Phase 1 (own session, test live on testnet before merging — this is the one that touches money)
3. Phase 2 (own session, immediately after — locks in Phase 1's fix)
4. Phase 3 (can be its own session anytime)
5. Phase 4 (only before scaling to multiple instances — not urgent otherwise)
6. Phase 5 (anytime, lowest priority)

After each phase, update `ARIA_HANDOFF.md`/`ARIA_ROADMAP.md` with what landed, and write a Walrus memory entry noting what was fixed — explicitly marked as superseding the audit findings it resolves, per standing practice. Nothing here gets pushed to GitHub from this sandbox; review the diff and push from your own machine as usual.
