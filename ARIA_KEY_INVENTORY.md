# ARIA — Key & Address Inventory

**Purpose:** a single reference for every Sui keypair/address ARIA touches, what
each one is allowed to do, and where it lives. Public addresses only — **no
private keys, mnemonics, or KeePass exports are ever written into this file.**
Private key material lives only in KeePass and (for keys the backend needs to
load) in Railway environment variables.

---

## 1. Deployer / UpgradeCap key

| | |
|---|---|
| Address | `0x24bd37a7d13a78de81bd5345899da8b7a4d41ebf26fc1af6f934f9841c7d97f3` |
| Status | **Retired — cold KeePass storage only.** Not loaded by the backend, not in Railway. |
| Signs | Nothing currently. Originally deployed `escrow.move` and (before P0b, June 16, 2026) signed `create_escrow` directly. |
| Why it's powerful | Owns the `UpgradeCap` (`0x41f043cf28d0bb77ef6031c5208b611bdd673992afa9e27763b41033e4a327eb`) — can upgrade the deployed package. This is the highest-privilege key in the system. |
| When you'd need it | Only to upgrade the Move contract, or to formally burn the UpgradeCap (planned pre-mainnet step, once an independent audit passes). |
| Recent use | Signed the **v7 upgrade** (June 25, 2026, tx `6DTCEZ3rf54NfY5RhV18WWx2apk1tgB5e1d2AUWGoukC`), publishing package **v7** at `0xadd5ac7867a69200d632e858193549b6fa94abff7d80397a1ab4c418f99d3e60` — pre-mainnet hardening (u128 intermediates in the resale split/cap math; additive, no behavior change). UpgradeCap is now at version 7. (Earlier: **v6** `0x897777aa…c901` Phase 2c resale market June 24, tx `CRYbygbqkk1HNaTaZfXsZnbXy85adHNUAQd6J4QKXTjD`; **v5** `0xd825ec2d…dc9b8` Phase 2a BookingPass June 24, tx `EoGhMXMEA8mDobxh38WT2WR1hxd4GuobfJqupsthE1LX`; **v4** `0xf68a874f…b4cd9e77` fee escrow + `seal_approve` June 23, tx `x7LUYvjszivxAouFYchPnLLVFSUGzhowYuhVQBArB2v`; v3 `0xec0d6bd4…644d8fa1` finalize_claim June 18; v2 `0x98e712…4264f26` June 17.) Note: the v7 upgrade required updating the local Sui CLI to 1.74.0 (testnet protocol 127) and a faucet top-up of this address for gas. The original package ID stays the type-defining ID for existing `BookingEscrow` objects — and anchors Seal's identity namespace — regardless of how many upgrades happen. |

## 2. Auto-release key (`ARIA_AUTO_RELEASE_KEY` / `autoReleaseKeypair`)

| | |
|---|---|
| Address | `0xc0b4e8b46731329fa83a8a5d93b1600b415fe0b050be986bb3f7cffda22e0ff9` |
| Status | **Active.** Loaded by the backend from the Railway env var. |
| Signs | The permissionless calls: `auto_release`, `finalize_claim` (v3), and `release_payment` (v4 — the check-in 3-way payment split). |
| Why it's low-risk | All three have **no sender check** in the contract ("callable by anyone") — this key carries **zero special on-chain privilege**. It can't touch a coin it isn't already entitled to release/split; it only triggers the escrow's own baked-in logic. It just needs enough testnet SUI for gas. |
| When you'd need it | Never manually — driven by two crons: `runAutoReleaseSweep()` (deposit auto-release + claim-finalize, hourly + 30s startup) and `runCheckInReleaseSweep()` (payment release at check-in, same cadence + 35s startup). |

## 3. Arbitrator key — original / cold (P1a, June 12, 2026)

| | |
|---|---|
| Address | `0x0069868f93f9127b3e8b51bf95bc529925ca382e6305da0bb01f693826b983f8` |
| Status | **Cold storage, manual-signing only, by design.** Never loaded by the backend. This is the one in your KeePass entry "ARIA Arbitrator Address and Keys." |
| Signs | `resolve_dispute` — but only if you manually sign with this key outside the app. |
| Why it exists | This was the first arbitrator key generated, intentionally kept offline as the "fall back to a human" option. |
| When you'd need it | If a dispute comes in on an escrow that was **created before** the Railway `ARIA_ARBITRATOR_ADDRESS` env var gets updated to key #4 below. That escrow's `arbitrator` field is permanently set to this address on-chain — only this key can resolve it, no matter what Railway says later. |

