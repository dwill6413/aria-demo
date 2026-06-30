# ARIA — Mainnet Migration Plan
**Created:** June 30, 2026
**Purpose:** Step-by-step plan to migrate ARIA from Sui testnet to mainnet for soft launch (closed testing with trusted users before public launch).

> **Approach:** Deploy to mainnet with UpgradeCap intact. Test with real funds and a small group of trusted users. Get the Move audit done in parallel. Burn UpgradeCap and open publicly only after audit passes. Seal and USDC swap can be layered in without contract changes.

---

## Stablecoin Decision

ARIA's codebase references "SuiUSD" as a placeholder. On mainnet the payment coin is:

**Native USDC on Sui mainnet**
- Coin type: `0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC`
- Issued by Circle, live on Sui mainnet — no bridging required
- Available on major CEXs (Coinbase, Kraken, etc.) — guests can deposit directly to their Sui wallet
- The in-app USDC → USDC swap feature becomes unnecessary since guests can fund directly from CEXs

> **Note:** This means the USDC → SuiUSD swap feature (DeepBook) may not be needed at all if ARIA uses native USDC as the payment coin. Guests deposit USDC from a CEX directly to their Sui wallet and book. Revisit this decision before launch.

---

## Phase 1 — Pre-Migration Prep (do this before touching mainnet)
*Estimated time: 1–2 days*

### 1.1 Fix zkLogin salt
- **What:** Salt `'0'` lets anyone derive a user's Sui address from their Google `sub`. Must change before real users.
- **Impact:** Changing the salt re-derives ALL existing addresses — existing testnet users get new addresses. On mainnet this is a fresh start so there are no existing users to migrate.
- **Action:** Change `salt` in `lib/zklogin.js` from `'0'` to a secret random string. Store it as `NEXT_PUBLIC_ZKLOGIN_SALT` env var on Vercel. Do this BEFORE any mainnet users sign up.

### 1.2 Fix DB TLS
- **What:** `rejectUnauthorized: false` in the PostgreSQL connection is a MITM risk with real money.
- **Action:** Get the Railway PostgreSQL CA certificate and add it to the connection config in `db.mjs`. Railway provides this in the database settings panel.

### 1.3 Generate fresh mainnet keypairs
Generate new keypairs for mainnet — never reuse testnet keys:
- **Auto-release key** (`ARIA_AUTO_RELEASE_KEY`) — signs `auto_release`, `finalize_claim`, `release_payment`
- **Arbitrator key** (`ARIA_ARBITRATOR_KEY`) — signs `resolve_dispute`, `refund_payment`, `refund_deposit`
- **Deployer key** — signs the `sui client publish` command only. Goes cold after publish.

```bash
# Generate each key
sui keytool generate ed25519
# Note the suiAddress and suiprivkey1... bech32 output
# Store private keys in KeePass immediately
```

### 1.4 Fund mainnet wallets
- Deployer: ~0.5 SUI for gas (publish costs ~$5–20)
- Auto-release key: ~$50 SUI for operational gas (months of sweep transactions)
- Arbitrator key: ~$20 SUI for gas

### 1.5 Set up mainnet USDC fee wallet
- Generate a receive-only wallet for ARIA's 5% fee (`ARIA_FEE_ADDRESS`)
- Store recovery phrase in KeePass
- This wallet only receives — never needs to sign

### 1.6 Set DEMO_HOST_ADDRESS for mainnet
- Your own zkLogin-derived mainnet address (sign in once to get it)
- Used as host for any catalog demo properties during testing

---

## Phase 2 — Contract Deployment to Mainnet
*Estimated time: 1–2 hours*

### 2.1 Update Move.toml for mainnet
```toml
# contracts/aria_escrow/Move.toml
[dependencies]
Sui = { git = "https://github.com/MystenLabs/sui.git", subdir = "crates/sui-framework/packages/sui-framework", rev = "framework/mainnet" }
```

