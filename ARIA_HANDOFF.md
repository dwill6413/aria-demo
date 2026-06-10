# ARIA — Technical Handoff Document
**Version:** 4.2 | **Updated:** June 10, 2026

Deeper technical details for developers or AI assistants continuing work on ARIA.
Reconciled against the code actually deployed to production as of June 10, 2026.
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

`@mysten/sui@2.16.3` SDK client methods (`SuiJsonRpcClient`, `SuiGrpcClient`,
`signAndExecuteTransaction`) are incompatible with the deployed Node 22 environment.
The working pattern in `server.mjs` is raw JSON-RPC:

```javascript
// 1. Fetch gas price + deployer coin via raw RPC helper
const gasPrice = BigInt(await suiRpc('suix_getReferenceGasPrice', []));
const coins    = await suiRpc('suix_getCoins', [sender, '0x2::sui::SUI', null, 1]);

// 2. Build PTB with all params explicit — no SDK client needed
tx.setGasPrice(gasPrice);
tx.setGasBudget(50_000_000n);
tx.setGasPayment([{ objectId, version, digest }]);
tx.sharedObjectRef({ objectId: '0x6', initialSharedVersion: 1, mutable: false }); // Clock
const txBytes = await tx.build(); // no client argument

// 3. Sign + submit via raw fetch
const signed = await deployerKeypair.signTransaction(txBytes);
await suiRpc('sui_executeTransactionBlock', [base64bytes, [sig], options]);
```

Do NOT use `SuiJsonRpcClient.signAndExecuteTransaction` or `SuiGrpcClient` —
both fail in the current environment. See `createEscrowOnChain` and
`autoReleaseEscrow` in `server.mjs` for the full working implementation.

### Testnet → mainnet changes (one line each)

- **Coin type**: `'0x2::sui::SUI'` → actual SuiUSD coin type address
- **Expiry**: `Date.now() + 300_000n` (5 min testnet) → `checkoutMs + 432_000_000n` (5 days)
- **Move.toml**: `rev = "framework/testnet"` → `rev = "framework/mainnet"`
- **UpgradeCap**: keep for testnet → burn after independent audit for mainnet
- **Escrow funding**: deployer funds escrow (testnet) → guest wallet signs and funds (production)

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
  addresses — never to a third address. Active, claimed, and released escrows
  are unreachable by the arbitrator key.
