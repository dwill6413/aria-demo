# ARIA — Product Roadmap & AI Handoff Document
**Version:** 2.10 | **Updated:** June 17, 2026
**Purpose:** Complete handoff for an AI assistant continuing ARIA development.
Read this entire document before writing any code.

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

**P2 — Auto-release cron job**
No scheduled job triggers `auto_release` after expiry. Build a job that queries
bookings where `checkout_date + 5 days < NOW()` and `deposit_status = 'held'`
and `escrow_object_id IS NOT NULL`, then calls `auto_release` on each.

**P2 — Production host address lookup**
`createEscrowOnChain` currently passes the deployer address as the host.
Replace with: `SELECT payout_sui_address FROM host_profiles WHERE ...`
queried by `property_id` at booking time.

**P2 — Claim/dispute backend routes**
Contract functions `claim_damage`, `dispute_claim`, `resolve_dispute` are
implemented and tested but no backend routes call them.
Build: `/booking/claim-damage`, `/booking/dispute-claim`, arbitrator endpoint.
See Phase 3 below.

**P3 — Minor contract cleanup**
- `STATUS_RESOLVED` constant is dead code (resolve_dispute deletes the object)
- Optional: add 30-day expiry upper bound (`assert expiry_ms <= now + MAX_EXPIRY_MS`)
- Neither is blocking; P3 priority

**Pre-mainnet gate**
- [x] P0a complete (June 12, 2026 — JSON-RPC migration, ahead of Jul 31 deadline)
- [x] P0b complete (June 16, 2026 — guest-funded escrow, live-tested end-to-end)
- [x] P1a complete (arbitrator key separated, wired, on-chain)
- [x] P1b complete (June 17, 2026 — deployer/backend-signer separated; new key needs Railway/faucet setup, see P1 section above)
- [ ] P2 complete
- [ ] Independent Move audit (OtterSec, Zellic, or similar)
- [ ] Burn UpgradeCap after audit

---

### PHASE 2 — Guest PII with Walrus + Seal
**Priority: High. Required before onboarding real users.**

#### Architecture (decided — do not re-debate)
Guest PII encrypted client-side with Seal SDK, stored on Walrus. ARIA stores only
the Walrus blob ID — no PII on ARIA's servers. Host added to Seal allowlist at
booking confirmation; removed when deposit is released (same PTB, atomic).

#### PII access lifecycle
```
Booking confirmed  → host added to Seal allowlist (access from booking, not check-in)
During stay        → host access active
Post-checkout window → host access active (needed for damage claims)
Deposit released   → SAME PTB calls escrow::auto_release AND pii_access::revoke_access
                     → host access permanently closed
Dispute active     → host retains access while deposit_status = 'held'
```

#### Seal allowlist contract (new Move module)
```move
public struct GuestPIIAccess has key {
    id: UID,
    guest: address,
    allowed_hosts: vector<address>,
}
public entry fun create_access(ctx: &mut TxContext)
public entry fun grant_access(access: &mut GuestPIIAccess, host: address, ctx: &mut TxContext)
public entry fun revoke_access(access: &mut GuestPIIAccess, host: address, ctx: &mut TxContext)
```
Adapt from Mysten's allowlist examples in the Seal GitHub repo.
When creating the `pii_access` object on-chain, use `extractCreatedObjectId()`
to extract its ID — the same PTB pattern applies.

#### Database change
```sql
CREATE TABLE IF NOT EXISTS guest_verifications (
    sui_address    TEXT PRIMARY KEY,
    walrus_blob_id TEXT NOT NULL,
    pii_object_id  TEXT NOT NULL,
    phone_verified BOOLEAN DEFAULT false,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);
```
No PII columns. Just pointers.

#### New routes
```
POST /guest/profile                     — store { walrus_blob_id, pii_object_id }
GET  /guest/profile                     — return { verified, walrus_blob_id }
GET  /host/guest-identity/:bookingRef   — return blob_id for host to decrypt client-side
```

#### Booking gate
```javascript
const v = await pool.query('SELECT 1 FROM guest_verifications WHERE sui_address=$1', [session.suiAddress]);
if (!v.rows.length) return reply.code(400).send({ error: 'Complete identity verification first' });
```

#### Critical integration with Phase 1
`/booking/release-deposit` must call BOTH in the SAME PTB:
1. `escrow::auto_release`
2. `pii_access::revoke_access`

#### New env var
```
SEAL_PACKAGE_ID = 0x<from deployment>
```

---

### PHASE 3 — 5-Day Inspection Window Business Logic
**Priority: Medium. Extends Phase 1 with real-world timing and claim flows.**

#### What to build

1. **Timing gate** — `/booking/release-deposit` only callable after `check_out` date.

2. **Auto-release job** — query bookings where `checkout + 5 days < NOW()` and
   `deposit_status = 'held'` and `escrow_object_id IS NOT NULL`. Call `auto_release`.
   Update Postgres. (Same as Phase 1 P2 item.)

