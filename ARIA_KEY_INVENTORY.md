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
| Recent use | Signed the **v6 upgrade** (June 24, 2026, tx `CRYbygbqkk1HNaTaZfXsZnbXy85adHNUAQd6J4QKXTjD`), publishing package **v6** at `0x897777aa537c6e438dba11c750d5579848e2cd57afb29c3f68531ec6aeb6c901` — Phase 2c resale market (`ResalePolicy` + list/buy/cancel; additive, no compatibility break). UpgradeCap is now at version 6. (Earlier: **v5** `0xd825ec2d…dc9b8` Phase 2a BookingPass June 24, tx `EoGhMXMEA8mDobxh38WT2WR1hxd4GuobfJqupsthE1LX`; **v4** `0xf68a874f…b4cd9e77` fee escrow + `seal_approve` June 23, tx `x7LUYvjszivxAouFYchPnLLVFSUGzhowYuhVQBArB2v`; v3 `0xec0d6bd4…644d8fa1` finalize_claim June 18; v2 `0x98e712…4264f26` June 17, tx `JCA8da…FtJZK`.) The original package ID above stays the type-defining ID for existing `BookingEscrow` objects — and anchors Seal's identity namespace — regardless of how many upgrades happen. |

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
| `ARIA_FEE_ADDRESS` | `0xcc27c579f88e82d0e78f159435675fecf4b1029405eb6f380553132f760ac6de` (alias `aria-fee`, generated June 23, 2026; recovery phrase in KeePass). Destination for ARIA's 3% booking fee leg of `release_payment` at check-in. |
| `ARIA_TAX_REMITTANCE_ADDRESS` | `0xc75ae8270ca15de2ab0c10a8269d5b42459f813a125ac3cd29ba4a76a008637c` (alias `aria-tax`, generated June 23, 2026; recovery phrase in KeePass). Destination for the tax leg of `release_payment`. |
| Status | **Receive-only — NOT signing keys.** The backend never loads a private key for either; they only ever appear as the `aria_addr` / `tax_addr` fields baked into a `BookingPaymentEscrow`, and as destinations of the on-chain split. |
| Why low-risk | Nothing the backend does requires their private keys. A leak of the *address* is harmless (it only receives funds); secure the receiving wallet's keys in KeePass like any treasury. |
| Verification role | `verifyBookingPaymentTransaction` rejects any booking PTB whose fee/tax legs don't point at exactly these addresses (destination-authority check), so a tampered transaction can't redirect ARIA's fee or the tax remittance. |
| When to set | Generate two receiving wallets, set both as Railway env vars. Until BOTH are set, `createBooking` falls back to the deposit-only P0b build and no payment escrow is created. |

---

## 6. Demo host address (`DEMO_HOST_ADDRESS`)

| | |
|---|---|
| Address | `0x1de92e91ad61de63de2db649203164e772f74ff984b0c6870ffa798a7b391c8b` |
| Status | **Set in Railway (June 23, 2026).** This is the operator's own zkLogin address (the Google demo account), used as the `host` for the 6 demo properties whose `catalog.mjs` `hostAddress` is `null`. |
| Why it exists | `claim_damage`, `seal_approve`, and the payout all assert `sender == escrow.host`. For the demo to exercise host actions (release deposit, view guest identity, file a claim) end-to-end from one logged-in account, the escrow's host must be an address the operator can sign with — so it's set to this zkLogin address. |
| Scope | Only affects NEW bookings on demo properties (existing escrows keep their old host baked in immutably). Becomes dead config once real hosts onboard with per-property addresses — see `ARIA_ROADMAP.md` tech-debt "Properties frontend-hardcoded / host onboarding" for the payout-vs-signing-address constraint. |

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

*Created June 17, 2026 (P2). Last updated June 24, 2026: deployer key #1 signed the
**v5** (Phase 2a BookingPass) and **v6** (Phase 2c resale market) upgrades; UpgradeCap
now at version 6. No keys rotated or generated for v5/v6 — same deployer, auto-release,
arbitrator, and treasury addresses as before. (Prior June 23, 2026: arbitrator key #4
marked active, signs `resolve_dispute` + Phase 1h.5 `refund_payment`/`refund_deposit`;
auto-release key #2 signs `finalize_claim` + `release_payment`; treasury addresses (#5)
and `DEMO_HOST_ADDRESS` (#6) recorded.) Update whenever a key is rotated, retired, or
generated — keep in sync with the Environment Variables sections of `ARIA_HANDOFF.md` /
`ARIA_ROADMAP.md` and with `ARIA_PACKAGE_INVENTORY.md`.*
