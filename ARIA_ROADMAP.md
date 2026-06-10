# ARIA — Product Roadmap & AI Handoff Document
**Version:** 2.0 | **Updated:** June 10, 2026
**Purpose:** Complete handoff for an AI assistant continuing ARIA development.
Read this entire document before writing any code.

---

## 1. Project Context

ARIA is a vacation rental dApp on Sui blockchain (testnet). It is NOT being pivoted —
the vacation rental direction is confirmed. Several strategic alternatives were
evaluated and rejected (boat rentals / "Helm", freelance escrow, contractor payments)
and the decision was made to evolve ARIA as a vacation rental platform with genuine
on-chain primitives.

The stablecoin thesis is the north star: ARIA uses SuiUSD as its primary payment
rail. On-chain escrow, instant settlement, and non-custodial architecture are the
real differentiators — not just marketing.

**Existing documentation (read these first):**
- `ARIA_HANDOFF.md` v3.0 — accurate technical state of deployed code
- `ARIA_REMEDIATION.md` — full security change log with rationale

**Live deployments:**
- Frontend: `https://aria-demo-psi.vercel.app` (Vercel, Next.js)
- Backend: `https://aria-demo-production-e590.up.railway.app` (Railway, Fastify ESM)
- Repo: `https://github.com/dwill6413/aria-demo`

---

## 2. What Is Already Built and Deployed

Everything below is live in production on testnet. Do not rebuild it.

- Google OAuth → zkLogin (seedless wallet onboarding)
- Postgres-backed sessions (cryptographically random IDs)
- Google JWT verification on callback
- Server-side pricing from `catalog.mjs` (tamper-proof)
- AI agent (Grok) with server-derived role, per-tool authorization
- Booking CRUD (create, cancel, history) — REST + AI paths
- **On-chain escrow** — `BookingEscrow` shared object created at booking confirmation
- Walrus immutable receipts (booking + cancellation + deposit release)
- Resend email confirmations
- Stripe fallback payment intent
- iCal export/import + availability checking
- Host dashboard (bookings, revenue, tax, applications, reviews)
- Guest bookings page with correct timezone-safe date display
- 10-table Postgres schema with indexes including `escrow_object_id` column
- RBAC: `requireSession`, `requireHost`, `requireSuperadmin` helpers
- IDOR protections on messages, reviews, deposit release
- XSS protection on AI chat output
- Mobile-responsive nav with hamburger menu (all 4 pages)

---

## 3. Roadmap

### ✅ PHASE 1 — Security Deposit Smart Contract
**Status: COMPLETE — deployed and verified end-to-end on June 10, 2026**

#### What was built
- Move smart contract (`contracts/aria_escrow/sources/escrow.move`)
- 23/23 unit tests passing (`contracts/aria_escrow/tests/escrow_tests.move`)
- Deployed to Sui testnet — **Package ID:**
  `0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe`
- `escrow_object_id` column added to `bookings` table in `db.mjs`
- `/booking/create` calls `create_escrow` on-chain; stores returned object ID
- `/booking/release-deposit` calls `auto_release` on-chain
- Node.js upgraded to 22 in `nixpacks.toml` (required by `@mysten/sui@2.16.3`)
- Transaction signing uses raw JSON-RPC fetch (bypasses SDK client incompatibilities)

#### Deployed contract details
| Item | Value |
|---|---|
| Package ID | `0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe` |
| Module | `escrow` |
| Network | Sui testnet |
| UpgradeCap | `0x41f043cf28d0bb77ef6031c5208b611bdd673992afa9e27763b41033e4a327eb` |
| Deployer | `0x24bd37a7d13a78de81bd5345899da8b7a4d41ebf26fc1af6f934f9841c7d97f3` |
| Coin type | `0x2::sui::SUI` (testnet) → SuiUSD on mainnet (generic `Coin<T>`, no code change) |

#### Contract functions (all implemented and tested)
- `create_escrow<T>` — called at booking; guest addr passed explicitly; shared object created
- `auto_release<T>` — called by anyone after expiry; full deposit returned to guest
- `claim_damage<T>` — host files claim before expiry; moves to STATUS_CLAIMED
- `accept_claim<T>` — guest accepts; funds split
- `dispute_claim<T>` — guest disputes; moves to STATUS_DISPUTED
- `resolve_dispute<T>` — arbitrator splits (guest + host must == amount)

