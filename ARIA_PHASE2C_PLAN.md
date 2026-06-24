# ARIA — Phase 2c Build Plan: Guardrailed Resale Market

**Status:** ⬜ Not started — design only. **Created:** June 24, 2026.
**Depends on:** Phase 2a soulbound `BookingPass` (v5, live + verified) and the
fee-escrow 3-way split (v4). **Contract target:** v6 upgrade.

**Purpose:** turn the soulbound pass into a *controlled, host-governed* transfer —
"humane cancellation + host-controlled liquidity," explicitly **not** a scalper
market. This doc is the concrete build scope: contract, DB, backend, frontend,
tests, open decisions, and a suggested sequence.

---

## 1. Current state (what we build on)

| Asset | Where | Reused for |
|---|---|---|
| Soulbound `BookingPass` (`key`, no `store`) | `escrow.move` 652–699 | The thing being transferred. Currently un-transferable by design. |
| `BookingEscrow<T>` + `BookingPaymentEscrow<T>` with a `guest: address` field | `escrow.move` | Must follow the new holder — this is the crux (see §2). |
| 3-way split (`coin::split` + `public_transfer`) in `release_payment` | `escrow.move` 81–145 | The royalty/upcharge split (Rail 3) reuses this exact pattern. |
| Seal identity (`seal_approve`, guest-PII allowlist) | `escrow.move` + `lib/seal.js` | Mandatory buyer identity (Rail 4). |
| Verifiable reviews + portable reputation (Theme A) | `/reviews/*`, Walrus | Reputation gate on flippers (Rail 5). |
| `properties`, `bookings`, `host_profiles`, `guest_verifications` tables | `db.mjs` | New columns for transferability + resale records. |

**Key design fact:** the pass is immutable and carries no mutable status. Its
validity = *guest owns pass AND the booking's escrow is live*. So a transfer is not
"move a key" — it must **reassign the whole booking** (escrow guest + pass + PII
access + payout identity) atomically, or the three drift apart.

---

## 2. The core enabler (the hard part) — contract v6

The roadmap is explicit: resale "needs a gated, mutable-guest contract change so
money/identity/access follow the new holder." Two sub-pieces:

**2.1 Make `guest` reassignable on both escrows.** Add a single gated entry that,
inside one PTB, reassigns `BookingEscrow.guest` and `BookingPaymentEscrow.guest`
to the buyer. Without this, after a "transfer" the deposit would still refund to
the *seller* and the host would still see the seller as the staying party.

**2.2 Reissue the pass to the buyer.** Because `BookingPass` fields (`guest`) are
immutable, the cleanest path is **burn-and-remint**: a module function deletes the
seller's pass and mints a fresh one to the buyer with identical
`booking_ref`/window but `guest = buyer`. (Alternative: add a mutable `guest` field
to the pass — rejected; burn-and-remint keeps the pass immutable and keeps the
"validity derived from ownership + live escrow" invariant intact.)

**2.3 Governance lives in a companion object — NOT the escrow.** Sui upgrade
compatibility forbids (a) adding fields to an existing `key` struct and (b) changing
an existing public function's signature. So we **cannot** add `transferable` to
`BookingEscrow` nor add params to `create_escrow`. Instead a new **`ResalePolicy`**
shared object is minted per booking (new additive function), and `transfer_booking`
mutates the existing escrows' `guest` field (allowed — a new function in the same
module may read/write existing fields).

**Proposed functions (all additive — no existing struct/signature touched):**

```move
public struct ResalePolicy has key {
    id:               UID,
    booking_ref:      String,
    host:             address,
    transferable:     bool,
    max_premium_bps:  u64,    // 0 = face-value only
    resale_count:     u8,     // hop counter
    release_time_ms:  u64,    // check-in, for the 48h window assert
}

/// Minted in the booking PTB for new bookings (host opt-in read from the listing).
public fun create_resale_policy(
    booking_ref, host, transferable, max_premium_bps, release_time_ms, ctx
)

/// One atomic, buyer-signed call. All amounts computed on-chain — nothing trusted.
public fun transfer_booking<T>(
    deposit_escrow: &mut BookingEscrow<T>,
    payment_escrow: &mut BookingPaymentEscrow<T>,
    policy:         &mut ResalePolicy,
    pass:           BookingPass,   // seller's pass, consumed (burned)
    buyer:          address,
    payment:        Coin<T>,       // value == P (face F + upcharge U)
    clock:          &Clock,
    ctx:            &mut TxContext,
)
```

