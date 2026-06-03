# ARIA — Product Roadmap & AI Handoff Document
**Version:** 1.0 | **Created:** June 02, 2026
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
real differentiators — not just marketing. The roadmap below makes those claims true.

**Existing documentation (read these first):**
- `ARIA_HANDOFF.md` v3.0 — accurate technical state of deployed code
- `ARIA_REMEDIATION.md` — full security change log with rationale
- `ARIA_CODE_REVIEW.md` — original findings report

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
- Security deposit tracked in Postgres (`deposit_status`: held/released)
- Walrus immutable receipts (booking + cancellation + deposit release)
- Resend email confirmations
- Stripe fallback payment intent
- iCal export/import + availability checking
- Host dashboard (bookings, revenue, tax, applications, reviews)
- Guest bookings page with correct timezone-safe date display
- 9-table Postgres schema with indexes (see `db.mjs`)
- RBAC: `requireSession`, `requireHost`, `requireSuperadmin` helpers
- IDOR protections on messages, reviews, deposit release
- XSS protection on AI chat output

**What the deposit is NOT yet:** The deposit is currently a Postgres flag, not a real
on-chain escrow. The UI says "held in Sui escrow" — that becomes true in Phase 1.

---

## 3. Roadmap

### PHASE 1 — Security Deposit Smart Contract (BUILD FIRST)
**Priority: Highest. Everything else depends on this.**

#### Why this first
The guest PII access lifecycle (Phase 2) is tied to the deposit lifecycle:
deposit released → PII access revoked. Build the deposit contract first so Phase 2
is designed correctly from the start rather than retrofitted. Additionally, the
deposit contract is what makes ARIA's core claim real — on-chain escrow, not a
database flag.

#### Architecture Decision (already made, do not re-debate)
- **One global package** deployed once to Sui testnet
- **One `BookingEscrow` shared object per booking** created by the package
- No global balance — each booking's funds are isolated in their own object
- ARIA never holds funds — the smart contract does
- No admin drain path, no pause function, no upgrade authority on mainnet

#### The Contract Spec

**File structure:**
```
contracts/aria_escrow/
  Move.toml
  sources/
    escrow.move
  tests/
    escrow_tests.move
```

**`Move.toml`:**
```toml
[package]
name = "aria_escrow"
version = "0.0.1"
edition = "2024.beta"

[dependencies]
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "testnet" }

[addresses]
aria_escrow = "0x0"
```

**Core struct:**
```move
public struct BookingEscrow<phantom T> has key {
    id: UID,
    booking_ref: String,          // e.g. "ARIA-1-1234567890"
    guest: address,               // suiAddress from session
    host: address,                // host's suiAddress
    arbitrator: address,          // ARIA deployer multisig — can only split to guest/host
    amount: u64,                  // total deposited (in MIST or token base units)
    coin: Coin<T>,                // the actual locked funds
    expiry_ms: u64,               // checkout timestamp + 5 days in milliseconds
    status: u8,                   // 0=active 1=released 2=claimed 3=disputed 4=resolved
    claim_amount: u64,            // set by host during claim_damage, 0 otherwise
}
```

**Error codes:**
```move
const ENotGuest: u64 = 0;
const ENotHost: u64 = 1;
const ENotArbitrator: u64 = 2;
const ENotExpired: u64 = 3;
const EAlreadyExpired: u64 = 4;
const EClaimExceedsDeposit: u64 = 5;
const EWrongStatus: u64 = 6;
const EZeroAmount: u64 = 7;
```

**Functions:**

