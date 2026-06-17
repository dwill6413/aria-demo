# ARIA — Technical Handoff Document
**Version:** 4.10 | **Updated:** June 17, 2026

Deeper technical details for developers or AI assistants continuing work on ARIA.
Reconciled against the code actually deployed to production as of June 17, 2026.
For the security change log see `ARIA_REMEDIATION.md`. For the build roadmap see `ARIA_ROADMAP.md`.

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

## Database Tables (10)

`properties`, `bookings`, `reviews`, `messages`, `hosts` (legacy/unused),
`tax_remittances`, `host_profiles`, `sessions`, `property_ical_feeds`,
plus `escrow_object_id TEXT` column on `bookings`.

`initDB()` in `db.mjs` creates all tables idempotently (`IF NOT EXISTS`) and adds
the `escrow_object_id` column via `ALTER TABLE IF NOT EXISTS`.

---

## Smart Contract (Phase 1 — Live)

A Move smart contract is deployed on Sui testnet. Every confirmed booking creates
a `BookingEscrow<SUI>` shared object that holds the deposit on-chain.

| Item | Value |
|---|---|
| Package ID | `0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe` |
| Module | `escrow` |
| Network | Sui testnet |
| UpgradeCap | `0x41f043cf28d0bb77ef6031c5208b611bdd673992afa9e27763b41033e4a327eb` |
| Deployer address | `0x24bd37a7d13a78de81bd5345899da8b7a4d41ebf26fc1af6f934f9841c7d97f3` |
| Source | `contracts/aria_escrow/sources/escrow.move` |

Contract functions: `create_escrow`, `auto_release`, `claim_damage`,
`accept_claim`, `dispute_claim`, `resolve_dispute`. All 23 unit tests pass.

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
the chain-queried result of the guest-submitted `create_escrow` digest. Use
this function for Phase 2's `pii_access` object creation too — do not inline
the filter logic again.

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

- **Coin type**: `'0x2::sui::SUI'` → actual SuiUSD coin type address
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

#### P2 — Fix before launch with real users

- Auto-release cron job missing
- Production host address lookup (`payout_sui_address` from `host_profiles`)
- Claim/dispute backend routes not wired

#### P3 — Clean up, not blocking

- `STATUS_RESOLVED` is dead code in the contract
- Optional: 30-day expiry upper bound in contract

### Pre-mainnet checklist

- [x] **P0a**: Migrate off JSON-RPC to gRPC (done June 12, 2026)
- [x] **P0b**: Guest wallet signs and funds `create_escrow` (done June 16, 2026, live-tested)
- [x] **P1a**: Arbitrator key separated (done June 12, 2026)
- [x] **P1b**: Separate deployer/UpgradeCap from backend signer (code done June 17, 2026 — Railway/faucet setup for the new key is a pending manual step, see P1b above)
- [ ] **P2**: Auto-release cron job built and running
- [ ] **P2**: Production host address lookup from `host_profiles`
- [ ] **P2**: Claim/dispute backend routes wired
- [ ] **P3**: `STATUS_RESOLVED` dead code resolved
- [ ] **P3**: Optional 30-day expiry upper bound
- [ ] Independent Move audit (OtterSec, Zellic, or similar)
- [ ] Burn UpgradeCap after audit passes

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
| `server.mjs` | Main Fastify server | Routes, RBAC, escrow helpers |
| `escrow.test.mjs` | Unit tests for `extractCreatedObjectId` | 15 tests, no network needed. Imports the real function from `escrow.mjs` (no longer a hand-copied duplicate). Run: `node escrow.test.mjs` |
| `catalog.mjs` | Prices + tax rates | Single source of truth |
| `db.mjs` | Pool + `initDB()` | 10 tables + indexes on `bookings.wallet_address`/`bookings.property_id`/`messages.booking_ref`, `escrow_object_id` column, idempotent |
| `auth.mjs` | OAuth + sessions | JWT verification, CSPRNG IDs |
| `ai_route.mjs` | Grok AI agent | Server-derived role, per-tool authz |
| `validation.mjs` | zod request schemas | Validates `/booking/create`, `/payment/create-intent`, `/host/apply` bodies |
| `bookings.mjs` | Shared `createBooking()` | Used by both REST and AI booking paths; booking refs include a random hex suffix |
| `lib/authFetch.js` | Shared session-aware fetch | Used by all 6 authenticated frontend pages |
| `nixpacks.toml` | Railway build config | Node 22 required |
| `contracts/aria_escrow/` | Move smart contract | escrow.move + 23 tests |
| `pages/ai.jsx` | AI chat UI | HTML-escaped output |
| `pages/bookings.jsx` | Guest dashboard | Full wallet address + copy button |
| `pages/host.jsx` | Host dashboard | Full wallet address + copy button |
| `pages/index.jsx` | Homepage + booking modal | Full wallet address + copy button |

