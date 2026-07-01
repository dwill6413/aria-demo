# ARIA — Product Roadmap & AI Handoff Document
**Version:** 2.30 | **Updated:** June 30, 2026
**Purpose:** Complete handoff for an AI assistant continuing ARIA development.
Read this entire document before writing any code.

> **June 30, 2026 (LATEST — wallet balance, zkLogin send, and self check-in shipped):**
> Three wallet/UX features shipped and verified end-to-end in-browser. No Move contract changes.
>
> **P3 — Wallet balance display.** `lib/useWalletBalance.js` hook polls `GET /wallet/balance`
> every 30s. Balance shown in header of all authenticated pages with low-balance faucet link
> and manual refresh. Verified: live SUI balance displays correctly.
>
> **P3 — zkLogin plain-SUI send.** Guests can send SUI to any address from the ARIA UI
> (homepage + bookings page) without any external wallet extension. Uses `coinWithBalance` +
> `tx.transferObjects` on the backend; `signTransactionWithZkLogin` + `submitSignedTransaction`
> on the frontend. Full non-custodial build→sign→submit→confirm with on-chain balance-change
> verification. Audit log in `wallet_sends` table. Verified end-to-end in-browser.
>
> **P4 — Self check-in with encrypted access instructions.** Host-configurable per property:
> "Front Desk" (existing BookingPass QR flow) or "Self Check-in" (encrypted access instructions
> revealed at check-in time). Key details:
> - AES-256-GCM server-side encryption (Node.js built-in crypto, `CHECKIN_KEY` env var).
>   Deliberately NOT Walrus Seal — access instructions are operational data, not PII;
>   server-mediated trust is appropriate and far simpler.
> - Time gate: 2h before check-in date through checkout + 24h.
> - Idempotent check-in: guests can re-open instructions anytime during their stay
>   ("✅ Checked In — View Instructions" button).
> - Host bookings view shows "✅ Checked In · [timestamp]" badge per booking.
> - New DB columns: `properties.check_in_type`, `properties.access_instructions_encrypted`,
>   `bookings.checked_in`, `bookings.checked_in_at`.
> - New routes: `PUT/GET /host/property/:id/access-instructions`, `POST /booking/:ref/checkin`.
> - New env var: `CHECKIN_KEY` (already set in Railway).
> - Verified end-to-end in-browser.
>
> **Also fixed this session:** CORS `PUT` method was missing from `@fastify/cors` config
> (blocked the access-instructions save). Catalog properties now show check-in settings
> block (fixed `loadCheckInSettings` to seed defaults before fetch; removed `source === 'db'`
> guard). Host `/bookings/all` response now includes `checkedIn`/`checkedInAt` fields.
>
> **Files touched:** `escrow.mjs`, `db.mjs`, `validation.mjs`, `server.mjs`,
> `pages/bookings.jsx`, `pages/host.jsx`, `pages/index.jsx`, `lib/useWalletBalance.js` (new).

> **June 30, 2026 (abandoned-booking sweep shipped):** Tech Debt
> "Unsigned-booking trap" fix #2 (the open item) is done: `createBooking`'s
> availability check only ever excluded `payment_status='cancelled'` — it had
> no time dimension — so a guest who started checkout and never signed the
> escrow PTB (stuck at `deposit_status='pending'`, `escrow_object_id` and
> `payment_escrow_object_id` both null) blocked the property's dates
> indefinitely, with no on-chain funds ever at risk. Added
> `runAbandonedBookingSweep()` in `server.mjs`, same cron pattern as the
> existing auto-release/check-in sweeps (`setInterval` + startup `setTimeout`,
> re-entrancy guard): every 5 minutes (`ABANDONED_BOOKING_SWEEP_INTERVAL_MS`)
> it finds bookings still `confirmed`/`pending`/un-escrowed past a 15-minute
> TTL (`ABANDONED_BOOKING_TTL_MS`) and flips them to `payment_status='cancelled',
> deposit_status='released'` (the same terminal state `cancelBooking` already
> uses for "nothing was ever locked on-chain"), freeing the dates for other
> guests. The UPDATE re-checks the same disqualifying conditions as the SELECT
> so a guest who signs in the gap is left untouched — no locking needed. Sends
> a "Booking Hold Expired" email (Resend) so a returning guest isn't confused
> by a dead booking ref. 15 minutes was chosen to stay longer than a normal
> signing flow but still comfortably inside the existing
> `/booking/:bookingRef/escrow/rebuild` resume window. Added a partial index
> `idx_bookings_abandoned_sweep ON bookings(created_at) WHERE payment_status =
> 'confirmed' AND deposit_status = 'pending'` (`db.mjs`) so the sweep query
> stays cheap as the table grows. No tests added — there's no existing test
> harness for the DB-backed cron sweeps (the other two sweeps aren't unit
> tested either; `escrow.test.mjs` only covers `escrow.mjs`'s pure
> build/verify/decode logic) — **run the server locally and confirm the new
> sweep doesn't error on boot before deploying.**
>
> **June 30, 2026 (tax-routing design correction, no contract upgrade):**
> Design fix: ARIA does not custody occupancy tax. Previously `release_payment`'s
> 3-way split sent the tax leg to a separate ARIA-controlled
> `ARIA_TAX_REMITTANCE_ADDRESS` wallet, which conflicted with the already-built
> off-chain model where hosts self-remit tax (`tax_remittances` table,
> `/tax/remit` route). Fixed so the tax leg now routes to the host's own payout
> address — same wallet as the rental subtotal — so at check-in ARIA receives
> only its 5% fee and the host receives rental+tax combined. No Move upgrade
> needed (`tax_addr` was always a plain function argument, not hardcoded).
> Changed: `escrow.mjs` (`buildBookingPaymentTransaction` sets `taxAddr = hostAddr`;
> `verifyBookingPaymentTransaction` checks `pay.taxAddr` against the
> authoritative host address instead of an env var), `bookings.mjs`/`server.mjs`
> (`useCombined` now gates on `ARIA_FEE_ADDRESS` alone), `escrow.test.mjs`
> (fixtures + a new tampered-tax-destination adversarial test). `ARIA_TAX_REMITTANCE_ADDRESS`
> is retired — see `ARIA_KEY_INVENTORY.md` §5 and `ARIA_FEE_DESIGN.md` v2.2.
> Confirmed: `node escrow.test.mjs` 79/79 passed and `sui move test` 52/52
> passed (user ran both locally after the fix).
>
> **June 29, 2026 (catalog/db parity: all 4 gaps closed):** Direct ask:
> "make sure any imported property listings by a host inherit all functionality
> as our hard coded test properties — no gaps." Audit found 4 places the 6
> fixed `catalog.mjs` demo properties and host-imported (`properties` table)
> listings resolved inconsistently; all 4 fixed same session. **(1) Tax
> jurisdiction:** 6 call sites (`server.mjs` ×5, `ai_route.mjs` ×1) hardcoded
> `JURISDICTION_TAX_RATES[propertyId]` (covers only ids 1-6) instead of
> `getProperty()` (covers both sources) — a host-imported listing's tax pages
> showed a fabricated "Unknown @ 8%". **(2) `canManageProperty()` — the inverse
> gap:** only checked the `properties` DB table, never the catalog's static
> `hostAddress`, so a configured host of one of the 6 demo properties could
> never manage their own listing (release deposits, resale settings, iCal
> import, tax remit/unremit all 403'd). Fixed at the function itself — now
> resolves via `getProperty()`, covering all 5 call sites + the AI chat's
> `release_deposit` tool at once. **(3) iCal export title** used a hardcoded
> 6-entry map instead of `getProperty()` (cosmetic). **(4) Dead schema:**
> `properties.transfer_allowed`/`max_resale_premium_bps` columns in `db.mjs`
> were never actually read/written (real resale settings live in
> `property_resale_settings`) — removed. Full detail + the files-touched list:
> see `ARIA_HANDOFF.md`'s matching June 29 entry. **Committed and pushed to
> `origin/main`** (commit `264b4b6`; confirmed via `git log origin/main`,
> June 30 2026). See Tech Debt row below re: recurring local file truncation
> caused by a OneDrive sync race on the project folder — **sync has since
> been paused by the user (June 30 2026)**; truncated working-tree files were
> repaired from `git show HEAD` and re-verified with `node --check`.
>
> **June 25, 2026 (v7 pre-mainnet hardening):** v7 escrow package
> `0xadd5ac7867a69200d632e858193549b6fa94abff7d80397a1ab4c418f99d3e60` published — resale
> split + price-cap math now uses u128 intermediates (overflow-safe), per an external code
> review. No behavior change at realistic values; 52/52 Move tests unchanged. Additive/no-break;
> tx `6DTCEZ3rf54NfY5RhV18WWx2apk1tgB5e1d2AUWGoukC`. Railway/Vercel `*_PACKAGE_ID` → v7.
> Phase 2c resale itself shipped + verified in v6 (below); v7 is identical logic, hardened.
>
> **June 24, 2026 (v6 published + Phase 2c resale market LIVE & VERIFIED):**
> The guardrailed resale market shipped to chain. v6 escrow package
> `0x897777aa537c6e438dba11c750d5579848e2cd57afb29c3f68531ec6aeb6c901` published —
> additive upgrade over v5, no compatibility break (existing escrow structs/signatures
> untouched; tx `CRYbygbqkk1HNaTaZfXsZnbXy85adHNUAQd6J4QKXTjD`). New shared
> `ResalePolicy` object + `create_resale_policy` / `list_for_resale` / `buy_resale` /
> `cancel_resale_listing`; 52/52 Move tests, 78/78 JS verifier tests. Env: Railway +
> Vercel `*_PACKAGE_ID` on v6, `RESALE_ENABLED=true`, `RESALE_WINDOW_MS=0` +
> `PAYMENT_RELEASE_OFFSET_MS=86400000` (testnet). **Verified end-to-end in-browser**:
> booking `ARIA-1-1782390279195-4320e7` listed at $400 and bought from a second
> verified account (buy digest `E9gWpqWGKZh5hJw6kfnF6LfZfrj1son5HbctTVnzpcXg`). The
> on-chain `BookingResold` event split the $400 sale as **ARIA $0.30 / host $1.35 /
> seller $398.35** (face $397 + 45% of the $3 upcharge), reassigned both escrows to the
> buyer, bumped `resale_count`→1, and minted a fresh soulbound pass to the buyer — and
> the booking moved out of the seller's account into the buyer's (Seal identity follows,
> since `seal_approve` gates on `escrow.guest`). **ARIA resale fee decided: 10% of the
> upcharge only** (face-value resale is fee-free). See §9 Phase 2c + `ARIA_PACKAGE_INVENTORY.md`
> + `ARIA_PHASE2C_PLAN.md`.
>
> **June 24, 2026 (v5 published + BookingPass activated):** Phase 2a
> shipped to chain. v5 escrow package `0xd825ec2d…dc9b8` published — additive upgrade
> over v4, no compatibility break (`seal_approve` + fee/Seal calls unchanged; tx
> `EoGhMXMEA8mDobxh38WT2WR1hxd4GuobfJqupsthE1LX`). Env rollout applied: Railway
> `ESCROW_PACKAGE_ID` = v5 and `BOOKING_PASS_ENABLED` = `true` (both confirmed);
> Vercel `NEXT_PUBLIC_ESCROW_PACKAGE_ID` = v5 (the `seal_approve` call target). The
> mint is **flag-gated only** — the publish→update-package-ids→then-enable ordering is
> the safeguard, by design (no runtime version guard, intentionally). **Verified**
> June 24, 2026: fresh booking `ARIA-1-1782312873579-3d5f50` minted the soulbound
> `BookingPass` (🎫 on-chain in My Bookings; existing bookings don't retroactively
> mint). See §9 Phase 2a + `ARIA_PACKAGE_INVENTORY.md`.
>
> **June 23, 2026 (full E2E QA + §5f quick wins + resume-signing):**
> Phases 1h.5 + 2 are QA'd end-to-end on live testnet (booking → two-escrow sign →
> confirm; host PII decrypt works ONLY while live — negative case verified; cancel
> deletes the escrow → `seal_approve` revokes PII access automatically). §5f
> quick-win batch shipped (helmet + Next headers, DB integrity indexes/CHECK enums,
> AI msg cap, `pii_access_log`, test script, README) — see §5f. Resume-signing
> shipped for the unsigned-booking trap (`/booking/:ref/escrow/rebuild` + "Complete
> payment & sign" on My Bookings — see Tech Debt "Unsigned-booking trap", fix #1
> done). Open: abandoned-booking sweep; the bigger §5f items (full CSP/CSRF, Move
> audit, migrations, frontend tests). Everything green; nothing mainnet-blocking
> shipped today.
>
> **June 23, 2026 (LATE — Phases 1h.5 + 2 SMOKE-TESTED LIVE, PASS):** v4 contract
> published (`0xf68a874f…`, fee fns + `seal_approve`); env wired (Railway
> `ESCROW_PACKAGE_ID`/`ARIA_FEE_ADDRESS`/`ARIA_TAX_REMITTANCE_ADDRESS`/
> `DEMO_HOST_ADDRESS`, Vercel `NEXT_PUBLIC_ESCROW_PACKAGE_ID`). A real booking
> signed the two-escrow PTB and confirmed; the Seal guest-PII encrypt→host-decrypt
> round-trip worked in-browser. Suites green (63 JS / 43 Move). Three live bugs
> fixed: consolidated-SplitCoins deposit decode, Seal package-id hybrid
> (encrypt/SessionKey = original id, `seal_approve` call = v4), missing
> `DEMO_HOST_ADDRESS` (see HANDOFF Sui Integration Lessons §12–13). Railway build
> switched npm→pnpm (was timing out). Still open: flip `REQUIRE_GUEST_VERIFICATION`,
> abandoned-booking sweep, reconciler, gas monitoring, mainnet Seal key server.
>
> **June 23, 2026 (Phase 2 — Seal/Walrus guest PII BUILT):** The full guest-PII
> system landed (see Phase 2 build order). `seal_approve` added to `escrow.move`
> (+3 Move tests) — gates PII decrypt on `sender == escrow.host` and the identity
> being the escrow's guest; ships in the SAME v4 publish as the fee functions.
> `guest_verifications` table (pointer only, no PII); `/guest/profile` +
> `/host/guest-identity` routes; `hasGuestProfile` in `/auth/me`; booking gate in
> `createBooking` behind `REQUIRE_GUEST_VERIFICATION`; `lib/seal.js` (encrypt +
> Seal-decrypt helpers, 2-of-2 Mysten testnet key servers); `pages/profile.jsx`
> (guest encrypt → Walrus) and a host "View Guest Identity" decrypt modal in
> `pages/host.jsx`; `signPersonalMessageWithZkLogin` for Seal's SessionKey. OPEN
> (operator/env): `pnpm add @mysten/seal`; the v4 publish (bundles seal_approve +
> fee fns) then set `NEXT_PUBLIC_ESCROW_PACKAGE_ID`; in-browser Seal smoke test
> (incl. zkLogin SessionKey signing — untested); flip `REQUIRE_GUEST_VERIFICATION`
> when ready; mainnet key-server provider + decrypt audit logging.
>
> **June 23, 2026 (Phase 1h.5 — backend + contract BUILT):** Fee collection /
> payment routing was implemented on the backend and contract (file-by-file log
> in `ARIA_FEE_DESIGN.md` §14). New `BookingPaymentEscrow` +
> `create_payment_escrow`/`release_payment`/`refund_payment`/`refund_deposit` in
> `escrow.move` (+12 Move tests); `buildBookingPaymentTransaction` /
> `verifyBookingPaymentTransaction` (lag-free destination-authority verification)
> + release/refund signers in `escrow.mjs`; combined one-signature booking PTB in
> `bookings.mjs`; two-escrow confirm + `runCheckInReleaseSweep` cron +
> payment/deposit refund-on-cancel in `server.mjs`; payment columns + unique
> `settlement_digest` in `db.mjs`; +14 JS unit tests (adversarial matrix). Policy
> locked: **fee follows refund** (full refund incl. ARIA fee before check-in,
> 3-way split at check-in) — matches Airbnb/Vrbo. Frontend done too (June 23):
> `pages/index.jsx` review-then-sign disclosure + `pages/ai.jsx` chat disclosure
> (+ `ai_route.mjs` field forwarding), cancellation copy corrected. **NOT yet:**
> the two treasury addresses, the v4 on-chain publish (bundle with 2a
> `seal_approve`), an in-browser smoke test of the signing UI, and running the
> suites (build sandbox can't — operator runs `node escrow.test.mjs` +
> `sui move test`). The combined path only activates once
> `ARIA_FEE_ADDRESS` + `ARIA_TAX_REMITTANCE_ADDRESS` are set; until then it falls
> back to the deposit-only P0b build.
>
> **June 22, 2026 (Assessment of Codebase Evaluation):**
> - An external codebase evaluation was fully assessed. It was confirmed that all highlighted items are either already resolved, praised as architecture strengths, or already tracked in the technical debt backlog or roadmap.
> - Specifically, the noted "frontend fetch duplication" was confirmed to already be fully consolidated under `lib/authFetch.js` (all 6 authenticated pages import from it; none define it inline).
> - No code or doc changes are warranted, as the evaluation independently confirmed our current priority order (Phase 1h.5 first).
>
> **June 22, 2026 (later still):** Fourth external review (Codex) evaluated — see
> **§5e**. Fixed two new verified issues: **cross-tenant booking cancellation**
> (any host could cancel any booking — now scoped to managed properties via
> `hostManagesBooking`) and a **missing `deposit_release_walrus_blob_id` column**
> (`ai_route.mjs` wrote it but `db.mjs` never created it).
>
> **June 22, 2026 (later):** Third external review evaluated — see **§5d**. Fixed
> in code: **P1-2** (claim-damage confirm now records the on-chain `claim_amount`
> decoded lag-free, not a client-supplied value) and **logout server-side
> revocation** (`deleteSession` now called). New backlog items added in §5d:
> package-manager/lockfile alignment, CSRF for cookie auth, security headers/CSP,
> DB integrity constraints, AI per-user budget/audit log, growth indexes. The
> standalone eval file was deleted after folding its findings here. Also: the
> lag-free escrow verifier (Phase 1h.5 "step 1") shipped and is live-confirmed —
> see `ARIA_FEE_DESIGN.md` §13.
>
> **June 22, 2026:** Fee collection/routing (Phase 1h.5) now has a written design
> — see **`ARIA_FEE_DESIGN.md` v2.0**. Decided model: rental + ARIA fee + tax are
> escrowed in a new non-custodial **`BookingPaymentEscrow`** at booking (one guest
> signature, alongside the deposit escrow), then released in a 3-way split
> (`subtotal`→host, `ariaFee`→ARIA, `taxes`→remittance) at **check-in**;
> full refund to guest on cancellation **before** check-in (binary policy). This
> needs a contract addition shipped in the **v4** upgrade — bundled with Phase
> 2a's `seal_approve`. SuiUSD-only this phase; Stripe Connect deferred. Also fixes
> a fee double-count bug in `calculateHostPayout`. **Top remaining build item:
> fee collection/routing (now design-complete, awaiting build).**
>
> **June 18, 2026:** Contract upgraded to **v3** (`0xec0d6bd4…644d8fa1`, adds
> `finalize_claim`); a second independent code review fixed 8 findings (see
> `ARIA_CODE_AUDIT.md` "Second Review"); ops cleanup done (addresses funded, old
> `ARIA_DEPLOYER_KEY` + `ANTHROPIC_API_KEY` removed from Railway, `@anthropic-ai/sdk`
> removed). Phase 2 (Seal/PII) remains the next feature phase.

