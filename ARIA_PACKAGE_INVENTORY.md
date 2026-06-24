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
| **Current published package ID (v5)** | `0xd825ec2db47c38758974dd9ae64fb4c4fe996ed383ae228052f30ec3351dc9b8` |
| Prior published package ID (v4) | `0xf68a874fbdd3e5aa328f6754bd757edc6c2690510284fa39d5088e44b4cd9e77` |
| UpgradeCap object ID | `0x41f043cf28d0bb77ef6031c5208b611bdd673992afa9e27763b41033e4a327eb` |
| UpgradeCap owner | `0x24bd37a7d13a78de81bd5345899da8b7a4d41ebf26fc1af6f934f9841c7d97f3` (cold deployer — see `ARIA_KEY_INVENTORY.md` #1) |

**Why two package IDs:** the *original* ID is permanent — it's what every
`BookingEscrow<T>` (and `BookingPaymentEscrow<T>`) object's type tag is pinned to
forever, no matter how many upgrades happen, and it's also the id Seal anchors its
identity namespace to (see Seal section). The *current* ID is whichever package
version has the latest function logic. **Function calls use the current ID; type
references — and Seal encrypt/SessionKey — use the original ID.** (The one
exception: the `seal_approve` *move call* targets the current ID because that's
the version the function lives in — see Seal section + `ARIA_HANDOFF.md` Sui
Integration Lessons §13.) **Note:** as of June 24, 2026 v5 is published on-chain and
the rollout is applied — Railway `ESCROW_PACKAGE_ID` = v5 and `BOOKING_PASS_ENABLED`
= `true` (both confirmed); Vercel `NEXT_PUBLIC_ESCROW_PACKAGE_ID` set to v5 per the
rollout (confirm the Vercel redeploy). The one open item is an in-browser
fresh-booking test confirming the soulbound `BookingPass` actually mints. See the
env-vars table below.

### Version history

| Version | Package ID | Date | Notes |
|---|---|---|---|
| v1 | `0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe` | June 12, 2026 (P1a) | Original deploy. Permanent type-defining ID + Seal identity-namespace anchor. |
| v2 | `0x98e712692f22f308bb6d097d2d8a2743ed0c01058135d71436b4abcd34264f26` | June 17, 2026 (P3) | Removed dead `STATUS_RESOLVED` constant; added 30-day `MAX_EXPIRY_MS` + `EExpiryTooFar`. Tx `JCA8daJ9mSByY6x51ZhEc6Ubfrv1LEbf3nsVccEFtJZK`. |
| v3 | `0xec0d6bd45d6bbf3aad04778ace4aacef33c071a30d79090532ba1697644d8fa1` | June 18, 2026 | Added permissionless `finalize_claim` (CLAIMED-deadlock fix). Tx `9wzX4hQkZzzyZTMh9siAU2kHqRLQmJJots3FjzgGMAQa`. |
| v4 | `0xf68a874fbdd3e5aa328f6754bd757edc6c2690510284fa39d5088e44b4cd9e77` | June 23, 2026 | **Phase 1h.5 fee escrow** (`BookingPaymentEscrow` + `create_payment_escrow`/`release_payment`/`refund_payment`/`refund_deposit`) **+ Phase 2 `seal_approve`**, one bundled upgrade. Tx `x7LUYvjszivxAouFYchPnLLVFSUGzhowYuhVQBArB2v`. Live + smoke-tested. |
| **v5 (current)** | `0xd825ec2db47c38758974dd9ae64fb4c4fe996ed383ae228052f30ec3351dc9b8` | June 24, 2026 | **Phase 2a BookingPass** — soulbound `BookingPass` owned object minted in the booking PTB, gated behind `BOOKING_PASS_ENABLED`. Additive upgrade, no compatibility break; `seal_approve` + fee/Seal calls unchanged. Tx `EoGhMXMEA8mDobxh38WT2WR1hxd4GuobfJqupsthE1LX`. Published on-chain + env set to v5 with `BOOKING_PASS_ENABLED=true` (June 24, 2026); **fresh-booking on-chain mint not yet verified in-browser**. |

### Env vars that reference this contract

| Env var | Value | Where |
|---|---|---|
| `ESCROW_PACKAGE_ID` | `0xd825ec2d…dc9b8` (v5) | Railway — set to v5 June 24, 2026 (confirmed) |
| `ESCROW_MODULE_NAME` | `escrow` | Railway |
| `NEXT_PUBLIC_ESCROW_PACKAGE_ID` | `0xd825ec2d…dc9b8` (v5) | Vercel — the `seal_approve` move-call target in `lib/seal.js`; set to v5 per rollout (confirm Vercel redeploy) |
| `BOOKING_PASS_ENABLED` | `true` (mint on) | Railway — gates the v5 BookingPass mint; flipped on June 24, 2026 after both `*_PACKAGE_ID` vars were on v5 (confirmed) |
| `PAYMENT_COIN_TYPE` / `NEXT_PUBLIC_PAYMENT_COIN_TYPE` | unset → `0x2::sui::SUI` (testnet); SuiUSD type on mainnet | Railway / Vercel |

### Explorer links

| What | Link |
|---|---|
| v1 package (original / type-defining) | `https://suiscan.xyz/testnet/object/0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe` |
| v4 package (prior) | `https://suiscan.xyz/testnet/object/0xf68a874fbdd3e5aa328f6754bd757edc6c2690510284fa39d5088e44b4cd9e77` |
| v4 upgrade transaction | `https://suiscan.xyz/testnet/tx/x7LUYvjszivxAouFYchPnLLVFSUGzhowYuhVQBArB2v` |
| v5 package (current) | `https://suiscan.xyz/testnet/object/0xd825ec2db47c38758974dd9ae64fb4c4fe996ed383ae228052f30ec3351dc9b8` |
| v5 upgrade transaction | `https://suiscan.xyz/testnet/tx/EoGhMXMEA8mDobxh38WT2WR1hxd4GuobfJqupsthE1LX` |

---

## Seal (guest PII) — NO separate contract

The original plan for a standalone `aria_escrow::pii_access` allowlist module was
**dropped** (see `ARIA_ROADMAP.md` Phase 2, revised June 17, 2026). Instead,
`seal_approve<T>(id, escrow, ctx)` was added directly to `escrow.move` in the v4
upgrade. **There is no `SEAL_PACKAGE_ID` and no separate deployment.**

| | |
|---|---|
| Gate function | `escrow::seal_approve` — present in both v4 `0xf68a874f…` and v5 `0xd825ec2d…`; the live move-call target follows `NEXT_PUBLIC_ESCROW_PACKAGE_ID` (v4 until the v5 rollout). Asserts `id == address::to_bytes(escrow.guest)` AND `sender == escrow.host` |
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
| "Which package ID do I call functions on?" | The current published one (v5): `0xd825ec2d…dc9b8` — but the live env still calls v4 `0xf68a874f…cd9e77` until the rollout flips `*_PACKAGE_ID`. |
| "Which package ID defines the escrow types / anchors Seal?" | The original (v1): `0x538262…7fdbe` — never changes. |
| "Which id does Seal encrypt + SessionKey use vs. the seal_approve call?" | encrypt + SessionKey → original `0x538262…`; the `seal_approve` move call → whatever `NEXT_PUBLIC_ESCROW_PACKAGE_ID` is set to (v4 `0xf68a874f…` now, v5 `0xd825ec2d…` after rollout — the fn exists in both). |
| "Who can publish a new upgrade?" | Whoever holds the UpgradeCap (`0x41f043…327eb`), currently the cold deployer key. |
| "Is there a separate Seal/PII contract?" | No — `seal_approve` lives in `escrow.move` (v4 + v5). No `SEAL_PACKAGE_ID`. |
| "What changed in v5?" | Added the soulbound `BookingPass` mint to the booking PTB, gated by `BOOKING_PASS_ENABLED`. Additive/no-break; everything else identical to v4. |

---

*Created June 17, 2026 (P3 upgrade). Last updated June 24, 2026 (v5 publish —
Phase 2a soulbound `BookingPass` mint, gated by `BOOKING_PASS_ENABLED`; additive
upgrade, no compatibility break). v5 is published on-chain (`Published.toml`
version 5), the env rollout is applied (Railway `ESCROW_PACKAGE_ID` = v5 +
`BOOKING_PASS_ENABLED` = `true`, both confirmed; Vercel `NEXT_PUBLIC_ESCROW_PACKAGE_ID`
set to v5 per rollout). One item remains: an in-browser fresh-booking test confirming
the soulbound `BookingPass` mints — flip the version-history note to "verified" once
that passes. Update this file every time a new package version is published or dependencies
change — keep it in sync with `Published.toml`, `ARIA_KEY_INVENTORY.md`, and the
Environment Variables sections of `ARIA_HANDOFF.md` / `ARIA_ROADMAP.md`.*