## 4. Arbitrator key — new / operational (P2, June 17, 2026)

| | |
|---|---|
| Address | `0xf46527e18f2fd7d3093c9591ded66e3a8711a18de63cd0bede2d88692e6f6a65` |
| Status | **Active — loaded by the backend.** `ARIA_ARBITRATOR_KEY` set in Railway and `ARIA_ARBITRATOR_ADDRESS` = this address (confirmed in deploy logs June 18 + June 23, 2026: `Sui arbitrator keypair loaded: 0xf46527e1…`). |
| Signs | `resolve_dispute`, `refund_payment`, and `refund_deposit` — all contract-gated on `sender == escrow.arbitrator`. (Phase 1h.5 added the two refund calls, signed by this same key via `/booking/cancel`.) |
| Why it's separate from #3 | An automated `/booking/resolve-dispute` route needs a key the backend can actually load and sign with. Key #3 was deliberately built to never be loaded by anything — so this new key fills that operational gap without compromising the "arbitrator key stays cold" design for #3. |
| When you'd need it | Automatically — once Railway is updated, the backend signs `resolve_dispute` with this key whenever `/booking/resolve-dispute` is called. Applies only to escrows **created after** the Railway update (see #3's caveat). |

---

## 5. Treasury addresses — receive-only (Phase 1h.5, payment escrow)

| | |
|---|---|
| `ARIA_FEE_ADDRESS` | `0xcc27c579f88e82d0e78f159435675fecf4b1029405eb6f380553132f760ac6de` (alias `aria-fee`, generated June 23, 2026; recovery phrase in KeePass). Destination for ARIA's 5% booking fee leg of `release_payment` at check-in. |
| `ARIA_TAX_REMITTANCE_ADDRESS` | **RETIRED (June 30, 2026).** `0xc75ae8270ca15de2ab0c10a8269d5b42459f813a125ac3cd29ba4a76a008637c` (alias `aria-tax`) is no longer used by the backend. Design correction: ARIA does not custody occupancy tax. The tax leg (`tax_addr`) now routes to the host's own payout address — the same wallet that receives the rental subtotal — so the host receives rental+tax combined at check-in and self-remits to the tax authority (tracked via `tax_remittances`/`/tax/remit`). No Move upgrade was needed since `tax_addr` is a plain function argument, not hardcoded. This row is kept for historical reference only; do not set this env var. |
| Status | **Receive-only — NOT a signing key.** The backend never loads a private key for the fee wallet; it only appears as the `aria_addr` field baked into a `BookingPaymentEscrow`, and as a destination of the on-chain split. |
| Why low-risk | Nothing the backend does requires its private key. A leak of the *address* is harmless (it only receives funds); secure the receiving wallet's key in KeePass like any treasury. |
| Verification role | `verifyBookingPaymentTransaction` rejects any booking PTB whose fee leg doesn't point at exactly this address (destination-authority check), and likewise rejects a tax leg that doesn't point at the authoritative host address. |
| When to set | Generate the fee-receiving wallet, set it as a Railway env var. Until set, `createBooking` falls back to the deposit-only P0b build and no payment escrow is created. |

---

## 6. Demo host address (`DEMO_HOST_ADDRESS`)

| | |
|---|---|
| Address | `0x1de92e91ad61de63de2db649203164e772f74ff984b0c6870ffa798a7b391c8b` |
| Status | **Set in Railway (June 23, 2026).** This is the operator's own zkLogin address (the Google demo account), used as the `host` for the 6 demo properties whose `catalog.mjs` `hostAddress` is `null`. |
| Why it exists | `claim_damage`, `seal_approve`, and the payout all assert `sender == escrow.host`. For the demo to exercise host actions (release deposit, view guest identity, file a claim) end-to-end from one logged-in account, the escrow's host must be an address the operator can sign with — so it's set to this zkLogin address. |
| Scope | Only affects NEW bookings on demo properties (existing escrows keep their old host baked in immutably). Becomes dead config once real hosts onboard with per-property addresses — see `ARIA_ROADMAP.md` tech-debt "Properties frontend-hardcoded / host onboarding" for the payout-vs-signing-address constraint. |