#### How transaction signing works (important for future AI assistants)
`@mysten/sui@2.16.3` SDK client methods (`signAndExecuteTransaction`,
`SuiJsonRpcClient`, `SuiGrpcClient`) are incompatible with the deployed Node/SDK
combination. The working pattern is:
```javascript
// 1. Fetch gas price + coin via raw RPC
const gasPrice = BigInt(await suiRpc('suix_getReferenceGasPrice', []));
const coins = await suiRpc('suix_getCoins', [sender, '0x2::sui::SUI', null, 1]);

// 2. Build with explicit params, no client
tx.setGasPrice(gasPrice);
tx.setGasBudget(50_000_000n);
tx.setGasPayment([{ objectId, version, digest }]);
tx.sharedObjectRef({ objectId: '0x6', initialSharedVersion: 1, mutable: false }); // Clock
const txBytes = await tx.build(); // no client arg

// 3. Sign + submit via raw fetch
const signed = await deployerKeypair.signTransaction(txBytes);
await suiRpc('sui_executeTransactionBlock', [base64bytes, [sig], options, 'WaitForLocalExecution']);
```
Do not attempt to use `SuiJsonRpcClient.signAndExecuteTransaction` or
`SuiGrpcClient` — both fail in the current environment. See `server.mjs`
`createEscrowOnChain` and `autoReleaseEscrow` functions for the working pattern.

#### Testnet vs mainnet differences (one line each)
- **Coin type:** `'0x2::sui::SUI'` → actual SuiUSD coin type address
- **Expiry:** `Date.now() + 300_000n` (5 min) → `checkoutMs + 432_000_000n` (5 days)
- **UpgradeCap:** keep for testnet → burn after audit for mainnet
- **Move.toml:** `rev = "framework/testnet"` → `rev = "framework/mainnet"`

#### Still pending from Phase 1
- **Auto-release scheduled job:** cron that queries bookings where
  `checkout + 5 days < NOW()` and `deposit_status = 'held'` and
  `escrow_object_id IS NOT NULL`, then calls `auto_release`. Not yet built.
- **Claim/dispute flows (Phase 3):** `claim_damage`, `dispute_claim`,
  `resolve_dispute` contract functions exist but backend routes not yet wired.
- **Production host address lookup:** currently uses deployer address as host.
  Production should look up `host_profiles.sui_address` by property_id.

---

### PHASE 2 — Guest PII with Walrus + Seal
**Priority: High. Required before onboarding real users.**

#### Why this architecture (already decided, do not re-debate)
ARIA must not be a PII custodian. Storing names, addresses, phone numbers creates
regulatory hooks (CCPA, GDPR, state privacy laws). Hosts legitimately need to know
who is renting their property. Walrus + Seal resolves both: guest PII is encrypted
client-side, stored on Walrus, and only the guest and the confirmed host can decrypt
it. ARIA stores nothing but a pointer (Walrus blob ID). ARIA is a pipe, not a bucket.

Stripe Identity / Persona was explicitly considered and rejected in favor of
Walrus + Seal because the latter is non-custodial end-to-end and architecturally
aligned with the rest of the stack.

#### Seal overview
- Seal is live on mainnet (launched September 2025)
- Docs: `https://seal-docs.wal.app`
- SDK: `npm install @mysten/seal` (TypeScript)
- Access control policies defined in Move on Sui
- Encryption/decryption happens client-side in the browser
- Key servers verify on-chain policy → return threshold key shares → decrypt

#### The PII Access Lifecycle (already decided)

```
Booking confirmed
    → host's suiAddress added to guest's Seal allowlist
    → host can decrypt guest PII (for check-in logistics, local registration)

During stay + 5-day inspection window
    → host access active (needs identity for damage claims)

Deposit released
    → SAME Sui transaction calls BOTH:
         (a) escrow::auto_release  (or resolve_dispute)
         (b) pii_access::revoke_access
    → host access permanently revoked
    → guest's PII is theirs alone again

Dispute active
    → host retains access while deposit_status = 'held'
```

