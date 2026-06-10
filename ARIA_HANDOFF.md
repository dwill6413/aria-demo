# ARIA — Technical Handoff Document (v4.1)

**Version:** 4.1 | **Updated:** June 10, 2026  
**Previous:** v4.0 (June 10, 2026) — Phase 1 escrow live.  
**Purpose:** Deeper technical details for developers or AI assistants (Claude, Grok, etc.) continuing work on ARIA. Reconciled against deployed code.

*(Original v4.0 content preserved below for complete context)*

# ARIA — Technical Handoff Document

**Version:** 4.0 | **Updated:** June 10, 2026

Deeper technical details for developers or AI assistants continuing work on ARIA.  
Reconciled against the code actually deployed to production as of June 10, 2026.  
For the security change log see `ARIA_REMEDIATION.md`. For the build roadmap see `ARIA_ROADMAP.md`.

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

## Database Tables (10)

`properties`, `bookings`, `reviews`, `messages`, `hosts` (legacy/unused),  
`tax_remittances`, `host_profiles`, `sessions`, `property_ical_feeds`,  
plus `escrow_object_id TEXT` column on `bookings`.

`initDB()` in `db.mjs` creates all tables idempotently (`IF NOT EXISTS`) and adds  
the `escrow_object_id` column via `ALTER TABLE IF NOT EXISTS`.

## Smart Contract (Phase 1 — Live)

A Move smart contract is deployed on Sui testnet. Every confirmed booking creates  
a `BookingEscrow<SUI>` shared object that actually holds the deposit on-chain.

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
const coins = await suiRpc('suix_getCoins', [sender, '0x2::sui::SUI', null, 1]);

// 2. Build PTB with all params set explicitly — no SDK client needed
tx.setGasPrice(gasPrice);
tx.setGasBudget(50_000_000n);
tx.setGasPayment([{ objectId, version, digest }]);
// Use sharedObjectRef for shared objects (Clock, escrow objects)
tx.sharedObjectRef({ objectId: '0x6', initialSharedVersion: 1, mutable: false });
const txBytes = await tx.build(); // no client argument