```move
// Called at booking confirmation. Guest locks funds.
// Signed by: guest (client-side zkLogin transaction)
public fun create_escrow<T>(
    booking_ref: String,
    host: address,
    arbitrator: address,
    expiry_ms: u64,
    coin: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext
): BookingEscrow<T>

// Called after expiry with no active claim. Returns full deposit to guest.
// Callable by: anyone (ARIA backend calls this automatically after 5 days)
public fun auto_release<T>(
    escrow: BookingEscrow<T>,
    clock: &Clock,
    ctx: &mut TxContext
)

// Called by host during inspection window (before expiry).
// claim_amount goes to host, remainder back to guest.
// Signed by: host (client-side zkLogin transaction)
public fun claim_damage<T>(
    escrow: BookingEscrow<T>,
    claim_amount: u64,
    clock: &Clock,
    ctx: &mut TxContext
)

// Called by guest to accept a damage claim without dispute.
// Signed by: guest
public fun accept_claim<T>(
    escrow: BookingEscrow<T>,
    ctx: &mut TxContext
)

// Called by ARIA arbitrator when guest disputes a damage claim.
// guest_amount + host_amount must == escrow.amount exactly (enforced by Move).
// Signed by: arbitrator address
public fun resolve_dispute<T>(
    escrow: BookingEscrow<T>,
    guest_amount: u64,
    host_amount: u64,
    ctx: &mut TxContext
)
```