### 2.2 Update coin type in contract (if needed)
- The contract uses `Coin<T>` generically — no hardcoded coin type in Move
- The coin type is passed as a type argument at call time from the backend
- **No Move source change needed** — just env var change

### 2.3 Run Move tests one final time
```bash
sui move test
# Must be 52/52 passing
```

### 2.4 Publish to mainnet
```bash
# Switch Sui CLI to mainnet
sui client switch --env mainnet

# Publish (run from the deployer wallet)
sui client publish --gas-budget 500000000
```
- Note the new **Package ID** from the output
- Note the **UpgradeCap object ID** — store in KeePass
- Retire deployer key to cold storage immediately after

### 2.5 Record mainnet contract details
Update `ARIA_KEY_INVENTORY.md` and `ARIA_HANDOFF.md` with:
- Mainnet Package ID (type-defining)
- UpgradeCap object ID
- Publish transaction digest
- Date published

---

## Phase 3 — Backend Configuration (Railway)
*Estimated time: 1–2 hours*

Update Railway environment variables:

```
# Contract
ESCROW_PACKAGE_ID          = <new mainnet package id>
ESCROW_MODULE_NAME         = escrow

# Coin type — native USDC on Sui mainnet
PAYMENT_COIN_TYPE          = 0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC

# Keys — mainnet keypairs generated in Phase 1
ARIA_AUTO_RELEASE_KEY      = <new mainnet suiprivkey1... bech32>
ARIA_ARBITRATOR_KEY        = <new mainnet suiprivkey1... bech32>
ARIA_ARBITRATOR_ADDRESS    = <new mainnet arbitrator public address>

# Treasury
ARIA_FEE_ADDRESS           = <new mainnet fee wallet address>

# Timing — real mainnet windows (not testnet shortcuts)
PAYMENT_RELEASE_OFFSET_MS  = 0          # release at check-in time exactly
RESALE_WINDOW_MS           = 172800000  # 48h no-transfer window after booking
ABANDONED_BOOKING_TTL_MS   = 900000     # 15 min (keep same)

# Features
BOOKING_PASS_ENABLED       = true
RESALE_ENABLED             = true
REQUIRE_GUEST_VERIFICATION = false      # keep off for soft launch; enable after Seal wired

# Infra
FRONTEND_URL               = https://your-production-domain.com
DATABASE_URL               = <mainnet postgres connection string>
```

**Remove testnet-only vars** that no longer apply.

---

## Phase 4 — Frontend Configuration (Vercel)
*Estimated time: 30 minutes*

```
NEXT_PUBLIC_API_URL                = https://your-railway-mainnet-url.up.railway.app
NEXT_PUBLIC_ESCROW_PACKAGE_ID      = <new mainnet package id>
NEXT_PUBLIC_ZKLOGIN_SALT           = <secret random string — set in Phase 1.1>
NEXT_PUBLIC_PAYMENT_COIN_TYPE      = 0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC
```

---

## Phase 5 — Seal Key Servers (Guest PII)
*Estimated time: 1–2 hours*
*Can be done after soft launch if REQUIRE_GUEST_VERIFICATION stays off*

### 5.1 Choose mainnet key server providers
Pick 2–3 from the verified mainnet list:
- Ruby Nodes — `https://seal.rubynodes.io`
- NodeInfra
- Studio Mirai
- Triton One
- Enoki (by Mysten Labs)

Pricing is subscription-based per provider, likely $10–50/month at low volume.

### 5.2 Update lib/seal.js
Replace testnet key server URLs with mainnet provider URLs:
```js
// lib/seal.js — replace testnet servers
const KEY_SERVERS = [
  'https://seal.rubynodes.io',      // example — use verified mainnet servers
  'https://seal.nodeinfra.com',
];
```

### 5.3 Enable guest verification
Once Seal is wired to mainnet servers and tested:
```
REQUIRE_GUEST_VERIFICATION = true   # Railway
```