---

## 7. Check-in encryption key (`CHECKIN_KEY`)

| | |
|---|---|
| Type | **Symmetric AES-256-GCM key** — NOT a Sui keypair. 64 hex characters (32 bytes). |
| Status | **Active — set in Railway (June 30, 2026).** |
| Purpose | Encrypts/decrypts host-provided self check-in access instructions (door codes, wifi passwords, entry notes) stored in `property_checkin_settings.access_instructions_encrypted`. |
| Stored format | `iv_hex:ciphertext_hex:authtag_hex` — each field is separately hex-encoded; authentication tag provides tamper detection. |
| Who uses it | Backend only (`encryptInstructions` / `decryptInstructions` helpers in `server.mjs`). Never sent to the frontend. |
| Why server-side (not Walrus Seal) | Access instructions are operational data, not PII. Server-mediated AES-256-GCM is appropriate — equivalent to how standard hotel PMS systems protect door codes. Seal would require a Move contract upgrade (`seal_approve_checkin`), on-chain key management, and Seal network dependency for what amounts to a door code. |
| Risk if leaked | An attacker with the key AND database access could decrypt stored access instructions. Rotate the key in Railway and re-save all host instructions if compromised. The key does NOT grant any Sui signing capability. |
| Rotation | Generate a new 64-char hex key, update `CHECKIN_KEY` in Railway, then have each host re-save their access instructions (re-encryption happens on save). |
| Generate new key | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

---

## 8. zkLogin salt — now per-user (`user_salts` table; M3 closed July 1, 2026)

| | |
|---|---|
| Type | **Postgres table (`user_salts`)**, one row per Google account, keyed by the JWT `sub` claim. NOT a Sui keypair, not a single shared value anymore. |
| Status | **Active.** Implemented in `auth.mjs` (`getOrCreateUserSalt`, `handleZkLoginSalt`), `db.mjs` (`user_salts` table, auto-created by `initDB()` on deploy), `server.mjs` (`POST /auth/zklogin/salt`), `lib/zklogin.js` + `pages/auth/zklogin/callback.jsx` (client fetches its own salt before completing login). |
| Purpose | Deriving each user's Sui address from their Google `sub` via `jwtToAddress(id_token, salt)`, using a salt that's unique to that user and, once created, never changes again — closing the single-point-of-failure M3 flagged. |
| How it works | On login, the callback page calls `POST /auth/zklogin/salt` with the id_token. The backend verifies it, looks up `user_salts WHERE sub = ...`. If found, returns that row's salt. If not (first login ever for this sub), it INSERTs a new row seeded with the value below (`ZKLOGIN_SALT` env var) and returns that. The browser uses this salt to build its ZK proof/addressSeed; `handleZkLoginCallback` calls the same `getOrCreateUserSalt()` moments later for the same sub, so both sides always agree — one is just reading back the row the other created. |
| **Does this close M3?** | **Yes.** Each user's derivation input is now frozen the first time they log in. Changing `ZKLOGIN_SALT` going forward can never again reshuffle an existing user's address — it only affects the seed value for a sub that has never logged in before. |
| Legacy value (still used as the *seed* only) | `59495786400363606476793255475060161673` — `ZKLOGIN_SALT` (Railway) / `NEXT_PUBLIC_ZKLOGIN_SALT` (Vercel, now only a same-value fallback in `lib/zklogin.js` if the salt endpoint call fails). Kept in place specifically so every account that had already logged in before this rollout gets a `user_salts` row seeded with the exact value their existing address already depends on — nobody's address moved at cutover. **Still must never be edited** — editing it wouldn't move any already-created row, but it's no longer even doing anything useful once every real account has logged in at least once post-rollout, so there's no upside to touching it, only risk if some code path is ever added that re-reads it live. |
| Why numeric (legacy detail) | The zkLogin prover requires exactly 16 bytes. `crypto.randomBytes(16).toString('hex')` produces 32 hex chars which the prover rejects as "must be 16 bytes." Use BigInt conversion: `node -e "const b = require('crypto').randomBytes(16); console.log(BigInt('0x' + b.toString('hex')).toString())"` |
| **Incident that led to this fix (June 30 → July 1, 2026)** | Before this table existed, all users shared one `ZKLOGIN_SALT` value. Changing it on June 30 (moving off the `'0'` dev default) re-derived every existing user's address at once. Went unnoticed for a day: two test accounts' Sui addresses had silently swapped relative to what old screenshots/transactions showed, which briefly led to assigning the wrong account as "official" property owner in `catalog.mjs` and revoking host status by address instead of realizing email was the safer key. Resolved by re-confirming each account's address live from its wallet display, then building this per-user mechanism so it can't happen again. |
| **Mainnet migration** | No special action needed now — per-user salts are already frozen per account. Just don't touch `ZKLOGIN_SALT`/`NEXT_PUBLIC_ZKLOGIN_SALT` for unrelated reasons, and keep the same Google OAuth client ID (`aud`) through the migration, since `aud` is also a derivation input and switching to a new OAuth client would still re-derive every address regardless of the per-user salt fix. |
| Risk if `user_salts` row is ever edited/deleted | Deleting a row would cause that one user's next login to be treated as brand-new (re-seeded from the current `ZKLOGIN_SALT` env value) — same address ONLY if that env var hasn't changed since; otherwise a new address. Never manually edit or delete rows in this table outside of a deliberate, planned migration. |
| Risk if a salt value leaks | Anyone with a user's salt + their Google `sub` can derive that one user's Sui address (public info anyway). A salt is not secret in the cryptographic sense — it just must stay consistent for that user, which per-user storage now guarantees independent of any env var. |