**Access start: booking confirmation** (hosts need identity before guest arrives).

#### The Seal Allowlist Move Contract

A simple Move module, separate from the escrow contract. Adapt from Mysten's
allowlist examples in the Seal GitHub repo.

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

#### Database change

```sql
CREATE TABLE IF NOT EXISTS guest_verifications (
    sui_address    TEXT PRIMARY KEY,
    walrus_blob_id TEXT NOT NULL,   -- encrypted PII blob
    pii_object_id  TEXT NOT NULL,   -- on-chain GuestPIIAccess object ID
    phone_verified BOOLEAN DEFAULT false,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);
```

No PII columns. Just pointers.

#### New backend routes
```
POST /guest/profile      — store { walrus_blob_id, pii_object_id }
GET  /guest/profile      — return { verified, walrus_blob_id }
GET  /host/guest-identity/:bookingRef — return blob_id for host to decrypt client-side
```

#### Booking gate
Add to `/booking/create` and AI `create_booking` before any logic:
```javascript
const v = await pool.query('SELECT 1 FROM guest_verifications WHERE sui_address=$1', [session.suiAddress]);
if (!v.rows.length) return reply.code(400).send({ error: 'Complete identity verification first', redirect: '/profile' });
```

#### New frontend pages
- `pages/profile.jsx` — collects legal name, phone, address; encrypts with Seal;
  stores blob on Walrus; sends only blob ID to backend
- `pages/host.jsx` — "View Guest Identity" button; fetches blob from Walrus;
  proves host identity to Seal; decrypts in browser; nothing written to server

#### Integration with Phase 1 (critical)
`/booking/release-deposit` must call BOTH in the SAME PTB:
1. `escrow::auto_release`
2. `pii_access::revoke_access`

Use the raw RPC pattern from Phase 1 — build both calls into one transaction.

#### New env var
```
SEAL_PACKAGE_ID=0x<from deployment>
```

---

### PHASE 3 — 5-Day Inspection Window Business Logic
**Priority: Medium. Extends Phase 1 with real-world timing and claim flows.**

#### What to build

1. **Timing gate on `/booking/release-deposit`:** only callable after `check_out`
   date. Currently hosts can release at any time.

2. **Auto-release scheduled job:** query bookings where `checkout + 5 days < NOW()`
   and `deposit_status = 'held'` and `escrow_object_id IS NOT NULL`. Call
   `auto_release` on each. Update Postgres.

3. **Claim flow — new route `/booking/claim-damage`:**
   - Host calls with `{ bookingRef, claimAmount, reason }`
   - Validates: host owns property, booking checked out, within 5-day window
   - Calls `claim_damage` on escrow contract
   - Updates `deposit_status = 'claimed'`
   - Emails guest with claim details and dispute option

4. **Dispute flow — new route `/booking/dispute-claim`:**
   - Guest calls with `{ bookingRef, reason }`
   - Updates `deposit_status = 'disputed'`
   - Notifies ARIA admin
   - ARIA calls `resolve_dispute` on contract with final split

5. **Extend `deposit_status`:**
   Currently: `held` | `released`
   Add: `claimed` | `disputed` | `forfeited`

---

## 4. Build Order Summary

```
✅ Phase 1a: escrow.move + tests
✅ Phase 1b: Deploy to testnet (Package ID above)
✅ Phase 1c: escrow_object_id column in db.mjs
✅ Phase 1d: /booking/create → create_escrow on-chain
✅ Phase 1e: /booking/release-deposit → auto_release on-chain
⬜ Phase 1f: Auto-release scheduled job
⬜ Phase 1g: claim_damage + dispute routes (Phase 3)

⬜ Phase 2a: pii_access.move (Seal allowlist)
⬜ Phase 2b: Deploy allowlist contract, get SEAL_PACKAGE_ID
⬜ Phase 2c: guest_verifications table in db.mjs
⬜ Phase 2d: /guest/profile + /host/guest-identity routes
⬜ Phase 2e: Booking gate in /booking/create and AI create_booking
⬜ Phase 2f: hasGuestProfile in /auth/me
⬜ Phase 2g: pages/profile.jsx (Seal encrypt + Walrus store)
⬜ Phase 2h: Host "View Guest Identity" modal in pages/host.jsx
⬜ Phase 2i: Wire deposit release to call revoke_access in same PTB

⬜ Phase 3: 5-day window timing gate + auto-release job + claim/dispute flows
```