---

## Deliberately Deferred

1. **zkLogin salt `'0'`** — changing orphans existing addresses. Migration required.
2. **DB TLS unverified** — Railway cert issue. Supply CA cert before mainnet.
3. **Session token in URL** — cross-domain dependency. One-time code exchange deferred.

---

## Current Technical Debt

1. Properties frontend-hardcoded; `properties` table empty.
2. Frontend tax/price duplication — `catalog.mjs` centralizes backend; frontend copy remains.
3. Stripe: create-intent only; webhooks missing.
4. Error handling inconsistent in some routes.
5. No automated backend/frontend tests (backend unit tests started with `escrow.test.mjs`).
6. `hosts` table and `@anthropic-ai/sdk` unused. `zod` is now adopted — see `validation.mjs`.
7. **Fee collection/routing mechanism — zero implementation.** ARIA's revenue
   (booking fee) is entirely separate from the escrow (guest security deposit) —
   no mechanism exists to collect or route ARIA's cut. Needs design for both
   Stripe (Connect-style split) and SuiUSD on-chain (PTB split between host and
   ARIA, similar to `resolve_dispute`'s split logic). Needs design before/alongside P0b.

---

## Environment Variables (current)

**Railway:**
```
DATABASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CALLBACK_URL, FRONTEND_URL
HOST_ADDRESSES, SESSION_SECRET, XAI_API_KEY, RESEND_API_KEY, STRIPE_SECRET_KEY
ESCROW_PACKAGE_ID       = 0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe
ESCROW_MODULE_NAME      = escrow
ARIA_AUTO_RELEASE_KEY   = <suiprivkey1... bech32 format — in Railway, never commit.
                           P1b: scoped to auto_release only, zero special privilege.>
ARIA_ARBITRATOR_ADDRESS = 0x0069868f93f9127b3e8b51bf95bc529925ca382e6305da0bb01f693826b983f8
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
- Keep this doc, `ARIA_ROADMAP.md`, and `ARIA_REMEDIATION.md` in sync.

---

*Technical Handoff v4.10 — June 17, 2026*
*Changes from v4.9: Marked P1b (deployer/backend-signer key separation) complete.
Renamed `ARIA_DEPLOYER_KEY`/`deployerKeypair` to `ARIA_AUTO_RELEASE_KEY`/
`autoReleaseKeypair` throughout `escrow.mjs`/`bookings.mjs`/`server.mjs`.
Corrected an inaccurate comment (and this doc's matching code example) that had
claimed `auto_release` required arbitrator-level authority — verified against
`escrow.move` that it's actually permissionless, so the new key needs no special
on-chain privilege. Also fixed several stale `server.mjs` file attributions for
code that was already living in `escrow.mjs` since the Phase 2b extraction
(`buildEscrowTransaction`, `extractCreatedObjectId`, `autoReleaseEscrow`).
Updated pre-mainnet checklist and P1 audit section accordingly.*