**Core security invariants (compiler-enforced by Move's linear types):**

1. `coin` in `BookingEscrow` is a linear type — it cannot be copied or dropped,
   only transferred. Every function that touches it must consume it and produce
   outputs summing to the exact same value. If outputs don't sum to input, the
   contract does not compile.

2. `create_escrow` asserts `coin.value > 0` (no zero-value escrows).

3. `claim_damage` asserts `claim_amount <= escrow.amount` before splitting.
   belt-and-suspenders — `coin::split` would abort anyway, but explicit assertion
   produces a readable error code.

4. `resolve_dispute` asserts `guest_amount + host_amount == escrow.amount` before
   any fund movement.

5. `arbitrator` can only ever split funds between `guest` and `host`. The
   arbitrator address is NOT stored globally — it's per-escrow, set at creation.
   If the ARIA arbitrator key is compromised, it can only affect escrows where
   `dispute` has been called. It cannot drain inactive escrows.

6. No arithmetic can overflow — Move `u64` arithmetic aborts on overflow.

7. No reentrancy — Move's object model makes this impossible by design.

**Unit tests to write in `escrow_tests.move`:**
- Happy path: create → auto_release after expiry → guest receives full amount
- Damage claim: create → claim_damage → host receives claim, guest receives remainder
- Claim cap: attempt to claim more than deposit → aborts with EClaimExceedsDeposit
- Pre-expiry auto_release: attempt auto_release before expiry → aborts with ENotExpired
- Dispute: create → claim_damage → resolve_dispute → both parties receive correct splits
- Zero deposit: attempt create_escrow with 0 coin → aborts with EZeroAmount
- Wrong status: attempt to call release on already-released escrow → aborts with EWrongStatus

#### ARIA Backend Changes

**`db.mjs`:** Add column to bookings table:
```sql
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS escrow_object_id TEXT;
```

**`server.mjs` changes:**
- `/booking/create`: after saving the booking to Postgres, construct and submit a
  Sui PTB (Programmable Transaction Block) calling `create_escrow`. Store the
  returned object ID in `bookings.escrow_object_id`.
- `/booking/release-deposit`: after updating Postgres status, submit a Sui PTB
  calling `auto_release` (if within normal release) or `resolve_dispute` (if
  arbitrating). This ALSO triggers Seal PII revocation (Phase 2).
- New cron/job: every hour, query bookings where `checkout_date + 5 days < NOW()`
  and `deposit_status = 'held'` and `escrow_object_id IS NOT NULL`. Call
  `auto_release` on each. Update Postgres to `released`.

**New env vars needed:**
```
ESCROW_PACKAGE_ID=0x<deployed package id>
ESCROW_MODULE_NAME=escrow
ARIA_DEPLOYER_KEY=<base64 or hex private key for backend signing>
```

`ARIA_DEPLOYER_KEY` is used for auto_release (permissionless but backend triggers
it) and dispute resolution. Store in Railway environment variables, never commit.

**Sui SDK usage (already in dependencies `@mysten/sui`):**
```javascript
import { SuiClient, getFullnodeUrl } from '@mysten/sui/client';
import { TransactionBlock } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

const client = new SuiClient({ url: getFullnodeUrl('testnet') });
const keypair = Ed25519Keypair.fromSecretKey(process.env.ARIA_DEPLOYER_KEY);

// Example: call auto_release
const tx = new TransactionBlock();
tx.moveCall({
  target: `${process.env.ESCROW_PACKAGE_ID}::escrow::auto_release`,
  typeArguments: ['0x2::sui::SUI'], // use actual SuiUSD type on mainnet
  arguments: [tx.object(escrowObjectId), tx.object('0x6')], // 0x6 = Clock
});
const result = await client.signAndExecuteTransactionBlock({
  transactionBlock: tx,
  signer: keypair,
});
```

**Note on coin type:** During testnet development, use `0x2::sui::SUI` (testnet SUI
from faucet) as the escrowed coin. When moving to mainnet, parameterize with the
actual SuiUSD coin type. The contract is generic `Coin<T>` — no code change needed.

#### Deployment Steps (run once)

```powershell
# 1. Install Sui CLI (Windows)
choco install sui
# OR download binary from github.com/MystenLabs/sui/releases

# 2. Configure testnet
sui client                              # first-time setup
sui client switch --env testnet

# 3. Create deployer wallet
sui client new-address ed25519
sui client active-address               # copy this address

# 4. Fund with testnet SUI
# Visit faucet.sui.io, paste deployer address, request tokens

# 5. Build and test
cd contracts/aria_escrow
sui move build
sui move test

# 6. Deploy
sui client publish --gas-budget 100000000

# 7. Copy Package ID from output → add to Railway env vars as ESCROW_PACKAGE_ID
# 8. Copy deployer private key → add to Railway env vars as ARIA_DEPLOYER_KEY
```

**UpgradeCap decision:**
- Testnet: keep UpgradeCap (you will need to fix things during development)
- Mainnet: burn UpgradeCap after independent Move audit. Immutable contract = maximum
  user trust guarantee. Schedule audit before mainnet.

---

### PHASE 2 — Guest PII with Walrus + Seal
**Priority: High. Required before onboarding real users.**

#### Why this architecture (already decided, do not re-debate)
ARIA must not be a PII custodian. Storing names, addresses, phone numbers creates
regulatory hooks (CCPA, GDPR, state privacy laws). Hosts legitimately need to know
who is renting their property. Walrus + Seal resolves both: guest PII is encrypted
client-side, stored on Walrus, and only the guest and the confirmed host can decrypt
it. ARIA stores nothing but a pointer (Walrus blob ID). ARIA is a pipe, not a bucket.

Stripe Identity / Persona (third-party KYC) was explicitly considered and rejected
in favor of Walrus + Seal because the latter is non-custodial end-to-end and
architecturally aligned with the rest of the stack.

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

During stay
    → host access active

Checkout + 5-day inspection window
    → host access active (needs identity for damage claims)

Deposit released (auto at day 5 OR host releases early)
    → deposit release triggers BOTH:
         (a) Postgres deposit_status = 'released'
         (b) Sui transaction removing host from Seal allowlist
    → host access permanently revoked
    → guest's PII is theirs alone again

Dispute (deposit not released within 5 days)
    → host retains access while dispute is live
    → access revoked when dispute resolves (deposit_status changes from 'held')
```

**Access start: booking confirmation** (not check-in date — hosts need to know
who's coming before they arrive, for check-in logistics and local STR regulations).

#### The Seal Allowlist Contract

A simple Move module, separate from the escrow contract. Mysten provides allowlist
examples in the Seal repository — adapt rather than write from scratch.

```move
// One GuestPIIAccess object per guest, owned by the guest
public struct GuestPIIAccess has key {
    id: UID,
    guest: address,                    // the guest — always has access
    allowed_hosts: vector<address>,    // hosts with active bookings
}

// Called once by guest when setting up their profile
public entry fun create_access(ctx: &mut TxContext): GuestPIIAccess

// Called at booking confirmation — adds host to allowlist
// Can be called by guest or by ARIA backend on guest's behalf
public entry fun grant_access(
    access: &mut GuestPIIAccess,
    host: address,
    ctx: &mut TxContext
)

// Called at deposit release — removes host from allowlist
// Triggered by the same transaction that releases the deposit
public entry fun revoke_access(
    access: &mut GuestPIIAccess,
    host: address,
    ctx: &mut TxContext
)
```

**Important:** `revoke_access` must be called in the SAME Sui transaction as the
deposit release. This makes revocation atomic with fund release — they cannot be
decoupled. If the deposit release succeeds, the PII revocation succeeds. If either
fails, both revert.

#### Database Change

```sql
-- Add to guest_verifications table in db.mjs initDB()
CREATE TABLE IF NOT EXISTS guest_verifications (
    sui_address       TEXT PRIMARY KEY,
    walrus_blob_id    TEXT NOT NULL,        -- encrypted PII blob
    pii_object_id     TEXT NOT NULL,        -- the on-chain GuestPIIAccess object ID
    phone_verified    BOOLEAN DEFAULT false,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);
```

**That is the ONLY table for this feature. No PII columns. No name. No address.
No phone number. Just pointers.**

#### New Backend Routes (`server.mjs`)

```
POST /guest/profile
  Body: { walrus_blob_id, pii_object_id }
  Auth: requireSession
  Action: upsert into guest_verifications
  Returns: { success: true }

GET /guest/profile
  Auth: requireSession
  Returns: { verified: boolean, walrus_blob_id (if exists) }

GET /host/guest-identity/:bookingRef
  Auth: requireHost
  Action: verify host owns a confirmed booking with this bookingRef.
          Return the guest's walrus_blob_id for that booking's guest.
          Host decrypts client-side — server never sees plaintext.
  Returns: { walrus_blob_id, pii_object_id }
```

#### Booking Gate

In `/booking/create` (server.mjs) and `create_booking` tool (ai_route.mjs), add
before ANY other logic:

```javascript
const verification = await pool.query(
  'SELECT walrus_blob_id FROM guest_verifications WHERE sui_address = $1',
  [session.suiAddress]
);
if (verification.rows.length === 0) {
  return reply.code(400).send({
    error: 'Please complete your identity verification before booking.',
    redirect: '/profile'
  });
}
```

#### `/auth/me` Update

Add to the response:
```javascript
hasGuestProfile: !!(await pool.query(
  'SELECT 1 FROM guest_verifications WHERE sui_address = $1',
  [session.suiAddress]
)).rows.length
```

Frontend uses this to show "Complete your profile" prompt.

#### New Frontend Pages

**`pages/profile.jsx` — Guest PII form:**
1. Form fields: legal name (not Google display name — full name as on government ID),
   phone number, street address, city, state, ZIP, country
2. On submit:
   a. Import Seal SDK: `import { SealClient } from '@mysten/seal'`
   b. Encrypt form data client-side with Seal using guest's suiAddress as policy
   c. PUT encrypted blob to Walrus (use existing Walrus publisher endpoint)
   d. Call `create_access` on the Seal allowlist contract (zkLogin transaction)
   e. POST `{ walrus_blob_id, pii_object_id }` to `/guest/profile`
   f. Redirect to booking
3. Show after: "Your identity is protected. Only your confirmed hosts can access it,
   and only during your stay + deposit window."

**`pages/bookings.jsx` — no change needed for guests.**

**`pages/host.jsx` — "View Guest Identity" button:**
- Add to each confirmed booking card
- On click: call `GET /host/guest-identity/:bookingRef`
- Fetch encrypted blob from Walrus using returned `walrus_blob_id`
- Prove host identity to Seal key servers (sign with zkLogin wallet)
- Seal returns key shares if host is in allowlist
- Decrypt and display in modal: name, phone, address
- Nothing written to server — display only, in browser memory

#### New Env Vars Needed
```
SEAL_PACKAGE_ID=0x<seal allowlist package id>   # from deployment
```

#### Integration Point with Phase 1
In `server.mjs` `/booking/release-deposit`, after updating Postgres, the Sui
transaction must call BOTH:
1. `escrow::auto_release` OR `escrow::resolve_dispute`
2. `pii_access::revoke_access`

These should be in the SAME Programmable Transaction Block (PTB) so they're atomic.

---

### PHASE 3 — 5-Day Inspection Window Business Logic
**Priority: Medium. Required for Phase 1 contract to be meaningful.**

This is new business logic that doesn't exist in ARIA yet.

#### What to build

1. **Post-checkout inspection window:** after a booking's `check_out` date passes,
   the deposit enters a 5-day inspection window. The host can file a damage claim
   during this window. After 5 days with no claim, the deposit auto-releases.

2. **`/booking/release-deposit` rate limiting / timing gate:** currently hosts
   can release at any time. Gate it: only callable after `check_out` date. Claims
   (`claim_damage`) only callable during the 5-day window.

3. **Auto-release job:** a scheduled job (or triggered on booking queries) that
   identifies bookings where:
   - `payment_status = 'confirmed'`
   - `deposit_status = 'held'`
   - `check_out + 5 days < NOW()`
   - `escrow_object_id IS NOT NULL`
   Then calls `auto_release` on the contract and updates Postgres.

4. **Claim flow (new):**
   - Host calls `/booking/claim-damage` with `{ bookingRef, claimAmount, reason }`
   - Server validates: host owns property, booking is checked out, within 5-day window
   - Calls `claim_damage` on the escrow contract
   - Updates `deposit_status = 'claimed'` in Postgres
   - Emails guest with claim details and dispute option

5. **Dispute flow (new):**
   - Guest calls `/booking/dispute-claim` with `{ bookingRef, reason }`
   - Updates `deposit_status = 'disputed'` in Postgres
   - Notifies ARIA (email to admin)
   - ARIA reviews and calls `resolve_dispute` on contract with final split

#### Booking statuses to add
`deposit_status` in Postgres currently: `held` | `released`
Extend to: `held` | `claimed` | `disputed` | `released` | `forfeited`

---

## 4. Tech Debt Backlog (from ARIA_HANDOFF.md v3.0)

These are known issues. Address after Phases 1-3 unless one is blocking.

| Item | Priority | Notes |
|---|---|---|
| Properties table empty / frontend hardcoded | Medium | `catalog.mjs` handles backend; frontend still has its own copy. Ideal: DB-driven listings |
| Frontend tax/price duplication | Low | Backend centralized in `catalog.mjs`; frontend copy still exists |
| Stripe webhooks missing | Medium | `/payment/create-intent` exists; no webhook to confirm payment |
| No automated tests | Medium | No test suite exists; security-critical code has no coverage |
| `zod` unused | Low | Already a dependency; add request body validation |
| Legacy `hosts` table unused | Low | Can be dropped in a migration |
| `@anthropic-ai/sdk` unused dependency | Low | Remove |
| Error handling inconsistent | Low | Some routes still have raw `err.message` |

---

## 5. Deliberately Deferred Items

These were consciously left unchanged to avoid breaking working behavior.
Do not "fix" them without understanding the migration required.

### zkLogin salt = `'0'`
**Risk if changed:** changing the salt re-derives every user's Sui address,
orphaning all existing bookings, host profiles, and sessions.
**Follow-up:** migrate to per-user secret salt. Store salt keyed by Google `sub`.
Derive new addresses. Migrate existing records. This is a significant data migration.

### DB TLS (`ssl: { rejectUnauthorized: false }`)
**Risk if changed:** Railway's managed Postgres cert won't validate against default
CA bundle, breaking the DB connection.
**Follow-up:** obtain Railway's CA certificate. Set `ssl: { ca: caCert, rejectUnauthorized: true }`.

### Session token in URL (`?sid=`) + localStorage
**Risk if changed:** cross-domain login (Vercel ↔ Railway) depends on this because
third-party cookies are blocked.
**Follow-up:** implement one-time authorization code exchange. Backend redirects with
a short-lived single-use `code`. Frontend POSTs the code to exchange for a session.
Token never appears in the URL or browser history.

---

## 6. Key Architectural Decisions (Do Not Re-Debate)

These decisions were made with full context. Record them here to prevent an AI
assistant from relitigating them.

| Decision | What was decided | Why |
|---|---|---|
| Pivot away from vacation rental | **Rejected** — staying with vacation rental | Strategic alternatives (Helm/boats, freelance escrow, contractor payments) evaluated and declined |
| PII storage | Walrus + Seal, zero raw PII on ARIA | Regulatory: avoid CCPA/GDPR custodianship hooks |
| PII KYC provider (Stripe Identity) | **Rejected** | Walrus + Seal is non-custodial, architecturally aligned, and now mainnet-ready |
| Smart contract: one contract per booking vs one global | One global package, per-booking objects | Sui's object model — no global balance to drain |
| Smart contract upgrade authority | Keep on testnet, burn before mainnet | Immutable contract = maximum user trust |
| PII access start point | Booking confirmation (not check-in) | Hosts need identity for logistics before arrival |
| Deposit lifecycle as PII access trigger | Yes — deposit released = PII access revoked | Natural business boundary; atomic revocation |
| Coin type for escrow | Generic `Coin<T>` | Works with testnet SUI now, SuiUSD on mainnet, no code change |
| Arbitrator role | ARIA deployer wallet, can only split to guest/host | Limits damage if compromised; no drain path |

---

## 7. Build Order Summary

```
Phase 1a: Write escrow.move + escrow_tests.move
Phase 1b: Deploy to testnet, get ESCROW_PACKAGE_ID
Phase 1c: Update db.mjs (escrow_object_id column)
Phase 1d: Wire /booking/create → create_escrow Sui PTB
Phase 1e: Wire /booking/release-deposit → auto_release Sui PTB
Phase 1f: Build auto-release scheduled job
Phase 1g: Build claim_damage + dispute flows (Phase 3)

Phase 2a: Write pii_access.move (Seal allowlist contract)
Phase 2b: Deploy allowlist contract, get SEAL_PACKAGE_ID
Phase 2c: Add guest_verifications table to db.mjs
Phase 2d: Add /guest/profile and /host/guest-identity/:bookingRef routes
Phase 2e: Add booking gate to /booking/create and AI create_booking
Phase 2f: Add hasGuestProfile to /auth/me
Phase 2g: Build pages/profile.jsx (Seal encrypt + Walrus store)
Phase 2h: Build host "View Guest Identity" modal in pages/host.jsx
Phase 2i: Wire deposit release to call revoke_access in same PTB as auto_release

Phase 3: 5-day window logic (booking gate on claim timing, auto-release job)
```

Phases 1 and 2 are interdependent at the deposit-release step (Phase 2i).
Complete Phases 1a–1f before starting Phase 2a.

---

## 8. Resources

| Resource | URL |
|---|---|
| Sui documentation | `https://docs.sui.io` |
| Move book | `https://move-book.com` |
| Sui Move intro course | `https://intro.sui-book.com` |
| Seal documentation | `https://seal-docs.wal.app` |
| Seal GitHub (examples) | `https://github.com/MystenLabs/seal` |
| Walrus documentation | `https://docs.walrus.site` |
| Sui testnet explorer | `https://suiexplorer.com/?network=testnet` |
| Sui testnet faucet | `https://faucet.sui.io` |
| `@mysten/sui` SDK | Already in `package.json` |

---

## 9. Environment Variables (Complete List)

**Currently in Railway (backend):**
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
```

**To add for Phase 1:**
```
ESCROW_PACKAGE_ID        # from sui client publish output
ESCROW_MODULE_NAME       # "escrow"
ARIA_DEPLOYER_KEY        # private key of deployer wallet (base64)
```

**To add for Phase 2:**
```
SEAL_PACKAGE_ID          # from allowlist contract deployment
```

**Currently in Vercel (frontend):**
```
NEXT_PUBLIC_API_URL      # points to Railway backend
```

---

*ARIA Roadmap v1.0 — June 02, 2026*
*This document should be updated as phases complete.*