---

## Not ARIA-controlled keys (for context, not in your vault)

- **Guest wallets** — each guest signs `create_escrow` with their own zkLogin-derived wallet. ARIA never holds or sees their private key.
- **Host payout addresses** — looked up per-property from `host_profiles.payout_sui_address`; each host's own wallet. ARIA doesn't generate or hold these.

---

## Quick decision table

| Question | Answer |
|---|---|
| "Which key does the backend use day-to-day?" | #2 (auto-release, signs the permissionless sweeps) and #4 (arbitrator, signs resolve_dispute + the cancel refunds) — both active in Railway. |
| "Which key should never touch a server?" | #1 (deployer/UpgradeCap) and #3 (original arbitrator) — both cold-storage only. |
| "Which key resolves a dispute on an old escrow?" | #3, if the escrow was created before the June 17 Railway update; #4 otherwise. |
| "Which key has the most power if leaked?" | #1 — it can upgrade the contract. |

---

*Created June 17, 2026 (P2). Last updated July 1, 2026: §8 rewritten — implemented true per-user zkLogin salt (`user_salts` table, `getOrCreateUserSalt`/`handleZkLoginSalt` in `auth.mjs`, `POST /auth/zklogin/salt`), closing M3 for real this time. The shared `ZKLOGIN_SALT`/`NEXT_PUBLIC_ZKLOGIN_SALT` value now only seeds new rows and is no longer read live on every login. (Earlier same-day: corrected an initial claim that the June 30 shared-salt update alone had closed M3 — it hadn't; documented the June 30→July 1 address-swap incident that motivated actually building this.) Prior June 30, 2026: added §7 `CHECKIN_KEY` — AES-256-GCM symmetric key for self check-in access instruction encryption (P4). Prior June 25, 2026: deployer key #1 signed the
**v5** (Phase 2a BookingPass), **v6** (Phase 2c resale market), and **v7** (pre-mainnet
u128 hardening) upgrades; UpgradeCap now at version 7. No keys rotated or generated for
v5/v6/v7 — same deployer, auto-release, arbitrator, and treasury addresses as before. (Prior June 23, 2026: arbitrator key #4
marked active, signs `resolve_dispute` + Phase 1h.5 `refund_payment`/`refund_deposit`;
auto-release key #2 signs `finalize_claim` + `release_payment`; treasury addresses (#5)
and `DEMO_HOST_ADDRESS` (#6) recorded.) Update whenever a key is rotated, retired, or
generated — keep in sync with the Environment Variables sections of `ARIA_HANDOFF.md` /
`ARIA_ROADMAP.md` and with `ARIA_PACKAGE_INVENTORY.md`.*