On-chain asserts (honest even if the backend is bypassed): `sender == guest` on both
escrows AND `pass.guest`; both escrows `STATUS_ACTIVE`; `policy.transferable`;
`policy.resale_count < MAX_RESALE_HOPS (1)`; `now < release_time_ms − 48h`. Then
**compute** `F = payment_total + deposit_amount`, `U = P − F` (assert `P ≥ F`),
assert `U ≤ F · max_premium_bps / 10000`, derive `aria_cut = U·10%`,
`host_cut = U·45%`, seller remainder `= P − aria_cut − host_cut (= F + 45%·U)`.
Reassign `guest = buyer` on both escrows, `resale_count += 1`, `public_transfer` the
three cuts (zero legs skipped), burn + remint the pass to `buyer`, emit
`BookingResold`. Buyer now owns both escrows, so the deposit refunds to the buyer and
the stay releases to the host as normal — no other function changes.

> **Why this is upgrade-safe:** only *new* structs and *new* functions are added;
> `BookingEscrow`, `BookingPaymentEscrow`, `BookingPass`, and every existing
> `create_*`/`release_*` signature are untouched — same additive discipline as v5.
> Trade-off: pre-v6 bookings have no `ResalePolicy`, so they can't be resold — fine,
> resale is opt-in for new bookings.

---

## 3. The five rails (concrete scope)

**Rail 1 — Host opt-in per listing (off by default).**
- DB: `properties.transfer_allowed BOOLEAN DEFAULT false`, `properties.max_resale_premium_bps INTEGER DEFAULT 0`.
- Contract: a new `ResalePolicy` object (additive — see §2.3) carries `transferable` + `max_premium_bps`, minted in the booking PTB. Existing `create_*` signatures are untouched (upgrade-safe).
- Backend: `createBooking` reads the listing settings and adds a `create_resale_policy` moveCall to the booking PTB.
- Frontend: a toggle + premium cap input on the host listing editor; default OFF.

**Rail 2 — Price cap (face-value default).**
- `max_resale_premium_bps = 0` ⇒ pure face-value resale (the Glastonbury/FIFA model).
- Buyer's `payment` must satisfy `P ≤ F * (1 + premium/10000)`; asserted on-chain in `transfer_booking`.

**Rail 3 — Host royalty on any premium (reuses 3-way split).**
- Face `F` = original paid; upcharge `U = P − F`. **Seller gets `F + 0.5·U`; host gets `0.5·U`.**
- Pure `coin::split` + `public_transfer`, same primitive as `release_payment`. Host's incentive flips from "this hurts me" to "I got paid again."
- **Open:** ARIA platform fee on resale — currently none (see §7).

**Rail 4 — Mandatory Seal identity on the buyer.**
- Buyer must complete the existing guest-verification → Seal allowlist flow *before* the swap; the host is added to the buyer's PII allowlist and the seller is removed, in (or adjacent to) the same PTB.
- Reuses `seal_approve` + `guest_verifications`. Backend gates `transfer_booking` build on `hasGuestProfile(buyer)`.

**Rail 5 — Transfer windows + hop limits + reputation gate.**
- **No transfer in the final 48h** — on-chain `now < check_in_ms − 48h` assert.
- **One hop** — track `resale_count` (DB + an on-chain counter on the escrow); reject if ≥ 1. Kills speculative chains.
- **Reputation gate (Theme A)** — book-and-flip-without-staying lowers the seller's portable reputation signal; surface it so hosts can screen. Off-chain scoring from the verifiable-reviews / stay-completion history.

---

## 4. Resale swap — TWO steps (the pass is soulbound)

A single buyer-signed PTB **cannot** work: the seller's pass has no `store`, so the
buyer can't carry it. So the swap is two signed transactions, both backend-built and
backend-verified (same non-custodial pattern as booking):

**Step 1 — `list_for_resale` (SELLER signs).** Consumes (burns) the seller's pass as
proof of consent, asserts all guardrails (transferable, hop, 48h window, ask ∈
[face, face·(1+cap)]), and records `listed = true` + `ask_price` on the `ResalePolicy`.
Pass metadata is already mirrored on the policy, so a reissue never needs the pass.

