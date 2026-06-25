# ARIA — Package & On-Chain Object Inventory

**Purpose:** a single at-a-glance reference for every Sui package ID, object ID,
and build identifier ARIA touches. Public, on-chain data only — no private
keys live here (see `ARIA_KEY_INVENTORY.md` for keys/addresses).

---

## `aria_escrow::escrow` — the booking escrow contract

| | |
|---|---|
| Module | `escrow` |
| Network | Sui testnet |
| Chain ID | `4c78adac` |
| **Original (type-defining) package ID** | `0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe` |
| **Current published package ID (v6)** | `0x897777aa537c6e438dba11c750d5579848e2cd57afb29c3f68531ec6aeb6c901` |
| Prior published package ID (v5) | `0xd825ec2db47c38758974dd9ae64fb4c4fe996ed383ae228052f30ec3351dc9b8` |
| Prior published package ID (v4) | `0xf68a874fbdd3e5aa328f6754bd757edc6c2690510284fa39d5088e44b4cd9e77` |
| UpgradeCap object ID | `0x41f043cf28d0bb77ef6031c5208b611bdd673992afa9e27763b41033e4a327eb` (now at version 6) |
| UpgradeCap owner | `0x24bd37a7d13a78de81bd5345899da8b7a4d41ebf26fc1af6f934f9841c7d97f3` (cold deployer — see `ARIA_KEY_INVENTORY.md` #1) |

**Why two package IDs:** the *original* ID is permanent — it's what every
`BookingEscrow<T>` (and `BookingPaymentEscrow<T>`) object's type tag is pinned to
forever, no matter how many upgrades happen, and it's also the id Seal anchors its
identity namespace to (see Seal section). The *current* ID is whichever package
version has the latest function logic. **Function calls use the current ID; type
references — and Seal encrypt/SessionKey — use the original ID.** (The one
exception: the `seal_approve` *move call* targets the current ID because that's
the version the function lives in — see Seal section + `ARIA_HANDOFF.md` Sui
Integration Lessons §13.) **Note:** **v6 published on-chain June 24, 2026** (Phase 2c
resale market — `ResalePolicy` + `list_for_resale`/`buy_resale`/`cancel_resale_listing`,
additive/no-break; tx `CRYbygbqkk1HNaTaZfXsZnbXy85adHNUAQd6J4QKXTjD`). **Env rollout
applied + resale VERIFIED in-browser June 24, 2026** — Railway `ESCROW_PACKAGE_ID` +
Vercel `NEXT_PUBLIC_ESCROW_PACKAGE_ID` on v6, `RESALE_ENABLED=true`, `RESALE_WINDOW_MS=0`
+ `PAYMENT_RELEASE_OFFSET_MS=86400000` (testnet). End-to-end list→buy confirmed on
booking `ARIA-1-1782390279195-4320e7` (buy digest `E9gWpqWGKZh5hJw6kfnF6LfZfrj1son5HbctTVnzpcXg`):
the on-chain `BookingResold` event split $400 sale as ARIA $0.30 / host $1.35 / seller
$398.35 (face $397 + 45% of the $3 upcharge), reassigned both escrows to the buyer,
bumped `resale_count`→1, and minted a fresh pass to the buyer. (v5 BookingPass also
published + verified — see v5 row.) See the env-vars table below.

### Version history

| Version | Package ID | Date | Notes |
|---|---|---|---|
| v1 | `0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe` | June 12, 2026 (P1a) | Original deploy. Permanent type-defining ID + Seal identity-namespace anchor. |
| v2 | `0x98e712692f22f308bb6d097d2d8a2743ed0c01058135d71436b4abcd34264f26` | June 17, 2026 (P3) | Removed dead `STATUS_RESOLVED` constant; added 30-day `MAX_EXPIRY_MS` + `EExpiryTooFar`. Tx `JCA8daJ9mSByY6x51ZhEc6Ubfrv1LEbf3nsVccEFtJZK`. |
| v3 | `0xec0d6bd45d6bbf3aad04778ace4aacef33c071a30d79090532ba1697644d8fa1` | June 18, 2026 | Added permissionless `finalize_claim` (CLAIMED-deadlock fix). Tx `9wzX4hQkZzzyZTMh9siAU2kHqRLQmJJots3FjzgGMAQa`. |
| v4 | `0xf68a874fbdd3e5aa328f6754bd757edc6c2690510284fa39d5088e44b4cd9e77` | June 23, 2026 | **Phase 1h.5 fee escrow** (`BookingPaymentEscrow` + `create_payment_escrow`/`release_payment`/`refund_payment`/`refund_deposit`) **+ Phase 2 `seal_approve`**, one bundled upgrade. Tx `x7LUYvjszivxAouFYchPnLLVFSUGzhowYuhVQBArB2v`. Live + smoke-tested. |
| v5 | `0xd825ec2db47c38758974dd9ae64fb4c4fe996ed383ae228052f30ec3351dc9b8` | June 24, 2026 | **Phase 2a BookingPass** — soulbound `BookingPass` owned object minted in the booking PTB, gated behind `BOOKING_PASS_ENABLED`. Additive upgrade, no compatibility break; `seal_approve` + fee/Seal calls unchanged. Tx `EoGhMXMEA8mDobxh38WT2WR1hxd4GuobfJqupsthE1LX`. Published + verified in-browser June 24, 2026 — booking `ARIA-1-1782312873579-3d5f50` minted the 🎫 pass. |
| **v6 (current)** | `0x897777aa537c6e438dba11c750d5579848e2cd57afb29c3f68531ec6aeb6c901` | June 24, 2026 | **Phase 2c resale market** — new `ResalePolicy` shared object + `create_resale_policy` / `list_for_resale` / `buy_resale` / `cancel_resale_listing`. Five rails: host opt-in, price cap, ARIA 10% / host 45% / seller-keeps-face+45% split, one-hop limit, configurable no-transfer window (`resale_window_ms`, baked per booking; 48h mainnet default). Additive upgrade, no struct/signature changes to existing escrows. 52/52 Move tests. Tx `CRYbygbqkk1HNaTaZfXsZnbXy85adHNUAQd6J4QKXTjD`. **Live + verified in-browser June 24, 2026** — end-to-end list→buy on booking `ARIA-1-1782390279195-4320e7` (buy digest `E9gWpqWGKZh5hJw6kfnF6LfZfrj1son5HbctTVnzpcXg`); `BookingResold` split ARIA $0.30 / host $1.35 / seller $398.35, escrows reassigned to buyer, fresh pass minted. `RESALE_ENABLED=true`. |

### Env vars that reference this contract

| Env var | Value | Where |
|---|---|---|
| `ESCROW_PACKAGE_ID` | `0x897777aa…c901` (v6) | Railway — on v6 (confirmed June 24, 2026) |
| `ESCROW_MODULE_NAME` | `escrow` | Railway |
| `NEXT_PUBLIC_ESCROW_PACKAGE_ID` | `0x897777aa…c901` (v6) | Vercel — `seal_approve` move-call target in `lib/seal.js`; on v6 (confirmed) |
| `BOOKING_PASS_ENABLED` | `true` (mint on) | Railway — gates the BookingPass mint; on since June 24, 2026. v6 keeps the pass logic, leave on. |
| `RESALE_ENABLED` | `true` | Railway — gates the Phase 2c resale routes + the `create_resale_policy` mint. Live June 24, 2026. |
| `RESALE_WINDOW_MS` | `0` (testnet) → 48h default on mainnet (unset) | Railway — no-transfer window baked into each booking's `ResalePolicy`. 0 on testnet because the release time is artificial; mainnet uses the real check-in + 48h. |
| `PAYMENT_RELEASE_OFFSET_MS` | `86400000` (1 day, testnet) → default 5 min if unset | Railway — how far out a new booking's payment release / `ResalePolicy.release_time_ms` is set. Longer = usable resale window on testnet. Mainnet: set release to the real check-in. |
| `PAYMENT_COIN_TYPE` / `NEXT_PUBLIC_PAYMENT_COIN_TYPE` | unset → `0x2::sui::SUI` (testnet); SuiUSD type on mainnet | Railway / Vercel |

### Explorer links

| What | Link |
|---|---|
| v1 package (original / type-defining) | `https://suiscan.xyz/testnet/object/0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe` |
| v4 package (prior) | `https://suiscan.xyz/testnet/object/0xf68a874fbdd3e5aa328f6754bd757edc6c2690510284fa39d5088e44b4cd9e77` |
| v4 upgrade transaction | `https://suiscan.xyz/testnet/tx/x7LUYvjszivxAouFYchPnLLVFSUGzhowYuhVQBArB2v` |
| v5 package (prior) | `https://suiscan.xyz/testnet/object/0xd825ec2db47c38758974dd9ae64fb4c4fe996ed383ae228052f30ec3351dc9b8` |
| v5 upgrade transaction | `https://suiscan.xyz/testnet/tx/EoGhMXMEA8mDobxh38WT2WR1hxd4GuobfJqupsthE1LX` |
| v6 package (current) | `https://suiscan.xyz/testnet/object/0x897777aa537c6e438dba11c750d5579848e2cd57afb29c3f68531ec6aeb6c901` |
| v6 upgrade transaction | `https://suiscan.xyz/testnet/tx/CRYbygbqkk1HNaTaZfXsZnbXy85adHNUAQd6J4QKXTjD` |

---

## Seal (guest PII) — NO separate contract

The original plan for a standalone `aria_escrow::pii_access` allowlist module was
**dropped** (see `ARIA_ROADMAP.md` Phase 2, revised June 17, 2026). Instead,
`seal_approve<T>(id, escrow, ctx)` was added directly to `escrow.move` in the v4
upgrade. **There is no `SEAL_PACKAGE_ID` and no separate deployment.**

| | |
|---|---|
| Gate function | `escrow::seal_approve` — present in v4 `0xf68a874f…`, v5 `0xd825ec2d…`, and v6 `0x897777aa…`; the live move-call target follows `NEXT_PUBLIC_ESCROW_PACKAGE_ID`. Asserts `id == address::to_bytes(escrow.guest)` AND `sender == escrow.host`. (Phase 2c resale relies on this: `buy_resale` reassigns `escrow.guest` to the buyer on-chain, so host PII access automatically follows the new holder.) |
| Seal identity namespace | anchored to the **original** package id `0x538262…` (Seal's `fetch_first_pkg_id`) — used for encrypt + `SessionKey` |
| Testnet key servers | `mysten-testnet-1` `0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75`, `mysten-testnet-2` `0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8` (2-of-2 threshold) |
| Mainnet | no free Mysten Open key server — needs a paid/third-party provider (still open) |

---

## Client SDK dependencies (npm) — current as of June 23, 2026

Backend (Railway, Node 22) + frontend (Vercel) share one `package.json`.

| Package | Version | Notes |
|---|---|---|
| `@mysten/sui` | `^2.19.0` | Bumped from `2.16.3` June 23, 2026 to satisfy `@mysten/seal`'s peer. gRPC client used everywhere. |
| `@mysten/seal` | `^1.2.1` | Added June 23, 2026 (Phase 2). Frontend-only, dynamic-imported in `lib/seal.js`. |
| `@mysten/walrus` | `^1.1.7` | Immutable receipts + PII blob storage (HTTP publisher). |
| `@mysten/deepbook-v3` | `^1.3.6` | Host-payout / liquidity reads. |

**Build/runtime:** Railway installs with **pnpm 10 via `npx --yes pnpm@10
install --frozen-lockfile`** (see `nixpacks.toml` / `railway.json`). NOT npm
(intermittent build-heartbeat timeouts on the large dep tree), NOT corepack (Node
22.11's corepack has stale signing keys), NOT pnpm 11 (requires Node ≥ 22.13; the
`nodejs_22` image is 22.11). Lockfile is `pnpm-lock.yaml` `lockfileVersion 9.0`.

---

## Quick decision table

| Question | Answer |
|---|---|
| "Which package ID do I call functions on?" | The current published one (v6): `0x897777aa…c901`. **Env rollout pending** — until Railway/Vercel `*_PACKAGE_ID` are moved to v6, the live deployment still calls v5 `0xd825ec2d…dc9b8`. |
| "Which package ID defines the escrow types / anchors Seal?" | The original (v1): `0x538262…7fdbe` — never changes. |
| "Which id does Seal encrypt + SessionKey use vs. the seal_approve call?" | encrypt + SessionKey → original `0x538262…`; the `seal_approve` move call → whatever `NEXT_PUBLIC_ESCROW_PACKAGE_ID` is set to (the fn exists in v4/v5/v6). |
| "Who can publish a new upgrade?" | Whoever holds the UpgradeCap (`0x41f043…327eb`, now at version 6), currently the cold deployer key. |
| "Is there a separate Seal/PII contract?" | No — `seal_approve` lives in `escrow.move` (v4–v6). No `SEAL_PACKAGE_ID`. |
| "What changed in v6?" | Phase 2c resale market: new `ResalePolicy` object + `list_for_resale`/`buy_resale`/`cancel_resale_listing`, all behind `RESALE_ENABLED`. Additive/no-break; existing escrow structs + signatures untouched. |

---

*Created June 17, 2026 (P3 upgrade). Last updated June 24, 2026 (**v6 publish —
Phase 2c resale market**: new `ResalePolicy` + `list_for_resale`/`buy_resale`/
`cancel_resale_listing`, configurable `resale_window_ms`; additive upgrade, no
compatibility break; 52/52 Move tests; tx `CRYbygbqkk1HNaTaZfXsZnbXy85adHNUAQd6J4QKXTjD`).
v6 is published on-chain (`Published.toml` version 6), the env rollout is applied
(Railway/Vercel `*_PACKAGE_ID` on v6, `RESALE_ENABLED=true`, `RESALE_WINDOW_MS=0`,
`PAYMENT_RELEASE_OFFSET_MS=86400000` on testnet), and **resale is verified live
in-browser June 24, 2026** — end-to-end list→buy on booking
`ARIA-1-1782390279195-4320e7` (buy digest `E9gWpqWGKZh5hJw6kfnF6LfZfrj1son5HbctTVnzpcXg`)
with the on-chain `BookingResold` split confirmed. v5 BookingPass also published +
verified. Update this file every time a new package
version is published or dependencies change — keep it in sync with `Published.toml`,
`ARIA_KEY_INVENTORY.md`, and the Environment Variables sections of `ARIA_HANDOFF.md`
/ `ARIA_ROADMAP.md`.*