---

## 1. Project Context

ARIA is a vacation rental dApp on Sui blockchain (testnet). Vacation rental
direction is confirmed — no pivot. See `ARIA_HANDOFF.md` for full context.

**Live deployments:**
- Frontend: `https://aria-demo-psi.vercel.app` (Vercel, Next.js)
- Backend: `https://aria-demo-production-e590.up.railway.app` (Railway, Fastify ESM)
- Repo: `https://github.com/dwill6413/aria-demo`

---

## 2. What Is Already Built and Deployed

- Google OAuth → zkLogin, Postgres-backed sessions, JWT verification
- Server-side pricing from `catalog.mjs`
- AI agent (Grok) with server-derived role, per-tool authorization
- Booking CRUD — REST + AI paths
- **On-chain escrow** — `BookingEscrow` shared object created at booking confirmation
- Walrus immutable receipts (booking + cancellation + deposit release)
- Resend email, Stripe fallback, iCal sync
- Host dashboard (bookings, revenue, tax, applications, reviews)
- Mobile-responsive nav with hamburger menu (all 4 pages)
- 10-table Postgres schema with indexes including `escrow_object_id`
- Full wallet address visible + copy button on all pages (`index.jsx`, `host.jsx`, `bookings.jsx`)
- `extractCreatedObjectId()` extracted as named function with 15 unit tests (`escrow.test.mjs`)

---

## 3. Roadmap

### ✅ PHASE 1 — Security Deposit Smart Contract
**Status: COMPLETE — deployed and verified end-to-end on June 10, 2026**

#### Deployed contract details
| Item | Value |
|---|---|
| Package ID | `0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe` |
| Module | `escrow` |
| Network | Sui testnet |
| UpgradeCap | `0x41f043cf28d0bb77ef6031c5208b611bdd673992afa9e27763b41033e4a327eb` |
| Deployer | `0x24bd37a7d13a78de81bd5345899da8b7a4d41ebf26fc1af6f934f9841c7d97f3` |
| Coin type | `0x2::sui::SUI` (testnet) → SuiUSD mainnet (generic `Coin<T>`, no code change) |

#### Transaction signing pattern (current — P0a complete)
`SuiGrpcClient` + `keypair.signAndExecuteTransaction()`. `suiRpc()` and all
raw JSON-RPC fetch helpers have been removed. See `createEscrowOnChain` and
`autoReleaseEscrow` in `server.mjs` for the full implementation.

Key detail: use `extractCreatedObjectId(changedObjects)` (defined in `server.mjs`,
tested in `escrow.test.mjs`) to extract a newly-created shared object's ID from
any PTB result. Takes the **last** "Created" entry — the split-coin ephemeral
entry always comes first, the real object always comes last.

#### Phase 1 pending items

**P0a — Migrate off JSON-RPC — ✅ COMPLETE (June 12, 2026)**

**P0b — Guest-funded escrow (most important non-custodial gap) — ✅ COMPLETE (June 16, 2026)**

The guest's own zkLogin wallet now signs `create_escrow` and provides the deposit
coin from their own balance. ARIA's backend builds the unsigned PTB but never
funds or signs the escrow-creation transaction — it only re-verifies on-chain
after the fact. Live-tested end-to-end on testnet (Railway + Vercel): a real
booking went through with the guest signing in-browser, submitting directly to
a public Sui fullnode, and the backend independently confirming the resulting
`BookingEscrow` object before writing `deposit_status = 'held'` to Postgres.
Confirmed visually via the bookings page ("confirmed" + "Deposit $661 held").

**Prerequisite gap found and fixed (June 16, 2026):** the ephemeral keypair, nonce,
and randomness needed to produce a zkLogin signature were generated server-side in
`auth.mjs:getZkLoginUrl`, round-tripped through the OAuth `state` param, and
discarded after the callback ran. Nothing — frontend or backend — retained the
material needed to sign anything as the guest's address after login. Fixed by:
- New `lib/zklogin.js` (frontend): generates the ephemeral keypair + nonce
  client-side (`beginZkLogin`), fetches and caches the ZK proof from the prover
  service after the OAuth callback (`completeZkLogin`), and exposes
  `signTransactionWithZkLogin()` for use once the unsigned-PTB work below lands.
  Material lives in `sessionStorage`, never sent to the backend.
- `auth.mjs`: `getZkLoginUrl` removed. `handleZkLoginCallback` now takes
  `{id_token, nonce}` from a POST body (nonce generated client-side) instead of
  decoding a server-issued state blob, and returns `{sid, address, email, name,
  picture}` directly instead of redirecting.
- `server.mjs`: `/auth/zklogin/init` route removed. `/auth/zklogin/callback` is
  now POST.
- `pages/index.jsx`: `handleLogin` builds the Google OAuth URL client-side
  (needs `NEXT_PUBLIC_GOOGLE_CLIENT_ID` and optionally
  `NEXT_PUBLIC_GOOGLE_CALLBACK_URL` in Vercel) instead of calling the backend
  for it.
- `pages/auth/zklogin/callback.jsx`: calls `completeZkLogin` then POSTs to the
  new callback endpoint.