---

## Phase 6 — Expiry Windows
*Estimated time: 30 minutes — code change*

The testnet uses a 5-minute escrow expiry for convenience. Mainnet needs real windows.

In `escrow.mjs`, update `buildEscrowTransaction`:
```js
// Current (testnet):
const expiryMs = BigInt(Date.now() + 300_000); // 5 minutes

// Mainnet:
const expiryMs = BigInt(checkoutDate.getTime() + 5 * 24 * 60 * 60 * 1000); // checkout + 5 days
```

The `MAX_EXPIRY_MS` in the Move contract is 30 days — a 5-day deposit hold is well within bounds.

---

## Phase 7 — Soft Launch Testing
*Estimated time: 1–2 weeks of testing*

With 2–3 trusted testers:

- [ ] Sign in via Google → zkLogin derives mainnet address
- [ ] Deposit USDC from a CEX to the derived Sui wallet address
- [ ] Browse listings → book a property → sign escrow with real USDC
- [ ] Confirm booking shows on-chain on Sui mainnet explorer
- [ ] Host views booking → releases deposit
- [ ] Guest check-in flow (self check-in + front desk)
- [ ] Cancel flow → verify refund lands
- [ ] Send SUI between wallets
- [ ] Resale listing and purchase
- [ ] Claim/dispute flow (test with arbitrator key)
- [ ] Auto-release sweep fires and releases expired escrows

**Monitor:** Railway logs, Sui mainnet explorer, PostgreSQL for any data anomalies.

---

## Phase 8 — Move Audit (run in parallel with Phases 1–7)
*Estimated time: 6–10 weeks*

Start the audit process immediately — it's the longest lead time item.

### 8.1 Prepare audit package
- Clean up `escrow.move` comments and docs
- Make sure all 52 Move tests pass
- Write a 1-page summary of what the contract does, its security model, and known limitations
- Include `ARIA_HANDOFF.md`'s contract section as background

### 8.2 Contact auditors
Priority order:
1. **OtterSec** — osec.io — Sui's official audit partner, knows Move best
2. **Zellic** — zellic.io — also Sui-partnered
3. **Sherlock** — sherlock.xyz — competitive marketplace, often faster/cheaper for small scopes

Request quotes from all three simultaneously. Expect $15K–$50K for ARIA's scope. Ask about Sui Foundation audit subsidies.

### 8.3 After audit passes
- Fix any findings (likely minor given prior reviews)
- Burn the UpgradeCap on mainnet — this is the point of no return
- Open to the public

---

## Phase 9 — Public Launch
*After audit complete, UpgradeCap burned*

- Remove invite-only restrictions
- Set up proper monitoring (alerts on Railway, Sui explorer webhooks)
- Announce

---

## Summary Timeline

| Phase | Work | When |
|---|---|---|
| 1 | Pre-migration prep | Week 1 |
| 2 | Contract deploy to mainnet | Week 1 |
| 3–4 | Railway + Vercel config | Week 1 |
| 5 | Seal mainnet key servers | Week 1–2 |
| 6 | Expiry windows code change | Week 1 |
| 7 | Soft launch testing | Weeks 2–3 |
| 8 | Move audit (parallel) | Weeks 1–10 |
| 9 | Public launch | After audit |

**Total to soft launch: ~1–2 weeks of focused work.**
**Total to public launch: ~8–12 weeks (audit is the gating item).**

---

## Open Questions Before Starting

1. **Production domain** — do you have a domain name for the mainnet ARIA app?
2. **Separate Railway service for mainnet?** — recommended: keep testnet running separately so you can still demo it while mainnet is live.
3. **Separate Vercel project for mainnet?** — same reason.
4. **USDC as payment coin confirmed?** — or do you want to use native SUI for simplicity and add USDC later?

---

*Created June 30, 2026. Update as each phase completes.*
