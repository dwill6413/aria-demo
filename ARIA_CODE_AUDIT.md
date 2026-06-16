# ARIA Code Quality & Scalability Audit

Date: 2026-06-16
Scope: full repo — backend (`server.mjs`, `auth.mjs`, `db.mjs`, `ai_route.mjs`, `catalog.mjs`, `config.mjs`, `deepbook.mjs`, `ical.mjs`), tests (`escrow.test.mjs`, `escrow_tests.move`), Move contract (`escrow.move`), client (`lib/zklogin.js`, all `pages/*.jsx`), and build/config (`package.json`, `next.config.mjs`, `railway.json`, `vercel.json`).

Findings are ordered by severity. Each includes the concrete evidence and a recommendation.

---

## Critical

### 1. Client-supplied price is trusted by the REST booking path
`pages/index.jsx`'s `handleBooking()` sends `pricePerNight: selected.price` and `totalAmount: getBookingTotal(...)` — both computed entirely client-side from a hardcoded `PROPERTIES` array — directly to `POST /booking/create`. `handleCardPayment()` does the same for `amount` to `POST /payment/create-intent`. Server-side, these routes in `server.mjs` accept and persist those values without recomputing them from a trusted source.

This is a real, reachable vulnerability: editing `selected.price` in devtools before clicking "Book" changes what gets charged and recorded.

Contrast: `ai_route.mjs`'s `create_booking` tool does this correctly — it ignores any client-supplied price and recomputes from `catalog.mjs` server-side (`const pricePerNight = prop.price;`). The fix already exists in the codebase; it just isn't applied to the REST path.

**Fix:** Have `server.mjs`'s `/booking/create` and `/payment/create-intent` import `catalog.mjs` and recompute `pricePerNight`/`totalAmount`/tax server-side from `propertyId` + dates, the same way `ai_route.mjs` already does. Never persist or charge a client-sent amount.

---

## High

### 2. Schema drift — tables used in code but never created
Two confirmed instances of the same defect: code queries a Postgres table that `initDB()` in `db.mjs` never creates.

- `sessions` — used throughout `auth.mjs` (`getSession`, `saveSession`, `deleteSession`, `purgeExpiredSessions`).
- `property_ical_feeds` — used in `ical.mjs` (`saveExternalCalendar`, `getExternalCalendars`).

Neither appears in `db.mjs`'s `CREATE TABLE` statements (which cover only `properties`, `bookings`, `reviews`, `messages`, `hosts`, `tax_remittances`, `host_profiles`). On a fresh database (new environment, disaster recovery, a new contributor's local setup), auth and iCal sync will fail outright with no clear error pointing at the cause.

This is a process gap, not a one-off bug: two independent features were shipped against tables that were never added to the migration path. As the schema grows this will keep happening unless there's a single place new tables get registered.

**Fix:** Add both tables to `initDB()` immediately. Going forward, treat "new table" and "new `CREATE TABLE` in `initDB()`" as one atomic change — consider a lightweight migration tool (even a numbered SQL-files-in-order convention) rather than hand-maintained `initDB()` once the schema grows further.

### 3. Property/pricing data duplicated across five locations
The same `PROPERTIES` array and `JURISDICTION_TAX_RATES` map exist independently in:

- `catalog.mjs` (intended single source of truth)
- `server.mjs` (inline duplicate)
- `ai_route.mjs` (duplicated again into prompt strings)
- `pages/index.jsx` (client-side duplicate, lines ~20–66)
- `pages/host.jsx` (client-side duplicate, lines ~24–31)

`catalog.mjs`'s own header comment claims `server.mjs` imports it — it doesn't. This isn't just DRY hygiene: it already produced a visible bug (see #10 below, hardcoded "8%" tax label vs. real 8.05%–17% rates computed elsewhere). Every price change requires editing five files correctly, or guests/hosts see inconsistent numbers.

**Fix:** Make `catalog.mjs` the actual single source server-side (import it in `server.mjs`), and serve property/pricing data to the client via an API call instead of hardcoding it into `pages/index.jsx`/`pages/host.jsx`.

### 4. Inconsistent authorization scoping between the two booking paths
`ai_route.mjs`'s `release_deposit` tool correctly scopes host actions to the specific property (`properties.host_address` match, unless the caller is in the global `HOST_ADDRESSES` env list). The parallel REST route in `server.mjs` was found (prior pass) to rely on a single global host-boolean check in several places, without per-property ownership scoping. That means a logic gap exists where the REST path may allow a host to act on a property that isn't theirs, while the AI path already gets this right.