**What shipped (both-sides change):**
- **Backend (`server.mjs`)**: `createEscrowOnChain`/`buildEscrowTransaction` no
  longer funds the escrow. It builds the unsigned transaction (`tx.setSender(guestAddr)`)
  and returns it to the frontend. The backend signer (now `ARIA_AUTO_RELEASE_KEY`,
  see P1b below) is scoped to just `auto_release` (see the comment block above
  `autoReleaseEscrow` in `escrow.mjs` for why that's still safe — it never moves
  a deployer-owned coin, only triggers the contract's own release logic).
- **Frontend (`lib/zklogin.js` + `pages/index.jsx`)**: `handleEscrowSign()` receives
  the unsigned PTB, signs it via `signTransactionWithZkLogin()`, and submits
  directly to a public Sui fullnode via `submitSignedTransaction()` — never
  routed through ARIA's backend, to keep the design maximally non-custodial —
  then reports `{bookingRef, digest}` to `/booking/:bookingRef/escrow/confirm`.
- **Backend verification (`verifyEscrowTransaction`)**: before writing
  `escrow_object_id` and flipping `deposit_status`, the backend re-queries the
  chain to confirm the reported transaction produced a real `BookingEscrow`
  with matching booking_ref/guest/host/amount — it never trusts the frontend's
  digest blindly. This matters because host tax records
  (`/tax/summary`, `tax_remittances`) join against `bookings`, and those numbers
  need to stay trustworthy even though pricing/tax itself is computed
  server-side and unaffected by who signs the escrow tx.

Scope decisions (locked):
- SuiUSD only — not multi-coin/USDC. Multi-coin support deferred indefinitely.
- Guest approves transaction in browser; expiry timestamp shown before signing.
- ARIA backend orchestrates but does not provide the coin.

**P1 — Key separation (before mainnet) — ✅ DONE (June 17, 2026)**

*P1a — arbitrator portion (June 12, 2026):*
- Dedicated arbitrator keypair generated. Mnemonic in KeePass only.
- Public address: `0x0069868f93f9127b3e8b51bf95bc529925ca382e6305da0bb01f693826b983f8`
- Set as `ARIA_ARBITRATOR_ADDRESS` in Railway. Confirmed on-chain.
- `*.key` files added to `.gitignore`.

*P1b — deployer/backend-signer separation (June 17, 2026):*
- Code renamed `ARIA_DEPLOYER_KEY` → `ARIA_AUTO_RELEASE_KEY` and
  `deployerKeypair` → `autoReleaseKeypair` throughout (`escrow.mjs`,
  `bookings.mjs`; `server.mjs` had an unused import, removed outright).
- While doing this, found and corrected an inaccurate comment: `auto_release`
  in `escrow.move` has **no on-chain sender check at all** (its own doc
  comment says "Callable by anyone") — unlike `resolve_dispute`, which does
  assert `tx_context::sender == escrow.arbitrator`. An older comment in
  `escrow.mjs` conflated the two and implied auto_release required the
  arbitrator address; it didn't. Practical upshot: the new auto-release key
  carries **zero on-chain privilege** — it only needs to exist and hold gas —
  which is exactly why a freshly generated, narrowly-scoped key is sufficient
  and safe here.
- Also removed `buildEscrowTransaction`'s old fallback that used the backend
  signer's own address as `arbitrator` if `ARIA_ARBITRATOR_ADDRESS` were ever
  unset. That fallback predated P1a and was stale/risky: it could have handed
  arbitrator authority (`resolve_dispute` rights) to the now-low-privilege
  auto-release key. Falls back to `hostAddr` instead.
- A fresh keypair was generated for `ARIA_AUTO_RELEASE_KEY`. **Manual steps
  required (not done by the agent — no Railway/faucet access from the
  sandbox):** set the new secret as `ARIA_AUTO_RELEASE_KEY` in Railway, fund
  the new address with testnet SUI (sandbox network blocks the faucet
  domain), remove `ARIA_DEPLOYER_KEY` from Railway, move the original
  deployer/UpgradeCap key to cold KeePass-only storage if not already there.

*Custody model — assign by blast radius:*
- **Deployer / UpgradeCap key**: cold KeePass only, regardless of scale. Never in Railway.
- **Backend signer** (`ARIA_AUTO_RELEASE_KEY`): Railway env var, scoped to `auto_release` only — and `auto_release` itself is permissionless on-chain, so this key has no special authority even if compromised. Worst case is gas-fee griefing, not fund loss.
- **Arbitrator key**: cold KeePass, manual signing. Bounded blast radius by contract
  design (`resolve_dispute` can only split one disputed escrow between its guest/host).

*Arbitration scaling path (designed now, built when volume justifies):*
1. **Now**: KeePass-held, manual signing.
2. **At scale**: scoped dispute-resolution service key, only executes approved resolutions.
3. **Cohort arbitrators**: `arbitrator` is per-escrow, so different cohorts can use
   different addresses with zero migration of existing escrows.

**P2 — Auto-release cron job — ✅ DONE (June 17, 2026)**
`runAutoReleaseSweep()` in `server.mjs` queries bookings where
`check_out + INTERVAL '5 days' < NOW()` and `deposit_status = 'held'` and
`escrow_object_id IS NOT NULL`, then calls `autoReleaseEscrow()` on each and
flips `deposit_status` to `released` on success. Wired via `setInterval`
(default hourly, `AUTO_RELEASE_SWEEP_INTERVAL_MS` env override) plus a
30-second startup `setTimeout` so it also runs once shortly after boot.

**P2 — Production host address lookup — ✅ DONE (June 17, 2026)**
Added `getPropertyHostAddress(propertyId, logger)` in `bookings.mjs`. Looks up
`PROPERTIES[propertyId].hostAddress` (new field in `catalog.mjs`, since the
`properties` table is empty/unused — see tech debt backlog), then prefers
`host_profiles.payout_sui_address` for that host if set, falling back to the
configured address, falling back further to `autoReleaseKeypair.toSuiAddress()`
if no host is configured yet for that property (current state for all 6 demo
properties). `createBooking` now calls this and persists the resolved address
to the new `bookings.host_sui_address` column.

**P2 — Claim/dispute backend routes — ✅ DONE (June 17, 2026)**
Contract functions `claim_damage`, `dispute_claim`, `resolve_dispute` are now
wired end-to-end using the same non-custodial build/sign/verify pattern as
escrow creation:
- `/booking/claim-damage` (host) + `/booking/claim-damage/confirm` — builds an
  unsigned `claim_damage` PTB for the host to sign, then verifies the resulting
  digest mutated the expected escrow before setting `deposit_status='claimed'`.
- `/booking/dispute-claim` (guest) + `/booking/dispute-claim/confirm` — same
  pattern for `dispute_claim`, sets `deposit_status='disputed'`.
- `/booking/resolve-dispute` (superadmin/arbitrator-gated) — calls the new
  `resolveDisputeEscrow()`, which signs with the dedicated `ARIA_ARBITRATOR_KEY`
  (see P1a) and calls `resolve_dispute` with the validated guest/host split
  (`guestAmount + hostAmount` must equal the deposit). Sets `deposit_status` to
  `forfeited` (guestAmount === 0) or `released` otherwise.
- `escrow.mjs` gained `buildClaimDamageTransaction`, `buildDisputeClaimTransaction`,
  `isObjectMutated`, the shared `verifyEscrowMutation` helper, and public
  wrappers `verifyClaimDamageTransaction`/`verifyDisputeClaimTransaction`.
- `db.mjs` added 9 new `bookings` columns: `host_sui_address`, `claim_amount`,
  `claim_reason`, `claimed_at`, `dispute_reason`, `disputed_at`,
  `resolved_guest_amount`, `resolved_host_amount`, `resolved_at`.
- `validation.mjs` added 5 new zod schemas for the routes above.
- `/booking/release-deposit` now guards against `['claimed','disputed','forfeited']`
  status so it can't double-release a deposit that's mid-claim-flow.
- 18 new unit tests added to `escrow.test.mjs` covering `isObjectMutated`,
  `verifyClaimDamageTransaction`, `verifyDisputeClaimTransaction` (33 total,
  all passing).
- Automating `resolve_dispute` requires a key the backend can actually load
  and sign with — the P1a arbitrator address was documented as cold-KeePass,
  manual-signing-only, so a new operational `ARIA_ARBITRATOR_KEY` was
  generated and funded with testnet SUI via the faucet this session. This
  effectively brings forward step 2 of the "arbitration scaling path" in the
  P1 section above. **Manual step complete (June 17, 2026):** `ARIA_ARBITRATOR_KEY`
  and `ARIA_ARBITRATOR_ADDRESS` (Section 8) are now set in Railway — the
  private key was delivered to the operator via chat only, never committed to
  any file, per this doc's own rule (Section 7), and confirmed set by the
  operator directly in the Railway dashboard. Any escrow created before this
  Railway update used the old P1a address as `arbitrator` on-chain and can
  only be resolved with that original cold key; this is a non-issue for fresh
  testnet bookings going forward.

**P3 — Minor contract cleanup (code done and live on-chain — June 17, 2026)**
- [x] Removed the unused `STATUS_RESOLVED` constant from `escrow.move`
  (resolve_dispute deletes the object, so this status value was never actually
  set). The `status_resolved()` accessor had to stay — Sui's package upgrade
  rules forbid removing a public function from an already-deployed package
  under any upgrade policy, even the default "compatible" one. It now returns
  a hardcoded `4` instead of referencing the removed constant; functionally
  unchanged, just no longer backed by a named constant.
- [x] Added a 30-day expiry upper bound: new `MAX_EXPIRY_MS` constant
  (`2_592_000_000`), new `EExpiryTooFar` error code, and an assertion in
  `create_escrow` (`expiry_ms <= now + MAX_EXPIRY_MS`). Added `max_expiry_ms()`
  accessor and two new tests (`test_create_with_expiry_too_far_fails`,
  `test_create_with_expiry_at_max_boundary_succeeds`).
- [x] **Live on-chain.** Published as upgrade transaction `JCA8daJ9mSByY6x51ZhEc6Ubfrv1LEbf3nsVccEFtJZK`,
  signed by the deployer's cold `UpgradeCap` key (Section 8, key #1). New
  package: `0x98e712692f22f308bb6d097d2d8a2743ed0c01058135d71436b4abcd34264f26`
  (version 2). Original package ID `0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe`
  remains the type-defining ID for existing `BookingEscrow` objects — that
  never changes on upgrade, only the module bytecode does. **Fully deployed.**
  `ESCROW_PACKAGE_ID` updated in Railway and redeployed (confirmed June 17,
  2026, 3:05 PM CDT via deploy logs — both keypairs load correctly, server up
  clean). New `create_escrow` calls now get the 30-day expiry cap; existing
  claim/dispute/auto-release calls on already-created escrows are unaffected
  either way.
- First upgrade attempt failed: Sui's "compatible" upgrade policy (the
  default, and the most permissive available) forbids removing any public
  function from an already-deployed package — `status_resolved()` had to be
  restored (now hardcoded to return `4` instead of referencing the removed
  constant) before the upgrade would succeed.

**Pre-mainnet gate**
- [x] P0a complete (June 12, 2026 — JSON-RPC migration, ahead of Jul 31 deadline)
- [x] P0b complete (June 16, 2026 — guest-funded escrow, live-tested end-to-end)
- [x] P1a complete (arbitrator key separated, wired, on-chain)
- [x] P1b complete (June 17, 2026 — deployer/backend-signer separated; new key needs Railway/faucet setup, see P1 section above)
- [x] P2 complete (June 17, 2026 — auto-release cron, production host lookup, claim/dispute routes; `ARIA_ARBITRATOR_KEY`/`ARIA_ARBITRATOR_ADDRESS` set in Railway, see P2 section above)
- [x] P3 complete (June 17, 2026 — contract upgrade published on-chain and fully deployed, package v2 at `0x98e712...4264f26`; `ESCROW_PACKAGE_ID` in Railway updated and redeployed, see P3 section above)
- [x] Second code review + fixes complete (June 18, 2026 — 8 findings, see `ARIA_CODE_AUDIT.md` "Second Review"; backend 39/39, Move 28/28)
- [x] Contract **v3** published (June 18, 2026 — `finalize_claim` deadlock fix, `0xec0d6bd4…644d8fa1`; Railway `ESCROW_PACKAGE_ID` updated + redeployed clean)
- [ ] Independent Move audit (OtterSec, Zellic, or similar)
- [ ] Burn UpgradeCap after audit
- [ ] **Fee collection/routing** — design complete (`ARIA_FEE_DESIGN.md` v2.0), build pending; ships with the v4 contract upgrade (top remaining build item; see Tech Debt)
- [ ] In-browser smoke test of the migrated gRPC submit path (`lib/zklogin.js`)
- [ ] Add ARIA-side audit logging for Seal PII decrypt requests before any
  real (non-demo) guest PII flows through Phase 2 — see Seal compliance note
  in Phase 2 above

---

### PHASE 2 — Guest PII with Walrus + Seal
**Priority: High. Required before onboarding real users with real PII (see
compliance note below — testnet work here uses fake/demo data only).**

#### Architecture — REVISED June 17, 2026 against verified Seal mechanics
The original placeholder architecture (a standalone `pii_access.move` module
with a `GuestPIIAccess{allowed_hosts: vector<address>}` object and manual
`grant_access`/`revoke_access` calls) was checked against Seal's actual SDK
behavior and found structurally wrong in three ways — it was missing the
mandatory `seal_approve*` gate function that key servers actually call (not
arbitrary "grant/revoke" functions), missing the client-side `SessionKey`
requirement, and missing any key-server/threshold configuration. Verified,
corrected design below.

**No separate Move module needed.** Add a single new function directly to the
existing, already-deployed `escrow.move`, via a normal package upgrade (this
will be **v4** — v3 was consumed June 18, 2026 by the `finalize_claim`
deadlock fix; the current on-chain package is `0xec0d6bd4…644d8fa1`):
```move
/// Called by Seal key servers (via dry-run, never an actual transaction) to
/// authorize decrypting a guest's PII blob. id's bytes must encode the
/// escrow's guest address; only that booking's host may decrypt.
entry fun seal_approve<T>(id: vector<u8>, escrow: &BookingEscrow<T>, ctx: &TxContext) {
    assert!(/* id corresponds to escrow.guest */, ENotGuest);
    assert!(tx_context::sender(ctx) == escrow.host, ENotHost);
}
```
This is valid because Seal's identity namespace (`[PkgId]*`) is anchored to a
package's **original/first-published ID forever** — confirmed from Seal's
key-server source (`fetch_first_pkg_id`) — while the actual `seal_approve`
call at decrypt time targets whatever package address is current. A function
added in a later upgrade is callable normally; nothing requires isolating
access-control logic into its own package (Seal's own reference patterns mix
allowlist logic with feature state in one module).

**Access lifecycle becomes fully automatic — no revoke call, no atomicity
requirement.** `auto_release`, `accept_claim`, and `resolve_dispute` already
call `object::delete(id)` on the `BookingEscrow` when they finalize. Since
Seal's key servers resolve object references to "current on-chain state" on
every dry-run, a deleted object can't be referenced — decryption access
disappears the instant the escrow object does, for free:
```
Booking confirmed    → BookingEscrow exists, escrow.host == this host → access live
During stay / window → object still exists → access live
Dispute active        → object still exists (deleted only on resolve_dispute) → access live
Deposit finalized      → auto_release/accept_claim/resolve_dispute delete the
                       object → seal_approve can no longer be satisfied → access gone
```
This eliminates the old plan's "same PTB" requirement and the entire
`revoke_access` build item — there is nothing to call.

**SessionKey requirement (missing from original plan, mandatory per Seal
docs).** Being on-chain-authorized is not sufficient — each host must also
create and sign a time-limited `SessionKey` with their wallet
(`SessionKey.create({address, packageId, ttlMin, suiClient})` →
`getPersonalMessage()` → `signPersonalMessage()` →
`setPersonalMessageSignature()`) before any `decrypt()`/`fetchKeys()` call
will succeed. One signature, then a TTL window of decrypts without re-signing.
Needs handling in the host UI (Phase 2h below).

**Key-server / threshold configuration (missing from original plan, required
client-side decision).** Testnet: Mysten's `mysten-testnet-1`
(`0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75`),
`mysten-testnet-2`
(`0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8`), and/or
the decentralized committee aggregator
(`https://seal-aggregator-testnet.mystenlabs.com`, object
`0xb012378c9f3799fb5b1a7083da74a4069e3c3f1c93de0b27212a5799ce1e1e98`) — no
self-hosted key server needed. **Mainnet has no free Mysten-run Open server**
— will need a paid/third-party provider (Ruby Nodes, NodeInfra, Studio Mirai,
Enoki, etc.) or to run one; pick and budget this before going live.

**Compliance note.** Seal's own docs state it isn't intended for regulated
PII/PHI as currently scoped — key delivery isn't logged on-chain (no audit
trail), testnet servers carry no SLA, and third-party key servers see decrypt
requests (not the underlying plaintext). Decision (June 17, 2026): build the
real architecture now since testnet carries no real guest data; before real
PII flows through this path at mainnet, add ARIA-side audit logging (log every
successful decrypt dry-run / `/host/guest-identity` fetch in Postgres) and
revisit. Tracked as a pre-mainnet gate item alongside the Move audit and
UpgradeCap burn (see Pre-mainnet gate below).

#### Database change (unchanged from original plan, minus the dropped object-ID column)
```sql
CREATE TABLE IF NOT EXISTS guest_verifications (
    sui_address    TEXT PRIMARY KEY,
    walrus_blob_id TEXT NOT NULL,
    phone_verified BOOLEAN DEFAULT false,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);
```
No PII columns, just a pointer. `pii_object_id` dropped — there's no separate
on-chain PII object anymore; `seal_approve` reads the existing `BookingEscrow`.

#### New routes
```
POST /guest/profile                     — store { walrus_blob_id }
GET  /guest/profile                     — return { verified, walrus_blob_id }
GET  /host/guest-identity/:bookingRef   — return { blob_id, escrow_object_id }
                                           for the host to build the
                                           seal_approve PTB and decrypt client-side
```

#### Booking gate (unchanged)
```javascript
const v = await pool.query('SELECT 1 FROM guest_verifications WHERE sui_address=$1', [session.suiAddress]);
if (!v.rows.length) return reply.code(400).send({ error: 'Complete identity verification first' });
```

#### No new env var
No `SEAL_PACKAGE_ID` — Seal's identity namespace uses `escrow.move`'s existing
original package ID (`0x538262...7fdbe`); no separate contract deployment.

---

### ✅ PHASE 3 — 5-Day Inspection Window Business Logic
**Status: COMPLETE (June 17, 2026) — delivered as part of P2 above.**

1. **Timing gate** — ✅ `/booking/release-deposit` rejects release before `check_out`.

2. **Auto-release job** — ✅ `runAutoReleaseSweep()` in `server.mjs`.