---

## 5. Tech Debt Backlog

| Item | Priority | Notes |
|---|---|---|
| Production host address lookup | High | Currently uses deployer address; should query `host_profiles.sui_address` by property_id |
| Auto-release job | High | Phase 1f — not yet built |
| Properties table empty / frontend hardcoded | Medium | `catalog.mjs` handles backend pricing; listings not DB-driven |
| Frontend tax/price duplication | Low | Backend centralized; frontend still has own copy |
| Stripe webhooks missing | Medium | `/payment/create-intent` exists; no webhook |
| No automated tests | Medium | No test suite for backend/frontend |
| `zod` unused | Low | Already a dependency; use for request body validation |
| Legacy `hosts` table unused | Low | Can be dropped |
| `@anthropic-ai/sdk` unused | Low | Remove |
| Error handling inconsistent | Low | Some routes still have raw `err.message` |

---

## 6. Deliberately Deferred Items

### zkLogin salt = `'0'`
Changing re-derives every user's Sui address, orphaning existing data.
Follow-up: per-user secret salt with data migration.

### DB TLS (`ssl: { rejectUnauthorized: false }`)
Railway cert doesn't validate against default CA.
Follow-up: supply Railway's CA cert, set `rejectUnauthorized: true`.

### Session token in URL (`?sid=`)
Cross-domain login (Vercel ↔ Railway) depends on it.
Follow-up: one-time authorization code exchange.

---

## 7. Key Architectural Decisions (Do Not Re-Debate)

| Decision | What was decided | Why |
|---|---|---|
| Pivot away from vacation rental | **Rejected** | Helm/boats, freelance escrow, contractor payments all evaluated and declined |
| PII storage | Walrus + Seal, zero raw PII on ARIA | Regulatory: avoid CCPA/GDPR custodianship |
| Stripe Identity for KYC | **Rejected** | Walrus + Seal is non-custodial and architecturally aligned |
| Smart contract: global vs per-booking | One global package, per-booking shared objects | No global balance to drain |
| UpgradeCap | Keep testnet, burn before mainnet | Immutable = maximum user trust |
| PII access start | Booking confirmation | Hosts need identity before guest arrives |
| Deposit lifecycle as PII trigger | Yes — released = access revoked | Natural boundary; atomic revocation |
| Coin type | Generic `Coin<T>` | Testnet SUI now; SuiUSD mainnet; no code change |
| Arbitrator | ARIA deployer, splits only to guest/host | Limits blast radius if compromised |
| SDK client for tx submission | Raw JSON-RPC fetch (bypass SDK) | SDK client methods incompatible with current env |

---

## 8. Environment Variables (Current State)

**In Railway (backend):**
```
DATABASE_URL
GOOGLE_CLIENT_ID
GOOGLE_CALLBACK_URL
FRONTEND_URL
HOST_ADDRESSES
SESSION_SECRET
XAI_API_KEY
RESEND_API_KEY
STRIPE_SECRET_KEY
ESCROW_PACKAGE_ID    = 0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe
ESCROW_MODULE_NAME   = escrow
ARIA_DEPLOYER_KEY    = <suiprivkey1... bech32 format>
```

**To add for Phase 2:**
```
SEAL_PACKAGE_ID      = 0x<from pii_access.move deployment>
```

**In Vercel (frontend):**
```
NEXT_PUBLIC_API_URL  = https://aria-demo-production-e590.up.railway.app
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
| Deployed escrow on explorer | `https://suiexplorer.com/object/0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe?network=testnet` |

---

*ARIA Roadmap v2.0 — June 10, 2026*
*Phase 1 complete. Phase 2 (Walrus + Seal PII) is next.*
