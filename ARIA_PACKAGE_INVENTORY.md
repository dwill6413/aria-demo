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
| **Current published package ID (v2)** | `0x98e712692f22f308bb6d097d2d8a2743ed0c01058135d71436b4abcd34264f26` |
| UpgradeCap object ID | `0x41f043cf28d0bb77ef6031c5208b611bdd673992afa9e27763b41033e4a327eb` |
| UpgradeCap owner | `0x24bd37a7d13a78de81bd5345899da8b7a4d41ebf26fc1af6f934f9841c7d97f3` (cold deployer — see `ARIA_KEY_INVENTORY.md` #1) |
| Toolchain version (last successful build) | `1.73.1` |

**Why two package IDs:** the *original* ID is permanent — it's what every
`BookingEscrow<T>` object's type tag is pinned to forever, no matter how many
upgrades happen. The *current* ID is whichever package version has the latest
function logic, and is what the backend should call into. Function calls use
the current ID; type references use the original ID.

### Version history

| Version | Package ID | Date | Notes |
|---|---|---|---|
| v1 | `0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe` | June 12, 2026 (P1a) | Original deploy. |
| v2 | `0x98e712692f22f308bb6d097d2d8a2743ed0c01058135d71436b4abcd34264f26` | June 17, 2026 (P3) | Removed dead `STATUS_RESOLVED` constant (kept `status_resolved()` accessor, now hardcoded, for upgrade compatibility); added 30-day `MAX_EXPIRY_MS` upper bound + `EExpiryTooFar`. Tx digest: `JCA8daJ9mSByY6x51ZhEc6Ubfrv1LEbf3nsVccEFtJZK`. |

### Env vars that reference this contract

| Env var | Value | Where |
|---|---|---|
| `ESCROW_PACKAGE_ID` | `0x98e712...4264f26` (v2) | Railway — **live since June 17, 2026, 3:05 PM CDT**, redeploy confirmed clean via deploy logs |
| `ESCROW_MODULE_NAME` | `escrow` | Railway |

### Explorer links

| What | Link |
|---|---|
| v1 package (original) | `https://suiexplorer.com/object/0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe?network=testnet` |
| v2 package (current) | `https://suiexplorer.com/object/0x98e712692f22f308bb6d097d2d8a2743ed0c01058135d71436b4abcd34264f26?network=testnet` |
| P3 upgrade transaction | `https://suiexplorer.com/txblock/JCA8daJ9mSByY6x51ZhEc6Ubfrv1LEbf3nsVccEFtJZK?network=testnet` |

---

## `aria_escrow::pii_access` (future — Seal allowlist contract)

| | |
|---|---|
| Status | **Not yet deployed.** Planned for Phase 2a/2b. |
| Env var placeholder | `SEAL_PACKAGE_ID = 0x<from pii_access.move deployment>` |
| Purpose | Seal-based allowlist contract gating decryption of guest PII. |

Update this section with the real package ID the moment it's deployed —
don't leave the placeholder stale once it's live.

---

## Quick decision table

| Question | Answer |
|---|---|
| "Which package ID do I call functions on?" | The current one (v2): `0x98e712...4264f26`. |
| "Which package ID defines the `BookingEscrow<T>` type?" | The original (v1): `0x538262...7fdbe` — never changes. |
| "Who can publish a new upgrade?" | Whoever holds the UpgradeCap (`0x41f043...327eb`), currently the cold deployer key. |
| "Is the Seal contract live yet?" | No — `pii_access.move` is still Phase 2, not deployed. |

---

*Created June 17, 2026, alongside the P3 upgrade. Update this file every time
a new package version is published or a new contract is deployed — keep it in
sync with `Published.toml`, `ARIA_KEY_INVENTORY.md`, and the Environment
Variables sections of `ARIA_HANDOFF.md` / `ARIA_ROADMAP.md`.*
