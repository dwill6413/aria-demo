# ARIA — Product Roadmap & AI Handoff Document
**Version:** 2.2 | **Updated:** June 10, 2026
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

#### Transaction signing pattern (important — do not change without testing)
The `@mysten/sui@2.16.3` SDK client methods fail in the current environment.
Working pattern: raw `suiRpc()` fetch for gas/coins, `tx.build()` with no client
arg, `deployerKeypair.signTransaction()`, `suiRpc('sui_executeTransactionBlock')`.
See `createEscrowOnChain` in `server.mjs` for the full implementation.

#### Phase 1 pending items (from security audit)

**P0 — Guest-funded escrow (most important production gap)**
On testnet the deployer funds the escrow from its own wallet. Production requires
the guest's zkLogin wallet to sign `create_escrow` and provide the coin.
- Implement client-side PTB signing in `index.jsx` booking flow
- Guest approves transaction in browser; expiry shown before signing
- ARIA backend orchestrates but does not provide the coin
- This makes the non-custodial claim actually true on-chain

**P1 — Key separation (before mainnet)**
Deployer, backend signer, and arbitrator are currently the same hot key.
No contract change needed — `arbitrator` is already a per-escrow field set at
`create_escrow` time, never changeable afterward.

*Immediate step (low effort):*
- Generate one dedicated arbitrator keypair, separate from the deployer and
  backend signer. Run locally: `sui keytool generate ed25519`
- Store the resulting mnemonic/private key in KeePass only — never in env vars,
  code, commits, or any markdown file. Only the **public address** (not the
  private key) is referenced anywhere, including in env vars and docs, since
  addresses are not secrets.
- Add the address as `ARIA_ARBITRATOR_ADDRESS` in Railway env vars.
- Update `createEscrowOnChain` to pass `process.env.ARIA_ARBITRATOR_ADDRESS` as
  the `arbitrator` parameter instead of the deployer address.
- Disputes are resolved by manually signing `resolve_dispute` from this key,
  held in KeePass, on an as-needed basis.

*Custody model — assign by blast radius, not uniformly:*
- **Deployer / UpgradeCap key**: broadest blast radius (controls contract code
  pre-burn). Stays cold in KeePass *regardless of scale* — contract upgrades are
  rare, deliberate events that don't scale with booking volume.
- **Backend signer** (`ARIA_DEPLOYER_KEY`): Railway env var, scoped to
  permissionless operations only (`auto_release`). Bounded impact even if
  compromised — `auto_release` can only refund the guest after expiry.
- **Arbitrator key**: bounded blast radius by contract design — `resolve_dispute`
  can only redistribute *one disputed escrow's* funds between *that escrow's*
  recorded guest and host, with `guest_amount + host_amount == escrow.amount`
  enforced on-chain. Cannot touch other escrows, cannot send funds elsewhere.
  Starts cold (KeePass, manual signing); see scaling path below.

*Arbitration scaling path (designed now, built when volume justifies it):*
Because `resolve_dispute`'s impact is contractually bounded per-escrow, the
arbitrator key is safe to scale from "cold key, manual signing" to "scoped hot
key in a dispute-resolution service" without any contract changes or migration:
1. **Now**: single arbitrator keypair, KeePass-held, manual signing.
2. **At scale**: stand up an internal dispute-review tool (queue + evidence +
   approval). A separate scoped service key — held only by that service, never
   by the main backend — executes approved resolutions by calling
   `resolve_dispute`. Even full compromise of this key has bounded, per-escrow,
   guest-or-host-only impact.
3. **Cohort/regional arbitrators**: since `arbitrator` is per-escrow, different
   cohorts (regions, booking value tiers) can use different arbitrator
   addresses going forward with zero migration of existing escrows.
4. Old escrows always keep the arbitrator address they were created with —
   rotating `ARIA_ARBITRATOR_ADDRESS` only affects new bookings.

**Repo hygiene — applies to every key in this section:**
Private keys and mnemonics must NEVER appear in `ARIA_ROADMAP.md`,
`ARIA_HANDOFF.md`, code comments, or any committed file. Only public addresses
(which are not secrets) may appear in documentation. Private keys live in
KeePass and/or Railway env vars only.

**P2 — Auto-release cron job**
No scheduled job triggers `auto_release` after expiry. Build a job that queries
bookings where `checkout_date + 5 days < NOW()` and `deposit_status = 'held'`
and `escrow_object_id IS NOT NULL`, then calls `auto_release` on each.
Use the raw RPC pattern from `server.mjs`.

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
- [ ] P0 complete
- [ ] P1 complete
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
⬜ Phase 1f: P0 — Guest wallet funds escrow (client-side PTB)
⬜ Phase 1g: P1 — Key separation (deployer / signer / arbitrator)
⬜ Phase 1h: P2 — Auto-release cron job
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
| Guest-funded escrow | **P0** | Testnet gap — deployer funds; must fix for mainnet |
| Key separation | **P1** | Same hot key for all roles — must fix for mainnet |
| Auto-release job | P2 | Phase 1h |
| Production host address | P2 | Phase 1i |
| Claim/dispute routes | P2 | Phase 1j / Phase 3 |
| Properties frontend-hardcoded | Medium | `properties` table empty |
| Frontend tax/price duplication | Low | `catalog.mjs` centralizes backend |
| Stripe webhooks | Medium | Create-intent only |
| No automated tests | Medium | No backend/frontend test suite |
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
| Arbitrator scope | Can only split between guest and host | Limits blast radius if compromised |
| SDK client for tx submission | Raw JSON-RPC fetch | SDK client methods incompatible in current env |
| Emergency withdraw / pause | **Rejected** | Admin drain path; undermines non-custodial claim |
| Arbitrator key custody | Cold (KeePass), separate from deployer & backend signer | Bounded blast radius (resolve_dispute is per-escrow, guest/host only) enables safe future scaling to a scoped service key |
| Private keys in documentation | **Never** — public addresses only | Roadmap/handoff docs are pushed to public GitHub |

---

## 8. Environment Variables

**In Railway (backend):**
```
DATABASE_URL, GOOGLE_CLIENT_ID, GOOGLE_CALLBACK_URL, FRONTEND_URL
HOST_ADDRESSES, SESSION_SECRET, XAI_API_KEY, RESEND_API_KEY, STRIPE_SECRET_KEY
ESCROW_PACKAGE_ID      = 0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe
ESCROW_MODULE_NAME     = escrow
ARIA_DEPLOYER_KEY      = <suiprivkey1... bech32 format — KeePass + Railway only, never committed>
```

**To add for P1 (arbitrator key separation):**
```
ARIA_ARBITRATOR_ADDRESS = 0x<public address only — generate via `sui keytool generate ed25519`>
```
The corresponding private key/mnemonic goes in KeePass only. Never in Railway,
never in any committed file. Only this public address is referenced in env vars
and code.

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
| Deployed escrow | `https://suiexplorer.com/object/0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe?network=testnet` |

---

*ARIA Roadmap v2.2 — June 10, 2026*
*Changes from v2.1: P1 expanded with concrete arbitrator key generation steps,
custody model by blast radius, and a documented arbitration scaling path. Repo
hygiene rule added — private keys/mnemonics never appear in any committed file,
only public addresses.*