// 3. Sign + submit via raw fetch
const signed = await deployerKeypair.signTransaction(txBytes);
await suiRpc('sui_executeTransactionBlock', [base64bytes, [sig], options]);
```

Do NOT attempt `SuiJsonRpcClient.signAndExecuteTransaction` or any SDK client  
execution method — they fail in the current environment. See `createEscrowOnChain`  
and `autoReleaseEscrow` in `server.mjs` for the full working implementation.

### Testnet vs mainnet (one change each)
- **Coin type**: `'0x2::sui::SUI'` → actual SuiUSD coin type address  
- **Expiry**: `Date.now() + 300_000n` (5 min for testing) → `checkoutMs + 432_000_000n` (5 days)  
- **Move.toml**: `rev = "framework/testnet"` → `rev = "framework/mainnet"`  
- **UpgradeCap**: keep for testnet → burn after audit for mainnet

## Key Technical Decisions

### Cross-Domain Auth
- Backend (Railway) and frontend (Vercel) are on different domains.  
- Session ID is passed via URL param (`?sid=`) after OAuth callback, stored in  
  `localStorage`, sent as `x-session-id` header. See `authFetch()` in frontend.  
- **Known limitation:** token in URL is not ideal. Deferred — see below.

### Session Management
- Sessions persisted in `sessions` table; survive Railway restarts.  
- Functions: `getSession()`, `saveSession()`, `deleteSession()`, `purgeExpiredSessions()`.  
- Session IDs generated with `crypto.randomBytes(32)` (CSPRNG).  
- Stored: `suiAddress`, `email`, `name`, `picture`, `createdAt`. Private key and  
  `id_token` are NOT stored.

### Authoritative Pricing & Tax
- `catalog.mjs` is the single source of truth for property prices and  
  `JURISDICTION_TAX_RATES`. Both `server.mjs` and `ai_route.mjs` import from it.  
- Client-supplied prices are ignored. Frontend still has its own copy for display  
  (remaining duplication — see tech debt).

### Node Version
Railway now runs **Node 22** (`nixpacks.toml`: `nodejs_22`). This was required  
by `@mysten/sui@2.16.3` which has `engines: { node: ">=22" }`. Do not downgrade.

## Security Hardening (all live)

1. **AI agent role is server-derived** from session, not client `mode` flag.  
2. **Google JWT verification** — RS256 against JWKS, nonce checked.  
3. **Server-side price validation** from `catalog.mjs`.  
4. **IDOR fixes** — ownership verified on messages, reviews, deposit release.  
5. **XSS fix** — AI chat output HTML-escaped before rendering.  
6. **CSPRNG session IDs** and minimal session storage.  
7. **Honest booking writes** — failed inserts return 500, not silent "confirmed."  
8. **Performance** — N+1 fixed in `get_all_messages`, indexes added.

## Date Handling

- Calendar dates use `fmtDay()` — formats from Y-M-D parts, never shifts timezone.  
- Timestamps use `fmtDate()` / `fmtDateTime()` — timezone-aware.

## Important Files

| File | Purpose | Notes |
|---|---|---|
| `server.mjs` | Main Fastify server | Routes, RBAC, escrow helpers, raw RPC pattern |
| `catalog.mjs` | Prices + tax rates | Single source of truth |
| `db.mjs` | Pool + `initDB()` | 10 tables, `escrow_object_id` column, idempotent |
| `auth.mjs` | OAuth + sessions | JWT verification, CSPRNG IDs |
| `ai_route.mjs` | Grok AI agent | Server-derived role, per-tool authz |
| `nixpacks.toml` | Railway build config | Node 22 required |
| `contracts/aria_escrow/` | Move smart contract | escrow.move + tests |
| `pages/ai.jsx` | AI chat UI | HTML-escaped output |
| `pages/bookings.jsx` | Guest dashboard | `fmtDay()`, mobile-responsive nav |
| `pages/host.jsx` | Host dashboard | Mobile-responsive nav |
| `pages/index.jsx` | Homepage + booking modal | Mobile-responsive hamburger nav |

## Deliberately Deferred

1. **zkLogin salt `'0'`** — changing orphans existing addresses. Migration required.  
2. **DB TLS unverified** — Railway cert issue. Supply CA cert before mainnet.  
3. **Session token in URL** — cross-domain dependency. One-time code exchange deferred.  
4. **Production host address** — escrow currently uses deployer address as host.  
   Production: look up `host_profiles.sui_address` by `property_id`.  
5. **Auto-release job** — cron to auto-release expired escrows not yet built.  
6. **Claim/dispute flows** — contract functions exist; backend routes not yet wired.

## Current Technical Debt

1. **Properties**: frontend-hardcoded; `properties` table empty.  
2. **Frontend tax/price duplication**: `catalog.mjs` centralizes backend; frontend copy remains.  
3. **Stripe**: create-intent only; webhooks missing.  
4. **Error handling**: inconsistent in some routes.  
5. **Testing**: no automated backend/frontend tests.  
6. **Legacy**: `hosts` table and `@anthropic-ai/sdk` unused; `zod` not used for validation.

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

## Best Practices for Changes

- Always use `authFetch()` in the frontend.  
- Use `requireSession` / `requireHost` / `requireSuperadmin` in `server.mjs`.  
- For AI agent, gate host tools by server-derived `isHost`, not request body.  
- Compute money and dates server-side; render calendar dates with `fmtDay()`.  
- All `db.mjs` DDL must stay idempotent.  
- For Sui transactions, use the raw RPC pattern — do not use SDK client methods.  
- Keep this doc, `ARIA_ROADMAP.md`, and `ARIA_REMEDIATION.md` in sync.

---
*Technical Handoff v4.0 — June 10, 2026*  
*Major change from v3.0: Phase 1 on-chain escrow complete and live.*

---

### New Section: Deep Security Audit of Smart Contract (Added v4.1, June 10, 2026)

**Audit Scope**: Full review of `contracts/aria_escrow/sources/escrow.move` + tests.  
**Overall Assessment**: Solid and audit-passing for demo scope. No critical fund-draining bugs in normal flows. Strong status machine, exact coin handling, and test coverage.

**Prioritized Recommendations** (implement in this order):

#### Critical / High Priority
1. **Arbitrator Role Hardening**  
   Single address is a single point of failure (compromise = arbitrary splits on disputes).  
   **Action**: Replace with multisig, capability object, or governance. Update `resolve_dispute` + tests. Do before mainnet/real funds.

2. **Auto-Release Cron Job**  
   **Action**: Backend job for escrows past checkout + 5 days. Use raw RPC.

3. **Production Host Address Lookup**  
   **Action**: Query `host_profiles` by `property_id` instead of deployer.

#### Medium Priority
4. **Wire Claim/Dispute Backend Routes**.  
5. **STATUS_RESOLVED Consistency** (constant exists but unused).  
6. **Timing/Expiry Polish** (consistent calcs, optional extensions).

#### Lower Priority
7. Emergency withdraw/pause.  
8. Enhanced events.  
9. Burn UpgradeCap post-audit.  
10. Third-party formal audit (e.g., OtterSec/Zellic).

**Audit Conclusion**: Contract is ready for demo/Sui Overflow after #1–#3. Keep synced with Roadmap.