3. **Claim route — `/booking/claim-damage`** — ✅ host-only, validates ownership +
   checkout-passed + claim ≤ deposit, builds unsigned `claim_damage` PTB,
   `/confirm` route verifies on-chain mutation before setting
   `deposit_status = 'claimed'`, emails guest.

4. **Dispute route — `/booking/dispute-claim`** — ✅ guest-only, builds unsigned
   `dispute_claim` PTB, `/confirm` verifies on-chain mutation before setting
   `deposit_status = 'disputed'`, notifies ARIA admin. `/booking/resolve-dispute`
   (superadmin-gated) signs with `ARIA_ARBITRATOR_KEY` and calls `resolve_dispute`
   with the validated split.

5. **Extend `deposit_status`** — ✅ `held` | `released` | `claimed` | `disputed` | `forfeited`

---

## 4. Build Order

```
✅ Phase 1a: escrow.move + 23 tests
✅ Phase 1b: Deploy to testnet (Package ID above)
✅ Phase 1c: escrow_object_id column in db.mjs
✅ Phase 1d: /booking/create → create_escrow on-chain
✅ Phase 1e: /booking/release-deposit → auto_release on-chain
✅ Phase 1f1: P0a — Migrate off JSON-RPC to gRPC (done June 12, 2026)
✅ Phase 1f1.5: extractCreatedObjectId extracted + 15 unit tests (done June 15, 2026)
✅ Phase 1f1.6: Wallet address full visibility + copy button (done June 15, 2026)
✅ Phase 1f2: P0b — Guest wallet funds escrow (done June 16, 2026)
✅ Phase 1g2: P1b — Deployer/backend-signer separation (done June 17, 2026)
✅ Phase 1h: P2 — Auto-release cron job (done June 17, 2026)
✅ Phase 1h.5: Fee collection/routing mechanism — built and live; see the
   fuller entry below (this line previously duplicated it as still-pending —
   stale, corrected June 30, 2026).
✅ Phase 1i: P2 — Production host address lookup (done June 17, 2026)
✅ Phase 1j: P2 — Claim/dispute backend routes (done June 17, 2026)
✅ Phase 1k: P3 — STATUS_RESOLVED removed + 30-day expiry bound added, upgrade
   published on-chain and fully deployed (June 17, 2026, package v2 at
   0x98e712...4264f26); Railway ESCROW_PACKAGE_ID updated and redeployed
✅ Phase 1L: Second code review + fixes (June 18, 2026 — 8 findings, see
   ARIA_CODE_AUDIT.md "Second Review"): hardened verifyEscrowTransaction (re-reads
   object type/amount/host/ref), frontend lib/zklogin.js migrated off JSON-RPC to
   gRPC, atomic booking insert (silent-confirmed + double-booking race),
   unified releaseDepositForBooking() across REST + AI, DEMO_HOST_ADDRESS config.
   Backend 39/39, Move 28/28.
✅ Phase 1m: Contract v3 — finalize_claim (CLAIMED-deadlock fix) published on-chain
   (June 18, 2026, package v3 at 0xec0d6bd4...644d8fa1); Railway ESCROW_PACKAGE_ID
   updated to v3 and redeployed clean. NOTE: this consumed the "v3" upgrade slot —
   Phase 2a's seal_approve will be the NEXT upgrade (package v4).
🟨 Phase 1h.5: Fee collection/routing — BACKEND + CONTRACT BUILT June 23, 2026
   (ARIA_FEE_DESIGN.md §14). BookingPaymentEscrow + create_payment_escrow/
   release_payment/refund_payment/refund_deposit in escrow.move (+12 Move tests);
   escrow.mjs build/verify/release/refund; combined booking PTB; two-escrow
   confirm + runCheckInReleaseSweep cron + refund-on-cancel; db columns + unique
   settlement_digest; +14 JS tests. Frontend done (index.jsx review-then-sign
   disclosure + ai.jsx chat disclosure + ai_route.mjs field forwarding).
   Tax-routing corrected June 30, 2026: tax leg now routes to the host (rides
   with the rental subtotal) instead of a separate ARIA-controlled
   ARIA_TAX_REMITTANCE_ADDRESS wallet (retired) — ARIA only ever receives its
   5% fee. **Two destination wallets, not three:** the contract still tracks
   host_amount/aria_amount/tax_amount as three separate line items for
   auditability, but tax_addr == hostAddr now, so funds actually land in only
   two wallets at release — host (subtotal + tax) and ARIA (fee). LIVE since
   June 23 (ARIA_FEE_ADDRESS set, both suites passing, v4 published) — re-run
   `node escrow.test.mjs` after the June 30 fix.
🟨 Phase 2a: seal_approve() added to escrow.move (June 23, 2026) — CODE DONE,
   +3 Move tests. `public entry fun seal_approve<T>(id, escrow, ctx)` asserts
   id == address::to_bytes(escrow.guest) AND sender == escrow.host. Still needs
   the v4 publish, which now ships seal_approve AND the Phase 1h.5 fee functions
   in ONE upgrade (package v4) via the cold UpgradeCap key.
🟨 Phase 2b: testnet key servers + threshold CHOSEN (lib/seal.js): both Mysten
   testnet servers, threshold 2-of-2 (drop to 1 for availability). Mainnet needs
   a paid/third-party key-server provider — still open.
✅ Phase 2c: guest_verifications table in db.mjs (June 23, 2026)
✅ Phase 2d: /guest/profile (POST/GET) + /host/guest-identity/:bookingRef routes (June 23, 2026)
✅ Phase 2e: Booking gate in createBooking() — both REST + AI paths, behind
   REQUIRE_GUEST_VERIFICATION env flag (dormant until turned on) (June 23, 2026)
✅ Phase 2f: hasGuestProfile in /auth/me (June 23, 2026)
✅ Phase 2g: pages/profile.jsx — Seal encrypt + Walrus store (June 23, 2026; lib/seal.js encryptAndStorePII)
✅ Phase 2h: pages/host.jsx "View Guest Identity" modal — SessionKey sign +
   seal_approve PTB + decrypt (June 23, 2026; lib/seal.js fetchAndDecryptPII,
   lib/zklogin.js signPersonalMessageWithZkLogin)
(Phase 2i eliminated — access revocation is automatic via escrow object
 deletion in auto_release/accept_claim/resolve_dispute; nothing to wire.)

   Phase 2 OPEN ITEMS (operator/env, not code): (1) `pnpm add @mysten/seal`
   (frontend dep, not yet installed); (2) the v4 on-chain publish (bundles
   seal_approve + fee functions), then set NEXT_PUBLIC_ESCROW_PACKAGE_ID to the
   v4 id so the seal_approve CALL targets the right package; (3) in-browser smoke
   test of the whole Seal flow incl. zkLogin SessionKey personal-message signing
   (untested — only exercised here); (4) flip REQUIRE_GUEST_VERIFICATION=true once
   the profile UI is live; (5) mainnet key-server provider + decrypt audit logging.

⬜ Phase 3: 5-day timing gate + auto-release job + claim/dispute flows
```

---

## 5. Tech Debt Backlog

| Item | Priority | Notes |
|---|---|---|
| Key separation | **Done** | P1a/P1b/P2 all complete — deployer, auto-release, and arbitrator keys are now three separate, appropriately-scoped keypairs. |
| Fee collection/routing mechanism | **✅ Done, live since June 23, 2026** | Built per `ARIA_FEE_DESIGN.md` v2.1. Non-custodial hold-and-release: `BookingPaymentEscrow` (`create_payment_escrow` in `escrow.move`) holds rental+fee+tax at booking (same guest-signed PTB as the deposit escrow), released via `release_payment` at check-in (auto-release key) or refunded via `refund_payment` on pre-check-in cancellation (arbitrator key). Wired into `bookings.mjs`/`server.mjs` via `buildBookingPaymentTransaction`. Shipped in the v4 contract publish alongside Phase 2a's `seal_approve`. ARIA fee raised to 5% (`6fca213`); tax-leg routing corrected June 30, 2026 to ride with the host's subtotal instead of a separate remittance wallet (`9d40a05`/`0eea17a`, confirmed pushed). SuiUSD path only; Stripe Connect still deferred. |
| Auto-release job | **Done** | Phase 1h — `runAutoReleaseSweep()` in `server.mjs`, hourly + 30s-after-boot |
| Production host address | **Done** | Phase 1i — `getPropertyHostAddress()` in `bookings.mjs`; `catalog.mjs` still needs real per-property `hostAddress` values set once hosts are onboarded |
| Claim/dispute routes | **Done** | Phase 1j — `/booking/claim-damage`, `/booking/dispute-claim`, `/booking/resolve-dispute` |
| Host onboarding (real hosts add their own listings) | **✅ Done, live** — corrected June 30, 2026, this row previously said "Medium, not built" which was stale. Shipped in `83bd6fe` ("Host onboarding - 4-step form, apply/approve routes, DB host profiles"), confirmed on `origin/main`: `host_profiles` table, apply/approve workflow (`POST` apply → `status='pending'` → admin approves → `status='approved'`, email at each step), `POST /host/properties` (create), `PATCH /host/properties/:id` (edit) + `/:id/deactivate`. `getPropertyHostAddress()` resolves per-property via `host_profiles.payout_sui_address`. `properties` table is **not** empty — at least one real host-created listing exists ("Pool Oasis", the one involved in the id-collision bug). Remaining gap: the 6 *original* hardcoded `catalog.mjs` demo properties still carry `hostAddress: null` and aren't migrated to real host owners — that's the only thing still gated behind `DEMO_HOST_ADDRESS`. **Design risk CLOSED June 30, 2026 (policy decision):** previously, a host could set `payout_sui_address` to a receive-only address different from their own signing wallet, which would silently lock them out of `claim_damage`/`seal_approve` (both assert `sender == escrow.host` on-chain). Decision: one host = one address, no exceptions — a host can move funds out of their ARIA wallet anywhere they like, but ARIA itself never pays into, or treats as authoritative, any address other than the host's own `session.suiAddress`. Implemented by removing `payoutSuiAddress` as a client-writable field entirely: `validation.mjs`'s `hostApplySchema` no longer accepts it, `server.mjs`'s `/host/apply` route always writes `session.suiAddress` into the `payout_sui_address` column regardless of request body, and `pages/become-host.jsx`'s Payout step now renders the address as a disabled, read-only field with a hint explaining why it can't be changed. The `payout_sui_address` DB column name is unchanged (no migration needed) — it's just now guaranteed to always equal `sui_address`. |
| **Unsigned-booking trap (UX, found June 23, 2026 via QA)** | **Done** — both fixes shipped | A booking is created (`payment_status='confirmed'`) BEFORE the guest signs the escrow PTB; the "Approve & sign" panel was ephemeral homepage-modal state, so navigating away stranded the booking (no escrow, but it still blocks the dates). **✅ Fix #1 (June 23):** resume-signing — `POST /booking/:ref/escrow/rebuild` (guest-owned, `deposit_status='pending'`; recomputes host + a fresh `release_time` and rebuilds the combined PTB via `buildBookingPaymentTransaction`) + a "✍️ Complete payment & sign" button on My Bookings (`pages/bookings.jsx`). **✅ Fix #2 (June 30):** `runAbandonedBookingSweep()` in `server.mjs` — every 5 min, auto-cancels bookings still `confirmed`/`pending`/un-escrowed past a 15-min TTL (`ABANDONED_BOOKING_TTL_MS`), freeing the dates and emailing the guest. Same cron pattern as the existing sweeps; backed by a new partial index `idx_bookings_abandoned_sweep` (`db.mjs`). |
| Frontend tax/price duplication | Low | `catalog.mjs` centralizes backend |
| Stripe webhooks | Medium | Create-intent only |
| No automated tests | Medium | Backend unit tests in `escrow.test.mjs` — **78 passing** (incl. resale verifier + `isObjectMutated` gRPC-shape tests). Move suite **52 tests** (incl. 8 resale cases). **No frontend tests** — and the resale UI (list/cancel/buy/market modal in `bookings.jsx`, host toggle in `host.jsx`, ID `idState` field in `profile.jsx`) is entirely unverified by automated tests; route-level tests would require the `server.mjs` split below. |
| `zod` | **Done** | Adopted in `validation.mjs` |
| Legacy `hosts` table | Low | Unused; drop it |
| **`server.mjs` modularization (REFACTOR)** | Medium — flagged by external review June 25, 2026 | `server.mjs` is now **~2,100 lines** (grew with the Phase 2c resale routes). Split route handlers into Fastify plugins (`routes/bookings.mjs`, `routes/resale.mjs`, `routes/auth.mjs`, `routes/host.mjs`, etc.) and move the large inline HTML email strings into a `templates/` dir. Pure refactor — zero behavior change — but it (a) makes the file maintainable and (b) is the prerequisite for **route-level unit tests** (currently impossible because everything is one monolith). Not a mainnet blocker; do before the codebase grows further. |
| **Auto-release wallet gas hygiene (MAINNET OPS)** | Medium — flagged by external review June 25, 2026 | The auto-release key (`ARIA_AUTO_RELEASE_KEY`) has **zero on-chain privilege** (the permissionless calls have no sender assert — confirmed in `ARIA_KEY_INVENTORY.md` #2), so a compromise can't drain user escrows. The residual risk is purely operational: keep only a **nominal SUI balance** in that wallet (enough for sweeps) and set up **balance/low-gas alerts** so a depleted gas tank doesn't silently stall the auto-release / check-in sweeps. No code change. |
| `@anthropic-ai/sdk` | **Done (removed)** | June 18, 2026 — removed from package.json/lockfile; `ANTHROPIC_API_KEY` deleted from Railway and `.env`. Was never imported. |
| Frontend gRPC migration | **Done** | June 18, 2026 — `lib/zklogin.js` epoch + submit now via `SuiGrpcClient` (off JSON-RPC, July 31 sunset). Needs in-browser smoke test. |
| Claim/dispute exercisable on demo properties | Medium | All `catalog.mjs` `hostAddress` are `null` → escrow host = `DEMO_HOST_ADDRESS` (if set) else auto-release key. Set `DEMO_HOST_ADDRESS` in Railway to test the flow end-to-end. |
| **Properties id-namespace collision (found + fixed June 29, 2026; data fix added later same day)** | ✅ Fixed, pushed (`f352bea`/`81c3aef`/`8cb6d31`) | `properties` table's `SERIAL` id starts at 1, same space as `catalog.mjs`'s 6 fixed demo ids — first host-created listing ("Pool Oasis", id=1) collided with Oceanfront Villa. Display-field fix: `GET /properties` returns `source` ('catalog'\|'db'); `host.jsx`/`index.jsx` merges key off it. Forward-only fix: `db.mjs` bumps `properties_id_seq` to `≥1000` on boot. **Found the deeper consequence June 29 (later):** because `catalog.mjs`'s `getProperty()` always resolves ids 1-6 to the fixed catalog FIRST, the existing colliding "Pool Oasis" row (still stuck at id=1) was permanently unbookable as itself — clicking it sent `propertyId=1`, which the server always resolved to the Oceanfront Villa, silently booking and charging for the Villa instead (Villa's price/tax, not Pool Oasis's — this is also what caused the "Book Now $410 vs $403 signed total" mismatch the user saw, since the pre-click client estimate used Pool Oasis's own price/tax while the actual booking used the Villa's). Data fix added: `db.mjs` now re-`id`s any existing row stuck at `id <= 6` to a fresh `≥1000` id on every boot. **Known limitation:** any bookings already made against a colliding row before this fix are indistinguishable from genuine Villa bookings (no FK, recorded identically) and can't be retroactively reattributed. **Not yet verified:** whether the BOOKINGS/REVENUE stats filter (`host.jsx` ~line 822, `activeBookings.filter(b => b.propertyId === p.id)`) also needs a `source` guard. Re-check next session. |
| Host listing edit/delete (shipped June 29, 2026) | ✅ Done, pushed (`81c3aef`) | `PATCH /host/properties/:id` + `/:id/deactivate` added; `host.jsx` Edit/Remove buttons on `source==='db'` cards. No "undo deactivate" UI yet (DB still has the row, `active=false` — a manual SQL flip works if ever needed). |
| **Catalog/DB parity audit — 4 gaps closed (June 29, 2026)** | **✅ Done, pushed (`0629c4b`/`5372d76`/`264b4b6`)** | Direct ask: host-imported listings must inherit all functionality of the 6 hardcoded catalog properties. (1) Tax jurisdiction hardcoded to `JURISDICTION_TAX_RATES[id]` at 6 call sites (`server.mjs` ×5, `ai_route.mjs` ×1) — only covered catalog ids 1-6; switched all to `getProperty()`. (2) `canManageProperty()` only checked the `properties` DB table, never the catalog's static `hostAddress` — a configured host of a demo property could never manage it (release deposit, resale settings, iCal import, tax remit/unremit all 403'd); fixed at the function root via `getProperty()`, which also fixed the AI chat's `release_deposit` tool. (3) `/ical/:propertyId` title used a hardcoded 6-entry map instead of `getProperty()` (cosmetic). (4) `properties.transfer_allowed`/`max_resale_premium_bps` columns confirmed dead (real resale settings live in `property_resale_settings`) — `ALTER TABLE` statements removed from `db.mjs`; columns can be manually dropped on already-migrated DBs. Full detail in `ARIA_HANDOFF.md`'s matching entry. |
| **Sandbox/local file-write reliability (recurring, June 29 + June 30, 2026)** | **Resolved (cause confirmed; user paused OneDrive sync June 30)** | Recurred a 6th time June 30, 2026: after the abandoned-booking-sweep + tax-routing commits (`9d40a05`/`0eea17a`) were already pushed, 9 working-tree files (`server.mjs`, `db.mjs`, `escrow.mjs`, `escrow.test.mjs`, `bookings.mjs`, plus 4 `.md` docs) were found truncated mid-statement on disk, all failing `node --check`. Disk space was confirmed NOT the cause (320G free). A plain `git checkout -- <file>` failed with "Operation not permitted" on unlink — confirming an external process (OneDrive) was holding a file lock, consistent with the original sync-race theory. Worked around via overwrite-in-place (`git show HEAD:<file>` piped into the existing file rather than delete+replace); all 9 files restored and re-verified clean with `node --check`. **User has now paused OneDrive sync on the `aria-demo` folder (June 30, 2026)** — monitor whether truncation recurs; if it doesn't, this row can close out entirely. A handful of harmless `*.tmp_restore` junk files from the repair are still lock-stuck and need manual deletion in File Explorer once the lock clears. |