**Fix:** Port the property-scoped check from `ai_route.mjs`'s `release_deposit` into the equivalent `server.mjs` routes.

---

## Medium

### 5. Booking creation logic implemented twice, independently
The REST path (`server.mjs`) and the AI tool-calling path (`ai_route.mjs`) each have their own implementation of booking creation, including the double-booking overlap check. Every future business-rule change (cancellation windows, tax logic, availability checks) has to be made correctly in both places or the two paths silently diverge — which is exactly how #1 and #4 happened.

**Fix:** Extract booking creation/validation into one shared module both `server.mjs` and `ai_route.mjs` call.

### 6. Test exercises a copy of the function, not the live one
`escrow.test.mjs` tests `extractCreatedObjectId` via a hand-copied duplicate of the function (its own header says so: "Function under test (copy of the one in server.mjs)"). A future edit to the real function in `server.mjs` can silently diverge from what the test suite verifies, defeating the purpose of the test.

**Fix:** Export the real function from `server.mjs` (or a small shared module) and import it in the test.

### 7. Unpinned dependency
`package.json` pins every dependency except `"@mysten/sui": "latest"`. This is the SDK the entire chain-facing surface depends on (escrow signing, zkLogin, transaction submission) — an unpinned breaking release could change behavior in production without any code change on ARIA's side.

**Fix:** Pin to a specific version, same as every other dependency.

### 8. Declared but unused dependency
`zod` is listed in `package.json` but a full-codebase grep found zero usages (`z.object`, `z.string`, etc. — none). Meanwhile several routes (e.g. `/booking/create`) accept unvalidated client input. Zod is already paid for in bundle size and not doing any work.

**Fix:** Either adopt it for request-schema validation (it's well-suited to fixing #1's input-trust problem too) or remove it from `package.json`.

### 9. Revenue math built on parsed display strings
`pages/host.jsx` computes `totalRevenue`/`totalAriaFees`/`totalTaxes` by regex-stripping a pre-formatted currency string (`b.breakdown.totalPaid.split(' ')[0].replace(/[^0-9]/g, '')`) instead of using a raw numeric field from the API. A future change to the display format (adding a comma, a decimal, a currency symbol) silently corrupts host revenue totals with no error thrown.

**Fix:** Have the API return raw numeric totals alongside the formatted display string; sum the numeric ones.

### 10. Hardcoded tax-rate copy contradicts actual rates
`pages/host.jsx` hardcodes "8% occupancy tax" / "TAX (8%)" in multiple places, while the real per-jurisdiction rates used elsewhere in the app range from 8.05% to 17% (`JURISDICTION_TAX_RATES` in `catalog.mjs`). Hosts doing their own tax math against this label will get a visibly wrong number. Direct consequence of the duplication in #3.

### 11. In-memory rate limiting and session cleanup won't survive horizontal scaling
Rate limiting (per prior pass of `server.mjs`) and the hourly `setInterval`-based session-purge in `auth.mjs` are both process-local state. Railway can scale to multiple instances; each instance would enforce its own independent rate-limit counters (effectively multiplying the limit by instance count) and run its own redundant cleanup timer. Not a bug today at one instance, but a real blocker the moment a second instance is added for capacity or zero-downtime deploys.

**Fix:** Move rate-limit counters to Postgres or Redis before scaling beyond a single instance; let one instance (or a cron-style job) own session cleanup.

### 12. Timestamp-based booking reference risks collision
Booking refs generated from a timestamp (per prior pass of `server.mjs`) can collide under concurrent booking attempts at scale.

**Fix:** Use a UUID or a DB sequence/`gen_random_uuid()` for booking refs.

### 13. No indexes on any table
`db.mjs`'s `initDB()` creates seven tables with zero `CREATE INDEX` statements. Lookups by `wallet_address`, `property_id`, and `booking_ref` (used throughout `server.mjs`/`ai_route.mjs`) will degrade linearly as `bookings`/`messages`/`reviews` grow. Not a problem at current data volume; will be one well before "scale" in any meaningful sense.

**Fix:** Add indexes on `bookings.wallet_address`, `bookings.property_id`, `bookings.booking_ref`, `messages.booking_ref` ahead of volume growth, not after a slow-query incident.

### 14. Mainnet URL in a testnet-only deployment
`deepbook.mjs`'s `getSuiUSDLiquidity` queries `https://deepbook-indexer.mainnet.mystenlabs.com/get_pools` while the rest of the app explicitly targets testnet. Likely unused today, but a latent inconsistency that will misbehave (wrong network's data) the moment this function is wired up.