- **No reentrancy**: Move's object model makes this structurally impossible.
- **No integer overflow**: Move u64 aborts on overflow; no silent wrapping.
- **No emergency withdraw / pause**: this is intentional and correct. An
  emergency withdraw is by definition an admin drain path and would make ARIA's
  non-custodial claim false at the contract level. A pause function creates a
  griefing vector (who pauses? can it block a guest's rightful auto-release?).
  The protection against contract bugs is per-object isolation plus immutability
  after mainnet audit — not a backdoor. **Do not add either of these.**

### Issues — prioritized

#### P0 — Must fix before mainnet with real funds

**Deployer-funded escrow**

On testnet, ARIA's deployer wallet signs `create_escrow` and provides the deposit
coin from its own SUI balance. This means the deployer — not the guest — holds
the escrowed funds. The non-custodial claim only becomes true when the guest's
zkLogin wallet signs the transaction and provides the coin from their own balance.

This is the most important production gap in the entire system. Everything else
is secondary to it.

Fix: implement client-side PTB signing using the guest's zkLogin wallet for
`create_escrow`. The guest approves the transaction from their browser; the
booking confirmation flow shows the expiry timestamp so it is transparent before
they sign. ARIA's backend orchestrates but does not provide the coin.

#### P1 — Fix before mainnet

**Hot key conflation (single point of failure)**

The backend transaction-signing key (`ARIA_DEPLOYER_KEY` in Railway), the
contract deployer, and the per-escrow arbitrator are all the same address. A
single key compromise enables an attacker to: forge `create_escrow` calls with
arbitrary parameters; and call `resolve_dispute` on any disputed escrow to
redirect the split.

Fix: separate into three distinct keys before mainnet:

1. **Deployer key** — used once to publish the package, then retired or kept cold.
2. **Backend signer** — Railway env var for `auto_release` and permissionless ops only.
3. **Arbitrator key** — cold wallet or 2-of-3 multisig. Set per-escrow at booking
   time. Never exposed to the backend process.

The contract already stores `arbitrator` per-escrow; this fix is operational, not
a contract change. The contract does not need to be redeployed.

#### P2 — Fix before launch with real users

**Auto-release cron job missing**

`auto_release` is callable by anyone after `expiry_ms`, but there is no scheduled
job to trigger it. Guests depend on the host releasing manually or calling
`auto_release` themselves — which they won't know to do.

Fix: scheduled job queries `bookings` where `checkout_date + 5 days < NOW()`,
`deposit_status = 'held'`, and `escrow_object_id IS NOT NULL`, then calls
`auto_release`. See roadmap Phase 1f.

**Production host address lookup**

`create_escrow` currently records the deployer address as the `host` in the
escrow object. Production must use the actual host's Sui address.

Fix: one DB query in `createEscrowOnChain`:
```javascript
SELECT payout_sui_address FROM host_profiles
WHERE status = 'approved' AND <property ownership condition>
```

**Claim/dispute backend routes not wired**

`claim_damage`, `dispute_claim`, and `resolve_dispute` exist in the contract and
are fully tested, but no backend routes call them. The 5-day inspection window
and dispute flow are non-functional at the application layer.

Fix: Phase 3 routes — `/booking/claim-damage`, `/booking/dispute-claim`, and
the arbitrator resolution endpoint. See roadmap.

#### P3 — Clean up, not blocking

**`STATUS_RESOLVED` is dead code**

The constant `u8 = 4` is defined but `resolve_dispute` consumes and deletes the
escrow object rather than writing a final status. The constant is never written.
Delete it, or retain it and set it before deletion for event indexing clarity.

**Expiry has no upper bound**

`expiry_ms` is caller-supplied; the contract only checks it is in the future. A
misconfigured backend could create a 100-year escrow. Consider adding a sanity
bound:
```move
const MAX_EXPIRY_MS: u64 = 30 * 24 * 60 * 60 * 1000; // 30 days
assert!(expiry_ms <= clock::timestamp_ms(clock) + MAX_EXPIRY_MS, EExpiryTooFar);
```

### Pre-mainnet checklist

- [ ] **P0**: Guest wallet signs and funds `create_escrow` (client-side PTB)
- [ ] **P1**: Separate deployer / backend-signer / arbitrator keys
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
`@mysten/sui@2.16.3`. Do not downgrade.

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
| `server.mjs` | Main Fastify server | Routes, RBAC, escrow helpers, raw RPC pattern |
| `catalog.mjs` | Prices + tax rates | Single source of truth |
| `db.mjs` | Pool + `initDB()` | 10 tables, `escrow_object_id` column, idempotent |
| `auth.mjs` | OAuth + sessions | JWT verification, CSPRNG IDs |
| `ai_route.mjs` | Grok AI agent | Server-derived role, per-tool authz |
| `nixpacks.toml` | Railway build config | Node 22 required |
| `contracts/aria_escrow/` | Move smart contract | escrow.move + 23 tests |
| `pages/ai.jsx` | AI chat UI | HTML-escaped output |
| `pages/bookings.jsx` | Guest dashboard | `fmtDay()`, mobile-responsive nav |
| `pages/host.jsx` | Host dashboard | Mobile-responsive nav |
| `pages/index.jsx` | Homepage + booking modal | Mobile-responsive hamburger nav |

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
5. No automated backend/frontend tests.
6. `hosts` table and `@anthropic-ai/sdk` unused; `zod` not used for validation.

---

## Environment Variables (current)

**Railway:**
```
DATABASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CALLBACK_URL, FRONTEND_URL
HOST_ADDRESSES, SESSION_SECRET, XAI_API_KEY, RESEND_API_KEY, STRIPE_SECRET_KEY
ESCROW_PACKAGE_ID   = 0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe
ESCROW_MODULE_NAME  = escrow
ARIA_DEPLOYER_KEY   = <suiprivkey1... bech32 format — in Railway, never commit>
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
- For Sui transactions, use the raw RPC pattern — do not use SDK client methods.
- Do not add emergency withdraw or pause functions to the contract.
- Keep this doc, `ARIA_ROADMAP.md`, and `ARIA_REMEDIATION.md` in sync.

---

*Technical Handoff v4.2 — June 10, 2026*
*Changes from v4.1: Full security audit with corrected priorities. P0 (guest-funded
escrow) and P1 (key separation) added as top production blockers. Emergency
withdraw/pause recommendation explicitly rejected with rationale.*