---

## 5b. Code-Quality Evaluation (June 18, 2026) — Outcomes

Independent code-quality review (`ARIA_EVALUATION_HANDOFF.md`, R1–R15) was
evaluated and acted on. Scorecard/rationale: see the evaluation response.

**Fixed this session (code-only, demo-ready):**

| Rec | What shipped |
|---|---|
| **M1 + R2** | New `cancelBooking()` in `bookings.mjs` (REST + AI both delegate). **Fixes the stranded-deposit bug**: cancel now calls `autoReleaseEscrow` on-chain; if the escrow can't release yet (pre-expiry) it stays `held` for the sweep instead of being flipped to `released` and skipped. |
| **R5** | `canAccessBookingThread()` gates `/messages/send`, `/messages/:bookingRef`, `/count` to the booking's guest + managing host + superadmin (was: any logged-in user). |
| **R14** | `escapeHtml()` (`emails.mjs`) applied to user-supplied claim/dispute `reason` (and names) before HTML-email interpolation. |
| **R1** | `getAuthedSession()` decorator replaces ~28 duplicated session-lookup blocks in `server.mjs` (middleware only; no route-module split). |
| **R3** | Single `walrus.mjs` `pushToWalrus()`; the three duplicates removed. |
| **R4** | AI prompts (`ai_route.mjs`) generated from `catalog.mjs` via `catalogPromptSections()` — no more hardcoded price/tax that can drift from what `createBooking()` charges. |
| **R7 / R15** | `index.jsx` booking payload trimmed to `{propertyId,checkIn,checkOut}`; stale `catalog.mjs` header comment updated. |

**Before mainnet (roadmap — needs a decision, infra, secret, or contract upgrade):**