**Fix:** Point at the testnet indexer, or remove the function if it's dead code.

### 15. Auth-header boilerplate duplicated across six frontend pages
`getStoredSid()`/`authFetch()` are copy-pasted, byte-for-byte identical, in `pages/index.jsx`, `pages/host.jsx`, `pages/bookings.jsx`, `pages/ai.jsx`, `pages/become-host.jsx`, and `pages/messages.jsx`. Any future change to session handling (e.g. switching auth transport) requires six synchronized edits.

**Fix:** Extract to a shared `lib/api.js` and import everywhere.

### 16. Silent error swallowing in history/list routes
Prior pass of `server.mjs` found `/bookings/history` and `/bookings/all` swallowing caught errors without logging. Production failures here are invisible until a user reports "my bookings disappeared."

**Fix:** Log caught errors server-side at minimum, even if the user-facing response stays generic.

### 17. Duplicated Walrus-push helper
`pushToWalrus()` is implemented separately in both `server.mjs` and `ai_route.mjs`, rather than as one shared module.

### 18. Duplicated HTML email templates
Prior pass of `server.mjs` found inline HTML email templates duplicated rather than centralized — same maintenance risk pattern as #3/#15.

---

## Low

### 19. No client-side payout-address validation
`pages/become-host.jsx`'s `payoutSuiAddress` field is freely editable with no format check (e.g. `0x` + expected length) before submission. Server-side validation should be the real authority regardless, but a basic client check would catch typos earlier.

### 20. Hand-rolled markdown renderer in the AI chat UI
`pages/ai.jsx` implements its own markdown-to-HTML converter feeding `dangerouslySetInnerHTML`. It correctly escapes HTML before tokenizing (so injected markup can't execute), which is the right call, but it's bespoke parsing logic for something a small audited library would handle more robustly as formatting needs grow.

### 21. `localStorage` used for cross-domain session id
`aria_sid` is stored in `localStorage` (not just the httpOnly cookie) specifically to support the `x-session-id` header needed because Railway (API) and Vercel (frontend) are different domains. This is a deliberate, already-understood tradeoff, but it is more exposed to XSS than httpOnly-cookie-only auth would be. Worth revisiting if the deployment topology ever collapses onto one domain.

---

## What's solid

Not everything needs fixing — several parts of the codebase are genuinely well done and worth preserving as the pattern to extend elsewhere:

- **`lib/zklogin.js`** — clean, thoroughly commented, correct non-custodial design. Ephemeral key material is deliberately kept in `sessionStorage` (not `localStorage`) so it can't outlive the tab. No issues found.
- **`escrow.move` + `escrow_tests.move`** — the contract's permission model is tight: every state transition checks the correct caller (`ENotGuest`/`ENotHost`/`ENotArbitrator`), amount invariants are enforced (`EZeroAmount`, `EClaimExceedsDeposit`, `ESplitMismatch`), and the arbitrator can only ever split funds between guest and host, never to a third address. Test coverage is genuinely thorough, including the load-bearing guest protection (`auto_release` before expiry must fail) and the dispute-split invariant. Each booking's escrow is its own independent shared object rather than a single global registry, so booking volume scales horizontally on-chain without contention on a shared resource — a sound design choice for scale.
- **`ai_route.mjs`** — correctly server-authoritative pricing (the pattern #1 needs to be copied from), property-scoped host authorization for `release_deposit`, a double-booking overlap guard, and an N+1-avoiding single-JOIN query for `get_all_messages`.
- **Ownership checks** before message read/send/cancel are consistently enforced server-side (matching session address against the booking's `wallet_address`) rather than relying on the UI to hide actions — this pattern holds across both `ai_route.mjs` and the frontend pages reviewed.
- **`auth.mjs`** — hand-rolled Google JWKS RS256 verification is done correctly (signature check, audience, issuer, expiry, nonce-binding to the client-generated zkLogin nonce), session ids are cryptographically random, and the raw id_token is never persisted server-side.

---

## Priority order for fixes

1. Fix #1 (price tampering) — exploitable today, directly affects money.
2. Fix #2 (missing tables) — breaks on any fresh deploy/DR scenario.
3. Fix #4 (authorization scoping) — second money/access-control gap.
4. Consolidate #3/#5 (single source of truth + shared booking logic) — prevents the next version of #1 and #4 from being reintroduced.
5. Everything else (medium/low) can be scheduled incrementally; none are urgent, but #11 (rate limiting/session cleanup) becomes a hard blocker the moment a second server instance is added.
