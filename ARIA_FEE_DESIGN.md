# ARIA — Fee Collection & Payment Routing Design

**Version:** 2.1 (design) | **Created:** June 22, 2026 | **Revised:** June 22, 2026
**Status:** Design — not yet implemented. Spec for build Phase 1h.5
("Fee collection/routing"), the top remaining build item in `ARIA_ROADMAP.md`.
**Scope this phase:** SuiUSD on-chain path only. Stripe Connect (fiat) is a
future phase (§10), not built now — mirrors the P0b precedent of shipping the
SuiUSD path first.

> **v2.1 change (production hardening):** added §12 "Production-readiness & safety
> hardening" — the invariants and threat→mitigation analysis that make the build
> safe for **both host and guest** funds. Promoted **lag-free PTB-argument
> verification** to a first-class requirement for *both* escrows (§6, §11), so the
> documented under-funding-under-fullnode-lag gap can never reach mainnet. Added
> **destination-authority** checks (the backend verifies the on-chain split pays
> ARIA's real wallets and the booking's real host — not attacker-chosen
> addresses), **replay/idempotency** protection, **abandoned-booking cleanup**,
> and a **permissionless release backstop**. Elevated the optional `refund_deposit`
> to **recommended for v1** (guest gets deposit + payment back together on cancel).
> Marked the `calculateHostPayout` double-count **done** (fixed in code, commit
> `5783260`).
>
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

**Verification at booking** (`verifyBookingPaymentTransaction`). After the guest
submits, re-fetch by digest and assert ALL of the following before writing
`payment_status = 'confirmed'`. This is the security-critical step — a guest
signs and submits their own tx, so the backend must *never* trust that it matches
what it built; it must independently prove the on-chain reality.

Primary verification is **lag-free PTB-argument decoding**, not object reads:

1. Transaction **succeeded** and **sender == the session guest's `guestAddr`**
   (not just "a guest" — the wallet bound to this session).
2. The tx contains a `create_payment_escrow` call to **our** `ESCROW_PACKAGE_ID`
   / module, with the expected **type argument** (`PAYMENT_COIN_TYPE`).
3. **Decode the call's input arguments** (lag-free — they live in the tx inputs,
   readable immediately regardless of `getObjects`/fullnode indexing lag) and
   assert each against the booking's server-authoritative values:
   - `host_amount == toUnits(subtotal)`, `aria_amount == toUnits(ariaFee)`,
     `tax_amount == toUnits(taxes)`, and their **sum == the funded coin value**.
   - **Destination authority:** `aria_addr == ARIA_FEE_ADDRESS`,
     `tax_addr == ARIA_TAX_REMITTANCE_ADDRESS`, and `host == ` the property's
     authoritative payout address (from `host_profiles`/`catalog`, **not** any
     value echoed by the client). This blocks a tampered PTB that points the
     rental or fee leg at an attacker-controlled wallet.
   - `booking_ref` matches **this** booking, `guest == guestAddr`,
     `arbitrator == ARIA_ARBITRATOR_ADDRESS`, `release_time_ms ==` the booking's
     check-in basis (§7).
