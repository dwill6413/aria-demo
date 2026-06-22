# ARIA — Fee Collection & Payment Routing Design

**Version:** 2.0 (design) | **Created:** June 22, 2026 | **Revised:** June 22, 2026
**Status:** Design — not yet implemented. Spec for build Phase 1h.5
("Fee collection/routing"), the top remaining build item in `ARIA_ROADMAP.md`.
**Scope this phase:** SuiUSD on-chain path only. Stripe Connect (fiat) is a
future phase (§10), not built now — mirrors the P0b precedent of shipping the
SuiUSD path first.

> **v2.0 change:** the original v1.0 draft settled the rental **instantly** at
> booking, which made the rental portion non-refundable on-chain. v2.0 replaces
> that with a **hold-and-release** model: rental, fee, and tax are escrowed at
> booking and released to their destinations at **check-in**, refundable to the
> guest before then. This requires a small contract addition, bundled into the
> already-planned **package v4** upgrade (Phase 2a's `seal_approve`).

---

## 1. Problem statement

Today ARIA moves exactly one thing on-chain: the **20% refundable security
deposit**, via the P0b guest-funded escrow. Everything else in a booking's money
flow is computed and displayed but **never actually collected or routed**:

- The **rental payment** (`subtotal`) is never transferred to the host.
  `calculateHostPayout()` in `deepbook.mjs` returns a number that only appears on
  the receipt and on the unused `GET /deepbook/payout/:amount` endpoint. The
  `settlementMethod: 'DeepBook'` label describes a settlement that does not happen.
- **ARIA's 3% fee** (`ariaFee`) is never collected.
- **Occupancy taxes** (`taxes`) are never routed to a remittance account, despite
  a `tax_remittances` table existing.

There is also a **fee double-count bug**: the guest is charged 3% as an add-on
(`bookingTotal = subtotal + ariaFee + taxes`) **and** `calculateHostPayout`
separately deducts 3% from the host. This design resolves it to a single
guest-side fee (§3).

**Goal:** collect rental, fee, and tax at booking, hold them non-custodially, and
release them to the correct destinations at check-in — with a guest-refund path
for cancellations — reusing the existing escrow patterns.

---

## 2. Design decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| **Settlement timing** | **Hold, release to host at check-in** | Rental/fee/tax escrowed at booking; released at check-in. Matches Airbnb/Vrbo risk model and enables cancellation refunds. |
| **What is held** | **Rental + fee + tax** (3-way split at release) | Nothing is charged for a stay that didn't happen — tax especially must not be collected on a cancelled booking. |
| **Cancellation policy** | **Binary — full refund before check-in, none after** | Clean v1. Guest cancels before the check-in release → 100% back; after release the rental is the host's. |
| **Rails this phase** | **SuiUSD on-chain only** | Defer Stripe Connect. Same staged approach as P0b. |
| **Custody** | **Non-custodial** | Funds sit in per-booking shared escrow objects, not an ARIA wallet. No global balance to drain — consistent with the contract philosophy. |
| **Fee incidence** | **Guest-side add-on only** | Guest pays `subtotal + 3%`; host receives the **full** `subtotal`. The host-side deduction is removed. |
| **Contract change** | **Yes — package v4**, bundled with Phase 2a's `seal_approve` | Adds a payment-escrow type with release/refund functions. One upgrade, audited together pre-mainnet. |

---

## 3. Money model (corrected)

For a booking of `nights` nights at `pricePerNight`:

```
subtotal       = pricePerNight * nights          // host's rental revenue
ariaFee        = round(subtotal * 0.03)          // ARIA's cut — guest-side add-on
taxes          = round(subtotal * jurisdictionRate)
bookingTotal   = subtotal + ariaFee + taxes
depositAmount  = round(bookingTotal * 0.20)      // refundable security deposit
chargeAmount   = bookingTotal + depositAmount     // total the guest signs for
```

Two escrow objects are created at booking; **nothing transfers to a destination
until release**:

| Object | Holds | Release condition | On release |
|---|---|---|---|
| **Payment escrow** (new, v4) | `subtotal + ariaFee + taxes` | check-in reached | 3-way split: `subtotal`→host, `ariaFee`→ARIA fee wallet, `taxes`→remittance wallet |
| **Deposit escrow** (existing, P0b) | `depositAmount` | checkout + 5-day inspection | full amount → guest (or claim/dispute split) |

`calculateHostPayout` is corrected so the host receives the full `subtotal`.

> **Invariant (assert at create + verify):**
> `host_amount + aria_amount + tax_amount == payment escrow coin value`, and
> `paymentEscrow + depositAmount == chargeAmount`. Splits must sum exactly to
> what the guest signed.

---

## 4. Contract additions (package v4, with Phase 2a)

A dedicated `BookingPaymentEscrow<T>` type, kept **separate** from the deposit's
`BookingEscrow<T>` so the deposit's claim/dispute state machine is untouched. The
destination addresses and split amounts are **baked into the object at creation**,
so release is fully deterministic and trustlessly verifiable — no caller supplies
amounts at release time.

```move
public struct BookingPaymentEscrow<phantom T> has key {
    id:              UID,
    booking_ref:     String,
    guest:           address,
    host:            address,
    aria_addr:       address,   // ARIA fee wallet
    tax_addr:        address,   // remittance wallet
    arbitrator:      address,
    host_amount:     u64,       // subtotal
    aria_amount:     u64,       // ariaFee
    tax_amount:      u64,       // taxes
    coin:            Coin<T>,   // value == host_amount + aria_amount + tax_amount
    release_time_ms: u64,       // check-in (optionally +24h grace)
    status:          u8,        // ACTIVE | RELEASED | REFUNDED
}

/// Guest funds this at booking (their wallet signs). Asserts the coin equals the
/// sum of the three legs and that release_time is in the future.
public fun create_payment_escrow<T>(
    booking_ref, guest, host, aria_addr, tax_addr, arbitrator,
    host_amount, aria_amount, tax_amount, release_time_ms,
    coin, clock, ctx,
) { /* assert coin value == sum; share_object */ }

/// Permissionless — callable by anyone once check-in is reached (no sender
/// check, exactly like auto_release). Splits the coin to the three baked-in
/// destinations. The backend cron signs this with the zero-privilege
/// auto-release key.
public fun release_payment<T>(escrow, clock, ctx) {
    assert!(status == ACTIVE && now >= release_time_ms);
    // split host_amount -> host, aria_amount -> aria_addr, tax_amount -> tax_addr
}

/// Arbitrator-gated, before check-in only. Full refund of the whole coin to the
/// guest (binary policy). Bounded blast radius: can only ever pay the guest.
public fun refund_payment<T>(escrow, ctx) {
    assert!(status == ACTIVE && sender == arbitrator); // and now < release_time_ms
    // transfer whole coin -> guest
}
```

Notes:
- `release_payment` is **permissionless** by design — like `auto_release`, it
  carries zero special privilege; the worst anyone can do by calling it is pay
  the three parties exactly what the guest already committed.
- `refund_payment` is **arbitrator-gated** so the on-chain refund happens through
  ARIA's `/booking/cancel` route, keeping the DB status + calendar release atomic
  with the chain. Its blast radius is bounded to "pay the guest" — it can never
  divert funds elsewhere. (A future trustless enhancement could also let the
  **guest** call `refund_payment` directly before check-in; deferred so v1 keeps
  DB/calendar in sync. See §7.)
- The **deposit escrow is unchanged** (v3 `create_escrow`). On cancellation the
  deposit returns to the guest anyway via its normal `auto_release` at expiry;
  see §7 for the optional early-refund symmetry.

---

## 5. On-chain mechanism — one atomic PTB at booking

The guest signs **once**. The PTB splits their funding coin and creates both
escrow objects atomically — either everything lands or nothing does.

```js
const COIN_TYPE = process.env.PAYMENT_COIN_TYPE || '0x2::sui::SUI'; // SuiUSD type on mainnet
// Shared scaling helper — same one the deposit uses, so legs never drift.
//   testnet: toUnits(d) = d * 1000n     mainnet: toUnits(d) = d * 1_000_000n (SuiUSD 6dp)

const tx = new Transaction();
tx.setSender(guestAddr);
const funding = coinWithBalance({ balance: toUnits(chargeAmount) });

const [paymentCoin, depositCoin] = tx.splitCoins(funding, [
  toUnits(subtotal + ariaFee + taxes),
  toUnits(depositAmount),
]);

// Payment escrow (new v4) — holds rental+fee+tax, split released at check-in.
tx.moveCall({
  target: `${PKG}::escrow::create_payment_escrow`,
  typeArguments: [COIN_TYPE],
  arguments: [
    tx.pure.string(bookingRef),
    tx.pure.address(guestAddr), tx.pure.address(hostAddr),
    tx.pure.address(process.env.ARIA_FEE_ADDRESS),
    tx.pure.address(process.env.ARIA_TAX_REMITTANCE_ADDRESS),
    tx.pure.address(arbitrator),
    tx.pure.u64(toUnits(subtotal)),
    tx.pure.u64(toUnits(ariaFee)),
    tx.pure.u64(toUnits(taxes)),
    tx.pure.u64(checkInMs),       // optionally checkInMs + 24h grace
    paymentCoin,
    tx.object('0x6'),
  ],
});

// Deposit escrow (existing v3) — unchanged.
tx.moveCall({
  target: `${PKG}::escrow::create_escrow`,
  typeArguments: [COIN_TYPE],
  arguments: [ /* bookingRef, guest, host, arbitrator, expiryMs, depositCoin, clock */ ],
});

const txBytes = await tx.build({ client: suiClient });
return { txBytes: toBase64(txBytes) };
```

Properties: one signature; atomic; non-custodial (funds sit in shared objects,
not an ARIA wallet); guest pays gas (sender = guest), so no ARIA key needs gas
for the booking path.

---

## 6. Backend changes

**Verification at booking** (`verifyBookingPaymentTransaction`, extends the P0b
pattern). After the guest submits, re-fetch by digest and assert before writing
`payment_status = 'confirmed'`:
1. Transaction succeeded; sender == `guestAddr`.
2. A `BookingPaymentEscrow` was created with `host_amount/aria_amount/tax_amount`
   == `toUnits(subtotal/ariaFee/taxes)` and the correct `host/aria_addr/tax_addr`.
3. A `BookingEscrow` (deposit) was created holding `toUnits(depositAmount)`
   (existing check).
4. `release_time_ms` matches the booking's check-in.

**Check-in release cron** (`runCheckInReleaseSweep`, mirrors `runAutoReleaseSweep`).
Hourly + 30s startup sweep: find bookings where `check_in <= NOW()`,
`settlement_status = 'held'`, not cancelled → sign `release_payment` with the
**zero-privilege auto-release key** (it's permissionless on-chain) → on success
set `settlement_status = 'released'` and record the digest.

**Cancellation route** (`/booking/cancel`). Validate the requester owns the
booking and check-in has not passed → build `refund_payment` signed by the
**arbitrator key** → submit → verify → set `payment_status='cancelled'`,
`settlement_status='refunded'`, free the calendar (release the date range). Guard
against racing the release cron with a status check, the same way
`/booking/release-deposit` guards against `['claimed','disputed','forfeited']`.

---

## 7. Risks & edge cases

- **Refund/release race.** The cancellation route and the check-in cron must not
  both act on the same escrow. Gate both on `settlement_status` (`held` →
  `released` xor `refunded`) inside the same guard pattern already used for
  deposit release. On-chain, `status == ACTIVE` makes the second call abort
  anyway, but the DB guard avoids even attempting it.
- **Deposit on cancellation.** v1: the deposit rides its normal lifecycle and
  `auto_release`s back to the guest at expiry — the guest is made whole, just not
  instantly for the deposit leg. Optional symmetry: add a `refund_deposit`
  (arbitrator, pre-check-in) so a cancellation returns deposit + payment in one
  flow. Recommended as a fast-follow, not required for v1.
- **Guest trust on refunds.** v1 routes refunds through the arbitrator so DB and
  calendar stay consistent. This means a guest's refund depends on ARIA signing.
  To make it trustless, a later version can also permit the **guest** to call
  `refund_payment` before check-in (and have the backend reconcile DB/calendar
  from the on-chain event). Flagged, deferred.
- **Tax remittance ≠ tax payment.** Routing `taxes` to a SuiUSD remittance wallet
  does not pay any tax authority (they don't take SuiUSD). It accrues for later
  off-chain remittance; `tax_remittances` tracks what's owed. Real-world
  compliance limitation, documented not solved.
- **Unit scaling / rounding.** All legs use the **same** `toUnits()` (×1000
  testnet, ×1e6 SuiUSD). The three payment legs must sum exactly to the payment
  coin; absorb any 1-unit rounding gap into the rental leg so the split is always
  exact. Asserted on-chain (`create_payment_escrow`) and in tests.
- **Booking-state ordering.** `createBooking` must insert the row as **`pending`
  / `settlement_status='held'`** and only flip to `confirmed` after verification —
  otherwise an abandoned signing leaves a phantom confirmed booking. The existing
  advisory-lock + atomic insert (Findings #3/#6) stays.
- **Check-in timestamp basis.** Decide `release_time_ms` = check-in 00:00 in the
  property's timezone, or check-in + 24h grace (closer to Airbnb). Recommend
  +24h; make it explicit so the cron and the on-chain assert agree.

---

## 8. Touchpoints

| File | Change |
|---|---|
| `contracts/aria_escrow/sources/escrow.move` | Add `BookingPaymentEscrow<T>` + `create_payment_escrow` / `release_payment` / `refund_payment` + events + Move tests. Ship in the **v4** upgrade alongside `seal_approve`. |
| `escrow.mjs` | `buildBookingPaymentTransaction` (two-escrow PTB), `verifyBookingPaymentTransaction`, `buildReleasePaymentTx`, `buildRefundPaymentTx`, shared `toUnits()`. |
| `deepbook.mjs` | Fix `calculateHostPayout` (host gets full `subtotal`); retire the DeepBook "swap" framing — settlement is now an escrow release. |
| `bookings.mjs` | `createBooking` issues the two-escrow PTB; booking starts `pending`/`held`. |
| `server.mjs` | Verify-on-confirm; `runCheckInReleaseSweep` cron; `/booking/cancel` route; race guards. |
| `pages/index.jsx`, `pages/ai.jsx` | Same single-signature UX; breakdown shows held→released routing and the cancellation policy. |
| `db.mjs` | Add `payment_escrow_object_id TEXT`, `settlement_status TEXT` (`held`\|`released`\|`refunded`\|`failed`), `settlement_digest TEXT` to `bookings`, idempotent. |
| `validation.mjs` | Schemas for `/booking/cancel` and the confirm route digest. |
| **Env / Railway** | Add `ARIA_FEE_ADDRESS`, `ARIA_TAX_REMITTANCE_ADDRESS` (addresses only); optional `PAYMENT_COIN_TYPE`. |
| `ARIA_KEY_INVENTORY.md` | Add the two receive-only treasury addresses (§9). |
| `ARIA_ROADMAP.md` / `ARIA_HANDOFF.md` | Phase 1h.5 now depends on the v4 upgrade; note the bundling with Phase 2a. |

---

## 9. New keys (receive-only)

Two new wallets, both **receive-only** — generated offline, private keys in
KeePass only, **never loaded by the backend** (they only ever receive):

| Wallet | Env var | Backend loads key? | Purpose |
|---|---|---|---|
| ARIA fee wallet | `ARIA_FEE_ADDRESS` | No — address only | Receives the 3% platform fee at each check-in release. |
| Tax remittance wallet | `ARIA_TAX_REMITTANCE_ADDRESS` | No — address only | Accrues occupancy tax for later off-chain remittance. |

A backend compromise cannot move their balances. Add both to
`ARIA_KEY_INVENTORY.md` under a new "Receive-only treasury addresses" section.
No new **signing** key is introduced: `release_payment` uses the existing
zero-privilege auto-release key (#2), `refund_payment` uses the existing
operational arbitrator key (#4).

---

## 10. Future phase — Stripe Connect (fiat), not built now

Fiat equivalent: **Stripe Connect** with each host as a connected account;
`application_fee_amount = ariaFee`, `transfer_data.destination = host account`.
The hold-and-release model maps to a **manual-capture PaymentIntent** (authorize
at booking, capture at check-in) or a separated charge held on the platform
balance until check-in, refunded on cancellation. Requires host KYC/onboarding.
Larger surface; deferred.

---

## 11. Definition of done (Phase 1h.5)

- [ ] `BookingPaymentEscrow` + `create_payment_escrow`/`release_payment`/`refund_payment` in `escrow.move`, with Move tests; shipped in the v4 upgrade (with `seal_approve`).
- [ ] `buildBookingPaymentTransaction` (two-escrow PTB) + `verifyBookingPaymentTransaction`; shared `toUnits()`.
- [ ] `calculateHostPayout` double-count removed (host gets full `subtotal`).
- [ ] `runCheckInReleaseSweep` cron releases the 3-way split at check-in; `/booking/cancel` refunds before check-in; both race-guarded on `settlement_status`.
- [ ] `payment_escrow_object_id` / `settlement_status` / `settlement_digest` columns added idempotently.
- [ ] Frontend: one signature; breakdown shows held→released routing + cancellation policy.
- [ ] `ARIA_FEE_ADDRESS` + `ARIA_TAX_REMITTANCE_ADDRESS` generated, set in Railway, added to `ARIA_KEY_INVENTORY.md`. No new signing key.
- [ ] Unit + Move tests: full split at release, refund before check-in, refund-after-release blocked, release-before-check-in blocked, rounding/scaling edges. Full suite green.
- [ ] Cancellation-policy copy: full refund before check-in, none after.
- [ ] `ARIA_ROADMAP.md` / `ARIA_HANDOFF.md` updated; Phase 1h.5 bundled with the v4 upgrade.

---

*Open items for the build session: (1) confirm `release_time_ms` basis — check-in
00:00 vs. +24h grace (recommended +24h); (2) confirm the mainnet SuiUSD coin-type
string for `PAYMENT_COIN_TYPE`; (3) decide whether to add the optional
`refund_deposit` symmetry in v1 or as a fast-follow.*