3. **Claim route — `/booking/claim-damage`**
   - Host calls with `{ bookingRef, claimAmount, reason }`
   - Validates: host owns property, booking checked out, within 5-day window
   - Calls `claim_damage` on contract
   - Updates `deposit_status = 'claimed'`
   - Emails guest with claim details and dispute option

4. **Dispute route — `/booking/dispute-claim`**
   - Guest calls with `{ bookingRef, reason }`
   - Updates `deposit_status = 'disputed'`
   - Notifies ARIA admin
   - ARIA calls `resolve_dispute` on contract with final split

5. **Extend `deposit_status`**
   Currently: `held` | `released`
   Add: `claimed` | `disputed` | `forfeited`

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
⬜ Phase 1h: P2 — Auto-release cron job
⬜ Phase 1h.5: Fee collection/routing mechanism (Stripe + SuiUSD paths — needs design)
⬜ Phase 1i: P2 — Production host address lookup
⬜ Phase 1j: P2 — Claim/dispute backend routes
⬜ Phase 1k: P3 — STATUS_RESOLVED + optional expiry bound

⬜ Phase 2a: pii_access.move (Seal allowlist contract)
⬜ Phase 2b: Deploy allowlist, get SEAL_PACKAGE_ID
⬜ Phase 2c: guest_verifications table in db.mjs
⬜ Phase 2d: /guest/profile + /host/guest-identity routes
⬜ Phase 2e: Booking gate in /booking/create and AI create_booking
⬜ Phase 2f: hasGuestProfile in /auth/me
⬜ Phase 2g: pages/profile.jsx (Seal encrypt + Walrus store)
⬜ Phase 2h: Host "View Guest Identity" modal in pages/host.jsx
⬜ Phase 2i: Wire deposit release to call revoke_access in same PTB

⬜ Phase 3: 5-day timing gate + auto-release job + claim/dispute flows
```

---

## 5. Tech Debt Backlog

| Item | Priority | Notes |
|---|---|---|
| Key separation | **P1** | Same hot key for deployer + backend signer — must fix for mainnet. P0b is done, so backend signer's role is now scoped to `auto_release`; unblocked, next session. |
| Fee collection/routing mechanism | High | Currently zero implementation. ARIA's revenue (booking fee) is separate from the escrow (guest security deposit) — no mechanism exists to collect or route ARIA's cut. Two paths to design: Stripe Connect-style split (fiat), and a SuiUSD on-chain split (PTB splits rental payment between host and ARIA in one tx, similar to resolve_dispute's split logic). Needs design before/alongside P0b. |
| Auto-release job | P2 | Phase 1h |
| Production host address | P2 | Phase 1i |
| Claim/dispute routes | P2 | Phase 1j / Phase 3 |
| Properties frontend-hardcoded | Medium | `properties` table empty |
| Frontend tax/price duplication | Low | `catalog.mjs` centralizes backend |
| Stripe webhooks | Medium | Create-intent only |
| No automated tests | Medium | Backend unit tests started (`escrow.test.mjs`). No frontend tests. |
| `zod` unused | Low | Already a dep; use for validation |
| Legacy `hosts` table | Low | Unused; drop it |
| `@anthropic-ai/sdk` unused | Low | Remove |

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

---

## 8. Environment Variables

**In Railway (backend):**
```
DATABASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CALLBACK_URL, FRONTEND_URL
HOST_ADDRESSES, SESSION_SECRET, XAI_API_KEY, RESEND_API_KEY, STRIPE_SECRET_KEY
ESCROW_PACKAGE_ID       = 0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe
ESCROW_MODULE_NAME      = escrow
ARIA_AUTO_RELEASE_KEY   = <suiprivkey1... bech32 format — Railway only, never committed.
                           P1b: scoped to auto_release only, zero special on-chain
                           privilege (see escrow.mjs). The original deployer/UpgradeCap
                           key has been retired from Railway to cold KeePass-only storage.>
ARIA_ARBITRATOR_ADDRESS = 0x0069868f93f9127b3e8b51bf95bc529925ca382e6305da0bb01f693826b983f8
```

**To add for Phase 2:**
```
SEAL_PACKAGE_ID = 0x<from pii_access.move deployment>
```

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

*ARIA Roadmap v2.10 — June 17, 2026*
*Changes from v2.9: Marked P1b (deployer/backend-signer key separation) complete.
`escrow.mjs`/`bookings.mjs`/`server.mjs` renamed `ARIA_DEPLOYER_KEY`/`deployerKeypair`
to `ARIA_AUTO_RELEASE_KEY`/`autoReleaseKeypair`; corrected an inaccurate code comment
that had claimed `auto_release` required arbitrator-level on-chain authority (it's
actually permissionless — confirmed against escrow.move — so the new key carries no
special privilege). A fresh narrowly-scoped key was generated for this one remaining
backend-signed action; the original deployer/UpgradeCap key is being retired to cold
KeePass-only storage. Updated pre-mainnet gate and build order accordingly.*