4. The same tx also created the **deposit** `BookingEscrow` holding
   `toUnits(depositAmount)` — verified by decoding the `create_escrow` args the
   same lag-free way (this also closes the existing `escrow.mjs` "amount NOT
   re-verified under lag" gap for the deposit path).
5. **Replay/idempotency:** the digest has not already been recorded for another
   booking; `settlement_digest` is unique. A given on-chain tx can confirm exactly
   one booking.

The object-content read (via `getObjects`) is kept only as a *secondary,
best-effort* cross-check; it is never the sole basis for acceptance, and a lag
there no longer downgrades verification to "type+sender only." If decoding can't
satisfy all checks, return **503/`pending`** and let the guest retry — never
confirm on partial evidence.

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
- **Deposit on cancellation (now recommended for v1).** A cancelling guest should
  get **all** their money back promptly — both the payment escrow and the deposit.
  Add a `refund_deposit` (arbitrator-gated, pre-check-in) to the v4 upgrade so
  `/booking/cancel` returns deposit + payment in one flow. Relying on the deposit's
  `auto_release` at expiry instead would make a cancelling guest wait (potentially
  weeks) for their own deposit back — poor for guest trust. Since v4 is already
  being cut for the payment escrow, the marginal cost of `refund_deposit` is small;
  build it now. (This also subsumes the previously-tracked `cancel_escrow` v4
  pre-mainnet item.)
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
- **Abandoned `pending` bookings block the calendar.** A booking inserts as
  `pending` and the date range is reserved (the overlap check excludes only
  `cancelled`). A guest who never signs would otherwise hold those dates forever.
  Add a **pending-expiry sweep**: bookings still `pending`/`held` with no verified
  settlement after a short TTL (e.g. 30 min) are auto-cancelled and their dates
  freed. Without this, griefers can lock a property's calendar for free.
- **Stuck funds if the cron is down.** If `release_payment` never fires (cron
  outage) after check-in, funds sit in the escrow. Mitigation is built in:
  `release_payment` is **permissionless**, so the **host can call it themselves**
  to self-serve their payout, and a startup/backstop sweep re-attempts any
  `held`-past-check-in booking. Surface a "release my payout" affordance in the
  host UI as the manual backstop.
- **Host payout address is frozen at booking.** `host` is baked into the escrow at
  creation, so if a host changes their `payout_sui_address` afterwards, escrows
  created earlier still pay the old address. This is the correct trust property
  (the guest agreed to pay *that* address) but must be documented; a host rotating
  a compromised key should expect in-flight bookings to pay the prior address.
- **Signing-key gas + liveness.** The auto-release key (release) and arbitrator
  key (refund) must always hold gas. Add **balance monitoring/alerting**; a
  gas-starved signer silently stalls payouts/refunds. (Guest still has the
  permissionless self-release path; refunds do depend on the arbitrator key.)
- **DB↔chain drift / reconciler.** A `release_payment` can succeed on-chain while
  the DB write fails (or vice-versa). Run a **reconciler** that compares each
  booking's `settlement_status` against the on-chain escrow object's `status`
  (ACTIVE/RELEASED/REFUNDED) and repairs drift — so the source of truth is always
  the chain, and a crashed mid-flight tx self-heals.
- **Zero-amount legs.** A no-tax jurisdiction yields `tax_amount == 0`. The
  contract must allow `tax_amount == 0` / `aria_amount == 0` (skip the transfer
  for a zero leg) while still asserting `host_amount > 0` and the exact sum — a
  blanket `> 0` assert on every leg would wrongly reject tax-free bookings.

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

- [ ] `BookingPaymentEscrow` + `create_payment_escrow`/`release_payment`/`refund_payment` **+ `refund_deposit`** in `escrow.move`, with Move tests; shipped in the v4 upgrade (with `seal_approve`). Zero-amount legs handled (§7).
- [ ] `buildBookingPaymentTransaction` (two-escrow PTB) + `verifyBookingPaymentTransaction`; shared `toUnits()`.
- [x] `calculateHostPayout` double-count removed (host gets full `subtotal`). **DONE — commit `5783260` (June 22, 2026); same fix applied to AI `get_revenue_summary`.**
- [ ] **Lag-free verification (§6): decode `create_payment_escrow` + `create_escrow` PTB args** to verify amounts, **destination authority** (ARIA fee/tax wallets + authoritative host address), `booking_ref`, guest sender, arbitrator, type arg, and `release_time_ms`. No acceptance on type+sender alone; object reads are secondary only. Applies to the deposit path too (closes the existing `escrow.mjs` lag gap).
- [ ] **Replay/idempotency:** `settlement_digest` unique; one tx confirms one booking; confirm route idempotent.
- [ ] `runCheckInReleaseSweep` cron releases the 3-way split at check-in; `/booking/cancel` refunds **payment + deposit** before check-in; both race-guarded on `settlement_status`. Host-triggered self-release path exposed (permissionless backstop).
- [ ] **Abandoned-booking sweep:** `pending`/`held` bookings past a short TTL auto-cancel and free the calendar (anti-griefing).
- [ ] **Reconciler:** periodic DB↔chain `settlement_status` vs on-chain `status` repair; chain is source of truth.
- [ ] `payment_escrow_object_id` / `settlement_status` / `settlement_digest` columns added idempotently.
- [ ] **Signing-key gas monitoring/alerting** for auto-release + arbitrator keys.
- [ ] Frontend: one signature; **pre-sign confirmation shows exact amounts, each destination, release schedule, and cancellation policy** before the guest signs; held→released routing visible afterwards.
- [ ] `ARIA_FEE_ADDRESS` + `ARIA_TAX_REMITTANCE_ADDRESS` generated, set in Railway, added to `ARIA_KEY_INVENTORY.md`. No new signing key.
- [ ] Unit + Move tests incl. **adversarial matrix (§12):** tampered destination, under-funded leg, sum mismatch, replayed digest, double-confirm, refund-after-release blocked, release-before-check-in blocked, zero-tax leg, abandoned-booking cleanup, cron-down host self-release, rounding/scaling edges. Full suite green.
- [ ] Cancellation-policy copy: full refund (payment + deposit) before check-in, none after.
- [ ] `ARIA_ROADMAP.md` / `ARIA_HANDOFF.md` updated; Phase 1h.5 bundled with the v4 upgrade.

---

*Open items for the build session: (1) confirm `release_time_ms` basis — check-in
00:00 vs. +24h grace (recommended +24h); (2) confirm the mainnet SuiUSD coin-type
string for `PAYMENT_COIN_TYPE`; (3) confirm the pending-booking TTL (recommended
30 min).*

---

## 12. Production-readiness & safety hardening

The goal of this section: **neither a host nor a guest can lose funds, and neither
can cheat the other**, even under a malicious counterparty, a hostile client, or
infrastructure failure. Everything here is a build requirement, not a nicety.

### 12.1 Invariants (must always hold)

1. **Conservation:** for every booking, the sum of all on-chain transfers equals
   exactly what the guest signed (`subtotal + ariaFee + taxes + depositAmount ==
   chargeAmount`). No tokens are created or destroyed by ARIA; ARIA holds no
   pooled balance.
2. **Two-sided fairness:** before check-in the guest can get 100% back (payment +
   deposit); at/after check-in the host is guaranteed the full `subtotal` and can
   self-claim it permissionlessly. There is no window where the host has delivered
   (check-in passed) and cannot be paid, nor where the guest has paid and can
   neither stay nor be refunded.
3. **No trusted custodian:** ARIA never holds guest or host principal. The only
   ARIA-held funds are its own collected fee and accrued tax (in receive-only
   wallets it cannot be tricked into over-collecting, because amounts are asserted
   on-chain at creation).
4. **Bounded authority:** the arbitrator key can only ever (a) split a *disputed
   deposit* between guest and host, or (b) refund a *pre-check-in* payment/deposit
   to the guest. It can never redirect funds to a third party or touch a
   post-check-in payment. The auto-release/release key carries zero privilege.
5. **Booking↔settlement coupling:** a booking is `confirmed` **iff** a verified
   on-chain settlement exists for it; the chain is the source of truth and the DB
   is reconciled to it.

### 12.2 Threat → mitigation (host & guest safety)

| # | Threat | Who's at risk | Mitigation |
|---|---|---|---|
| T1 | Malicious guest submits a PTB that **redirects the rental/fee leg** to their own wallet, or under-funds a leg, then claims "confirmed" | Host, ARIA | §6 lag-free arg decode + **destination-authority** check; backend confirms only if host/aria/tax addresses and amounts match server-authoritative values |
| T2 | **Fullnode lag** lets an under-funded escrow pass on "type+sender only" | Host | Verification decodes lag-free tx inputs for amounts; never accepts on type+sender alone; else 503/`pending` |
| T3 | Guest **confirms once but the booking is created twice**, or replays another booking's tx digest | ARIA, host | `settlement_digest` uniqueness; digest must encode *this* `booking_ref`; idempotent confirm |
| T4 | Guest **books to grief**, never signs, locking the calendar | Host | Pending-expiry sweep auto-cancels + frees dates after TTL |
| T5 | Guest cancels but **deposit is stuck** until expiry | Guest | `refund_deposit` in v1 returns payment + deposit together on cancel |
| T6 | **Cron outage** after check-in — host unpaid | Host | `release_payment` is permissionless: host self-releases from the UI; backstop sweep retries |
| T7 | ARIA **withholds a legitimate refund** (arbitrator won't sign) | Guest | Documented v1 trust assumption; trustless guest-callable `refund_payment` is the planned follow-up (§7). Until then, refunds are SLA'd + monitored |
| T8 | **Release/refund race** double-acts on one escrow | Both | On-chain `status == ACTIVE` aborts the second call; DB `settlement_status` guard prevents even attempting it |
| T9 | **Signing key gas-starved** → payouts/refunds stall silently | Both | Balance monitoring + alerting; host self-release path independent of ARIA gas |
| T10 | **DB says released, chain didn't** (or vice-versa) | Both | Reconciler repairs drift against on-chain `status`; chain wins |
| T11 | Guest signs **without understanding** what leaves their wallet | Guest | Pre-sign confirmation itemizes every amount + destination + the cancellation policy before signing |
| T12 | Host **rotates payout key**, expects in-flight bookings to follow | Host | Documented: `host` is frozen at booking; rotate forward-only, expect prior escrows to pay the old address |
| T13 | **Tax-free jurisdiction** (`tax_amount == 0`) wrongly rejected | Guest/host | Contract permits zero legs (skip transfer) while asserting exact sum |
| T14 | **Wrong coin type** (e.g. a worthless token) passed as `Coin<T>` | Host, ARIA | Verify the tx **type argument** == `PAYMENT_COIN_TYPE`; reject otherwise |

### 12.3 Operational backstops

- **Reconciler** (periodic): DB `settlement_status` ⇔ on-chain `status`; self-heal.
- **Pending-expiry sweep:** free calendars held by unpaid bookings.
- **Backstop release sweep** + **host self-release UI** for cron outages.
- **Key gas alarms** for the auto-release and arbitrator keys.
- **Refund SLA + alerting** while refunds remain arbitrator-gated.
- **Event indexing:** index `PaymentEscrowCreated/Released/Refunded` for audit and
  reconciliation; never rely on client-reported state.

### 12.4 Test matrix (gate for "done")

- **Move (`#[expected_failure]` where noted):** create asserts sum==coin; release
  before `release_time` *fails*; refund after release *fails*; refund by
  non-arbitrator *fails*; double-release/refund *fails* (object consumed);
  zero-tax leg succeeds; full 3-way split lands exact amounts.
- **Backend unit:** decode-and-verify accepts the canonical tx; rejects tampered
  destination (T1), under-funded leg (T2), wrong coin type (T14), replayed digest
  (T3), double-confirm (T3); release/refund race guard (T8).
- **Integration (end-to-end):** book → pay → verify → check-in release (host paid,
  ARIA fee + tax routed); book → cancel → payment+deposit refunded; abandoned
  booking → swept + dates freed; cron-down → host self-release; reconciler repairs
  an injected DB↔chain drift.
- **Frontend:** pre-sign confirmation renders exact amounts/destinations/policy;
  abandoned signing leaves no `confirmed` booking.

---

## 13. Verification spike — lag-free decode PROVEN (June 22, 2026)

A feasibility spike against `@mysten/sui` confirmed the §6 lag-free verification
approach works, and **resolved the open wrinkle** about the deposit escrow.

**What was proven:**

1. **Pure inputs round-trip cleanly.** `tx.pure` u64 / address / string values
   decode back exactly via `bcs.u64() / bcs.Address / bcs.string()` from the
   transaction's own inputs — no `getObjects`, no fullnode object read, so they
   are immune to indexing lag.
2. **The deposit amount IS recoverable lag-free** — this is the wrinkle resolved.
   Even though `create_escrow` takes a `Coin<T>` (no explicit amount argument),
   the coin is produced by a `SplitCoins` command whose **amount is itself a Pure
   u64 input**. The spike read it back as `input[0] = 95`. So the deposit's funded
   amount can be verified from the PTB without reading the created object.
3. **The new `create_payment_escrow` explicit amounts decode directly** — the
   `host_amount / aria_amount / tax_amount` u64 args appeared as Pure inputs and
   decoded to `[80, 3, 12]`; addresses (32 bytes) and the `booking_ref` string
   (length-prefixed) decode too.

**The one rule the implementation must follow:** map a MoveCall's arguments to
inputs **by index** (`arg.Input` → `data.inputs[i]`), and find the deposit amount
by following the `SplitCoins` result that feeds the escrow's coin argument. Do
**not** identify values by byte length (two different u64s are both 8 bytes; an
address and some hashes are both 32) — that is fragile. Always verify against the
**fetched, resolved** transaction (what's on-chain), parsed via
`Transaction.from(txBytes)`, since a fetched tx is always in resolved form.

**Reference decoder (validated shape):**

```js
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';
import { fromBase64 } from '@mysten/sui/utils';

const asU64  = (inp) => bcs.u64().parse(fromBase64(inp.Pure.bytes));      // -> string
const asAddr = (inp) => bcs.Address.parse(fromBase64(inp.Pure.bytes));    // -> 0x..
const asStr  = (inp) => bcs.string().parse(fromBase64(inp.Pure.bytes));   // -> string

// Pull a named MoveCall and a positional arg→input resolver out of a fetched tx.
function decodeCall(txBytes, fn, moduleName = 'escrow') {
  const data = Transaction.from(txBytes).getData();          // { inputs[], commands[] }
  const idx  = data.commands.findIndex(
    (c) => c.MoveCall && c.MoveCall.module === moduleName && c.MoveCall.function === fn,
  );
  if (idx < 0) return null;
  const call = data.commands[idx].MoveCall;
  const inputOf = (argPos) => {                              // resolve an arg to its input
    const a = call.arguments[argPos];
    return a.Input != null ? data.inputs[a.Input] : a;       // Pure/Object input, or Result
  };
  return { call, inputOf, data };
}

// Deposit amount = the SplitCoins amount whose Result feeds create_escrow's coin arg.
function depositAmountFromSplit({ call, data }) {
  const coinArg = call.arguments.find((a) => a.Result != null || a.NestedResult != null);
  const splitIdx = coinArg.Result ?? coinArg.NestedResult[0];
  const split = data.commands[splitIdx];                     // { SplitCoins: { coin, amounts:[Input] } }
  return asU64(data.inputs[split.SplitCoins.amounts[0].Input]);
}
```

`verifyBookingPaymentTransaction` then asserts, all from the decoded values:
`host_amount/aria_amount/tax_amount == toUnits(subtotal/ariaFee/taxes)`, their
sum == the split coin amount, `aria_addr == ARIA_FEE_ADDRESS`,
`tax_addr == ARIA_TAX_REMITTANCE_ADDRESS`, `host ==` authoritative payout addr,
`booking_ref ==` this booking, `guest ==` session guest, plus the type argument
== `PAYMENT_COIN_TYPE`. The same `decodeCall` + `depositAmountFromSplit` hardens
the existing deposit `verifyEscrowTransaction` independently (no v4 needed) — this
is the recommended **first** build step, since it closes the current
under-funding-under-lag gap and proves the exact pattern the payment escrow reuses.

> **Live check — PASSED (June 22, 2026).** Ran `check-escrow-decode.mjs` against a
> real testnet `create_escrow` digest (`35D3UZ8GB7duuHR79UjXAcP9E3vnRjT1gi8aMwYX5tg1`).
> The implemented path reads the **parsed** `txn.transaction.inputs/commands`
> directly from `suiClient.core.getTransaction({ include: { transaction: true }})`
> — no `rawTransaction`/`Transaction.from()` needed. The live envelope carries an
> extra `$kind` discriminator (`{ $kind:'Pure', Pure:{ bytes } }`, commands keyed
> `$kind`) alongside the `Pure`/`MoveCall`/`SplitCoins` keys the decoder reads, so
> `decodeCreateEscrowArgs` works unchanged. It decoded `booking_ref`, guest, host,
> `typeArg`, and recovered the deposit amount (`66000`) lag-free from the
> `SplitCoins` input, matching `depositToMist(66)`. **Caveat retired for the SUI
> path.**
>
> One minor residual, to confirm when SuiUSD is wired: `coinWithBalance` for a
> **non-SUI** owned coin may resolve to `MergeCoins` + `SplitCoins` rather than a
> bare gas split; the `SplitCoins` amount is still a Pure input (low risk), but
> re-run `check-escrow-decode.mjs` against the first real SuiUSD escrow to confirm.
