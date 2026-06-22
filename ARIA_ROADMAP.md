# ARIA — Product Roadmap & AI Handoff Document
**Version:** 2.18 | **Updated:** June 22, 2026
**Purpose:** Complete handoff for an AI assistant continuing ARIA development.
Read this entire document before writing any code.

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
⬜ Phase 1h.5: Fee collection/routing mechanism — DESIGN COMPLETE June 22, 2026
   (ARIA_FEE_DESIGN.md v2.1); build pending. Hold-and-release: BookingPaymentEscrow
   holds rental+fee+tax, 3-way split released at check-in, full refund to guest
   before check-in. SuiUSD-only; needs the v4 contract upgrade (bundled w/ 2a).
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
⬜ Phase 1h.5: Fee collection/routing — TOP remaining build item. DESIGN COMPLETE
   (ARIA_FEE_DESIGN.md v2.1). Its BookingPaymentEscrow + release_payment/
   refund_payment contract functions ship in the SAME v4 upgrade as 2a's
   seal_approve — coordinate the two so there is one v4 publish, not two.
⬜ Phase 2a: Add seal_approve() AND BookingPaymentEscrow/release_payment/
   refund_payment (Phase 1h.5) to escrow.move, publish ONE upgrade (package **v4**)
⬜ Phase 2b: Pick testnet key servers + threshold (no contract deploy — see Phase 2 above)
⬜ Phase 2c: guest_verifications table in db.mjs (no pii_object_id column)
⬜ Phase 2d: /guest/profile + /host/guest-identity routes (latter returns escrow_object_id too)
⬜ Phase 2e: Booking gate in /booking/create and AI create_booking
⬜ Phase 2f: hasGuestProfile in /auth/me
⬜ Phase 2g: pages/profile.jsx (Seal encrypt + Walrus store)
⬜ Phase 2h: Host "View Guest Identity" modal in pages/host.jsx — incl. SessionKey
   create/sign step before decrypt
(Phase 2i eliminated — access revocation is automatic via escrow object
 deletion in auto_release/accept_claim/resolve_dispute; nothing to wire.)

⬜ Phase 3: 5-day timing gate + auto-release job + claim/dispute flows
```

---

## 5. Tech Debt Backlog

| Item | Priority | Notes |
|---|---|---|
| Key separation | **Done** | P1a/P1b/P2 all complete — deployer, auto-release, and arbitrator keys are now three separate, appropriately-scoped keypairs. |
| Fee collection/routing mechanism | High — **design done, build pending** | Design complete: `ARIA_FEE_DESIGN.md` v2.0. Non-custodial hold-and-release — a new `BookingPaymentEscrow` holds rental+fee+tax at booking (created in the same guest-signed PTB as the deposit escrow), released as a 3-way split (`subtotal`→host, `ariaFee`→ARIA fee wallet, `taxes`→remittance wallet) at check-in; full guest refund on cancellation before check-in. Reuses existing keys (auto-release key signs `release_payment`, arbitrator key signs `refund_payment`); adds two receive-only treasury addresses. Needs the v4 contract upgrade (bundle with Phase 2a). Also fixes the `calculateHostPayout` fee double-count. SuiUSD path only this phase; Stripe Connect deferred. |
| Auto-release job | **Done** | Phase 1h — `runAutoReleaseSweep()` in `server.mjs`, hourly + 30s-after-boot |
| Production host address | **Done** | Phase 1i — `getPropertyHostAddress()` in `bookings.mjs`; `catalog.mjs` still needs real per-property `hostAddress` values set once hosts are onboarded |
| Claim/dispute routes | **Done** | Phase 1j — `/booking/claim-damage`, `/booking/dispute-claim`, `/booking/resolve-dispute` |
| Properties frontend-hardcoded | Medium | `properties` table empty; `catalog.mjs` now also carries `hostAddress` per property, still hand-maintained |
| Frontend tax/price duplication | Low | `catalog.mjs` centralizes backend |
| Stripe webhooks | Medium | Create-intent only |
| No automated tests | Medium | Backend unit tests in `escrow.test.mjs` — **39 passing** (15 `extractCreatedObjectId`, 8 `verifyEscrowTransaction` incl. object type/amount/host/ref checks, 1 `depositToMist`, 8 `isObjectMutated`, 4 `verifyClaimDamageTransaction`, 3 `verifyDisputeClaimTransaction`). Move suite 28 tests. No frontend tests. |
| `zod` | **Done** | Adopted in `validation.mjs` |
| Legacy `hosts` table | Low | Unused; drop it |
| `@anthropic-ai/sdk` | **Done (removed)** | June 18, 2026 — removed from package.json/lockfile; `ANTHROPIC_API_KEY` deleted from Railway and `.env`. Was never imported. |
| Frontend gRPC migration | **Done** | June 18, 2026 — `lib/zklogin.js` epoch + submit now via `SuiGrpcClient` (off JSON-RPC, July 31 sunset). Needs in-browser smoke test. |
| Claim/dispute exercisable on demo properties | Medium | All `catalog.mjs` `hostAddress` are `null` → escrow host = `DEMO_HOST_ADDRESS` (if set) else auto-release key. Set `DEMO_HOST_ADDRESS` in Railway to test the flow end-to-end. |

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
| **`cancel_escrow` / `refund_deposit` contract fn (v4)** | Proper instant pre-expiry refund on cancel. **Now promoted to a v1 requirement of Phase 1h.5** (`ARIA_FEE_DESIGN.md` v2.1 §7/§11): `refund_deposit` (arbitrator-signed, pre-check-in) ships in the same v4 upgrade so `/booking/cancel` returns deposit + payment together instead of making a cancelling guest wait for `auto_release` at expiry. No longer a deferred fast-follow. |
| **R6** — scope `/bookings/all` to host's properties | Multi-tenant isolation; only matters once host-owned listings ship. |
| **M3** — per-user zkLogin salt (+ migration) | salt `'0'` lets anyone derive a user's Sui address from their Google `sub`. Re-derives addresses → migration required. |
| **M4** — DB TLS CA cert | `rejectUnauthorized:false` is a MITM risk; supply the Railway CA cert. |
| **M6** — Stripe webhook / payment capture | Card path creates an intent but never confirms capture; bookings can be `confirmed` without paid card. |
| **R10** — externalize rate-limit + single cron | In-process now; hard prerequisite before a 2nd Railway instance. |
| **R8** — numbered SQL migrations | Replace chained `ALTER TABLE IF NOT EXISTS`; minimal runner, no heavy ORM. |
| **R11** — integration tests + CI | booking→confirm, cancel→escrow, auth middleware; wire `escrow.test.mjs` + `sui move test` into CI. |
| **R12 / R13** | Incremental TS on backend; frontend componentization — as features demand. |
| **R1 (full split)** | Break `server.mjs` into `routes/*.mjs` plugins (middleware half already done). |
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

## 6. Deliberately Deferred

### zkLogin salt = `'0'`
Changing re-derives every user's Sui address, orphaning existing data.
Follow-up: per-user secret salt with migration.

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
ESCROW_PACKAGE_ID       = 0xec0d6bd45d6bbf3aad04778ace4aacef33c071a30d79090532ba1697644d8fa1
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

## 9. Resources

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