| Rec | Why deferred / what's needed |
|---|---|
| **`refund_deposit` contract fn (v4)** | **✅ Done, live** — shipped in `7b09e73` alongside the Phase 1h.5 payment escrow, confirmed on `origin/main`. Arbitrator-signed, pre-check-in instant refund; `bookings.mjs` calls `refundDepositEscrow()` from `/booking/cancel` so a cancelling guest gets deposit + payment back together instead of waiting for `auto_release` at expiry. Move-tested (`test_refund_deposit_to_guest`, `test_refund_deposit_non_arbitrator_fails`); no dedicated JS unit test found by name in `escrow.test.mjs` — worth confirming coverage there. |
| **R6** — scope `/bookings/all` to host's properties | **✅ Done, July 1, 2026.** Confirmed genuinely live (not just theoretical) via an independent external review that flagged it as the top risk. Fixed in `server.mjs` (`getOwnedPropertyIds()`, used by `/bookings/all`, `/reviews/all`, `/tax/summary`) and mirrored in `ai_route.mjs` (`getOwnedPropertyIds()`/`canHostAccessBooking()`, used by `get_all_bookings`, `get_revenue_summary`, `get_all_messages`, `get_reviews`, `get_messages`, `send_message`). Superadmins (`HOST_ADDRESSES`) still see everything; a regular approved host now only sees data for properties whose `hostAddress` matches their own Sui address. The AI's `get_messages`/`send_message` had an even looser bug beyond the read-scoping issue — "host may access ANY booking's thread" with no property check at all — also closed via the same `canHostAccessBooking()` helper. |
| **M3** — per-user zkLogin salt (+ migration) | **✅ Done and verified live, July 1, 2026.** Real incident forced the issue: a June 30 change to the old single shared `ZKLOGIN_SALT` reshuffled which Sui address two test accounts resolved to, breaking address-keyed data (`host_profiles.sui_address`, `catalog.mjs` hardcoded host addresses) that assumed the old mapping — confirmed live July 1. Fix: new `user_salts` table (one row per Google `sub`), `getOrCreateUserSalt()`/`handleZkLoginSalt()` in `auth.mjs`, `POST /auth/zklogin/salt`, and the OAuth callback page/`lib/zklogin.js` now fetch each user's own salt at login instead of reading a shared constant. Existing users were migrated transparently — their first post-rollout login seeds their row with the prior shared value, so no address moved. **Verified post-deploy:** both `cwilliams36092@gmail.com` (`0xbdb2e801...`) and `ariasuidemo@gmail.com` (`0x528819eb...`) logged in after the rollout and each still shows the exact same address it had before — the migration held. `ZKLOGIN_SALT`/`NEXT_PUBLIC_ZKLOGIN_SALT` now only matter as that one-time seed value; changing them can no longer reshuffle anyone already migrated. Still true regardless: don't change either at mainnet migration (see `ARIA_KEY_INVENTORY.md` §8) — no code depends on you changing it, so there's no upside, only risk for any not-yet-migrated `sub`. |
| **M4** — DB TLS CA cert | `rejectUnauthorized:false` is a MITM risk; supply the Railway CA cert. |
| **M6** — Stripe webhook / payment capture | **✅ Done, July 1, 2026.** Rebuilt the whole card path rather than patching the old stub, which created a PaymentIntent but never loaded Stripe.js or confirmed a charge — the frontend just faked a success state, so a booking could show `confirmed` with no card ever charged, and it never even recorded which dates were being booked (only took `{propertyId, nights}`). Switched to hosted Stripe Checkout (redirect, not embedded Elements — no card data touches ARIA's code, no PCI scope, avoids a second CSP-allowlist exercise on top of the zkLogin prover one above). New flow: `POST /payment/create-intent` (`server.mjs`) now calls `createPendingCardBooking()` (`bookings.mjs`) to validate + price + atomically hold the dates (`payment_status='pending'`, same idea as the SuiUSD path's `deposit_status='pending'` window) using the same per-property advisory-lock conflict check `createBooking` uses, then creates a Checkout Session for the exact server-computed total (guest never sees or can tamper with the amount). `POST /webhooks/stripe` (new, its own encapsulated Fastify plugin so a raw-buffer content-type parser applies only to that route) verifies Stripe's signature and is the *only* thing that flips a booking to `confirmed` (`checkout.session.completed` → `confirmCardBooking()`) or releases the held dates (`checkout.session.expired` → `cancelPendingCardBooking()`); both are idempotent (UPDATE...WHERE payment_status='pending', so a Stripe retry is a safe no-op). A new fallback sweep (`runStripeAbandonedSweep`, 1-hour TTL) releases a pending card booking if even the expiry webhook goes missing. `payment_status`'s CHECK constraint widened to add `pending`/`failed` alongside `confirmed`/`cancelled`. Deliberate scope cut: **no refundable deposit on the card path** — deposit release, check-in passes, and resale are all Sui-escrow-native concepts with no card equivalent yet, so `deposit_amount`/`deposit_status` stay `NULL` for these bookings (which also means none of the escrow-specific UI in `pages/bookings.jsx` lights up for them, with an explicit `paymentMethod !== 'stripe'` guard added as belt-and-suspenders). The guest-facing "Pay with Card" price already included a Stripe processing surcharge formula (`lib/pricing.js`'s `getCardTotal`) that was previously computed but never actually wired to a real charge — now the backend charges exactly that number. Fixed two smaller bugs found while wiring this up: `paymentMethod` was never returned by `GET /bookings/history` (so `pages/bookings.jsx` always displayed "SuiUSD" regardless of the real `payment_method` column), and the booking confirmation email template hardcoded "SuiUSD" and claimed the Walrus receipt was a "PERMANENT ON-CHAIN RECORD" (same over-claim as the Walrus permanence fixes elsewhere in this doc — missed there since it's an email template, not a page). Requires `STRIPE_WEBHOOK_SECRET` (from the Stripe Dashboard's webhook endpoint config, pointed at `POST /webhooks/stripe`) set on Railway — not yet done as of this writing; the route safely 500s with a clear log line if it's missing rather than accepting unverified events. |
| **M6b** — Stripe/Seal identity parity | **✅ Done, July 1, 2026.** Follow-up to M6: a card-paid booking never produces a guest-signed escrow (no guest wallet transaction happens anywhere in the Stripe flow), so host.jsx's "View Guest Identity" — gated on-chain by `seal_approve`, which requires a real `&BookingEscrow<T>` object — had nothing to check against for Stripe guests, even though the guest-side upload (Walrus + Seal encryption) already worked identically regardless of payment method. Considered and rejected an off-chain fallback (host.jsx's DB-based `hostManagesBooking()` check standing in for the on-chain gate): that would mean ARIA's backend, not Seal's key servers, deciding PII access — real custody, a genuine architecture regression, not a shortcut. Shipped instead: `createIdentityAttestationEscrow()` (`escrow.mjs`) — the existing zero-privilege auto-release key calls the **same, unmodified** `create_escrow` entry function used by the guest-signed path, funded with a trivial symbolic amount, `guest`/`host` set to the booking's real addresses, expiry ~1 year out (so it's never a realistic `auto_release` target). No Move contract changes, no redeployment. Called from `confirmCardBooking()` (`bookings.mjs`) right after a Stripe booking is verified-confirmed; best-effort — a failure here can't un-confirm an already-charged booking, it just means that host won't get identity access for that one booking, surfaced as a clear error rather than any silent fallback. The resulting object id is stored in a new, dedicated `identity_attestation_object_id` column (`db.mjs`) — never `escrow_object_id` — so `autoReleaseEscrow`, the deposit sweep, refunds, resale, and the check-in-pass flow can't see or touch it; `GET /host/guest-identity/:bookingRef` (`server.mjs`) now accepts either column as the on-chain object to check identity access against, SuiUSD bookings unchanged. Also fixed a related bug found while wiring this: `createPendingCardBooking()`'s INSERT omitted `deposit_status`, so it silently took the table's `'held'` default instead of `NULL` — now set explicitly. Testnet-only design note: the auto-release key needs a small amount of testnet SUI beyond gas to fund these; not a concern per-user direction, since no real funds (including stablecoins) exist on testnet — revisit funding/rate-limiting this key specifically before any mainnet migration. |
| **R10** — externalize rate-limit + single cron | In-process now; hard prerequisite before a 2nd Railway instance. |
| **R8** — numbered SQL migrations | Replace chained `ALTER TABLE IF NOT EXISTS`; minimal runner, no heavy ORM. |
| **R11** — integration tests + CI | booking→confirm, cancel→escrow, auth middleware; wire `escrow.test.mjs` + `sui move test` into CI. |
| **R12 / R13** | Incremental TS on backend; frontend componentization — as features demand. |
| **R1 (full split)** | Break `server.mjs` into `routes/*.mjs` plugins (middleware half already done). |
| **USDC → SuiUSD in-app swap (mainnet launch blocker — MAY BE MOOT)** | Guests will arrive with USDC (available on CEXs) and need SuiUSD to pay for bookings. SuiUSD is not on CEXs so an in-app swap is the critical onramp. Plan: DeepBook USDC/SuiUSD pool swap via `@mysten/deepbook-v3`, same non-custodial zkLogin sign pattern as send/escrow. "Swap" modal in the wallet UI alongside the existing Send button. **Cannot be built or tested on testnet** (no real stable coins exist there). Pre-mainnet gate: (1) confirm a USDC/SuiUSD DeepBook pool exists with usable liquidity; (2) `@mysten/deepbook-v3` is in `package.json` but **not yet imported** — `deepbook.mjs` uses plain REST fetch only, so **no July 31 JSON-RPC sunset exposure** (confirmed June 30, 2026); (3) get real coin types for both assets on mainnet. **Key question (decide before mainnet config):** if ARIA adopts native USDC (Circle, `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC`) as the payment coin, this swap is unnecessary — guests deposit USDC directly from Coinbase/Kraken. See "SuiUSD → USDC label rename" row below. |
| **SuiUSD → USDC label rename (pre-mainnet, ~1 hour)** | All "SuiUSD" display labels must change to "USDC" when the mainnet payment coin is set. **35 occurrences confirmed across 12 files (June 30, 2026):** `pages/listing/[id].jsx` (Book Now button), `pages/bookings.jsx` (charge/payment labels), `pages/host.jsx` (revenue sub-label), `pages/ai.jsx` + `ai_route.mjs` (chat disclosures + AI system prompt), `pages/index.jsx` + `pages/become-host.jsx` (marketing copy), `bookings.mjs` + `server.mjs` (booking response strings), `deepbook.mjs` (`currency: 'SuiUSD'`), `db.mjs` (`payment_method DEFAULT 'SuiUSD'`). Bulk rename: `grep -rl "SuiUSD" --include="*.{jsx,mjs,js}" . \| xargs sed -i 's/SuiUSD/USDC/g'` — then manually review `db.mjs` default, `become-host.jsx` Transak sentence, and `ai_route.mjs` system prompt. Do this as part of the Phase 3–4 mainnet env pass in `ARIA_MAINNET_MIGRATION.md`. |
| **M7 — secrets passed as Docker build ARG/ENV** | Railway/nixpacks injects all secrets (`ARIA_*_KEY`, `GOOGLE_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `SESSION_SECRET`, `XAI_API_KEY`, `SHINAMI_API_KEY`, …) as Docker `ARG`/`ENV` — flagged by `SecretsUsedInArgOrEnv` warnings in the build log (June 18, 2026). Secrets in build args can persist in image layers/history. Fine for demo; before mainnet, move to Railway **runtime** secrets or build-secret mounts so they aren't baked into the image. |
| **M8 — audit `SHINAMI_API_KEY`** | Appears as a Railway env var / build arg but isn't referenced in the docs or (apparent) code. Confirm whether it's actually used (gas station / sponsored tx?) — if not, remove it from Railway like the retired `ANTHROPIC_API_KEY`. Also: `npm install` reports 3 moderate-severity advisories — run `npm audit` and triage before mainnet. |

---

## 5c. Second External Review (ChatGPT, June 18, 2026) — Outcomes

A second independent review was evaluated and the high/medium items fixed this
session. Verified each against live code before acting.

> **Update (June 19, 2026 — live-verified):** the escrow "weak-evidence" fix
> below was reworked once live testing exposed that the public testnet fullnode
> can't serve a just-created object for >1 min (read-after-write lag), which
> failed nearly every booking. `verifyEscrowTransaction` now gates on the created
> object's **type** read **lag-free** from `getTransaction`'s `objectTypes` map
> (scanned by value; matched on the `::escrow::BookingEscrow<` suffix, since the
> type carries the *original* package id, not v3); the `getObjects` content/amount
> check is best-effort; 503-retryable only if nothing is verifiable. Both flows
> are now **live-verified on testnet**: booking confirm first-try, and cancel-
> after-expiry on-chain release (M1). Full transferable write-up: see
> `ARIA_HANDOFF.md` -> "Sui Integration Lessons". Pre-mainnet limitation: amount
> check skipped under read lag (type+sender still enforced) — see options below.

**Fixed this session:**

| Finding | Sev | Fix |
|---|---|---|
| iCal SSRF + missing authz | **HIGH** | `ical.mjs` `assertPublicHttpsUrl()` (https-only; rejects hosts resolving to private/loopback/link-local/CGNAT/metadata IPs); `fetchExternalBookings` re-validates, uses a 5s timeout, `redirect:'error'`, and a 2 MB cap. `/ical/import` now requires `isHost` + `canManageProperty` + URL validation. (NOTE: with the `properties` table empty, `canManageProperty` is superadmin-only for now — fail-closed.) |
| Escrow weak-evidence accept | **HIGH** | `verifyEscrowTransaction` no longer soft-accepts when the created object can't be read — it returns `{ok:false, retryable:true}` and `/booking/:ref/escrow/confirm` responds 503, keeping the booking pending for retry (the "Retry escrow deposit" button) instead of marking the deposit held on tx+sender alone. |
| Reviews not tied to caller's booking | MED | `/reviews/submit` now loads the booking, requires `wallet_address === session.suiAddress`, and derives `property_id` from the booking row (client-supplied `propertyId` ignored). |
| Host emails unescaped | MED | `/host/apply` + `/host/approve` now `escapeHtml()` name/email/city/state/strPermit/host.name (closes the gap left by the earlier R14 pass). |

**Deferred (LOW / quality):**

| Item | Notes |
|---|---|
| Reviews SQL aggregation + index | `GET /reviews/:propertyId` pulls all rows and averages in Node; use SQL `AVG`/`COUNT` and add a `reviews(property_id)` index (db.mjs has no reviews index). |
| Escrow-signing shared hook | Signing logic is duplicated in `pages/index.jsx` and `pages/ai.jsx`; extract a shared hook (pairs with R13). |
| `/availability/:propertyId` is public + triggers outbound fetch | Now SSRF-guarded at the fetch layer; consider caching/rate-limiting the outbound iCal fetch to avoid DoS amplification. |
| Optional escrow reconciler | Replace the manual "Retry escrow deposit" with a sweep that persists the reported digest and auto-re-verifies pending escrows (complements finding #1's retryable result). |
| AI host-tool property scoping | Same as R6 — `get_all_bookings`/`get_revenue_summary`/`get_all_messages`/`get_reviews` are platform-wide; scope per-property for multi-tenant. |
| `x-session-id` in `localStorage` | Accepted demo tradeoff (XSS-exposable); see Deliberately Deferred. |

---

## 5d. Third External Review (Security/Quality/Scalability Eval, June 22, 2026) — Outcomes

A third independent review (the standalone `ARIA_SECURITY_QUALITY_SCALABILITY_EVALUATION.md`,
since deleted — its findings are folded in here so nothing is lost) was evaluated
against live code. Most findings duplicated items already tracked above; the
genuinely new/verified ones were acted on or added to the backlog.

**Fixed this session (code, June 22, 2026):**

| Finding | What shipped |
|---|---|
| **Claim amount could diverge from chain (P1-2)** | `/booking/claim-damage/confirm` previously wrote `request.body.claimAmount` (client-supplied) to the DB/guest-email while only verifying the escrow was *mutated*. Now `decodeClaimDamageAmountMist()` decodes the **on-chain** `claim_amount` (arg[1] of the signed `claim_damage` PTB, lag-free) via `verifyEscrowMutation`, and the route records that authoritative value; undecodable → 400. Confirm schema now declares `reason` (optional) and no longer accepts an amount. Unit-tested. |
| **Logout didn't revoke server-side (P1-3 / L2)** | `/auth/logout` only cleared the cookie; the unused `deleteSession()` is now exported and called, deleting the Postgres session row so a copied `aria_session`/`x-session-id` stops working immediately. |

**Already tracked (no new action — see above):** payment collection/routing = Fee
collection (Phase 1h.5); host-data isolation across `/bookings/all`, `/tax/summary`,
`/reviews/all`, and AI host tools = **R6** (done July 1, 2026, see above); DB TLS = **M4**;
zkLogin salt = **M3**; Stripe finality = **M6**; single-process sweeps/rate-limits =
**R10**; numbered migrations = **R8**; integration tests + CI = **R11**; iCal cache =
the iCal-amplification §5c row; UpgradeCap burn + Move audit = pre-mainnet gate.

**New backlog items added (before mainnet / multi-host):**

| Item | Priority | Notes |
|---|---|---|
| **Package-manager / lockfile mismatch** | Medium | Repo has `pnpm-lock.yaml` (lockfileVersion 9.0) but Railway/Vercel/Nixpacks all run `npm install` with no `package-lock.json` and no `packageManager` field → prod can drift from the locked graph. Fix: standardize on pnpm (`"packageManager": "pnpm@9"` + `pnpm install --frozen-lockfile` in all three deploy configs). **Deploy-affecting — apply while watching a Railway/Vercel build.** Add `test`/`lint`/`audit` scripts too. |
| **CSRF protection for cookie auth** | ✅ Done, July 1, 2026 | Prod cookies use `SameSite=None` (cross-domain Vercel↔Railway) so they're attached to forged cross-site requests regardless of CORS. Fix: `getAuthedSession()` in `server.mjs` (and the equivalent check in `ai_route.mjs`'s `/api/ai/chat`) now requires the explicit `x-session-id` header — not the cookie — for every non-GET/HEAD request. A cross-site page can't attach that header without triggering a CORS preflight, which our origin-allowlisted CORS config rejects for any origin but `FRONTEND_URL`. Every mutating call in the app already goes through `authFetch()` (`lib/authFetch.js`), which always sets this header, so no frontend changes were needed. GET routes still accept the cookie (read-only, no CSRF risk). |
| **Security headers / CSP** | ✅ Done and enforcing, July 1, 2026 | `next.config.mjs` ships a real CSP built from an audit of every external domain the frontend calls (Google OAuth redirect, Sui fullnode, zkLogin prover, Walrus publisher/aggregator, the Railway API via `NEXT_PUBLIC_API_URL`, `images.unsplash.com` for demo photos, `img-src https:` kept open since host-imported listings can carry photos from arbitrary CDNs). Seal's key-server URLs are resolved dynamically on-chain, not hardcoded — covered by an `*.mystenlabs.com` wildcard. First Report-Only pass (browse, host approve/revoke, Send SUI) was clean, so we flipped to enforcing — which immediately caught a real gap: `NEXT_PUBLIC_PROVER_URL` is set on Vercel to a self-hosted prover proxy (`zklogin-prover-fe-production-e590.up.railway.app`, backed by a `zklogin-prover` service on Railway's internal network), invisible to a source-code grep since it's an env-var override, not the `lib/zklogin.js` default. Fixed by reading the same env var in `next.config.mjs` so the CSP always tracks whatever prover is actually configured, reverted to Report-Only, re-verified with a full pass (fresh login, revoke/approve host, Send SUI, browse both host and guest views, booking + cancel + check-in) — zero violations — then flipped back to enforcing the same day. Stripe.js isn't allowlisted yet since the frontend doesn't load it (Stripe integration is still a stub — see the Stripe webhook backlog item); add `js.stripe.com`/`api.stripe.com` when that ships. |
| **DB integrity constraints** | Medium | `payment_status`/`deposit_status` are free-text (add CHECK enums); no foreign keys; no unique index on `reviews(booking_ref)` despite one-review-per-booking in code (add it). Note `tax_remittances(booking_ref)` is already UNIQUE. Pairs with **R8** migrations. |
| **AI per-user budget + tool audit log** | Medium | `/api/ai/chat` takes a full client `messages` array with no message-count/length cap and only the global (per-IP) rate limit. Add an AI-specific per-session limit, message/length caps, and persist an audit log for booking-mutating tool calls. |
| **Growth indexes** | Medium | Add `reviews(property_id)`, unique `reviews(booking_ref)`, `tax_remittances(booking_ref)` and dashboard composite indexes; convert `/reviews/:propertyId` average to SQL `AVG()`/`COUNT()`. |

---

## 5e. Fourth External Review (Codex audit, June 22, 2026) — Outcomes

A fourth independent audit was evaluated against live code. Two findings were
genuinely new and verified; both fixed this session. The rest duplicated items
already tracked.

**Fixed this session (code, June 22, 2026):**

| Finding | What shipped |
|---|---|
| **Cross-tenant booking cancellation (High)** | `cancelBooking()` skipped the ownership check whenever `isHost` was true → any approved host could cancel **any** booking platform-wide. Now `cancelBooking` self-authorizes via new `hostManagesBooking(session, booking)` in `bookings.mjs` (superadmin `HOST_ADDRESSES`, OR the booking's escrow `host_sui_address`, OR a `properties.host_address` match — mirrors `canClaimAsHost`). The unsafe `isHost` param was removed from `cancelBooking` and from both call sites (`/booking/cancel`, AI `cancel_booking`). Demo super-host (in `HOST_ADDRESSES`) is unaffected; regular hosts are now correctly scoped. |
| **AI release wrote a non-existent column (Medium)** | `ai_route.mjs` wrote `bookings.deposit_release_walrus_blob_id`, but `db.mjs` never created it → a clean DB would throw "column does not exist" on an AI-path deposit release. Added the idempotent `ALTER TABLE … ADD COLUMN IF NOT EXISTS deposit_release_walrus_blob_id TEXT` in `initDB()`. |

**Already tracked (no new action):** host data platform-wide = **R6** (done July 1,
2026, see §5c above); session model (localStorage/`x-session-id`/`SameSite=None`) = CSRF +
XSS hardening (§5d); process-local rate-limit/sweeps = **R10**; public `/availability`
iCal amplification = §5c/§5d iCal item; package-manager/lockfile drift = §5d.

---

## 5f. Fifth External Review (Haiku 4.5, June 23, 2026) — Outcomes + TODO

Full security/quality/innovation review evaluated against live code. Overall:
Security B+, Quality B+, Innovation A. ~A third of its action items were **already
done** earlier on June 23 (post-snapshot) and a few points were off — see below —
but it surfaced a clean shortlist of genuine quick wins. **Scheduled for June 24,
2026** (none are mainnet-blocking on their own; do them as one batch + commit).

**Already done June 23 (review snapshot was stale — do NOT redo):** treasury
addresses generated + set (`ARIA_FEE_ADDRESS`/`ARIA_TAX_REMITTANCE_ADDRESS`);
`NEXT_PUBLIC_ESCROW_PACKAGE_ID` set on Vercel; combined payment+deposit PTB **and**
Seal decrypt (incl. zkLogin SessionKey signing) **smoke-tested live**; both suites
run green (63 JS / 43 Move); pnpm build switch (`npx pnpm@10 --frozen-lockfile`);
`ARIA_PACKAGE_INVENTORY.md` updated v2→v4. (= its entire "3.2 Needs Activation" table.)

**Review points that are off (skip):** (1) booking-ref UUID — unnecessary, refs
already carry a `crypto.randomBytes(3)` suffix AND `bookings.booking_ref` is `UNIQUE`
(collision prevented twice). (2) `packageManager: pnpm@9` — superseded; pnpm 11
needs Node 22.13 but the nixpacks image is 22.11, so we pinned pnpm 10 via npx.
(3) "log every successful Seal **decrypt**" — decrypt is client-side (browser), the
backend can't observe it; the correct audit point is the `/host/guest-identity`
route (log host→guest→booking on access *request*).

**✅ DONE June 23, 2026 (quick-win batch shipped — all 6 below).** Added
`@fastify/helmet` dep. CSP intentionally deferred (needs a Seal/Walrus/Sui/Google
origin allowlist validated against the live app, ideally Report-Only first — noted
in `next.config.mjs`). Everything else live.

| # | Item | Where |
|---|---|---|
| 1 | **Security headers** — add `@fastify/helmet` (HSTS, CSP, X-Frame-Options, Referrer-Policy, X-Content-Type-Options) + headers in `next.config.mjs`. None present today. | `server.mjs`, `next.config.mjs` |
| 2 | **DB integrity** — `UNIQUE` index on `reviews(booking_ref)` (1 review/booking, only enforced in code today) + index on `reviews(property_id)` (queried by `/reviews/:propertyId`, unindexed). Optional: `CHECK` enums on `payment_status`/`deposit_status` (one-time data-conformance check first). | `db.mjs` |
| 3 | **`"test"` script** — `"test": "node escrow.test.mjs"` in `package.json` (prereq for any CI). | `package.json` |
| 4 | **AI message cap** — `/api/ai/chat` accepts an uncapped `messages` array; add per-request count + total-length cap. | `ai_route.mjs` |
| 5 | **Guest-identity access log** — small audit table + insert on `/host/guest-identity` (host address, guest address, booking ref, ts). The correctly-framed Seal audit point; needed before real PII on mainnet. | `db.mjs`, `server.mjs` |
| 6 | **README sync** — add Seal, payment escrow, `/profile` (currently omits all three). | `README.md` |

**Bigger items it (correctly) raised — already on the pre-mainnet gate, own passes:**
CSRF tokens / strict-Origin + same-site collapse + CSP; DB TLS CA cert (**M4**);
secrets out of Docker build ARGs (**M7**); numbered SQL migrations; frontend (Jest/RTL)
+ E2E (Playwright) tests + CI automation; independent Move audit + UpgradeCap burn
decision; per-user zkLogin salt migration (**M3**); `useEscrowSign()` hook to dedupe
`index.jsx`/`ai.jsx` (~100 lines, **R13**); multi-host scoping for AI tools + dashboards
(= host-onboarding tech-debt item above).

---

## 5g. Sixth External Review (Codex 5.1 mini, June 24, 2026) — Outcomes

Four findings, all valid (no false positives). Two had a quick-win nugget (fixed
June 24); two were already tracked.

**Fixed June 24, 2026:**
- **Sweep re-entrancy guard** — `guardedAutoReleaseSweep` / `guardedCheckInReleaseSweep`
  skip a tick if the prior run is still in flight. The sweeps `await` on-chain
  releases serially, so a run could outlast its interval and overlap itself (or the
  startup `setTimeout`). `server.mjs`.
- **`/bookings/all` bounded** — `LIMIT` (`BOOKINGS_ALL_LIMIT`, default 500) so one
  host request can't pull the whole table into memory. `server.mjs`.

**Already tracked / logged for later:**
- **DB TLS `rejectUnauthorized:false` (High)** = **M4** — supply the Railway CA cert.
  Genuine mainnet blocker; lower urgency on testnet (the app↔DB link is Railway-internal).
- **Sweep scaling** (batch `LIMIT`, concurrency cap, job queue) — for when volume
  justifies it; the overlap guard ships now.
- **Read pagination** — `/bookings/history` is wallet-scoped (bounded); `/bookings/all`
  now `LIMIT`ed; proper offset/cursor pagination is the follow-up.
- **`server.mjs` monolith (~1,500 lines)** = **R1** — split into `routes/*.mjs`; also
  move the inline HTML email strings into templates (the reviewer's specific add).

---

## 6. Deliberately Deferred

### ~~zkLogin salt (shared, global)~~ — RESOLVED July 1, 2026, see M3 above
Was: a single `ZKLOGIN_SALT`/`NEXT_PUBLIC_ZKLOGIN_SALT` value shared by every
user. Changing it re-derived EVERY user's Sui address simultaneously — this
happened for real on June 30, 2026 (moving off the `'0'` dev default to a
random value) and confused which of two test accounts owned which address for
a full day before it was caught (July 1, 2026). Records already keyed by the
OLD address at that time (`host_profiles.sui_address`, the hardcoded address
that had been in `catalog.mjs`) stayed pointed at the wrong account — no way
to fix already-created records short of manual correction, which is what
happened here.

Now: each user gets their own persisted salt in `user_salts`, created on
their first login and never touched again (see M3 entry above and
`ARIA_KEY_INVENTORY.md` §8 for the implementation). The legacy shared value
only matters as the one-time seed for a `sub` that's never logged in before —
it's no longer read on every login. Verified live immediately after rollout:
both existing accounts logged in and kept the exact addresses they had before
the migration.

**Still true, and still worth remembering at mainnet migration:** you do not
need to, and should not, change `ZKLOGIN_SALT` / `NEXT_PUBLIC_ZKLOGIN_SALT` as
part of moving to mainnet. zkLogin address derivation (`hash(iss, aud, sub,
salt)`) does not depend on which Sui network you point at — the same salt
(and same Google OAuth client ID / `aud`) yields the SAME address on testnet
and mainnet. Moving to mainnet should mean changing `SUI_NETWORK`, RPC URLs,
and republishing the Move package — not touching the salt. Issuing a NEW
Google OAuth client ID for production instead of reusing the current one
would still re-derive every address regardless of the per-user salt fix,
since `aud` is also a derivation input — avoid that too unless a clean
address reset is actually intended.

### DB TLS (`ssl: { rejectUnauthorized: false }`)
Railway cert doesn't validate against default CA.
Follow-up: supply Railway CA cert.

### Session token in URL (`?sid=`)
Cross-domain login (Vercel ↔ Railway) depends on it.
Follow-up: one-time authorization code exchange.

---

## 7. Key Architectural Decisions (Do Not Re-Debate)

| Decision | What was decided | Why |
|---|---|---|
| Pivot from vacation rental | **Rejected** | Helm/boats, freelance escrow, contractor payments all evaluated |
| PII storage | Walrus + Seal, zero raw PII on ARIA | Regulatory: avoid CCPA/GDPR custodianship |
| Stripe Identity for KYC | **Rejected** | Walrus + Seal is non-custodial and architecturally aligned |
| Contract: global vs per-booking | One global package, per-booking shared objects | No global balance to drain |
| UpgradeCap | Keep testnet, burn before mainnet after audit | Immutable = maximum user trust |
| PII access start | Booking confirmation (not check-in) | Hosts need identity before guest arrives |
| Deposit lifecycle drives PII access | Yes — released = access revoked atomically | Natural boundary |
| Coin type | Generic `Coin<T>` | Testnet SUI now; SuiUSD mainnet; no code change |
| P0b payment coin scope | SuiUSD only (not multi-coin/USDC) | Keep P0b scope smaller; multi-coin deferred indefinitely |
| Arbitrator scope | Can only split between guest and host | Limits blast radius if compromised |
| SDK client for tx submission | `SuiGrpcClient` + `keypair.signAndExecuteTransaction()` | P0a complete; gRPC is the working pattern |
| Emergency withdraw / pause | **Rejected** | Admin drain path; undermines non-custodial claim |
| Arbitrator key custody | Cold (KeePass), separate from deployer & backend signer | Bounded blast radius enables safe future scaling |
| Private keys in documentation | **Never** — public addresses only | Roadmap/handoff docs are pushed to public GitHub |
| extractCreatedObjectId | Named function in `server.mjs`, tested in `escrow.test.mjs` | Reuse for Phase 2 pii_access; do not inline |
| Claim/dispute verification | Same build-unsigned/client-signs/backend-verifies-on-chain pattern as escrow creation | Consistency; backend never custodies host/guest signing authority for claim_damage/dispute_claim |
| Arbitration automation | Brought forward from "future scaling" to now — dedicated `ARIA_ARBITRATOR_KEY` signs `resolve_dispute` directly from the backend | Manual KeePass signing doesn't scale to a working `/booking/resolve-dispute` route; blast radius still bounded per-escrow by the contract |

---

## 8. Environment Variables

**In Railway (backend):**
```
DATABASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CALLBACK_URL, FRONTEND_URL
HOST_ADDRESSES, SESSION_SECRET, XAI_API_KEY, RESEND_API_KEY, STRIPE_SECRET_KEY
ESCROW_PACKAGE_ID       = 0xd825ec2db47c38758974dd9ae64fb4c4fe996ed383ae228052f30ec3351dc9b8
                          (v5, June 24 2026 — adds BookingPass mint_booking_pass; prior v4
                          0xf68a874fbdd3e5aa328f6754bd757edc6c2690510284fa39d5088e44b4cd9e77)
BOOKING_PASS_ENABLED    = true   (June 24 2026 — gates the v5 BookingPass mint; set ON
                          only after both *_PACKAGE_ID vars were on v5)
# Vercel also needs NEXT_PUBLIC_ESCROW_PACKAGE_ID = 0xd825ec2d...c9b8 (seal_approve CALL target)
                           (LIVE in Railway since June 18, 2026 — v3 upgrade adding
                           finalize_claim; redeploy confirmed clean (deploy db4f1425).
                           Prior v2: 0x98e712692f22f308bb6d097d2d8a2743ed0c01058135d71436b4abcd34264f26.
                           Original/type-defining (unchanged across upgrades):
                           0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe)
ESCROW_MODULE_NAME      = escrow
ARIA_AUTO_RELEASE_KEY   = <suiprivkey1... bech32 format — Railway only, never committed.
                           P1b: scoped to auto_release + finalize_claim (both
                           permissionless on-chain), zero special privilege. Funded;
                           confirmed loaded in Railway deploy logs June 18, 2026.
                           Public address: 0xc0b4e8b46731329fa83a8a5d93b1600b415fe0b050be986bb3f7cffda22e0ff9>
ARIA_ARBITRATOR_KEY     = <suiprivkey1... bech32 format — Railway only, never committed.
                           P2: scoped to resolve_dispute only. Funded; SET in Railway
                           (confirmed loaded in deploy logs June 18, 2026).>
ARIA_ARBITRATOR_ADDRESS = 0xf46527e18f2fd7d3093c9591ded66e3a8711a18de63cd0bede2d88692e6f6a65
                          (P2, June 17, 2026 — supersedes the P1a placeholder address
                          0x0069868f93f9127b3e8b51bf95bc529925ca382e6305da0bb01f693826b983f8
                          for new bookings going forward; see P2 section above)
DEMO_HOST_ADDRESS       = <optional, June 18, 2026 — a real Sui address to act as host
                          for the 6 demo properties (catalog.mjs hostAddress is null),
                          so claim/dispute can be exercised end-to-end. Falls back to
                          ARIA_AUTO_RELEASE_KEY's address if unset. NOT yet set in Railway.>

REMOVED June 18, 2026: ARIA_DEPLOYER_KEY (P1b ops complete — old deployer/UpgradeCap
key is cold KeePass-only, never loaded by the backend) and ANTHROPIC_API_KEY
(@anthropic-ai/sdk removed from the codebase; old sk-ant-... key should be revoked).
AUTO_RELEASE_SWEEP_INTERVAL_MS = <optional, default 3600000 (1 hour) — sweep cadence
                           for runAutoReleaseSweep()>

# Phase 1h.5 (June 23, 2026; tax-routing corrected June 30) — payment escrow.
# The combined payment+deposit booking PTB activates once the fee address
# below is set; otherwise createBooking falls back to the deposit-only P0b build.
ARIA_FEE_ADDRESS           = 0xcc27c579f88e82d0e78f159435675fecf4b1029405eb6f380553132f760ac6de
                           (alias aria-fee, generated June 23, 2026). Receive-only —
                           ARIA's 5% booking fee. NOT a signing key.
# ARIA_TAX_REMITTANCE_ADDRESS — RETIRED June 30, 2026. ARIA does not custody tax;
# the tax leg now routes to the host's own payout address (rides with the
# rental subtotal). Do not set this env var. See ARIA_KEY_INVENTORY.md §5.
PAYMENT_COIN_TYPE          = <optional, default 0x2::sui::SUI (testnet). Set to the
                           SuiUSD coin type on mainnet.>
CHECKIN_RELEASE_SWEEP_INTERVAL_MS = <optional, defaults to AUTO_RELEASE_SWEEP_INTERVAL_MS
                           — cadence for runCheckInReleaseSweep()>

# Abandoned-booking sweep (June 30, 2026) — frees calendar dates held by a
# guest who never signed the escrow PTB. Both optional.
ABANDONED_BOOKING_TTL_MS           = <optional, default 900000 (15 min) — how long an
                           unsigned booking sits before runAbandonedBookingSweep()
                           cancels it and frees the dates>
ABANDONED_BOOKING_SWEEP_INTERVAL_MS = <optional, default 300000 (5 min) — sweep cadence;
                           runs far more often than the other sweeps since the goal
                           is freeing dates quickly, not waiting on an on-chain deadline>
```

**To add for Phase 2:** *(none)* — the revised Seal design (above) adds
`seal_approve` to the existing `escrow.move` and anchors Seal's identity
namespace to the original package ID (`0x538262…7fdbe`), so there is **no**
separate `SEAL_PACKAGE_ID`. A `guest_verifications` table is added in `db.mjs`.

**In Vercel (frontend):**
```
NEXT_PUBLIC_API_URL = https://aria-demo-production-e590.up.railway.app
```

---

## 9. Product Vision & Feature Backlog (brainstorm — June 23, 2026)

Future feature directions, each tied to a primitive ARIA already runs (so they're
buildable, not hand-wavy). ⭐ = highest differentiation / on-brand. Lift is rough.
These are NOT committed work — they're the idea bank to pull from next.

### Theme A — Trust & reputation (ARIA's real moat vs Airbnb)
- ✅ **Verifiable reviews — SHIPPED June 24, 2026** *(was low lift)* — `/reviews/submit`
  now accepts a review ONLY for the caller's own, non-cancelled, **on-chain-escrow-backed**
  booking (`escrow_object_id` must exist), writes the review to **Walrus as an immutable
  attestation** (tied to the escrow object id + settlement digest), and stores
  `verified`/`settlement_ref`/`review_walrus_blob_id`. Frontend: "✓ Verified stay"
  badge + "on-chain proof" Walrus link on host review cards (`host.jsx`), and a
  `✓N` verified-review count on guest property cards (`index.jsx`). Optional stricter
  gate `REQUIRE_STAY_COMPLETED` (checkout-passed; off by default). Also fixed a latent
  bug: `/reviews/all` returned raw snake_case rows so the host UI's `guestName`/`bookingRef`
  were undefined — now mapped to camelCase. **First idea off the bank.**
- ⭐ **Portable on-chain reputation** *(medium)* — a guest's/host's stay history,
  review record, and dispute record as a Sui object the user OWNS and carries
  across platforms. Walrus already stores the receipts; make reputation portable
  and self-sovereign instead of trapped in a platform.
- **Transparent dispute resolution** *(med-high)* — evolve the existing arbitrator
  flow into a staked/community-juror system (Kleros-style) for damage disputes,
  full record on-chain. Replaces the single trusted arbitrator with a credibly
  neutral one.

### Theme B — New money mechanics (reuse the 3-way payment escrow + DeepBook)
- 🔴 **USDC → SuiUSD in-app swap (mainnet launch blocker)** — guests arrive with USDC
  from CEXs and need SuiUSD to book. DeepBook USDC/SuiUSD pool swap via
  `@mysten/deepbook-v3`, zkLogin-signed (same non-custodial pattern as send/escrow).
  "Swap" modal in wallet UI alongside Send. Cannot test on testnet (no real stable coins).
  Pre-mainnet gates: pool liquidity, gRPC compatibility, mainnet coin types confirmed.
  Alternative: link out to a native Sui swap UI if one ships before launch.
- ⭐ **N-way payout split** *(low — trivial extension of `BookingPaymentEscrow`)* —
  generalize rental→host / fee→ARIA / tax→remittance to also auto-pay cleaner,
  co-host, property manager at check-in. Cheapest big win for real hosts.
- ⭐ **Booking-as-transferable-object** *(medium)* — a confirmed booking is a Sui
  object; make it transferable → a legit, escrow-backed reservation resale/transfer
  market. Airbnb bans this; ARIA can do it safely. Novel + flashy.
- **Host cash-advance** *(high)* — borrow against confirmed future bookings
  (receivables as collateral). DeFi × travel.

### Theme C — Physical-world bridge (flashy, demo-winning) → BookingPass
- 🟨 **BookingPass / check-in pass** — the unifying object behind check-in + resale
  (Theme B) + smart-lock + reputation. Built in two phases:
  - ✅ **Phase 1 — dynamic wallet-signed check-in pass — SHIPPED June 24, 2026.**
    The guest's app signs a FRESH `ARIA-CHECKIN:<ref>:<ts>:<nonce>` personal message
    with their zkLogin wallet (reusing `signPersonalMessageWithZkLogin`) and renders
    a **rotating QR** on My Bookings (`pages/bookings.jsx`, `qrcode.react`, ~18s
    refresh). A host-only **scanner** (`pages/scan.jsx`) posts the scanned payload to
    `POST /checkin/verify`, which proves it's *fresh* (timestamp window — screenshots
    go stale), *wallet-signed* (`verifyCheckinSignature` in `escrow.mjs` →
    `verifyPersonalMessageSignature`), by the *booking's own guest*, for a *live,
    on-chain-escrow-backed* booking the scanning host manages → ✅/⛔. **NEEDS an
    in-browser smoke test** (server-side zkLogin signature verification, same risk
    class as the Seal SessionKey path — may need a tweak for the gRPC client).
    No contract upgrade. Camera QR scanning (vs paste) is a small follow-up.
  - 🟩 **Phase 2a — owned `BookingPass` NFT — LIVE June 24, 2026 (v5 `0xd825ec2d…dc9b8`; flag on; mint verified in-browser — booking `ARIA-1-1782312873579-3d5f50`)** — mint an owned
    pass to the guest in the booking PTB (`mint_booking_pass`, one extra `moveCall`,
    no extra signature). **Soulbound by default: `public struct BookingPass has key`
    with NO `store` ability** → the owner can't transfer it; only a function inside
    the module can (so transfer stays off until resale guardrails exist, enforced by
    the type system). Validity = guest owns pass + the booking's escrow is live →
    **cancel deletes the escrow → pass auto-invalidates** (no void call needed; reuses
    the automatic-revocation property). On-chain-verified check-in. Keep on-chain
    metadata minimal (booking_ref + window, NOT property address/PII) so it doesn't
    undo the Seal privacy posture.
  - ⬜ **Phase 2b — smart-lock `pass_approve`** — a Seal-style gate so real **door
    locks** open only for the stay window if the holder owns an active pass; cancel →
    escrow gone → won't open. NFC + real lock integration is the hardware follow-up.
  - ✅ **Phase 2c — guardrailed resale market — LIVE & VERIFIED June 24, 2026 (v6).**
    Resale IS allowed but fenced so it's "humane cancellation + host-controlled
    liquidity," not a scalper market. Shipped in v6 `0x897777aa…c901`; verified
    end-to-end on booking `ARIA-1-1782390279195-4320e7` (buy digest
    `E9gWpqWGKZh5hJw6kfnF6LfZfrj1son5HbctTVnzpcXg`). The five rails, as built:
    1. **Host opt-in per listing** — transferability is a host setting (`properties`/
       `property_resale_settings.transfer_allowed`), **off by default**; baked into the
       booking's `ResalePolicy` at booking time. No policy = not resaleable.
    2. **Price cap** — ask `P` must be in `[face, face·(1+max_premium_bps)]`, enforced
       on-chain in `list_for_resale` and configured per listing (Rail 2).
    3. **Upcharge split — ARIA 10% / host 45% / seller 45% (FINAL, supersedes the
       earlier 50/50).** Face `F` = original paid; upcharge `U = P − F`. **Seller gets
       `F + 0.45·U`, host gets `0.45·U`, ARIA gets `0.10·U`** — ARIA's fee is on the
       upcharge ONLY (face-value resale is fee-free). Verified on-chain: $400 sale →
       ARIA $0.30 / host $1.35 / seller $398.35.
    4. **Mandatory Seal identity** on the buyer — `transfer/build` blocks a buyer with
       no `guest_verifications` row; after the swap the host sees the buyer's identity
       (since `seal_approve` gates on `escrow.guest`, now the buyer).
    5. **Transfer window + one hop** — no transfer inside `resale_window_ms` of the
       release time (48h mainnet default, baked per policy, env-tunable for testnet),
       and `resale_count` capped at 1 (no speculative chains). Reputation signal: the
       market surfaces a seller's prior flip count.
    Mechanism (as built): two-step, non-custodial — `list_for_resale` (seller signs,
    burns the pass, sets the ask) then `buy_resale` (buyer signs + funds; **both escrows'
    `guest` reassigned to the buyer**, splits pay out, a fresh soulbound pass is minted).
    Governance lives in a NEW shared `ResalePolicy` object (Sui upgrade rules forbid
    adding fields to the existing escrows), so a transfer moves the WHOLE booking, not
    just the key. See `ARIA_PHASE2C_PLAN.md` for the full build plan.

### Theme D — AI agent depth (reuse the Grok agent)
- **Host-ops autopilot** *(medium)* — dynamic pricing, auto-draft replies, listing
  copy, calendar optimization.
- **Agent-to-agent booking** *(high)* — a guest's AI agent negotiates/books with a
  host's AI agent. Forward-looking; strong for an "AI + blockchain" track.

### Suggested sequencing (POV, not committed)
1. **Verifiable reviews + N-way split** — both low lift, both reuse existing
   structures, both deliver real value fast.
2. **Portable reputation** — the defensible, can't-be-copied-without-going-on-chain
   moat; reframes the whole pitch.
3. **Smart-lock check-in** — build when there's a demo/hackathon to win.
4. **Booking transfer market**, **dispute jurors**, **agent-to-agent**, **cash-advance**
   — bigger bets for after product-market signal.

> Prerequisite for most of Theme A/B at scale: real **host onboarding** (the
> `properties` table is still empty — see Tech Debt "Properties frontend-hardcoded /
> host onboarding"), since a two-sided marketplace is what makes reputation,
> splits, and transfers meaningful.

---

## 10. Resources

| Resource | URL |
|---|---|
| Sui documentation | `https://docs.sui.io` |
| Move book | `https://move-book.com` |
| Seal documentation | `https://seal-docs.wal.app` |
| Seal GitHub (examples) | `https://github.com/MystenLabs/seal` |
| Walrus documentation | `https://docs.walrus.site` |
| Sui testnet explorer | `https://suiexplorer.com/?network=testnet` |
| Sui testnet faucet | `https://faucet.sui.io` |
| Sui data stack overview (gRPC/GraphQL) | `https://blog.sui.io/graphql-archival-store-sui-data-stack/` |
| Deployed escrow | `https://suiexplorer.com/object/0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe?network=testnet` |

---

*ARIA Roadmap v2.17 — June 18, 2026*
*Changes from v2.16: (1) Contract upgraded to v3 (`0xec0d6bd4…644d8fa1`) adding
permissionless `finalize_claim` (CLAIMED-deadlock fix); Railway `ESCROW_PACKAGE_ID`
updated + redeployed clean. Phase 2a's `seal_approve` is therefore now the v4
upgrade. (2) Logged a second independent code review (Phase 1L) — 8 findings
fixed, see `ARIA_CODE_AUDIT.md` "Second Review" (hardened escrow object
verification, frontend gRPC migration, atomic booking insert, unified deposit
release, `DEMO_HOST_ADDRESS`); backend 39/39, Move 28/28. (3) Ops: addresses
funded, old `ARIA_DEPLOYER_KEY` + `ANTHROPIC_API_KEY` removed from Railway,
`@anthropic-ai/sdk` removed. Updated pre-mainnet gate, build order, tech-debt
backlog, Section 8 env vars (added `DEMO_HOST_ADDRESS`), and the Phase 2 env note
(no `SEAL_PACKAGE_ID`). Top remaining build item: fee collection/routing.*
*ARIA Roadmap v2.16 — June 17, 2026*
*Changes from v2.15: scoped Phase 2 (Seal/Walrus guest PII) against verified
Seal SDK mechanics — researched actual `seal_approve*` requirements,
SessionKey flow, key-server/threshold config, and identity-namespace
anchoring (confirmed tied to a package's original ID forever, so a function
added via upgrade works fine). Found the original placeholder architecture
(separate `pii_access.move` with manual grant/revoke) was structurally wrong
and replaced it with a simpler design: add `seal_approve()` directly to
`escrow.move`, gated on the existing `BookingEscrow` object, so access
revokes itself automatically when the object is deleted at finalization —
eliminating the old plan's separate contract, `SEAL_PACKAGE_ID`, and
`revoke_access`/Phase 2i entirely. Added a pre-mainnet gate item for Seal
audit logging, per Seal's own docs flagging it isn't scoped for regulated
PII without additional safeguards — decided to build the real architecture
now since testnet carries no real guest data, and revisit before mainnet.*
*ARIA Roadmap v2.15 — June 17, 2026*
*Changes from v2.14: confirmed `ESCROW_PACKAGE_ID` updated in Railway and
redeployed (deploy logs at 3:05 PM CDT show both keypairs loading correctly,
server up clean). P3 is now fully deployed end-to-end — no manual steps
remain. Updated P3 section, pre-mainnet gate, build order, and Environment
Variables accordingly.*
*ARIA Roadmap v2.14 — June 17, 2026*
*Changes from v2.13: P3 upgrade published successfully on-chain — transaction
`JCA8daJ9mSByY6x51ZhEc6Ubfrv1LEbf3nsVccEFtJZK`, new package
`0x98e712692f22f308bb6d097d2d8a2743ed0c01058135d71436b4abcd34264f26` (v2).
Marked P3 complete in the pre-mainnet gate and build order. One manual step
remains: update `ESCROW_PACKAGE_ID` in Railway to the new package ID.*
*ARIA Roadmap v2.13 — June 17, 2026*
*Changes from v2.12: the first upgrade attempt failed —
`sui client upgrade` rejected the package with "missing public declaration:
public function 'status_resolved' is missing." Sui's package upgrade rules
forbid removing a public function from an already-deployed package under any
upgrade policy, including the default "compatible" one. Restored
`status_resolved()` with the same signature, now returning a hardcoded `4`
instead of referencing the removed `STATUS_RESOLVED` constant. Updated the P3
section to reflect this; the constant removal still stands, the accessor does
not. Re-run `sui move test` (still 25/25 passing) before retrying the upgrade.*
*ARIA Roadmap v2.12 — June 17, 2026*
*Changes from v2.11: P3 contract cleanup in `escrow.move` — removed dead
`STATUS_RESOLVED` constant/accessor; added `MAX_EXPIRY_MS` (30-day) upper
bound on `expiry_ms` with new `EExpiryTooFar` error code and `max_expiry_ms()`
accessor; added 2 new Move unit tests (25 total in `escrow_tests.move`). Code
complete; on-chain upgrade still pending — requires the operator to run
`sui client upgrade` with the cold UpgradeCap key. Updated P3 section, build
order Phase 1k, and pre-mainnet gate accordingly.*
*Changes from v2.10: Marked P2 (auto-release cron job, production host address
lookup, claim/dispute backend routes) and Phase 3 (5-day inspection window
business logic) complete. Added `runAutoReleaseSweep()` to `server.mjs`;
`getPropertyHostAddress()` to `bookings.mjs` with `catalog.mjs` gaining a
per-property `hostAddress` field; `buildClaimDamageTransaction`,
`buildDisputeClaimTransaction`, `isObjectMutated`, `verifyClaimDamageTransaction`,
`verifyDisputeClaimTransaction` to `escrow.mjs`; 5 new routes
(`/booking/claim-damage[/confirm]`, `/booking/dispute-claim[/confirm]`,
`/booking/resolve-dispute`) and 5 new zod schemas to `validation.mjs`; 9 new
`bookings` columns to `db.mjs`. `deposit_status` extended to
`held|released|claimed|disputed|forfeited`. Generated and funded a new
operational `ARIA_ARBITRATOR_KEY`/`ARIA_ARBITRATOR_ADDRESS` so the backend can
actually sign `resolve_dispute` (the P1a address was cold-only); this
supersedes the P1a address for new bookings — manual Railway step still
pending. 18 new unit tests added to `escrow.test.mjs` (33 total, all passing).
Updated pre-mainnet gate, build order, and tech debt backlog accordingly.*
