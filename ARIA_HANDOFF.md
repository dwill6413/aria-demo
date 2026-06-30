# ARIA — Technical Handoff Document
**Version:** 4.31 | **Updated:** June 30, 2026

> **June 30, 2026 (LATEST — wallet balance display, zkLogin send, and self check-in with encrypted access instructions):**
> Three features shipped and verified end-to-end in-browser this session. No Move contract changes.
>
> **1. Wallet balance display (P3 — wallet UX).** Added `lib/useWalletBalance.js` hook
> that polls `GET /wallet/balance` every 30 seconds and on-demand. Balance (in SUI) is
> displayed in the header of all authenticated pages (`index.jsx`, `bookings.jsx`,
> `host.jsx`, `listing/[id].jsx`) with a low-balance faucet link and a ↻ refresh button.
>
> **2. zkLogin plain-SUI send (P3 — wallet UX).** Guests can now send SUI to any address
> directly from the ARIA UI — no external Sui Wallet extension required. The flow reuses
> zkLogin's existing browser-side signing authority:
> - Backend (`escrow.mjs`): `buildSendTransaction` + `verifySendTransaction` exports.
>   Uses `coinWithBalance({ balance: BigInt(amountMist) })` + `tx.transferObjects`.
>   `verifySendTransaction` reads `balanceChanges` from `getTransaction` to confirm
>   recipient received exactly the declared amount.
> - Backend (`server.mjs`): `POST /wallet/send/build` + `POST /wallet/send/confirm` routes.
>   Uses `isValidSuiAddress` + `parseToMist` for safe validation. Logs to `wallet_sends`
>   audit table.
> - Frontend: "Send" button + full Send modal added to both `pages/bookings.jsx` and
>   `pages/index.jsx` (homepage is where most users send from). Same non-custodial
>   build→sign→submit→confirm pattern as escrow. Explorer link on success.
> - DB (`db.mjs`): `wallet_sends` table (`from_address`, `to_address`, `amount_mist`,
>   `tx_digest`, `created_at`) with unique index on `tx_digest`.
> - Validation (`validation.mjs`): `walletSendBuildSchema`, `walletSendConfirmSchema`.
> - CORS: `PUT` added to allowed methods (`server.mjs` `@fastify/cors` config) —
>   was missing, blocked the access-instructions save route.
> - **Verified end-to-end in-browser (Jun 30 2026).**
>
> **3. Guest self check-in with AES-256-GCM encrypted access instructions (P4 — check-in UX).**
> Hosts can now choose between two check-in types per property. Guests get a time-gated
> Check In button that either reveals self check-in access instructions (door codes, wifi,
> etc.) or opens the existing BookingPass QR flow.
>
> *Host side:*
> - DB (`db.mjs`): `properties.check_in_type TEXT DEFAULT 'front_desk'`,
>   `properties.access_instructions_encrypted TEXT`, `bookings.checked_in BOOLEAN DEFAULT false`,
>   `bookings.checked_in_at TIMESTAMPTZ`.
> - Backend (`server.mjs`): `PUT /host/property/:id/access-instructions` (encrypt + store),
>   `GET /host/property/:id/access-instructions` (decrypt + return, ownership-checked).
>   AES-256-GCM via Node.js built-in `crypto`. Key = `CHECKIN_KEY` env var (64 hex chars / 32 bytes).
>   Stored format: `iv_hex:ciphertext_hex:authtag_hex`.
> - Frontend (`pages/host.jsx`): per-property CHECK-IN TYPE toggle (Front Desk / Self Check-in)
>   + textarea for instructions when Self selected + Save button. Lazy-loads existing settings
>   on first card render. Fixed: `loadCheckInSettings` now seeds default state before fetch
>   so the block renders for all properties (including catalog properties), not just DB-sourced ones.
>   Fixed: removed `source === 'db'` guard — all listed properties get the check-in settings block.
>
> *Guest side:*
> - Backend (`server.mjs`): `POST /booking/:bookingRef/checkin` — verifies session,
>   wallet ownership, booking active, deposit held. Time gate: opens 2 hours before
>   check-in date (midnight UTC), closes 24h after checkout. Returns decrypted instructions
>   for `self` type; returns `{ checkInType: 'front_desk' }` for front-desk (frontend
>   opens existing BookingPass). Marks `checked_in=true` idempotently (guests can re-open).
> - Frontend (`pages/bookings.jsx`): "🔑 Check In" button appears within the check-in
>   window on active bookings. Self check-in: shows instructions modal with a "Got it"
>   button. Front-desk: opens existing BookingPass QR modal. After first check-in, badge
>   changes to "✅ Checked In — View Instructions" (clickable — re-fetches instructions
>   so guests don't need to screenshot). Host bookings view also shows "✅ Checked In ·
>   [timestamp]" badge per booking.
> - New env var: `CHECKIN_KEY` — must be 64 hex chars (32 bytes). Generate:
>   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
>   Add to Railway. Intentionally NOT using Walrus Seal — server-side encryption is
>   appropriate here (access instructions are operational, not PII; one key, all properties;
>   backend-mediated trust model equivalent to standard hotel systems).
> - Validation (`validation.mjs`): `accessInstructionsSchema`.
> - **Verified end-to-end in-browser (Jun 30 2026):** host saved self check-in instructions,
>   guest checked in, modal showed decrypted door code / wifi. Re-open flow verified.
>   Host bookings view shows checked-in badge with timestamp.
>
> **Files touched this session:** `escrow.mjs`, `db.mjs`, `validation.mjs`, `server.mjs`,
> `pages/bookings.jsx`, `pages/host.jsx`, `pages/index.jsx`, `lib/useWalletBalance.js` (new).
> **Committed and pushed to `origin/main`** (commits `05cf775`, `0717df9`, `8ac5809`,
> and several follow-up fixes for CORS, catalog property rendering, and host check-in badge).
> Railway/Vercel auto-deploy from `main`.

> **June 29, 2026 (catalog/db parity audit + fixes, all 4 gaps closed):**
> Off-chain only, no new Move package. Prompted by a direct ask: "make sure any
> imported property listings by a host inherit all functionality as our hard
> coded test properties — no gaps." A read-only audit (cross-checked manually,
> not taken at face value) found 4 gaps where the 6 fixed `catalog.mjs` demo
> properties and host-imported (`properties` table, `source:'db'`) listings were
> resolved inconsistently. All 4 fixed and verified via `node --check`:
>
> 1. **Tax-jurisdiction hardcoding (highest impact).** Six call sites resolved
> tax rate/name/breakdown via `JURISDICTION_TAX_RATES[propertyId]` — a static
> map covering only ids 1-6 — instead of `catalog.mjs`'s `getProperty()`, which
> already resolves both sources correctly. A host-imported listing's bookings/
> tax pages showed a fabricated "Unknown @ 8%" instead of the host's own
> self-declared jurisdiction/rate. Fixed in `server.mjs` (`/resale/listings`,
> `/bookings/history`, `/bookings/all`, `/tax/summary`, `/tax/remit`) and
> `ai_route.mjs` (`get_revenue_summary` AI tool) — all now batch-resolve via
> `getProperty()`/`Promise.all` before mapping rows. Removed the now-dead
> `JURISDICTION_TAX_RATES`/`PROPERTIES` imports from both files.
>
> 2. **`canManageProperty()` only checked the `properties` DB table — the
> inverse gap.** A real, approved host configured as the static `hostAddress`
> on one of the 6 fixed catalog properties (`catalog.mjs` `PROPERTIES[id].hostAddress`)
> could never manage their own listing — release deposits, edit resale settings,
> import iCal, or remit/unremit tax all 403'd, because the check only queried
> the `properties` table row, never the catalog. **Root-cause fix** (one place,
> covers all 5 call sites automatically): `canManageProperty(session, propertyId)`
> in `server.mjs` now resolves via `getProperty(propertyId)` and compares its
> `hostAddress` (works for both sources) against `session.suiAddress` via the
> existing `normalizeAddr()`. Also fixed the AI chat's `release_deposit` tool
> in `ai_route.mjs`, which had its own duplicated, equally narrow DB-only check
> — now checks `booking.host_sui_address` first, then falls back to the same
> `getProperty()` resolution.
>
> 3. **iCal export title (cosmetic).** `GET /ical/:propertyId` built the
> exported `.ics` feed's title from a hardcoded 6-entry map; a host-imported
> listing's feed showed "Property {id}" instead of its real title. Now uses
> `getProperty()`.
>
> 4. **Dead schema (`db.mjs`).** `ALTER TABLE properties ADD COLUMN
> transfer_allowed/max_resale_premium_bps` was pure dead schema — every actual
> read/write path (`/host/resale-settings` GET/POST, `getResaleSettings()` in
> `bookings.mjs`) only ever touches the separate `property_resale_settings`
> table, keyed generically by `property_id` for both sources. Removed the two
> `ALTER TABLE` calls from `initDB()`; left a comment noting an already-
> migrated DB can optionally `DROP COLUMN` the orphaned columns manually (not
> done automatically — didn't want a destructive schema change unsupervised).
>
> **Files touched:** `server.mjs`, `ai_route.mjs`, `db.mjs`. **Committed and
> pushed to `origin/main`** (commit `264b4b6`, "Catalog/DB parity fixes:
> tax jurisdiction, canManageProperty, iCal title, dead columns; update
> docs" — confirmed via `git log origin/main`, June 30 2026). Railway/Vercel
> auto-deploy from `main`; not independently re-verified live in this pass.
>
> **⚠️ Operational note — recurring local file truncation during this
> session.** Five separate times across this session (3 files the first time:
> a broad batch including `server.mjs`/`catalog.mjs`/`ai_route.mjs`/etc.; then
> `server.mjs` and `ai_route.mjs` again individually; then `db.mjs`), a file
> being edited on the user's local disk (`C:\Users\Cecil\aria-demo`, a Windows
> machine) was found truncated mid-statement immediately after a write — not
> caused by the edit tool itself (confirmed: the content *before* the
> truncation point matched the intended edit exactly every time; only the
> *tail*, often completely unrelated code far below the edited region, went
> missing). Each time, repaired by diffing the live (truncated) file against
> `git show HEAD:<file>` and splicing the missing tail back in from the last
> commit at a stable shared anchor point, preserving the uncommitted edits.
> Verified via `node --check` after every repair. A stray 0-byte
> `.git/index.lock` was also found once, suggesting an interrupted git
> operation. **Suspected root cause: a cloud-sync client (OneDrive or similar)
> racing the file write on that folder, or low disk space** — not confirmed,
> but the pattern (intact head, missing tail, no error from the write itself)
> is consistent with a sync process truncating the file mid-upload after Node/
> the edit tool already finished writing it. **User action needed:** check
> disk space and pause cloud sync on the `aria-demo` folder if it's inside a
> synced directory; clear `.git/index.lock` manually (close any git GUI/
> terminal first) before the next commit attempt.
>
> **Still pending, explicitly parked by user:** Task #4 — reconcile the booking
> wallet-funding root-cause hypothesis for `ARIA-2-1782401744020-a944c8` (a
> friend's booking). Blocked on the friend being available to retest. Do not
> resume until the user raises it again.

> **June 29, 2026 (resale self-heal fix + property-id collision bug + host
> edit/delete listings):** Three pieces of work, off-chain only (no new Move package).
>
> 1. **Resale-listing 502 fix (Task #16).** `/pass/:ref/list-resale` and
> `/cancel-resale` BUILD routes now read the live on-chain `ResalePolicy` object
> first (new `readResalePolicyObject` + `ResalePolicyBcs` in `escrow.mjs`) and
> short-circuit/reconcile the DB directly if the action already happened on-chain
> but failed to persist — mirrors `/escrow/rebuild`'s existing `alreadyConfirmed`
> pattern, but reads chain state instead of DB state. Verification fns now return
> `{ok:false, retryable:true}` for transient RPC failures → routes map that to HTTP
> 503 (not 400/502) with `retryable:true` in the body. Verified end-to-end: booking
> `ARIA-1-1782743184823-9cfb5b` self-healed to "Listed for $443."
>
> 2. **Property-id collision bug (found via live testing of the Phase 3a AI-paste
> import, found in `ARIA_HANDOFF.md`'s own Phase 3a section below).** The
> `properties` DB table is a plain `SERIAL PRIMARY KEY` starting at 1 — same id
> space as the 6 fixed catalog properties (`catalog.mjs` `PROPERTIES`, ids 1-6,
> code-only, no DB row). The first-ever host-created listing got id=1, colliding
> with the Oceanfront Villa demo property. Two surfaces were affected: (a)
> `pages/host.jsx`/`index.jsx`'s `PROPERTY_DISPLAY` merge matched by id alone, so
> the new listing's title/price rendered with the wrong location/beds/baths/tag/
> photo; (b) more seriously, the per-listing BOOKINGS/REVENUE stats cards filtered
> `activeBookings` by `propertyId === p.id`, so the new (never-booked) listing
> displayed — and was affected by cancelling — the *real* Oceanfront Villa
> booking. No actual data was duplicated or lost; it was a single booking row
> rendered/wired twice due to the id collision. **Fix:** `GET /properties` now
> returns a `source` field (`'catalog'` | `'db'`); both frontend merges and the
> stats logic should key off `source`, not raw id (display merges fixed in this
> pass; verify the BOOKINGS/REVENUE filter at `host.jsx` ~line 822 was also
> updated — see TODO below). `db.mjs`'s `initDB()` now also bumps
> `properties_id_seq` to `GREATEST(1000, MAX(id))` on every boot so no *future*
> listing can land in the 1-6 range. **Did not fix the already-existing colliding
> row** (the test "Pool House Oasis" listing, parked at id=1) — that's what the
> new edit/delete feature (next item) is for.
>
> 3. **Host listing edit + delete (new, no prior task #).** Hosts had no way to
> modify or remove a published listing. Added `PATCH /host/properties/:id` (edit,
> reuses `propertyCreateSchema` + the same clamping as create) and `PATCH
> /host/properties/:id/deactivate` (soft-delete via `active=false`, same flag
> `getAllProperties()` already filters on) — both ownership-checked against
> `session.suiAddress` via `normalizeAddr`, both 404 for the 6 fixed catalog ids
> (no DB row to act on). `host.jsx`: Edit/Remove buttons now show on
> `source==='db'` cards only; Edit reopens the Add-Property modal pre-filled
> (`openEditModal`), `handlePublish` branches PATCH vs POST off a new `editingId`
> state. **TODO next session:** use the new Remove button to deactivate the
> stray "Pool House Oasis" test listing (id=1) instead of the raw SQL workaround
> discussed mid-session (`UPDATE properties SET id = 1000 WHERE id = 1`) — either
> works, Remove is cleaner.
>
> **Deploy status: committed and pushed to `origin/main`** (commits `f352bea`,
> `81c3aef`, `8cb6d31` — property-id collision fix in three passes — confirmed
> via `git log origin/main`, June 30 2026). Files touched: `escrow.mjs`,
> `server.mjs`, `pages/bookings.jsx`, `pages/host.jsx`, `pages/index.jsx`,
> `db.mjs`. Railway/Vercel auto-deploy from `main`; not independently
> re-verified live in this pass.
>
> **Still pending, explicitly parked by user:** Task #4 — reconcile the booking
> wallet-funding root-cause hypothesis for `ARIA-2-1782401744020-a944c8` (a
> friend's booking). Blocked on the friend being available to retest. Do not
> resume until the user raises it again.

> **June 25, 2026 (v7 pre-mainnet hardening):** v7 escrow package
> `0xadd5ac7867a69200d632e858193549b6fa94abff7d80397a1ab4c418f99d3e60` published —
> resale split (`aria_cut`/`host_cut`) and the Rail 2 price-cap comparison now use u128
> intermediates so the multiply-then-divide can't overflow u64 at extreme values (per an
> external review). No behavior change at realistic values; 52/52 Move tests unchanged.
> Additive/no-break; tx `6DTCEZ3rf54NfY5RhV18WWx2apk1tgB5e1d2AUWGoukC`. Set Railway/Vercel
> `*_PACKAGE_ID` to v7. (Publishing required bumping the local Sui CLI to 1.74.0 for
> testnet protocol 127 + a faucet top-up of the deployer for gas.) Phase 2c resale itself
> shipped + verified in v6 (below) — v7 is the same logic, overflow-hardened.
>
> **June 24, 2026 (v6 published + Phase 2c resale market LIVE & VERIFIED):**
> v6 escrow package `0x897777aa537c6e438dba11c750d5579848e2cd57afb29c3f68531ec6aeb6c901`
> published — additive upgrade over v5, no compatibility break (existing escrow
> structs/signatures untouched). Upgrade tx `CRYbygbqkk1HNaTaZfXsZnbXy85adHNUAQd6J4QKXTjD`.
> Adds the resale market: shared `ResalePolicy` object + `create_resale_policy` /
> `list_for_resale` / `buy_resale` / `cancel_resale_listing` (52/52 Move, 78/78 JS).
> Backend: list/cancel/transfer build+confirm routes (`/pass/:ref/…`, `/resale/listings`)
> + host settings routes, all gated by `RESALE_ENABLED`. Env: Railway + Vercel
> `*_PACKAGE_ID` on v6, `RESALE_ENABLED=true`, `RESALE_WINDOW_MS=0`,
> `PAYMENT_RELEASE_OFFSET_MS=86400000` (testnet). **Verified end-to-end in-browser**:
> booking `ARIA-1-1782390279195-4320e7` listed at $400, bought from a second verified
> account (buy digest `E9gWpqWGKZh5hJw6kfnF6LfZfrj1son5HbctTVnzpcXg`); on-chain
> `BookingResold` split **ARIA $0.30 / host $1.35 / seller $398.35** (10% / 45% / face+45%
> of the upcharge), both escrows reassigned to the buyer, `resale_count`→1, fresh pass
> minted. Two bug-fixes shipped during QA: confirm routes take `bookingRef` from the URL
> param (not body), and `isObjectMutated` now detects the real gRPC mutation shape
> (`idOperation: 'None'`, not the literal `'Mutated'`). Caveat: on testnet the release
> time is artificial, so `RESALE_WINDOW_MS=0` — mainnet uses the real check-in + 48h.
>
> **June 24, 2026 (v5 published + BookingPass P2a activated):** v5 escrow
> package `0xd825ec2db47c38758974dd9ae64fb4c4fe996ed383ae228052f30ec3351dc9b8`
> published — additive upgrade over v4, no compatibility break (`seal_approve` +
> fee/Seal calls unchanged). Upgrade tx `EoGhMXMEA8mDobxh38WT2WR1hxd4GuobfJqupsthE1LX`.
> Env rollout applied: Railway `ESCROW_PACKAGE_ID` = v5 + `BOOKING_PASS_ENABLED` =
> `true` (both confirmed); Vercel `NEXT_PUBLIC_ESCROW_PACKAGE_ID` = v5 (the
> `seal_approve` call target — present in v5). The mint is **flag-gated only**; the
> publish→update-package-ids→then-enable ordering is the safeguard, by design (no
> runtime version guard — `escrow.mjs` checks only `BOOKING_PASS_ENABLED === 'true'`).
> **Verified** June 24, 2026: fresh booking `ARIA-1-1782312873579-3d5f50` minted the
> soulbound `BookingPass` (🎫 on-chain in My Bookings; existing bookings don't
> retroactively mint). Note: the `seal_approve` target now resolves to v5, so an
> in-flight pre-v5 booking's PII decrypt could misbehave — fresh bookings are clean.
>
> **June 24, 2026 (verifiable reviews + BookingPass P1 + Codex micro-fixes):**
> Two ideas pulled off the §9 vision bank. **Verifiable reviews** (Theme A) —
> `/reviews/submit` now only accepts a review for the caller's own, non-cancelled,
> on-chain-escrow-backed booking, written to Walrus as an immutable attestation;
> "✓ Verified stay" badge + Walrus proof link (host.jsx) + `✓N` count on cards
> (index.jsx); fixed a latent `/reviews/all` snake_case→camelCase bug. **BookingPass
> Phase 1** (Theme C) — a dynamic, wallet-signed check-in pass: rotating QR on My
> Bookings (`signPersonalMessageWithZkLogin`, `qrcode.react`) + a host scanner
> (`pages/scan.jsx`) → `POST /checkin/verify` (`verifyCheckinSignature` in
> `escrow.mjs`). **NEEDS in-browser smoke test** (server-side zkLogin sig verify is
> the risk). **Codex 5.1 review** (§5g): sweep re-entrancy guards + `LIMIT` on
> `/bookings/all`; rest already tracked (TLS=M4, monolith=R1). New deps:
> `qrcode.react`. See `ARIA_ROADMAP.md` §9 (BookingPass spec) + §5g.

> **June 23, 2026 (late — full end-to-end QA + resume-signing):** Phases 1h.5 +
> 2 are now QA'd end-to-end on live testnet, not just unit-tested:
> booking → two-escrow signature → confirm; host PII decrypt works ONLY while the
> booking is live (verified the negative case: no escrow → no decrypt); and on
> **cancel** the escrow is `object::delete`'d so `seal_approve` can't be satisfied
> → PII access **auto-revokes** (verified — the elegant no-revoke-call property).
> Also shipped + QA'd: **resume-signing** for the unsigned-booking trap —
> `POST /booking/:ref/escrow/rebuild` + a "Complete payment & sign" button on My
> Bookings rebuild the PTB for a stranded `deposit_status='pending'` booking so a
> forgotten signature is one-click recoverable instead of a date-blocking zombie.
> The §5f quick-win batch (below) was completed early (June 23), not June 24.
> STILL OPEN (lower urgency): abandoned-booking sweep (stranded bookings hold
> dates until cancelled/signed).
>
> **Product vision / feature backlog** (brainstorm June 23, 2026) lives in
> `ARIA_ROADMAP.md` §9 — verifiable reviews, portable on-chain reputation,
> staked dispute jurors (Theme A); N-way payout split, transferable-booking resale
> market, host cash-advance (Theme B); Seal-gated smart-lock check-in (Theme C);
> AI host-ops autopilot + agent-to-agent booking (Theme D). Each is tied to an
> existing ARIA primitive. Not committed work — the idea bank to pull from next.
>
> **June 23, 2026 (Fifth external review — Haiku 4.5):** evaluated; quick-win batch
> **shipped June 23** (security headers via `@fastify/helmet` + Next headers; DB
> integrity — `UNIQUE` index on `reviews(booking_ref)` + `reviews(property_id)`
> index + optional status CHECK enums; `"test"` script; AI `messages` cap;
> `/host/guest-identity` access-log table; README sync). Full breakdown + the
> already-done / off-base items in `ARIA_ROADMAP.md` §5f. None mainnet-blocking.
>
> **June 23, 2026 (Phase 2 — Seal/Walrus guest PII BUILT):** Full guest-PII
> system (see `ARIA_ROADMAP.md` Phase 2). `escrow.move` gains
> `public entry fun seal_approve<T>(id, escrow, ctx)` — Seal key servers dry-run
> it to authorize a host decrypting a guest's PII; asserts the identity bytes are
> the escrow's guest AND `sender == escrow.host` (+3 Move tests, suite 40→43).
> Ships in the SAME v4 publish as the fee functions. Backend: `guest_verifications`
> table (Walrus pointer only — no PII in Postgres), `/guest/profile` (POST/GET),
> `/host/guest-identity/:bookingRef` (host-gated), `hasGuestProfile` in `/auth/me`,
> and a `REQUIRE_GUEST_VERIFICATION`-gated booking gate in `createBooking`.
> Frontend: `lib/seal.js` (encrypt + Seal-decrypt; 2-of-2 Mysten testnet key
> servers; identity = guest address; encrypt uses the ORIGINAL package id,
> seal_approve CALL uses the current/v4 id), `pages/profile.jsx` (guest encrypt →
> Walrus), host "View Guest Identity" modal in `pages/host.jsx`, and
> `signPersonalMessageWithZkLogin` in `lib/zklogin.js` for Seal's SessionKey.
> **SMOKE-TESTED END-TO-END June 23, 2026 (PASS):** `@mysten/seal` installed
> (Sui bumped 2.16→2.19 for its peer), v4 published (`0xf68a874f…`),
> `NEXT_PUBLIC_ESCROW_PACKAGE_ID` set, and the full guest-encrypt → host-decrypt
> round-trip verified in-browser (zkLogin SessionKey signing works). See Sui
> Integration Lessons §13 for the Seal package-id pattern that this surfaced.
>
> **June 23, 2026 (Phase 1h.5 — payment escrow backend + contract BUILT):**
> Fee collection / payment routing landed on the backend and contract — full
> file-by-file log in `ARIA_FEE_DESIGN.md` §14. Summary: a new
> `BookingPaymentEscrow<T>` (separate from the deposit's `BookingEscrow`) holds
> rental + ARIA fee + tax, created in the SAME guest-signed PTB as the deposit
> (one signature, two shared objects, atomic). `release_payment` does a 2-way
> split at check-in (permissionless, auto-release key, via `runCheckInReleaseSweep`):
> ARIA gets its 5% fee, the host gets rental + tax combined (tax_addr == host —
> ARIA does not custody tax; the host self-remits, see `ARIA_FEE_DESIGN.md` v2.2).
> `refund_payment` gives a full guest refund before check-in (arbitrator-gated);
> `refund_deposit` returns the deposit early on cancel. Policy: **fee follows
> refund** (full refund incl. fee before check-in, none after) — matches
> Airbnb/Vrbo. Verification is lag-free PTB-arg decoding with a
> **destination-authority** check (rental/fee/tax legs must point at the
> authoritative host / `ARIA_FEE_ADDRESS`; tax_addr is checked against the
> same authoritative host address), plus
> replay protection via a unique `settlement_digest`. **Tests written (12 Move +
> 14 JS, incl. the adversarial matrix) but NOT run in the build sandbox** (the
> `@mysten/sui` pnpm symlink is unreadable there and no `sui` binary) — run
> `node escrow.test.mjs` + `sui move test`. Frontend wired too (June 23):
> `pages/index.jsx` review-then-sign disclosure (combined path no longer
> auto-signs), `pages/ai.jsx` chat disclosure, `ai_route.mjs` field forwarding,
> cancellation copy corrected — still needs an in-browser smoke test. **Open:**
> generate/set the two treasury addresses, the v4 on-chain publish (bundle with
> Phase 2a `seal_approve`). The combined path only activates when
> both treasury env vars are set; otherwise it falls back to the deposit-only
> P0b build, so existing behavior is unchanged until you opt in.
>
> **June 22, 2026 (Assessment of Codebase Evaluation):**
> - An external codebase evaluation was fully assessed. It was confirmed that all highlighted items are either already resolved, praised as architecture strengths, or already tracked in the technical debt backlog or roadmap.
> - Specifically, the noted "frontend fetch duplication" was confirmed to already be fully consolidated under `lib/authFetch.js` (all 6 authenticated pages import from it; none define it inline).
> - No code or doc changes are warranted, as the evaluation independently confirmed our current priority order (Phase 1h.5 first).
>
> **June 22, 2026 (Codex review fixes):**
> - **Cross-tenant cancellation fixed:** `cancelBooking()` no longer bypasses the
>   ownership check for hosts. New `hostManagesBooking(session, booking)` in
>   `bookings.mjs` scopes a host to bookings they manage (superadmin / escrow
>   `host_sui_address` / `properties.host_address`); the `isHost` param was removed
>   from `cancelBooking` and both call sites (`/booking/cancel`, AI `cancel_booking`).
> - **Missing column added:** `db.mjs` now creates `bookings.deposit_release_walrus_blob_id`
>   (idempotent) — `ai_route.mjs` wrote it on AI-path deposit release but it was
>   never in the schema.
>
> **June 22, 2026 (later) — security fixes + verifier groundwork:**
> - **P1-2 fixed:** `/booking/claim-damage/confirm` now records the **on-chain**
>   `claim_amount` (decoded lag-free from the signed `claim_damage` PTB via
>   `decodeClaimDamageAmountMist` / `verifyEscrowMutation`), not the client's
>   `request.body.claimAmount`. Undecodable → 400. `claimDamageConfirmSchema`
>   gained optional `reason`, dropped the amount.
> - **Logout revocation fixed:** `deleteSession()` is exported and called by
>   `/auth/logout`, deleting the Postgres session row (a copied `aria_session`
>   no longer lingers to expiry).
> - **Lag-free escrow verifier shipped (Phase 1h.5 step 1):** `decodeCreateEscrowArgs`
>   + hardened `verifyEscrowTransaction` replace the weak "type+sender only" lag
>   fallback with a full strict check decoded from the tx; live-confirmed against a
>   real testnet digest (`check-escrow-decode.mjs`, `ARIA_FEE_DESIGN.md` §13).
> - A third external review (security/quality/scalability) was folded into
>   `ARIA_ROADMAP.md` §5d and its standalone file deleted.

Deeper technical details for developers or AI assistants continuing work on ARIA.
Reconciled against the code actually deployed to production as of June 18, 2026.
For the security change log see `ARIA_REMEDIATION.md` and `ARIA_CODE_AUDIT.md`
(the June 18 "Second Review" section). For the build roadmap see `ARIA_ROADMAP.md`.
For the fee/payment-routing design see **`ARIA_FEE_DESIGN.md`**.

> **June 22, 2026 update summary:**
> - Fee collection/routing (Phase 1h.5) designed — `ARIA_FEE_DESIGN.md` v2.1
>   (v2.1 adds §12 production-safety hardening: lag-free PTB-arg verification for
>   both escrows + destination-authority checks, replay/idempotency, abandoned-
>   booking sweep, reconciler, host self-release backstop; `refund_deposit`
>   promoted to a v1 requirement so cancel refunds payment + deposit together).
>   Non-custodial hold-and-release: a new `BookingPaymentEscrow<T>` holds
>   rental + ARIA fee + tax, created in the same guest-signed PTB as the deposit
>   escrow (one signature, two shared objects, atomic). `release_payment` does a
>   2-way split (`subtotal+taxes`→host, `ariaFee`→ARIA fee wallet — ARIA does
>   not custody tax; tax rides with the host, who self-remits off-chain) at
>   check-in — permissionless, signed by the existing zero-privilege
>   auto-release key via a new `runCheckInReleaseSweep` cron. `refund_payment`
>   (arbitrator-gated, pre-check-in) gives a full guest refund on cancellation via
>   a new `/booking/cancel` route. Needed the **v4** contract upgrade — bundled with
>   Phase 2a's `seal_approve` (one publish). Adds one receive-only treasury
>   address (`ARIA_FEE_ADDRESS`); no new signing
>   key. Fixes the `calculateHostPayout` fee double-count (host gets full
>   `subtotal`). SuiUSD-only; Stripe Connect deferred.
>
> **June 18, 2026 update summary** (details throughout this doc):
> - Smart contract upgraded to **package v3** (`0xec0d6bd4…644d8fa1`) adding a
>   permissionless `finalize_claim` — live on testnet, Railway pointed at it.
> - Second independent code review (8 findings, all fixed): hardened on-chain
>   escrow verification, frontend gRPC migration, atomic booking insert, unified
>   deposit-release, configurable demo host. See `ARIA_CODE_AUDIT.md`.
> - Ops: all operational addresses funded; old `ARIA_DEPLOYER_KEY` removed from
>   Railway; unused `@anthropic-ai/sdk` dependency + `ANTHROPIC_API_KEY` removed.

---

## Architecture Overview

- **Frontend**: Next.js (Pages Router) + react-datepicker, deployed on Vercel
- **Backend**: Fastify (ESM) + PostgreSQL (node-postgres), deployed on Railway (Node 22)
- **Auth**: Google OAuth → zkLogin (derives a Sui wallet address)
- **AI agent**: Grok (xAI), via an OpenAI-compatible `fetch` call (no SDK)
- **Database**: PostgreSQL, 10 tables (see below)
- **Payments**: SuiUSD primary + Stripe fallback (create-intent only)
- **Storage**: Walrus for immutable receipts
- **Sessions**: Stored in PostgreSQL `sessions` table
- **On-chain escrow**: `BookingEscrow<SUI>` shared object on Sui testnet, created at booking

---

## Database Tables (11)

`properties`, `bookings`, `reviews`, `messages`, `hosts` (legacy/unused),
`tax_remittances`, `host_profiles`, `sessions`, `property_ical_feeds`,
`guest_identity_access_log`, `wallet_sends`.

Key columns added June 30, 2026:
- `properties.check_in_type TEXT DEFAULT 'front_desk'`
- `properties.access_instructions_encrypted TEXT`
- `bookings.checked_in BOOLEAN DEFAULT false`
- `bookings.checked_in_at TIMESTAMPTZ`

`initDB()` in `db.mjs` creates all tables idempotently (`IF NOT EXISTS`) and adds
columns via `ALTER TABLE … ADD COLUMN IF NOT EXISTS`.

---

## Smart Contract (Phase 1 — Live)

A Move smart contract is deployed on Sui testnet. Every confirmed booking creates
a `BookingEscrow<SUI>` shared object that holds the deposit on-chain.

| Item | Value |
|---|---|
| Package ID (current, **v7**) | `0xadd5ac7867a69200d632e858193549b6fa94abff7d80397a1ab4c418f99d3e60` |
| Package ID (prior, v6) | `0x897777aa537c6e438dba11c750d5579848e2cd57afb29c3f68531ec6aeb6c901` |
| Package ID (prior, v5) | `0xd825ec2db47c38758974dd9ae64fb4c4fe996ed383ae228052f30ec3351dc9b8` |
| Package ID (prior, v4) | `0xf68a874fbdd3e5aa328f6754bd757edc6c2690510284fa39d5088e44b4cd9e77` |
| Package ID (older, v3) | `0xec0d6bd45d6bbf3aad04778ace4aacef33c071a30d79090532ba1697644d8fa1` |
| Package ID (type-defining / original) | `0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe` |
| Module | `escrow` |
| Network | Sui testnet |
| UpgradeCap | `0x41f043cf28d0bb77ef6031c5208b611bdd673992afa9e27763b41033e4a327eb` |
| Deployer address | `0x24bd37a7d13a78de81bd5345899da8b7a4d41ebf26fc1af6f934f9841c7d97f3` |
| Source | `contracts/aria_escrow/sources/escrow.move` |

Contract functions: `create_escrow`, `auto_release`, `claim_damage`,
`accept_claim`, `dispute_claim`, `resolve_dispute`, and (**v3, June 18 2026**)
`finalize_claim`. All **28** unit tests pass (`sui move test`).

**Package version history:**
- **v3** (`0xec0d6bd4…644d8fa1`) — June 18, 2026. Adds `finalize_claim`
  (CLAIMED-deadlock fix, see below). Upgrade tx `9wzX4hQkZzzyZTMh9siAU2kHqRLQmJJots3FjzgGMAQa`.
  `ESCROW_PACKAGE_ID` in Railway points here (redeploy confirmed clean).
- **v2** (`0x98e712…4264f26`) — June 17, 2026. P3 cleanup (30-day expiry cap,
  removed dead `STATUS_RESOLVED`).
- **v1** (`0x538262…7fdbe`) — original publish. Remains the **type-defining ID**
  for all `BookingEscrow` objects (unchanged across upgrades) and the anchor for
  Seal's identity namespace in Phase 2.

**`finalize_claim` (v3) — CLAIMED-deadlock fix.** `claim_damage` moves an escrow
to `STATUS_CLAIMED`; from there the only prior exits were guest-only
(`accept_claim` / `dispute_claim`), so a silent guest could lock both parties'
funds forever. `finalize_claim<T>(escrow, clock, ctx)` is permissionless (like
`auto_release`) and callable once `expiry_ms` has passed while still
`STATUS_CLAIMED`: it pays `claim_amount` to the host and the remainder to the
guest — the same split `accept_claim` produces. The backend keeper
(`finalizeClaimEscrow` in `escrow.mjs`, driven by a second pass in
`runAutoReleaseSweep`) calls it automatically for timed-out claims.

### How transactions are signed and submitted

**STATUS: P0a COMPLETE (June 12, 2026).** Migrated off Sui's JSON-RPC interface
(deactivating network-wide July 31, 2026) onto the gRPC client — well ahead of
the deadline. Verified end-to-end on testnet: `create_escrow` and `auto_release`
both execute successfully, with the `BookingEscrow` object correctly created,
ID extracted, stored in Postgres, and later deleted on release.

**STATUS: P0b COMPLETE (June 16, 2026).** `create_escrow` is no longer signed
by the deployer — the code example below (`autoReleaseKeypair.signAndExecuteTransaction`)
now applies **only to `auto_release`**. For `create_escrow`, the backend
(`buildEscrowTransaction` in `escrow.mjs`) builds an *unsigned* PTB with
`tx.setSender(guestAddr)` and returns the serialized bytes to the frontend.
The guest's own zkLogin wallet signs (`signTransactionWithZkLogin()` in
`lib/zklogin.js`) and submits directly to a public Sui fullnode
(`submitSignedTransaction()`) — never relayed through ARIA's backend. The
frontend then reports `{bookingRef, digest}` to
`/booking/:bookingRef/escrow/confirm`, which independently re-queries the chain
(`verifyEscrowTransaction`) before trusting the result and writing
`escrow_object_id`/`deposit_status` to Postgres. See "Pattern: guest-signed
escrow creation" below for the actual code.

**STATUS: frontend JSON-RPC migration COMPLETE (June 18, 2026).** P0a migrated
the *backend* off JSON-RPC, but the browser signing path in `lib/zklogin.js`
still used `suix_getLatestSuiSystemState` (epoch read) and
`sui_executeTransactionBlock` (submit) — both JSON-RPC, sunset July 31, 2026.
These now go through the gRPC `SuiGrpcClient` (`getCurrentSystemState` and
`executeTransaction`), matching the backend. Function signatures are unchanged,
so `pages/index.jsx` / `pages/ai.jsx` were untouched. **Still worth a real
in-browser smoke test** — gRPC-web behaves slightly differently in-browser than
the old `fetch`.

**STATUS: escrow verification hardened, then made lag-robust (June 18–19, 2026
— `ARIA_CODE_AUDIT.md` finding S1; live-verified June 19).** `verifyEscrowTransaction`
originally only checked tx success + sender + that *some* object was created — a
guest signing in their own browser could substitute a near-zero / wrong-host
escrow and still get `deposit_status='held'`. It now verifies in **layers ordered
by reliability** (this is the transferable pattern — see "Sui Integration
Lessons" §1–4 below):
1. tx succeeded **and** `sender == booking.guest` — lag-free, from `getTransaction`.
2. the created object is our `BookingEscrow` **type** — read **lag-free** from
   `getTransaction`'s `objectTypes` map (a `Record<objectId,type>` in the same
   response), scanned **by value** for the `::escrow::BookingEscrow<` suffix.
   We match the suffix, NOT the package id, because a struct's type always
   carries the **original** package id (`0x538262…`), not the upgraded v3 id —
   see Lessons §3.
3. **best-effort:** `getObjects` content read (BCS-decoded via the exported
   `BookingEscrowBcs`) to also confirm `guest`/`host`/`booking_ref` and that the
   funded amount == `depositToMist(deposit_amount)` (the single dollar→mist
   source shared with `buildEscrowTransaction`). This read frequently lags
   minutes on the public fullnode, so it's a bonus: if it can't be read but the
   **type + sender are confirmed (steps 1–2)**, the deposit is accepted; a
   readable-but-mismatched object is hard-rejected; if **nothing** is verifiable
   the confirm returns **503 retryable** (booking stays pending — never marked
   held on weak evidence).

**Why layered (the bug that forced it):** the first hardening gated on the
`getObjects` content read, which on the public testnet fullnode returns
"Object … not found" for **seconds to >1 minute** after creation (read-after-
write lag — Lessons §1) even though `getTransaction` is instant. That rejected
nearly every real booking. The `objectTypes` type-gate (step 2) is the fix
because it rides the lag-free `getTransaction` response. **Live-verified June 19,
2026:** booking confirmed first-try (`Escrow verified on-chain and recorded`),
and cancel-after-expiry released the escrow on-chain (`cancelBooking: escrow
released on-chain`).

**KNOWN LIMITATION (pre-mainnet):** when step 3's content read lags, the
amount/host/ref check is skipped (type + sender still enforced), so under-funding
isn't caught on testnet (amounts are symbolic). Mainnet options (roadmapped,
all lag-free): a reliable/dedicated fullnode, an async reconciler that re-reads
once indexed, or decoding the `create_escrow` args from the tx inputs.

**The working pattern for `auto_release`** (`@mysten/sui: "latest"`, Node 22):

```javascript
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';

const suiClient = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
});

// auto_release — signed by a dedicated, narrowly-scoped key as of P1b
// (June 17, 2026): ARIA_AUTO_RELEASE_KEY / autoReleaseKeypair, not the
// deployer/UpgradeCap key. See the comment block above autoReleaseEscrow
// in escrow.mjs for why this key needs no special on-chain privilege:
// auto_release has no sender check at all ("Callable by anyone" in
// escrow.move), so this signer never moves a deployer-owned coin — it only
// triggers the contract's own release logic on a coin the guest already
// deposited. The original deployer/UpgradeCap key has been retired to cold
// KeePass-only storage and is no longer loaded by the backend.
const tx = new Transaction();
tx.setSender(autoReleaseKeypair.toSuiAddress());

tx.moveCall({
  target: `${PKG}::escrow::auto_release`,
  typeArguments: ['0x2::sui::SUI'],
  arguments: [tx.object(escrowObjectId), tx.object('0x6')],
});

const result = await autoReleaseKeypair.signAndExecuteTransaction({
  transaction: tx,
  client: suiClient,
  include: { effects: true },
});

if (result.$kind === 'FailedTransaction') {
  // result.FailedTransaction.status.error.message
} else {
  // result.Transaction.digest, result.Transaction.effects.status
}
```

**Pattern: guest-signed escrow creation (P0b)** — backend builds, frontend signs:

```javascript
// escrow.mjs — buildEscrowTransaction: builds an UNSIGNED PTB, never signs it.
const tx = new Transaction();
tx.setSender(guestAddr); // guest is the sender, not the deployer

const coin = coinWithBalance({ balance: depositMist });

tx.moveCall({
  target: `${PKG}::escrow::create_escrow`,
  typeArguments: ['0x2::sui::SUI'],
  arguments: [
    tx.pure.string(bookingRef),
    tx.pure.address(guestAddr),
    tx.pure.address(hostAddr),
    tx.pure.address(arbitratorAddr),
    tx.pure.u64(expiryMs),
    coin,
    tx.object('0x6'),
  ],
});

const escrowTxBytes = await tx.build({ client: suiClient }); // base64 bytes returned to frontend, never signed here
```

```javascript
// lib/zklogin.js — signed and submitted entirely in the guest's browser.
const signature = await signTransactionWithZkLogin(transactionBytes);
const digest = await submitSignedTransaction(transactionBytesBase64, signature);
// digest is POSTed to /booking/:bookingRef/escrow/confirm, which independently
// re-verifies on-chain (verifyEscrowTransaction) before trusting it.
```

**Critical gotcha — extracting the created object's ID:**
`include: { objectChanges: true }` and `include: { objectTypes: true }` are
both **absent** from the result in this SDK version. Use
`result.Transaction.effects.changedObjects`. When a transaction splits a coin
AND creates a shared object, both appear as "Created" entries. PTB execution
order guarantees the split-coin comes FIRST and the real object comes LAST.
Always take the **last** "Created" entry.

This logic is now extracted into `extractCreatedObjectId(changedObjects)` in
`escrow.mjs`, covered by 15 unit tests in `escrow.test.mjs`. Used both by
`auto_release` and (post-P0b) by `verifyEscrowTransaction`, which calls it on
the chain-queried result of the guest-submitted `create_escrow` digest.
(Phase 2's Seal integration no longer creates a separate on-chain object —
see `ARIA_ROADMAP.md` Phase 2, revised June 17, 2026 — so this helper isn't
needed there. Still the right pattern for any future PTB that creates a new
shared object.)

```javascript
// escrow.mjs — extracted helper, tested in escrow.test.mjs
function extractCreatedObjectId(changedObjects) {
  const createdEntries = (changedObjects || []).filter(c => {
    let op = c.idOperation ?? c.operation ?? c.id_operation ?? c.$kind;
    if (op && typeof op === 'object') op = op.$kind;
    return typeof op === 'string' && /created/i.test(op);
  });
  const chosen = createdEntries[createdEntries.length - 1];
  return chosen?.objectId ?? chosen?.id ?? chosen?.object_id ?? null;
}
```

**`autoReleaseEscrow`** uses the identical signing pattern. See `escrow.mjs`.

**Remaining for the July 31 deadline:** `@mysten/deepbook-v3` may also use
JSON-RPC internally for price/liquidity reads — not yet checked. Lower
priority since it's read-only and DeepBook itself may migrate independently,
but worth a check before the deadline.

### Testnet → mainnet changes (one line each)

- **Coin type**: `'0x2::sui::SUI'` → native USDC on Sui mainnet: `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC` (Circle-issued, available on Coinbase/Kraken — no in-app swap needed if this is the payment coin). Set `PAYMENT_COIN_TYPE` in Railway and `NEXT_PUBLIC_PAYMENT_COIN_TYPE` in Vercel.
- **SuiUSD label rename**: Changing the payment coin also means renaming all "SuiUSD" display strings to "USDC" — 35 occurrences across 12 files confirmed June 30, 2026. Bulk rename: `grep -rl "SuiUSD" --include="*.{jsx,mjs,js}" . | xargs sed -i 's/SuiUSD/USDC/g'`, then manually check `db.mjs` column default, `become-host.jsx` Transak sentence, and `ai_route.mjs` system prompt. See `ARIA_ROADMAP.md` tech debt for the full file list.
- **Expiry**: `Date.now() + 300_000n` (5 min testnet) → `checkoutMs + 432_000_000n` (5 days)
- **Move.toml**: `rev = "framework/testnet"` → `rev = "framework/mainnet"`
- **UpgradeCap**: keep for testnet → burn after independent audit for mainnet
- **Escrow funding**: ✅ already guest-signed on testnet (P0b complete June 16, 2026) — same pattern carries to mainnet unchanged, only the coin type and expiry window differ.

---

## Smart Contract Security Audit (June 10, 2026)

Full line-by-line review of `contracts/aria_escrow/sources/escrow.move`.

### Overall assessment

No fund-draining vulnerability exists in the contract. The status machine is
sound: every state transition is gated, no path skips a state, no settled escrow
can be re-entered. Coin handling is exact — Move's linear type system enforces
that the sum of outputs equals the sum of inputs at compile time. The
`ESplitMismatch` assertion in `resolve_dispute` provides belt-and-suspenders on
top of that. Test coverage is comprehensive (23/23, every error code exercised).
The contract is suitable for demo and Sui Overflow.

### What is well-designed — do not change

- **Per-object isolation**: each booking holds its own `Coin<T>`; there is no
  global balance. A bug in one escrow cannot affect any other.
- **No admin drain path**: ARIA's server address does not appear in any escrow.
  A fully compromised backend cannot move a single token from any active escrow.
- **Bounded arbitrator blast radius**: the arbitrator can only act on escrows in
  `STATUS_DISPUTED`, and can only split between the recorded `guest` and `host`
  addresses — never to a third address.
- **No reentrancy**: Move's object model makes this structurally impossible.
- **No integer overflow**: Move u64 aborts on overflow; no silent wrapping.
- **No emergency withdraw / pause**: intentional and correct. Do not add either.

### Issues — prioritized

#### P0a — Migrate off JSON-RPC — ✅ COMPLETE (June 12, 2026)

#### P0b — Guest-funded escrow (most important non-custodial gap) — ✅ COMPLETE (June 16, 2026)

The guest's own zkLogin wallet now signs `create_escrow` and provides the
deposit coin from their own balance — ARIA's deployer wallet no longer funds
or signs this transaction. Implemented as a both-sides change:
- **Backend (`server.mjs`)**: `buildEscrowTransaction` builds an unsigned PTB
  (`tx.setSender(guestAddr)`) and returns the serialized bytes to the frontend.
  It never signs or funds escrow creation. The backend signer's role is now
  scoped to just `auto_release`.
- **Frontend (`lib/zklogin.js` + `pages/index.jsx`)**: `handleEscrowSign()`
  signs the PTB via `signTransactionWithZkLogin()` and submits it directly to
  a public Sui fullnode via `submitSignedTransaction()` — never routed through
  ARIA's backend — then reports `{bookingRef, digest}` to
  `/booking/:bookingRef/escrow/confirm`.
- **Backend verification (`verifyEscrowTransaction`)**: re-queries the chain by
  digest and confirms a real, matching `BookingEscrow` object was created
  before writing `escrow_object_id`/`deposit_status` to Postgres — never
  trusts the frontend's report blindly.

Verified end-to-end on testnet: real booking, guest signed in-browser via
zkLogin, deposit landed on-chain, backend confirmed it, bookings page showed
"confirmed" + "Deposit $661 held".

#### P1 — Fix before mainnet — ✅ COMPLETE

**P1a — Arbitrator separation: ✅ done (June 12, 2026).** Dedicated arbitrator
keypair generated, private key/mnemonic in KeePass only, public address
(`ARIA_ARBITRATOR_ADDRESS`) wired into `createEscrowOnChain` and confirmed on-chain.
Mnemonic ownership independently re-confirmed June 16, 2026 — derived `suiAddress`
via `sui keytool import`/`list` matches `ARIA_ARBITRATOR_ADDRESS` exactly.

**P1b — Deployer / backend-signer separation: ✅ done (June 17, 2026).** Now
that P0b had landed, the backend signer's role had shrunk to just
`auto_release`. `escrow.mjs`/`bookings.mjs`/`server.mjs` renamed
`ARIA_DEPLOYER_KEY`/`deployerKeypair` to `ARIA_AUTO_RELEASE_KEY`/
`autoReleaseKeypair` throughout. This also corrected an inaccurate code
comment that had claimed `auto_release` required arbitrator-level on-chain
authority — confirmed against `escrow.move` that `auto_release` is actually
permissionless ("Callable by anyone", no sender assertion), so the new key
carries zero special privilege beyond holding gas. A fresh key was generated
for this purpose; the original deployer/UpgradeCap key is being retired from
Railway to cold KeePass-only storage and is no longer loaded by the backend.
Remaining manual steps (Railway env var swap, faucet funding of the new
address, confirming the old key's removal from Railway) are operator actions,
not code changes — see `ARIA_ROADMAP.md` for the address.

#### P2 — Fix before launch with real users — ✅ COMPLETE (June 17, 2026)

- **Auto-release cron job**: ✅ done. `runAutoReleaseSweep()` in `server.mjs`
  queries `bookings` for escrows past expiry that are still `pending`/`held`,
  calls `autoReleaseEscrow` (signed by `autoReleaseKeypair`) for each, and
  updates `deposit_status`. Wired via `setInterval(AUTO_RELEASE_SWEEP_INTERVAL_MS)`
  (default 1 hour) plus a 30-second startup `setTimeout` so it also runs once
  shortly after boot rather than waiting a full interval.
- **Production host address lookup**: ✅ done. `getPropertyHostAddress()` in
  `bookings.mjs` resolves the real payout address instead of falling back to
  the auto-release key: it reads the property's configured host address, then
  looks up `payout_sui_address` from `host_profiles` for that address, falling
  back to the configured address if no `host_profiles` row exists or the query
  fails. Only falls back to `autoReleaseKeypair.toSuiAddress()` if a property
  has no configured host address at all.
- **Claim/dispute backend routes**: ✅ done. Five new routes added to
  `server.mjs`, all following the same non-custodial build-unsigned/
  client-signs/backend-verifies pattern as `create_escrow`:
  - `/booking/claim-damage` (host builds unsigned `claim_damage` PTB)
  - `/booking/claim-damage/confirm` (verifies via `verifyClaimDamageTransaction`,
    checks sender == host and that the escrow object was mutated, writes
    `claim_amount`/`claim_reason`/`claimed_at`)
  - `/booking/dispute-claim` (guest builds unsigned `dispute_claim` PTB)
  - `/booking/dispute-claim/confirm` (verifies via `verifyDisputeClaimTransaction`,
    checks sender == guest, writes `dispute_reason`/`disputed_at`)
  - `/booking/resolve-dispute` (arbitrator-signed `resolve_dispute`, calls
    `resolveDisputeEscrow`, writes `resolved_guest_amount`/`resolved_host_amount`/
    `resolved_at`)
  Backed by 9 new `bookings` columns (`host_sui_address`, `claim_amount`,
  `claim_reason`, `claimed_at`, `dispute_reason`, `disputed_at`,
  `resolved_guest_amount`, `resolved_host_amount`, `resolved_at`), 5 new `zod`
  schemas in `validation.mjs`, and a `['claimed','disputed','forfeited']` guard
  added to `/booking/release-deposit` so a disputed/claimed escrow can no
  longer be silently auto-released out from under the claim. Covered by 18 new
  unit tests in `escrow.test.mjs` (`isObjectMutated`: 8, `verifyClaimDamageTransaction`:
  4, `verifyDisputeClaimTransaction`: 3, plus the route logic exercised via the
  new helper functions) — 33 tests total, all passing.

**New for P2 — `resolve_dispute` needs its own operational signer.** The
P1a arbitrator key (`0x0069868f93f9127b3e8b51bf95bc529925ca382e6305da0bb01f693826b983f8`)
was deliberately generated as cold-KeePass-only, manual-signing-only — it was
never meant to be loaded by the backend. But an automated `/booking/resolve-dispute`
route needs a signer the backend can actually call. So a **new, separate,
narrowly-scoped operational arbitrator keypair** was generated this session
(`ARIA_ARBITRATOR_KEY` / `arbitratorKeypair`, loaded in `escrow.mjs`, used only
to sign `resolve_dispute` — the contract asserts `tx_context::sender ==
escrow.arbitrator`, so this key carries no privilege beyond that one call).
Its public address is `0xf46527e18f2fd7d3093c9591ded66e3a8711a18de63cd0bede2d88692e6f6a65`,
funded with testnet SUI gas via the faucet. This **supersedes** the P1a address
for any escrow created going forward — `ARIA_ARBITRATOR_ADDRESS` in Railway
needs to be updated to the new address (pending manual step, see Environment
Variables below). Any escrow already created on-chain before that Railway
update still has the old P1a address baked into its `arbitrator` field on-chain
and can only be resolved by that original cold key — this is immutable per-object
state in Move, not something a config change retroactively fixes.

#### P3 — Clean up, not blocking

Code done June 17, 2026 in `contracts/aria_escrow/sources/escrow.move`:
- Removed the unused `STATUS_RESOLVED` constant (resolve_dispute deletes the
  object, so this status was never actually set). The `status_resolved()`
  accessor could **not** be removed alongside it — the first upgrade attempt
  failed with `error[Compatibility E01001]: missing public declaration:
  public function 'status_resolved' is missing`. Sui's package upgrade rules
  forbid removing any public function from an already-deployed package, even
  under the default "compatible" policy (the most permissive one available).
  `status_resolved()` now returns a hardcoded `4` instead of referencing the
  removed constant — same signature, same return value, just no longer named.
- Added a 30-day expiry upper bound: new `MAX_EXPIRY_MS` constant
  (`2_592_000_000` ms), new `EExpiryTooFar` error code, assertion in
  `create_escrow` (`expiry_ms <= now + MAX_EXPIRY_MS`), and a `max_expiry_ms()`
  accessor. Two new tests added in `escrow_tests.move`:
  `test_create_with_expiry_too_far_fails` and
  `test_create_with_expiry_at_max_boundary_succeeds`.

**Live on-chain.** Published June 17, 2026 via `sui client upgrade`, signed
with the deployer's cold `UpgradeCap` key (see Environment Variables / Key
Inventory — this key cannot be loaded by the backend or by Claude). Upgrade
transaction: `JCA8daJ9mSByY6x51ZhEc6Ubfrv1LEbf3nsVccEFtJZK`. New package:
`0x98e712692f22f308bb6d097d2d8a2743ed0c01058135d71436b4abcd34264f26`
(version 2). The original package ID stays the type-defining ID for existing
`BookingEscrow` objects — only the bytecode changed.

**Fully live.** `ESCROW_PACKAGE_ID` updated in Railway to the new package ID
above and redeployed (confirmed June 17, 2026, 3:05 PM CDT — deploy logs show
both the auto-release and arbitrator keypairs loading correctly, DB
initialized, server up). New `create_escrow` calls now get the 30-day expiry
cap. Existing escrows and the claim/dispute/auto-release flow are unaffected
either way — those calls work against either package ID since the underlying
struct type and function signatures didn't change.

### Pre-mainnet checklist

- [x] **P0a**: Migrate off JSON-RPC to gRPC (done June 12, 2026)
- [x] **P0b**: Guest wallet signs and funds `create_escrow` (done June 16, 2026, live-tested)
- [x] **P1a**: Arbitrator key separated (done June 12, 2026)
- [x] **P1b**: Separate deployer/UpgradeCap from backend signer (code done June 17, 2026 — Railway/faucet setup for the new key is a pending manual step, see P1b above)
- [x] **P2**: Auto-release cron job built and running (done June 17, 2026)
- [x] **P2**: Production host address lookup from `host_profiles` (done June 17, 2026)
- [x] **P2**: Claim/dispute backend routes wired (done June 17, 2026 — `ARIA_ARBITRATOR_KEY`/`ARIA_ARBITRATOR_ADDRESS` set in Railway June 17, 2026)
- [x] **P3**: `STATUS_RESOLVED` dead code removed, 30-day expiry upper bound added, upgrade published on-chain and fully deployed (June 17, 2026 — package v2 at `0x98e712...4264f26`; Railway `ESCROW_PACKAGE_ID` updated and redeployed, see P3 section above)
- [x] **Second code review (June 18, 2026)**: 8 findings fixed (escrow object verification, frontend gRPC migration, atomic booking insert, unified deposit-release, `finalize_claim` deadlock fix, demo-host config). See `ARIA_CODE_AUDIT.md` "Second Review". Backend suite 39/39, Move 28/28.
- [x] **v3 contract upgrade (June 18, 2026)**: `finalize_claim` published (`0xec0d6bd4…644d8fa1`); Railway `ESCROW_PACKAGE_ID` updated and redeployed clean.
- [ ] Independent Move audit (OtterSec, Zellic, or similar)
- [ ] Burn UpgradeCap after audit passes
- [ ] In-browser smoke test of the migrated gRPC submit path (`lib/zklogin.js`)
- [ ] Fee collection/routing mechanism — still zero implementation (see Tech Debt)

---

## Key Technical Decisions

### Cross-Domain Auth
- Session ID passed via `?sid=` URL param after OAuth callback, stored in
  `localStorage`, sent as `x-session-id` header. See `authFetch()` in frontend.
- Known limitation: token in URL. Deferred — see Deliberately Deferred below.

### Session Management
- Sessions in `sessions` table; survive Railway restarts.
- `getSession()`, `saveSession()`, `deleteSession()`, `purgeExpiredSessions()`.
- IDs: `crypto.randomBytes(32)` (CSPRNG). Stored: `suiAddress`, `email`, `name`,
  `picture`, `createdAt`. No private key, no `id_token`.

### Authoritative Pricing & Tax
- `catalog.mjs` is the single source of truth. Both `server.mjs` and `ai_route.mjs`
  import it. Client-supplied prices are ignored.

### Node Version
Railway runs **Node 22** (`nixpacks.toml`: `nodejs_22`). Required by
`@mysten/sui@latest`. Do not downgrade.

---

## Security Hardening (all live)

1. **AI agent role server-derived** — from session, not client `mode` flag.
2. **Google JWT verification** — RS256 against JWKS, nonce checked.
3. **Server-side price validation** — from `catalog.mjs`.
4. **IDOR fixes** — ownership verified on messages, reviews, deposit release.
5. **XSS fix** — AI chat output HTML-escaped before rendering.
6. **CSPRNG session IDs** and minimal session storage.
7. **Honest booking writes** — failed inserts return 500, not silent "confirmed."
8. **Performance** — N+1 fixed in `get_all_messages`, indexes added.

---

## Date Handling

- Calendar dates: `fmtDay()` — Y-M-D parts only, no timezone shift.
- Timestamps: `fmtDate()` / `fmtDateTime()` — timezone-aware.

---

## Important Files

| File | Purpose | Notes |
|---|---|---|
| `server.mjs` | Main Fastify server | Routes, RBAC, escrow helpers, auto-release + claim-finalize sweeps |
| `escrow.mjs` | Sui escrow helpers | `buildEscrowTransaction`, hardened `verifyEscrowTransaction` (re-reads object via `readEscrowObject`/`BookingEscrowBcs`), `depositToMist`, `autoReleaseEscrow`, `finalizeClaimEscrow` (v3), `resolveDisputeEscrow`, claim/dispute build+verify |
| `escrow.test.mjs` | Unit tests for escrow helpers | **39 tests**, no network needed: `extractCreatedObjectId` (15), `verifyEscrowTransaction` (8 — incl. type/amount/host/ref checks), `depositToMist` (1), `isObjectMutated` (8), `verifyClaimDamageTransaction` (4), `verifyDisputeClaimTransaction` (3). Imports the real functions from `escrow.mjs`. Run: `node escrow.test.mjs` |
| `catalog.mjs` | Prices + tax rates | Single source of truth; `hostAddress` per property (all `null` for demo) |
| `db.mjs` | Pool + `initDB()` | 10 tables + indexes, `escrow_object_id` + claim/dispute columns, idempotent |
| `auth.mjs` | OAuth + sessions | JWT verification, CSPRNG IDs |
| `ai_route.mjs` | Grok AI agent | Server-derived role, per-tool authz; `release_deposit` delegates to shared `releaseDepositForBooking()` |
| `validation.mjs` | zod request schemas | Validates booking/payment/host-apply/claim/dispute/resolve bodies |
| `bookings.mjs` | Shared booking + release logic | `createBooking()` (atomic insert under advisory lock), `releaseDepositForBooking()` (shared by REST + AI), `getPropertyHostAddress()` (honors `DEMO_HOST_ADDRESS`) |
| `lib/zklogin.js` | Client zkLogin signing | Ephemeral key/proof in `sessionStorage`; epoch + submit now via gRPC `SuiGrpcClient` (June 18 migration) |
| `lib/authFetch.js` | Shared session-aware fetch | Used by all 6 authenticated frontend pages |
| `nixpacks.toml` | Railway build config | Node 22 required |
| `contracts/aria_escrow/` | Move smart contract | escrow.move + **28 tests** (25 prior + 3 added for `finalize_claim`) |
| `pages/ai.jsx` | AI chat UI | HTML-escaped output |
| `lib/useWalletBalance.js` | Wallet balance hook | Polls `GET /wallet/balance` every 30s; used by all authenticated pages |
| `pages/bookings.jsx` | Guest dashboard | Balance display, Send modal, Check In button + instructions modal |
| `pages/host.jsx` | Host dashboard | Balance display, check-in type settings per property card, checked-in badge on bookings |
| `pages/index.jsx` | Homepage + booking modal | Balance display, Send modal |

---

## Deliberately Deferred

1. **zkLogin salt `'0'`** — changing orphans existing addresses. Migration required.
2. **DB TLS unverified** — Railway cert issue. Supply CA cert before mainnet.
3. **Session token in URL** — cross-domain dependency. One-time code exchange deferred.

---

## Current Technical Debt

1. **Host onboarding is built and live** (`83bd6fe`, confirmed pushed) — 4-step
   apply/approve flow, `host_profiles` table, `POST`/`PATCH /host/properties`.
   `properties` table is **not** empty (real host-created listings exist).
   Stale note corrected June 30, 2026: only the 6 *original* hardcoded
   `catalog.mjs` demo properties still have `hostAddress: null` — escrow `host`
   for those specifically falls back to `DEMO_HOST_ADDRESS` (if set) else the
   auto-release key. Until that var is set in Railway, claim/dispute can't be
   exercised end-to-end on the 6 demo properties specifically (on-chain
   `claim_damage` asserts `sender == host`) — host-created listings are
   unaffected, they already carry a real `payout_sui_address`.
2. Frontend tax/price duplication — `catalog.mjs` centralizes backend; frontend copy remains.
3. Stripe: create-intent only; webhooks missing.
4. Error handling inconsistent in some routes.
5. No automated backend/frontend tests beyond `escrow.test.mjs` (**78 passing**,
   per `ARIA_ROADMAP.md` §5 — count above is stale) and the Move suite
   (**52 tests**). No frontend tests.
6. `hosts` table unused (legacy). `zod` adopted (`validation.mjs`).
   *(`@anthropic-ai/sdk` was removed June 18, 2026 — no longer a dependency.)*
7. ~~Fee collection/routing mechanism — zero implementation.~~ **Done, live since
   June 23, 2026.** `BookingPaymentEscrow` (`create_payment_escrow`/`release_payment`/
   `refund_payment` in `escrow.move`) holds rental+fee+tax and splits it 3-way on
   release. Wired into `bookings.mjs`/`server.mjs`. ARIA fee is 5%; Stripe
   Connect-style split for the card path is still not built.
8. `@mysten/deepbook-v3` is in `package.json` but **not imported anywhere in the codebase**
   (confirmed June 30, 2026). `deepbook.mjs` uses a plain `fetch` to the DeepBook indexer
   REST API — no SDK, no JSON-RPC. **No July 31 2026 sunset exposure.** The package can
   stay for when the USDC→SuiUSD swap feature is built at mainnet.

---

## Environment Variables (current)

**Railway:**
```
DATABASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CALLBACK_URL, FRONTEND_URL
HOST_ADDRESSES, SESSION_SECRET, XAI_API_KEY, RESEND_API_KEY, STRIPE_SECRET_KEY
ESCROW_PACKAGE_ID       = 0xadd5ac7867a69200d632e858193549b6fa94abff7d80397a1ab4c418f99d3e60
                          (v7 — published June 25, 2026; u128 overflow hardening of the
                          resale math. Upgrade tx 6DTCEZ3rf54NfY5RhV18WWx2apk1tgB5e1d2AUWGoukC.
                          Prior v6: 0x897777aa537c6e438dba11c750d5579848e2cd57afb29c3f68531ec6aeb6c901
                          (Phase 2c resale, tx CRYbygbqkk1HNaTaZfXsZnbXy85adHNUAQd6J4QKXTjD))
BOOKING_PASS_ENABLED    = true   (June 24, 2026 — gates the BookingPass mint; v6 keeps it)
RESALE_ENABLED          = true   (June 24, 2026 — gates Phase 2c resale routes +
                          create_resale_policy mint; set ON after *_PACKAGE_ID on v6)
RESALE_WINDOW_MS        = 0      (testnet; no-transfer window baked per ResalePolicy.
                          Mainnet: unset = 48h default, with release = real check-in)
PAYMENT_RELEASE_OFFSET_MS = 86400000  (1 day testnet, so resale has a usable window;
                          default 5 min if unset. Mainnet: release = real check-in)
                           (LIVE in Railway since June 18, 2026 — v3 upgrade adding
                           finalize_claim; redeploy confirmed clean via deploy logs
                           (deploy db4f1425, both keypairs loaded, DB initialized).
                           Upgrade tx 9wzX4hQkZzzyZTMh9siAU2kHqRLQmJJots3FjzgGMAQa.
                           Prior: v2 0x98e712692f22f308bb6d097d2d8a2743ed0c01058135d71436b4abcd34264f26.
                           Type-defining/original (unchanged across upgrades):
                           0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe)
ESCROW_MODULE_NAME      = escrow
ARIA_AUTO_RELEASE_KEY   = <suiprivkey1... bech32 format — in Railway, never commit.
                           P1b: scoped to auto_release (and finalize_claim — both
                           permissionless on-chain), zero special privilege.
                           Public address: 0xc0b4e8b46731329fa83a8a5d93b1600b415fe0b050be986bb3f7cffda22e0ff9
                           Confirmed loaded in Railway deploy logs June 18, 2026.>
ARIA_ARBITRATOR_KEY     = <suiprivkey1... bech32 format — in Railway, never commit.
                           P2 (June 17, 2026): scoped to resolve_dispute only.
                           Confirmed loaded in Railway deploy logs June 18, 2026.>
ARIA_ARBITRATOR_ADDRESS = 0xf46527e18f2fd7d3093c9591ded66e3a8711a18de63cd0bede2d88692e6f6a65
                           (set in Railway June 17, 2026; supersedes the P1a
                           cold-storage address 0x0069868f93f9127b3e8b51bf95bc529925ca382e6305da0bb01f693826b983f8
                           for escrows created going forward. Pre-existing escrows
                           still need the original P1a key to resolve.)
DEMO_HOST_ADDRESS       = <optional, June 18, 2026 — a real Sui address to act as
                           host for the 6 demo properties (whose catalog.mjs
                           hostAddress is null), so the claim/dispute flow can be
                           exercised end-to-end. If unset, escrow host falls back
                           to ARIA_AUTO_RELEASE_KEY's address. NOT YET SET in Railway.>
AUTO_RELEASE_SWEEP_INTERVAL_MS = <optional, default 3600000 (1 hour)>
ARIA_FEE_ADDRESS        = 0xcc27c579f88e82d0e78f159435675fecf4b1029405eb6f380553132f760ac6de
                           (alias aria-fee, generated June 23, 2026; see
                           ARIA_KEY_INVENTORY.md §5). Receive-only — ARIA's 5%
                           booking fee. NOT a signing key. The combined
                           payment+deposit booking PTB activates once this is set.
ARIA_TAX_REMITTANCE_ADDRESS = RETIRED (June 30, 2026). ARIA does not custody tax.
                           The tax leg now routes to the host's own payout
                           address (same wallet as the rental subtotal) — host
                           receives rental+tax combined at check-in and
                           self-remits off-chain. See ARIA_FEE_DESIGN.md v2.2.
PAYMENT_COIN_TYPE       = <optional, default 0x2::sui::SUI (testnet); SuiUSD type on mainnet>
CHECKIN_RELEASE_SWEEP_INTERVAL_MS = <optional, defaults to AUTO_RELEASE_SWEEP_INTERVAL_MS>
ABANDONED_BOOKING_TTL_MS = <optional, default 900000 (15 min). June 30, 2026 —
                           runAbandonedBookingSweep() cancels bookings still
                           confirmed/pending/un-escrowed past this age, freeing
                           the dates. See Tech Debt "Unsigned-booking trap.">
ABANDONED_BOOKING_SWEEP_INTERVAL_MS = <optional, default 300000 (5 min) — sweep cadence>
REQUIRE_GUEST_VERIFICATION = <Phase 2e — 'true' to require a guest_verifications
                           row before booking (both REST + AI). Default off so it
                           stays dormant until the /profile UI is live + tested.>
CHECKIN_KEY             = <64 hex chars (32 bytes) — AES-256-GCM key for encrypting
                           host access instructions (door codes, wifi, etc.).
                           Added June 30, 2026. Generate:
                           node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
                           Set in Railway. If unset, PUT /host/property/:id/access-instructions
                           throws "CHECKIN_KEY must be 64 hex chars".
                           One key for all properties/hosts — server-mediated trust model,
                           intentionally not using Walrus Seal (appropriate for non-PII
                           operational data). ALREADY SET in Railway (June 30, 2026).>

Vercel (frontend), Phase 2:
NEXT_PUBLIC_ESCROW_PACKAGE_ID = <the v4 package id once published — used by
                           lib/seal.js as the seal_approve CALL target. Falls back
                           to the original/type-defining id if unset, but
                           seal_approve only EXISTS in v4, so decrypt won't work
                           until this points at v4.>
NEXT_PUBLIC_PAYMENT_COIN_TYPE = <optional, default 0x2::sui::SUI; the type arg for
                           the seal_approve<T> call (SuiUSD on mainnet)>
# Frontend dep: run `pnpm add @mysten/seal` (NOT yet installed). lib/seal.js and
# the two pages dynamic-import it, so the app builds without it until a user
# actually hits the encrypt/decrypt path.

REMOVED June 18, 2026:
- ARIA_DEPLOYER_KEY  — deleted from Railway (P1b ops complete). The original
  deployer/UpgradeCap key is cold KeePass-only and never loaded by the backend.
- ANTHROPIC_API_KEY  — deleted from Railway; @anthropic-ai/sdk removed from the
  codebase (was unused). The old sk-ant-... key should be revoked in the console.
```

**Vercel:**
```
NEXT_PUBLIC_API_URL = https://aria-demo-production-e590.up.railway.app
```

---

## Best Practices for Changes

- Always use `authFetch()` in the frontend.
- Use `requireSession` / `requireHost` / `requireSuperadmin` in `server.mjs`.
- Gate AI agent host tools by server-derived `isHost`, not request body.
- Compute money and dates server-side; render calendar dates with `fmtDay()`.
- All `db.mjs` DDL must stay idempotent.
- For Sui transactions, use the gRPC pattern established in P0a — see `server.mjs`.
- Use `extractCreatedObjectId(changedObjects)` for any PTB that creates a shared
  object — do not inline the filter logic.
- Do not add emergency withdraw or pause functions to the contract.
- For any PTB that creates a shared object, verify it on-chain by **re-reading
  the object's content** (`readEscrowObject`/BCS) and checking its fields against
  the expected values — never trust a client-reported digest at face value.

- Use the single `depositToMist()` helper for dollar→mist conversion everywhere.
- Keep this doc, `ARIA_ROADMAP.md`, `ARIA_REMEDIATION.md`, and `ARIA_CODE_AUDIT.md` in sync.

---

## Sui Integration Lessons (transferable)

Hard-won gotchas from building ARIA on Sui (testnet, `@mysten/sui` v2 **gRPC**
client, zkLogin, package upgrades, Walrus). Written generically so any agent or
dev can apply them to other Sui dApps — not just ARIA. Reference implementation
for most of these lives in `escrow.mjs` (`verifyEscrowTransaction`,
`readEscrowObject`, `BookingEscrowBcs`).

### 1. Read-after-write asymmetry: `getTransaction` is instant, `getObjects` lags
After a tx executes, `getTransaction(digest)` returns its effects immediately.
But `getObjects(createdObjectId)` (current object state) can return
"Object … not found" for **seconds to minutes** on public fullnodes — observed
**>1 minute** on `fullnode.testnet.sui.io`, because reads are load-balanced
across replicas that lag the one that processed the tx. **Do not gate critical
logic on reading back a freshly-created object.** If you must read it, retry with
backoff AND keep a fallback that neither strands the user nor accepts on weak
evidence. Prefer verifying from the transaction's own effects (§2).

### 2. Verify a created object's TYPE lag-free via `objectTypes`
`getTransaction({ digest, include: { objectTypes: true } })` →
`result.Transaction.objectTypes` is a `Record<objectId, fullType>` populated from
the **same** call (no extra round-trip, no lag). To find "the object my Move call
created," **scan that map by value** for your struct type and take the key as the
object id — more robust than guessing which `effects.changedObjects` "Created"
entry is yours. Real shape from ARIA:
```
{ '0x98e7…': '0x538262…::escrow::BookingEscrow<0x2::sui::SUI>',
  '0xf26b…': '0x2::coin::Coin<0x2::sui::SUI>' }
```

### 3. A struct's type carries the ORIGINAL package id, not the upgraded one
After `sui client upgrade`, your package id changes but every existing/!new
object's fully-qualified **type still shows the first-published (type-defining)
package id**. ARIA runs package **v3** (`0xec0d6…`) yet every `BookingEscrow`
type reads `0x538262…` (v1). So when matching a type string, match the
`::module::Struct<` **suffix**, never pin your current `PACKAGE_ID`. (Same reason
Seal's identity namespace anchors to the original package id forever.)

### 4. Verifying a transaction you didn't sign (non-custodial flows)
When the user signs+submits and only reports a digest, **never trust the digest
at face value** — re-derive from chain, layered by reliability:
1. tx succeeded + `sender == expected user` (lag-free).
2. created object is YOUR type (lag-free, §2) — blocks "created some unrelated
   object" substitution.
3. (best-effort) read object content to verify amounts/fields — guards
   under-funding, but depends on the laggy `getObjects`, so treat as a bonus.

Distinguish **"readable but fields wrong"** (real attack → hard reject) from
**"couldn't read"** (infra lag → don't strand; accept on the lag-free evidence
you DO have, or return a **retryable** status). Two anti-patterns to avoid:
(a) soft-accepting on "some object was created" (lets a guest substitute a
near-zero deposit); (b) hard-failing a confirmed op because a read replica lagged.

### 5. The gRPC client result is a discriminated union
`@mysten/sui` gRPC `getTransaction`/`executeTransaction` return
`{ $kind: 'Transaction' | 'FailedTransaction', Transaction?: {...},
FailedTransaction?: {...} }`. The real payload (status/effects/transaction/
objectTypes) is **nested under `.Transaction`**. Reading top-level
`.status`/`.effects` is always `undefined` — a silent bug that makes every tx
look failed. Always branch on `$kind`. And nothing is included by default — pass
`include: { effects: true, objectTypes: true, transaction: true }` explicitly.

### 6. Decoding object content with BCS
`getObjects({ include: { content: true } })` returns `content` as **raw BCS
bytes** of the Move struct. Parse with a hand-built `bcs.struct` mirroring the
Move struct EXACTLY in field order/type. Rules that bite:
- `UID` serializes as a bare 32-byte address → `bcs.Address`.
- `Coin<T>` = `{ id: UID, balance: Balance<T> { value: u64 } }`.
- `std::string::String` = length-prefixed bytes → `bcs.string()`.
- `u64` comes back as a **string** — compare as string/BigInt, never JS number.
The `json`/`display` includes exist but their shapes vary across
JSON-RPC/gRPC/GraphQL — the BCS `content` path is the consistent one.

### 7. `coinWithBalance` + created-object ordering
`coinWithBalance({ balance })` emits a `SplitCoins` (an ephemeral coin) **and**
your create call. In `effects` "Created" entries the ephemeral coin is FIRST and
your real object LAST, so "take the last Created" works — but the §2
`objectTypes` type-scan is order-independent and preferred.

### 8. Settle on-chain — don't just flip a DB status
ARIA's cancel path originally set `deposit_status='released'` in Postgres but
never called the contract, leaving the coin locked on-chain forever (a "stranded
deposit"). **Any state change that should move funds must actually submit the
on-chain tx and gate the DB write on its success.** Sui has **no native cron**:
a keeper (server interval) must submit time-based settlement (e.g. `auto_release`
after expiry). For testnet set short expiries (ARIA uses `now + 5min`) so timing
is exercisable without waiting days. Tie related state to object lifecycle where
possible — ARIA's `auto_release`/`accept_claim`/`resolve_dispute` all
`object::delete` the escrow, which (bonus) auto-revokes any Seal access keyed to it.

### 9. JS SDK still uses JSON-RPC in places — and JSON-RPC is being sunset
Sui's JSON-RPC interface deactivates network-wide (announced for July 31, 2026).
Migrate to the gRPC client. Watch the **browser** path too: ARIA's `lib/zklogin.js`
silently used `sui_executeTransactionBlock` / `suix_getLatestSuiSystemState`
(JSON-RPC) long after the backend migrated — submit via the gRPC
`executeTransaction` and read epoch via `getCurrentSystemState`.

### 10. Server-side fetch of a user-supplied URL = SSRF (general)
Not Sui-specific but it bit ARIA (iCal import). Any URL a user can register that
the server later fetches needs: **https-only**, resolve the host and **reject any
private/loopback/link-local/CGNAT/metadata IP** (`169.254.169.254`),
`redirect: 'error'` (so a public URL can't 30x to an internal one), a **timeout**
and a **response-size cap**, plus authz on who can register it. See
`ical.mjs assertPublicHttpsUrl`.

### 11. You cannot unit-test these — smoke-test the real chain
Mocked unit tests CANNOT catch read-after-write timing, the gRPC
discriminated-union shape, or a BCS-layout mismatch against real chain bytes.
ARIA shipped escrow-verification bugs past **41 green unit tests** that only live
testnet caught. When integrating a new SDK call, add a **temporary diagnostic log
of the real response shape**, deploy, exercise it once, read the log, then remove
the diagnostic. (That is exactly how the `objectTypes` shape in §2 was confirmed.)

### 12. Decoding a coin amount from a CONSOLIDATED SplitCoins
`coinWithBalance` used twice in one PTB (ARIA's combined payment+deposit booking)
does NOT emit two separate `SplitCoins` — the SDK consolidates them into ONE
`SplitCoins` with an `amounts` array `[a, b]`, and each consuming call references
a different **result index** (`NestedResult[splitCmd, 0]`, `[splitCmd, 1]`). When
decoding an amount lag-free from tx inputs, index `amounts[]` by the coin arg's
result index — NOT `amounts[0]` unconditionally. Reading `[0]` made the deposit
decoder return the *payment* amount and reject the first live combined booking.
(See `decodeCreateEscrowArgs` in `escrow.mjs`; regression-tested in `escrow.test.mjs`.)

### 13. Seal + package upgrades: original id for encrypt, current id for the call
**Live-confirmed June 23, 2026.** When `seal_approve` is added in a package
UPGRADE (not the first publish), the ids must be split:
- **encrypt** and **`SessionKey.create`** require the **original / first-published**
  package id (`0x538262…`). Passing an upgraded id (v4/v5) throws
  **"Package ID used in PTB is invalid"** — Seal only accepts a first-version id.
- the **`seal_approve` move-call target** must be the **current/upgraded** id
  (now v5 `0xd825ec2d…`, where the function lives — also present in v4), or `tx.build`
  fails **"unable to find function …::escrow::seal_approve"**.
Seal reconciles the two by resolving the call's package to its first version. In
`lib/seal.js`: `SEAL_PACKAGE_ID` (original) for encrypt + SessionKey,
`CURRENT_PACKAGE_ID` (v5, from `NEXT_PUBLIC_ESCROW_PACKAGE_ID`) for the call.
Also: `seal_approve` gates on `sender == escrow.host`, so the host's wallet must
BE the escrow's host — set `DEMO_HOST_ADDRESS` to that wallet BEFORE the booking
is created (existing escrows keep the old host immutably), or the key servers
return **"User does not have access to one or more of the requested keys."**

---

*Technical Handoff v4.18 — June 19, 2026*
*Changes from v4.17: escrow verification reworked to be lag-robust and
**live-verified end-to-end on testnet**. Root cause: gating on the `getObjects`
content read failed on ~every booking because the public fullnode can't serve a
just-created object for >1 min (read-after-write lag) while `getTransaction` is
instant. Fix: `verifyEscrowTransaction` now gates on the created object's TYPE
read lag-free from `getTransaction`'s `objectTypes` map (scanned by value,
matched on the `::escrow::BookingEscrow<` suffix since the type carries the
original package id, not v3), with the `getObjects` content/amount check demoted
to best-effort and a 503-retryable fallback (never marks held on weak evidence).
Also live-verified the M1 cancel-time on-chain release (`cancelBooking: escrow
released on-chain` after the testnet 5-min expiry). Added a new transferable
**"Sui Integration Lessons"** section (11 gotchas/patterns) and updated the
signing/verification section. Tests 41/41. Known pre-mainnet limitation: amount
check skipped under read lag (type+sender still enforced) — mainnet options
(reliable fullnode / async reconciler / tx-input decode) roadmapped.*
*Technical Handoff v4.17 — June 18, 2026*
*Changes from v4.16: (1) Smart contract upgraded to v3
(`0xec0d6bd4…644d8fa1`) adding permissionless `finalize_claim` (CLAIMED-deadlock
fix); `ESCROW_PACKAGE_ID` updated in Railway and redeployed clean (deploy
db4f1425). (2) Second independent code review — 8 findings fixed, documented in
`ARIA_CODE_AUDIT.md` "Second Review": hardened `verifyEscrowTransaction`
(re-reads object type/amount/host/ref), frontend `lib/zklogin.js` migrated off
JSON-RPC to gRPC, atomic booking insert under advisory lock (fixes silent
"confirmed" + double-booking race), unified `releaseDepositForBooking()` across
REST + AI (gates on on-chain result), configurable `DEMO_HOST_ADDRESS`. Backend
suite 33→39 tests; Move 25→28. (3) Ops: all operational addresses funded; old
`ARIA_DEPLOYER_KEY` and `ANTHROPIC_API_KEY` removed from Railway; unused
`@anthropic-ai/sdk` dependency removed from the codebase. Updated the contract
table/version history, signing section, pre-mainnet checklist, Important Files,
Tech Debt, and Environment Variables accordingly. Remaining manual: in-browser
smoke test of the gRPC submit path; optional set `DEMO_HOST_ADDRESS` in Railway;
fee-collection design.*
*Technical Handoff v4.16 — June 17, 2026*
*Changes from v4.15: noted that Phase 2 (Seal/PII) was re-scoped in
`ARIA_ROADMAP.md` — no longer creates a separate on-chain object, so
`extractCreatedObjectId()` isn't needed for it. See roadmap for full detail.*
*Technical Handoff v4.15 — June 17, 2026*
*Changes from v4.14: confirmed `ESCROW_PACKAGE_ID` set in Railway and
redeployed — deploy logs (3:05 PM CDT) show both keypairs loading correctly,
DB initialized, server up clean. P3 is now fully deployed end-to-end, no
manual steps remain. Updated pre-mainnet checklist and Environment Variables.*
*Technical Handoff v4.14 — June 17, 2026*
*Changes from v4.13: P3 upgrade published successfully on-chain — transaction
`JCA8daJ9mSByY6x51ZhEc6Ubfrv1LEbf3nsVccEFtJZK`, new package
`0x98e712692f22f308bb6d097d2d8a2743ed0c01058135d71436b4abcd34264f26` (v2).
Updated pre-mainnet checklist and Environment Variables (`ESCROW_PACKAGE_ID`).
One manual step remains: set that new package ID in Railway.*
*Technical Handoff v4.13 — June 17, 2026*
*Changes from v4.12: first upgrade attempt failed — `sui client upgrade`
rejected the package, "missing public declaration: public function
'status_resolved' is missing." Sui forbids removing any public function from
an already-deployed package under any upgrade policy. Restored
`status_resolved()` with the same signature, now hardcoded to return `4`
instead of referencing the removed constant. Updated the P3 section
accordingly; re-ran `sui move test` (still 25/25 passing) before retrying.*
*Technical Handoff v4.12 — June 17, 2026*
*Changes from v4.11: P3 contract cleanup — removed dead `STATUS_RESOLVED`
constant and `status_resolved()` accessor from `escrow.move`; added a 30-day
expiry upper bound (`MAX_EXPIRY_MS` constant, `EExpiryTooFar` error code,
assertion in `create_escrow`, `max_expiry_ms()` accessor) plus two new tests
in `escrow_tests.move`. Code-complete but not yet live on-chain — publishing
the upgrade requires the operator to run `sui client upgrade` manually with
the cold `UpgradeCap` key (commands given in chat, not committed anywhere).
Updated pre-mainnet checklist and Important Files table accordingly.*
*Changes from v4.10: Marked P2 complete — auto-release cron job
(`runAutoReleaseSweep()`, interval + 30s startup sweep), production host
address lookup (`getPropertyHostAddress()` now reads `host_profiles.payout_sui_address`
instead of defaulting to the auto-release key), and the five claim/dispute
routes (`/booking/claim-damage`, `/booking/claim-damage/confirm`,
`/booking/dispute-claim`, `/booking/dispute-claim/confirm`,
`/booking/resolve-dispute`), backed by 9 new `bookings` columns and 5 new
`validation.mjs` schemas. Added a `['claimed','disputed','forfeited']` guard
to `/booking/release-deposit` so auto-release can't run out from under an
active claim/dispute. Generated a new operational `ARIA_ARBITRATOR_KEY` /
`arbitratorKeypair` scoped to `resolve_dispute` only, since the P1a arbitrator
key was cold-storage/manual-signing-only and can't be loaded by the backend;
documented that this new address supersedes the P1a address for new escrows
while pre-existing escrows still need the original P1a key. Added 18 new unit
tests to `escrow.test.mjs` (`isObjectMutated`, `verifyClaimDamageTransaction`,
`verifyDisputeClaimTransaction`) — 33 tests total, all passing. Updated
pre-mainnet checklist, P2 audit section, Important Files table, and
Environment Variables accordingly. Remaining manual step: set
`ARIA_ARBITRATOR_KEY` and the updated `ARIA_ARBITRATOR_ADDRESS` in Railway.*