**Step 2 — `buy_resale` (BUYER signs + funds).** Buyer pays exactly `ask_price`;
on-chain it reassigns both escrows' `guest → buyer`, splits the upcharge **ARIA 10% /
host 45% / seller keeps face + 45%**, bumps `resale_count`, and mints a fresh pass to
the buyer.

Around step 2: **Seal** adds the host to the buyer's PII allowlist and removes the
seller (PII follows the holder); the **backend verifies** the on-chain effects (guest
reassigned, splits paid, new pass id) before updating Postgres — never trusting the
client report (mirrors `verifyEscrowTransaction`). `cancel_resale_listing` unlists and
remints the pass to the seller.

---

## 5. DB changes (`db.mjs`)

- `properties`: `transfer_allowed BOOLEAN DEFAULT false`, `max_resale_premium_bps INTEGER DEFAULT 0`.
- `bookings`: `resale_count INTEGER DEFAULT 0`, `original_wallet_address TEXT` (provenance), `resale_walrus_blob_id TEXT` (immutable resale receipt).
- New `resales` table: `booking_ref`, `seller_address`, `buyer_address`, `face_amount`, `sale_price`, `host_cut`, `seller_cut`, `tx_digest`, `created_at`.

## 6. Backend routes (`server.mjs` / `escrow.mjs`)

- `POST /pass/:bookingRef/list-resale` — seller lists for resale (price ≤ cap); validates window/hop/transfer_allowed.
- `GET /resale/listings` — open resale listings (buyer browse).
- `POST /pass/:bookingRef/transfer/build` — build the buyer-signed swap PTB (gates on buyer Seal identity, cap, window, hop).
- `POST /pass/:bookingRef/transfer/confirm` — verify on-chain effects, write `resales` + bump `resale_count`, swap Seal allowlist, store resale receipt on Walrus.
- New verifier `verifyTransferBookingTransaction` in `escrow.mjs` (guest reassigned on both escrows, splits correct, new pass minted) + unit tests in `escrow.test.mjs`.

## 7. Decisions (LOCKED June 24, 2026)

1. **ARIA fee on resale** — ✅ **10% of the upcharge only.** Face-value resale is ARIA-fee-free. Upcharge `U = P − F` splits **ARIA 10% · host 45% · seller 45%**; seller also keeps full face `F`. Naturally capped by Rail 2.
2. **Tamper-proof transferability** — ✅ **companion `ResalePolicy` shared object** (NOT baked into the escrow). See §2 — Sui upgrade rules forbid adding fields to the existing `BookingEscrow`/`BookingPaymentEscrow` structs or changing `create_*` signatures, so the policy lives in a new object minted in the booking PTB. Listing-setting changes affect only future bookings (correct behavior).
3. **Pass reissue** — ✅ **burn-and-remint** (keeps the pass immutable + the ownership-derived-validity invariant).
4. **Reputation gate** — ✅ **host-visible flag first**, hard block later. Signal = flips-without-stay count from stay-completion history.
5. **Hop limit** — ✅ **one hop** (`MAX_RESALE_HOPS = 1`).

## 8. Suggested build sequence

1. **Contract v6** — `transfer_booking` + reassignable guest + escrow `transferable`/`max_premium_bps`/`resale_count`; Move tests (cap, window, hop, split math, identity precondition). *Gate everything behind a `RESALE_ENABLED` flag + dormant publish, same playbook as 2a.*
2. **DB migrations** (§5) — additive columns + `resales` table.
3. **Backend** — listing settings read-through into booking PTB; the four resale routes + verifier + tests.
4. **Seal swap** — host allowlist follows the holder on transfer.
5. **Frontend** — host transferability toggle + cap; buyer resale browse/buy; reputation flag surfaced to hosts.
6. **Publish v6 → set package ids → flip `RESALE_ENABLED`** (the proven publish→ids→flag ordering), then an in-browser end-to-end resale test before marking live.

---

*Phase 2c plan v1 — June 24, 2026. Foundation (2a soulbound pass) is live; this is
the controlled-unlock layer. Keep in sync with `ARIA_ROADMAP.md` §9 Theme C and
`ARIA_PACKAGE_INVENTORY.md` when v6 ships.*
