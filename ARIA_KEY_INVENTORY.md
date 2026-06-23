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
| Recent use | Signed the P3 upgrade (June 17, 2026, tx `JCA8daJ9mSByY6x51ZhEc6Ubfrv1LEbf3nsVccEFtJZK`), publishing package v2 at `0x98e712692f22f308bb6d097d2d8a2743ed0c01058135d71436b4abcd34264f26`. The original package ID above stays the type-defining ID for existing `BookingEscrow` objects regardless of how many upgrades happen. |

## 2. Auto-release key (`ARIA_AUTO_RELEASE_KEY` / `autoReleaseKeypair`)

| | |
|---|---|
| Address | `0xc0b4e8b46731329fa83a8a5d93b1600b415fe0b050be986bb3f7cffda22e0ff9` |
| Status | **Active.** Loaded by the backend from the Railway env var. |
| Signs | Only `auto_release`. |
| Why it's low-risk | `auto_release` has no sender check in the contract at all ("callable by anyone") — this key carries **zero special on-chain privilege**. It can't touch a coin it isn't already entitled to release. It just needs enough testnet SUI to pay gas. |
| When you'd need it | Never manually — the backend's `runAutoReleaseSweep()` calls it automatically on an hourly cron (plus a 30s startup sweep) for any escrow past its expiry with no active claim/dispute. |

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
| Status | **Generated and funded, not yet wired up.** Private key was delivered to you in chat only (never written to a file) — pending manual step: add it to Railway as `ARIA_ARBITRATOR_KEY`, and update `ARIA_ARBITRATOR_ADDRESS` to this address. |
| Signs | Only `resolve_dispute` (contract requires `sender == escrow.arbitrator`). |
| Why it's separate from #3 | An automated `/booking/resolve-dispute` route needs a key the backend can actually load and sign with. Key #3 was deliberately built to never be loaded by anything — so this new key fills that operational gap without compromising the "arbitrator key stays cold" design for #3. |
| When you'd need it | Automatically — once Railway is updated, the backend signs `resolve_dispute` with this key whenever `/booking/resolve-dispute` is called. Applies only to escrows **created after** the Railway update (see #3's caveat). |

---

## 5. Treasury addresses — receive-only (Phase 1h.5, payment escrow)

| | |
|---|---|
| `ARIA_FEE_ADDRESS` | **TBD — not yet generated/set.** Destination for ARIA's 3% booking fee leg of `release_payment` at check-in. |
| `ARIA_TAX_REMITTANCE_ADDRESS` | **TBD — not yet generated/set.** Destination for the tax leg of `release_payment`. |
| Status | **Receive-only — NOT signing keys.** The backend never loads a private key for either; they only ever appear as the `aria_addr` / `tax_addr` fields baked into a `BookingPaymentEscrow`, and as destinations of the on-chain split. |
| Why low-risk | Nothing the backend does requires their private keys. A leak of the *address* is harmless (it only receives funds); secure the receiving wallet's keys in KeePass like any treasury. |
| Verification role | `verifyBookingPaymentTransaction` rejects any booking PTB whose fee/tax legs don't point at exactly these addresses (destination-authority check), so a tampered transaction can't redirect ARIA's fee or the tax remittance. |
| When to set | Generate two receiving wallets, set both as Railway env vars. Until BOTH are set, `createBooking` falls back to the deposit-only P0b build and no payment escrow is created. |

---

## Not ARIA-controlled keys (for context, not in your vault)

- **Guest wallets** — each guest signs `create_escrow` with their own zkLogin-derived wallet. ARIA never holds or sees their private key.
- **Host payout addresses** — looked up per-property from `host_profiles.payout_sui_address`; each host's own wallet. ARIA doesn't generate or hold these.

---

## Quick decision table

| Question | Answer |
|---|---|
| "Which key does the backend use day-to-day?" | #2 (auto-release) today; #4 (new arbitrator) once Railway is updated. |
| "Which key should never touch a server?" | #1 (deployer/UpgradeCap) and #3 (original arbitrator) — both cold-storage only. |
| "Which key resolves a dispute on an old escrow?" | #3, if the escrow was created before the Railway update; #4 otherwise. |
| "Which key has the most power if leaked?" | #1 — it can upgrade the contract. |

---

*Created June 17, 2026, alongside P2 completion. Update this file whenever a
key is rotated, retired, or a new one is generated — keep it in sync with the
Environment Variables sections of `ARIA_HANDOFF.md` and `ARIA_ROADMAP.md`.*
