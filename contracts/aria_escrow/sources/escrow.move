module aria_escrow::escrow {

    // === Imports ===

    use sui::coin::{Self, Coin};
    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::object::{Self, ID, UID};
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};
    use sui::address;
    use std::string::String;

    // === Status Constants ===
    const STATUS_ACTIVE:   u8 = 0;
    const STATUS_RELEASED: u8 = 1;
    const STATUS_CLAIMED:  u8 = 2;
    const STATUS_DISPUTED: u8 = 3;
    // (value 4 was the retired STATUS_RESOLVED — see status_resolved() below)
    // Payment-escrow terminal state: guest was fully refunded before check-in.
    const STATUS_REFUNDED: u8 = 5;

    // === Error Codes ===
    const ENotGuest:            u64 = 0;
    const ENotHost:             u64 = 1;
    const ENotArbitrator:       u64 = 2;
    const ENotExpired:          u64 = 3;
    const EAlreadyExpired:      u64 = 4;
    const EClaimExceedsDeposit: u64 = 5;
    const EWrongStatus:         u64 = 6;
    const EZeroAmount:          u64 = 7;
    const ESplitMismatch:       u64 = 8;
    const EExpiryInPast:        u64 = 9;
    const EExpiryTooFar:        u64 = 10;
    // Payment-escrow error codes
    const ENotReleaseTime:      u64 = 11; // release_payment called before check-in
    const ERefundTooLate:       u64 = 12; // refund_payment called at/after check-in
    const EReleaseTimeInPast:   u64 = 13; // create_payment_escrow with past release time

    // 5 days in milliseconds
    const FIVE_DAYS_MS: u64 = 432_000_000;

    // 30 days in milliseconds — upper bound on how far out expiry_ms can be set
    const MAX_EXPIRY_MS: u64 = 2_592_000_000;

    // === Core Object ===

    // Suppress lint: Coin<T> is intentional here — we need to split and transfer
    // individual coins directly. Balance<T> would require wrapping/unwrapping.
    #[allow(lint(coin_field))]
    public struct BookingEscrow<phantom T> has key {
        id:           UID,
        booking_ref:  String,
        guest:        address,
        host:         address,
        arbitrator:   address,
        amount:       u64,
        coin:         Coin<T>,
        expiry_ms:    u64,
        status:       u8,
        claim_amount: u64,
    }

    // Holds the guest's actual payment (rental + ARIA fee + tax) for a booking,
    // kept SEPARATE from the security deposit's BookingEscrow so the deposit's
    // claim/dispute state machine is untouched. The three destination addresses
    // and the three split amounts are baked in at creation, so release is fully
    // deterministic and trustlessly verifiable — no caller supplies amounts at
    // release time. Industry-standard "fee follows refund": a full refund before
    // check-in returns rental + fee + tax to the guest; at check-in the funds
    // split to host / ARIA / tax remittance.
    #[allow(lint(coin_field))]
    public struct BookingPaymentEscrow<phantom T> has key {
        id:              UID,
        booking_ref:     String,
        guest:           address,
        host:            address,
        aria_addr:       address, // ARIA fee wallet
        tax_addr:        address, // tax remittance wallet
        arbitrator:      address,
        host_amount:     u64,     // rental subtotal -> host at check-in
        aria_amount:     u64,     // ARIA booking fee -> aria_addr at check-in
        tax_amount:      u64,     // taxes -> tax_addr at check-in
        coin:            Coin<T>, // value == host_amount + aria_amount + tax_amount
        release_time_ms: u64,     // check-in (optionally + grace)
        status:          u8,      // STATUS_ACTIVE | STATUS_RELEASED | STATUS_REFUNDED
    }

    // === Events ===

    public struct EscrowCreated has copy, drop {
        escrow_id:   ID,
        booking_ref: String,
        guest:       address,
        host:        address,
        amount:      u64,
        expiry_ms:   u64,
    }

    public struct DepositReleased has copy, drop {
        escrow_id:    ID,
        booking_ref:  String,
        guest:        address,
        guest_amount: u64,
        host_amount:  u64,
    }

    public struct DamageClaimed has copy, drop {
        escrow_id:    ID,
        booking_ref:  String,
        host:         address,
        claim_amount: u64,
    }

    public struct ClaimDisputed has copy, drop {
        escrow_id:   ID,
        booking_ref: String,
        guest:       address,
    }

    public struct DisputeResolved has copy, drop {
        escrow_id:    ID,
        booking_ref:  String,
        guest_amount: u64,
        host_amount:  u64,
    }

    public struct PaymentEscrowCreated has copy, drop {
        escrow_id:       ID,
        booking_ref:     String,
        guest:           address,
        host:            address,
        host_amount:     u64,
        aria_amount:     u64,
        tax_amount:      u64,
        release_time_ms: u64,
    }

    public struct PaymentReleased has copy, drop {
        escrow_id:   ID,
        booking_ref: String,
        host_amount: u64,
        aria_amount: u64,
        tax_amount:  u64,
    }

    public struct PaymentRefunded has copy, drop {
        escrow_id:   ID,
        booking_ref: String,
        guest:       address,
        amount:      u64,
    }

    // === Public Functions ===

    /// Create a new escrow and share it on-chain.
    /// Called at booking confirmation. Guest locks funds into the escrow.
    /// guest_addr is passed explicitly so the ARIA backend (deployer) can sign
    /// the transaction while correctly recording the guest's Sui address.
    /// expiry_ms = checkout_unix_ms + FIVE_DAYS_MS (computed by ARIA backend).
    /// On testnet use a short window (e.g. now + 60_000) to test without waiting.
    public fun create_escrow<T>(
        booking_ref: String,
        guest_addr:  address,
        host:        address,
        arbitrator:  address,
        expiry_ms:   u64,
        coin:        Coin<T>,
        clock:       &Clock,
        ctx:         &mut TxContext,
    ) {
        let amount = coin::value(&coin);
        assert!(amount > 0, EZeroAmount);
        assert!(expiry_ms > clock::timestamp_ms(clock), EExpiryInPast);
        assert!(expiry_ms <= clock::timestamp_ms(clock) + MAX_EXPIRY_MS, EExpiryTooFar);

        let escrow = BookingEscrow<T> {
            id:           object::new(ctx),
            booking_ref,
            guest:        guest_addr,
            host,
            arbitrator,
            amount,
            coin,
            expiry_ms,
            status:       STATUS_ACTIVE,
            claim_amount: 0,
        };

        let escrow_id = object::id(&escrow);

        event::emit(EscrowCreated {
            escrow_id,
            booking_ref:  escrow.booking_ref,
            guest:        escrow.guest,
            host:         escrow.host,
            amount:       escrow.amount,
            expiry_ms:    escrow.expiry_ms,
        });

        transfer::share_object(escrow);
    }

    /// Release the full deposit back to the guest after the inspection window.
    /// Callable by anyone — ARIA backend calls this automatically after 5 days.
    public fun auto_release<T>(
        escrow: BookingEscrow<T>,
        clock:  &Clock,
        _ctx:   &mut TxContext,
    ) {
        assert!(escrow.status == STATUS_ACTIVE, EWrongStatus);
        assert!(clock::timestamp_ms(clock) >= escrow.expiry_ms, ENotExpired);

        let guest       = escrow.guest;
        let amount      = escrow.amount;
        let booking_ref = escrow.booking_ref;

        let BookingEscrow {
            id, booking_ref: _, guest: _, host: _, arbitrator: _,
            amount: _, coin, expiry_ms: _, status: _, claim_amount: _,
        } = escrow;

        let escrow_id = object::uid_to_inner(&id);
        object::delete(id);

        event::emit(DepositReleased {
            escrow_id,
            booking_ref,
            guest,
            guest_amount: amount,
            host_amount:  0,
        });

        transfer::public_transfer(coin, guest);
    }

    /// Host files a damage claim during the inspection window (before expiry).
    /// claim_amount must be > 0 and <= escrow.amount.
    public fun claim_damage<T>(
        escrow:       &mut BookingEscrow<T>,
        claim_amount: u64,
        clock:        &Clock,
        ctx:          &mut TxContext,
    ) {
        assert!(escrow.status == STATUS_ACTIVE, EWrongStatus);
        assert!(tx_context::sender(ctx) == escrow.host, ENotHost);
        assert!(clock::timestamp_ms(clock) < escrow.expiry_ms, EAlreadyExpired);
        assert!(claim_amount > 0, EZeroAmount);
        assert!(claim_amount <= escrow.amount, EClaimExceedsDeposit);

        escrow.status       = STATUS_CLAIMED;
        escrow.claim_amount = claim_amount;

        event::emit(DamageClaimed {
            escrow_id:    object::id(escrow),
            booking_ref:  escrow.booking_ref,
            host:         escrow.host,
            claim_amount,
        });
    }

    /// Guest accepts the host's damage claim without dispute.
    /// claim_amount goes to host; remainder goes to guest.
    public fun accept_claim<T>(
        escrow: BookingEscrow<T>,
        ctx:    &mut TxContext,
    ) {
        assert!(escrow.status == STATUS_CLAIMED, EWrongStatus);
        assert!(tx_context::sender(ctx) == escrow.guest, ENotGuest);

        let guest        = escrow.guest;
        let host         = escrow.host;
        let amount       = escrow.amount;
        let claim_amount = escrow.claim_amount;
        let booking_ref  = escrow.booking_ref;

        let BookingEscrow {
            id, booking_ref: _, guest: _, host: _, arbitrator: _,
            amount: _, coin, expiry_ms: _, status: _, claim_amount: _,
        } = escrow;

        let escrow_id = object::uid_to_inner(&id);
        object::delete(id);

        let mut coin     = coin;
        let guest_amount = amount - claim_amount;

        if (claim_amount > 0 && guest_amount > 0) {
            let host_coin = coin::split(&mut coin, claim_amount, ctx);
            transfer::public_transfer(host_coin, host);
            transfer::public_transfer(coin, guest);
        } else if (claim_amount == amount) {
            transfer::public_transfer(coin, host);
        } else {
            transfer::public_transfer(coin, guest);
        };

        event::emit(DepositReleased {
            escrow_id,
            booking_ref,
            guest,
            guest_amount,
            host_amount: claim_amount,
        });
    }

    /// Finalize a damage claim the guest never responded to. Callable by ANYONE
    /// (like auto_release) once the inspection window has passed (expiry_ms),
    /// but only while the escrow is still STATUS_CLAIMED — i.e. the host filed a
    /// claim and the guest neither accepted (accept_claim) nor disputed
    /// (dispute_claim) it. Without this, a silent guest could lock the deposit
    /// forever: from STATUS_CLAIMED the only exits were guest-only calls, so an
    /// unresponsive guest left both parties' funds permanently stuck. This pays
    /// claim_amount to the host and the remainder to the guest — exactly the
    /// split accept_claim would have produced — so the deadlock resolves itself
    /// the same way a timely guest acceptance would.
    public fun finalize_claim<T>(
        escrow: BookingEscrow<T>,
        clock:  &Clock,
        ctx:    &mut TxContext,
    ) {
        assert!(escrow.status == STATUS_CLAIMED, EWrongStatus);
        assert!(clock::timestamp_ms(clock) >= escrow.expiry_ms, ENotExpired);

        let guest        = escrow.guest;
        let host         = escrow.host;
        let amount       = escrow.amount;
        let claim_amount = escrow.claim_amount;
        let booking_ref  = escrow.booking_ref;

        let BookingEscrow {
            id, booking_ref: _, guest: _, host: _, arbitrator: _,
            amount: _, coin, expiry_ms: _, status: _, claim_amount: _,
        } = escrow;

        let escrow_id = object::uid_to_inner(&id);
        object::delete(id);

        let mut coin     = coin;
        let guest_amount = amount - claim_amount;

        if (claim_amount > 0 && guest_amount > 0) {
            let host_coin = coin::split(&mut coin, claim_amount, ctx);
            transfer::public_transfer(host_coin, host);
            transfer::public_transfer(coin, guest);
        } else if (claim_amount == amount) {
            transfer::public_transfer(coin, host);
        } else {
            transfer::public_transfer(coin, guest);
        };

        event::emit(DepositReleased {
            escrow_id,
            booking_ref,
            guest,
            guest_amount,
            host_amount: claim_amount,
        });
    }

    /// Guest disputes the host's damage claim.
    /// Moves escrow to STATUS_DISPUTED; arbitrator must then resolve.
    public fun dispute_claim<T>(
        escrow: &mut BookingEscrow<T>,
        ctx:    &mut TxContext,
    ) {
        assert!(escrow.status == STATUS_CLAIMED, EWrongStatus);
        assert!(tx_context::sender(ctx) == escrow.guest, ENotGuest);

        escrow.status = STATUS_DISPUTED;

        event::emit(ClaimDisputed {
            escrow_id:   object::id(escrow),
            booking_ref: escrow.booking_ref,
            guest:       escrow.guest,
        });
    }

    /// ARIA arbitrator resolves a disputed claim.
    /// guest_amount + host_amount MUST equal escrow.amount exactly.
    /// Arbitrator can only split between guest and host — never to any other address.
    public fun resolve_dispute<T>(
        escrow:       BookingEscrow<T>,
        guest_amount: u64,
        host_amount:  u64,
        ctx:          &mut TxContext,
    ) {
        assert!(escrow.status == STATUS_DISPUTED, EWrongStatus);
        assert!(tx_context::sender(ctx) == escrow.arbitrator, ENotArbitrator);
        assert!(guest_amount + host_amount == escrow.amount, ESplitMismatch);

        let guest       = escrow.guest;
        let host        = escrow.host;
        let booking_ref = escrow.booking_ref;

        let BookingEscrow {
            id, booking_ref: _, guest: _, host: _, arbitrator: _,
            amount: _, coin, expiry_ms: _, status: _, claim_amount: _,
        } = escrow;

        let escrow_id = object::uid_to_inner(&id);
        object::delete(id);

        let mut coin = coin;

        if (host_amount > 0 && guest_amount > 0) {
            let host_coin = coin::split(&mut coin, host_amount, ctx);
            transfer::public_transfer(host_coin, host);
            transfer::public_transfer(coin, guest);
        } else if (host_amount == 0) {
            transfer::public_transfer(coin, guest);
        } else {
            transfer::public_transfer(coin, host);
        };

        event::emit(DisputeResolved {
            escrow_id,
            booking_ref,
            guest_amount,
            host_amount,
        });
    }

    /// Arbitrator-gated full refund of the security DEPOSIT to the guest, used by
    /// ARIA's /booking/cancel route so a cancelling guest gets their deposit back
    /// immediately instead of waiting for auto_release at expiry. Bounded blast
    /// radius: it can only ever pay the guest (the deposit's rightful recipient),
    /// never a third address, so it carries no risk beyond what auto_release would
    /// eventually do anyway. Only valid while the escrow is still ACTIVE.
    public fun refund_deposit<T>(
        escrow: BookingEscrow<T>,
        ctx:    &mut TxContext,
    ) {
        assert!(escrow.status == STATUS_ACTIVE, EWrongStatus);
        assert!(tx_context::sender(ctx) == escrow.arbitrator, ENotArbitrator);

        let guest       = escrow.guest;
        let amount      = escrow.amount;
        let booking_ref = escrow.booking_ref;

        let BookingEscrow {
            id, booking_ref: _, guest: _, host: _, arbitrator: _,
            amount: _, coin, expiry_ms: _, status: _, claim_amount: _,
        } = escrow;

        let escrow_id = object::uid_to_inner(&id);
        object::delete(id);

        event::emit(DepositReleased {
            escrow_id,
            booking_ref,
            guest,
            guest_amount: amount,
            host_amount:  0,
        });

        transfer::public_transfer(coin, guest);
    }

    // === Payment Escrow (rental + ARIA fee + tax) ===

    /// Guest funds the payment escrow at booking (their own wallet signs, in the
    /// same atomic PTB that creates the deposit escrow). The coin MUST equal the
    /// sum of the three legs, and release_time_ms (check-in) must be in the future.
    /// The destination addresses and amounts are recorded immutably so that
    /// release_payment is fully deterministic.
    public fun create_payment_escrow<T>(
        booking_ref:     String,
        guest_addr:      address,
        host:            address,
        aria_addr:       address,
        tax_addr:        address,
        arbitrator:      address,
        host_amount:     u64,
        aria_amount:     u64,
        tax_amount:      u64,
        release_time_ms: u64,
        coin:            Coin<T>,
        clock:           &Clock,
        ctx:             &mut TxContext,
    ) {
        let total = coin::value(&coin);
        assert!(total > 0, EZeroAmount);
        assert!(host_amount + aria_amount + tax_amount == total, ESplitMismatch);
        assert!(release_time_ms > clock::timestamp_ms(clock), EReleaseTimeInPast);

        let escrow = BookingPaymentEscrow<T> {
            id:              object::new(ctx),
            booking_ref,
            guest:           guest_addr,
            host,
            aria_addr,
            tax_addr,
            arbitrator,
            host_amount,
            aria_amount,
            tax_amount,
            coin,
            release_time_ms,
            status:          STATUS_ACTIVE,
        };

        let escrow_id = object::id(&escrow);

        event::emit(PaymentEscrowCreated {
            escrow_id,
            booking_ref:     escrow.booking_ref,
            guest:           escrow.guest,
            host:            escrow.host,
            host_amount:     escrow.host_amount,
            aria_amount:     escrow.aria_amount,
            tax_amount:      escrow.tax_amount,
            release_time_ms: escrow.release_time_ms,
        });

        transfer::share_object(escrow);
    }

    /// Release the payment at check-in as a 3-way split to the baked-in
    /// destinations. Permissionless — callable by anyone once release_time_ms is
    /// reached (exactly like auto_release); the worst any caller can do is pay the
    /// three parties exactly what the guest already committed. ARIA's check-in
    /// sweep signs this with the zero-privilege auto-release key. Zero-amount legs
    /// (e.g. a tax-exempt booking) are skipped so no dust coins are created.
    public fun release_payment<T>(
        escrow: BookingPaymentEscrow<T>,
        clock:  &Clock,
        ctx:    &mut TxContext,
    ) {
        assert!(escrow.status == STATUS_ACTIVE, EWrongStatus);
        assert!(clock::timestamp_ms(clock) >= escrow.release_time_ms, ENotReleaseTime);

        let booking_ref = escrow.booking_ref;
        let host        = escrow.host;
        let aria_addr   = escrow.aria_addr;
        let tax_addr    = escrow.tax_addr;
        let host_amount = escrow.host_amount;
        let aria_amount = escrow.aria_amount;
        let tax_amount  = escrow.tax_amount;

        let BookingPaymentEscrow {
            id, booking_ref: _, guest: _, host: _, aria_addr: _, tax_addr: _,
            arbitrator: _, host_amount: _, aria_amount: _, tax_amount: _,
            coin, release_time_ms: _, status: _,
        } = escrow;

        let escrow_id = object::uid_to_inner(&id);
        object::delete(id);

        let mut coin = coin;
        if (host_amount > 0) {
            transfer::public_transfer(coin::split(&mut coin, host_amount, ctx), host);
        };
        if (aria_amount > 0) {
            transfer::public_transfer(coin::split(&mut coin, aria_amount, ctx), aria_addr);
        };
        // Whatever remains is exactly tax_amount (sum invariant enforced at creation).
        if (coin::value(&coin) > 0) {
            transfer::public_transfer(coin, tax_addr);
        } else {
            coin::destroy_zero(coin);
        };

        event::emit(PaymentReleased {
            escrow_id,
            booking_ref,
            host_amount,
            aria_amount,
            tax_amount,
        });
    }

    /// Full refund of the payment to the guest before check-in (binary policy:
    /// fee follows refund, matching Airbnb/Vrbo). Arbitrator-gated so the on-chain
    /// refund happens through ARIA's /booking/cancel route, keeping the DB status
    /// and calendar release atomic with the chain. Bounded blast radius: can only
    /// ever pay the guest. Hard-blocked once check-in is reached, after which only
    /// release_payment (to host/ARIA/tax) is valid — the two are mutually
    /// exclusive in time at release_time_ms.
    public fun refund_payment<T>(
        escrow: BookingPaymentEscrow<T>,
        clock:  &Clock,
        ctx:    &mut TxContext,
    ) {
        assert!(escrow.status == STATUS_ACTIVE, EWrongStatus);
        assert!(tx_context::sender(ctx) == escrow.arbitrator, ENotArbitrator);
        assert!(clock::timestamp_ms(clock) < escrow.release_time_ms, ERefundTooLate);

        let guest       = escrow.guest;
        let booking_ref = escrow.booking_ref;

        let BookingPaymentEscrow {
            id, booking_ref: _, guest: _, host: _, aria_addr: _, tax_addr: _,
            arbitrator: _, host_amount: _, aria_amount: _, tax_amount: _,
            coin, release_time_ms: _, status: _,
        } = escrow;

        let escrow_id = object::uid_to_inner(&id);
        object::delete(id);

        let amount = coin::value(&coin);

        event::emit(PaymentRefunded {
            escrow_id,
            booking_ref,
            guest,
            amount,
        });

        transfer::public_transfer(coin, guest);
    }

    // === Seal access control (Phase 2 — guest PII) ===

    /// Seal key-server gate for decrypting a guest's PII blob. Seal key servers
    /// call this via a DRY RUN (never a real transaction) when a host requests
    /// the decryption keys; if it doesn't abort, the keys are released.
    ///
    /// The Seal identity is `[original_package_id][guest_address_bytes]`; the key
    /// server passes the inner id (the guest's 32-byte address) here as `id`. We
    /// authorize the decrypt only when BOTH hold:
    ///   1. `id` is exactly this escrow's guest address (so a host can't use one
    ///      booking's escrow to unlock a different guest's blob), and
    ///   2. the caller is this escrow's host.
    ///
    /// No revoke is needed: `auto_release`/`accept_claim`/`resolve_dispute`/
    /// `finalize_claim`/`refund_deposit` all `object::delete` the escrow when the
    /// booking finalizes. Seal resolves object refs to current on-chain state on
    /// every dry run, so once the escrow object is gone this can never be
    /// satisfied — decryption access disappears automatically with the booking.
    public entry fun seal_approve<T>(
        id:     vector<u8>,
        escrow: &BookingEscrow<T>,
        ctx:    &TxContext,
    ) {
        assert!(id == address::to_bytes(escrow.guest), ENotGuest);
        assert!(tx_context::sender(ctx) == escrow.host, ENotHost);
    }

    // === BookingPass (Phase 2a — owned, soulbound proof of booking) ===

    // SOULBOUND: `key` only, NO `store`. The guest OWNS it (it sits in their
    // wallet) but cannot transfer it onward — `transfer::public_transfer`
    // requires `store`, which we deliberately omit; only a function in THIS
    // module can move it. So resale stays disabled until the Phase 2c guardrails
    // (host opt-in, price cap, 50/50 upcharge split, buyer identity, transfer
    // windows) ship a gated transfer. The pass is IMMUTABLE and carries no
    // mutable status: its validity is derived from "the guest owns this AND the
    // booking's escrow is still live", so cancellation (which deletes the escrow)
    // auto-invalidates it with no void call. Metadata is minimal (booking_ref +
    // stay window, NO PII / property address) to preserve the Seal privacy posture.
    public struct BookingPass has key {
        id:           UID,
        booking_ref:  String,
        guest:        address,
        host:         address,
        property_id:  u64,
        check_in_ms:  u64,
        check_out_ms: u64,
    }

    public struct BookingPassMinted has copy, drop {
        pass_id:     ID,
        booking_ref: String,
        guest:       address,
        host:        address,
    }

    /// Mint a soulbound BookingPass and transfer it to the guest. Called in the
    /// SAME guest-signed booking PTB that funds the escrows (one extra moveCall,
    /// no extra signature), so the guest owns it the instant they book. Uses
    /// `transfer::transfer` (module-internal) — NOT `public_transfer`, which would
    /// require `store` and make the pass freely transferable.
    public fun mint_booking_pass(
        booking_ref:  String,
        guest:        address,
        host:         address,
        property_id:  u64,
        check_in_ms:  u64,
        check_out_ms: u64,
        ctx:          &mut TxContext,
    ) {
        let pass = BookingPass {
            id: object::new(ctx),
            booking_ref,
            guest,
            host,
            property_id,
            check_in_ms,
            check_out_ms,
        };
        event::emit(BookingPassMinted {
            pass_id:     object::id(&pass),
            booking_ref: pass.booking_ref,
            guest:       pass.guest,
            host:        pass.host,
        });
        transfer::transfer(pass, guest);
    }

    // BookingPass accessors
    public fun pass_booking_ref(p: &BookingPass): String { p.booking_ref }
    public fun pass_guest(p: &BookingPass): address      { p.guest }
    public fun pass_host(p: &BookingPass): address       { p.host }
    public fun pass_property_id(p: &BookingPass): u64     { p.property_id }
    public fun pass_check_in_ms(p: &BookingPass): u64     { p.check_in_ms }
    public fun pass_check_out_ms(p: &BookingPass): u64    { p.check_out_ms }

    // === Read-Only Accessors ===

    public fun status<T>(e: &BookingEscrow<T>): u8        { e.status }
    public fun amount<T>(e: &BookingEscrow<T>): u64       { e.amount }
    public fun guest<T>(e: &BookingEscrow<T>): address    { e.guest }
    public fun host<T>(e: &BookingEscrow<T>): address     { e.host }
    public fun expiry_ms<T>(e: &BookingEscrow<T>): u64    { e.expiry_ms }
    public fun claim_amount<T>(e: &BookingEscrow<T>): u64 { e.claim_amount }
    public fun booking_ref<T>(e: &BookingEscrow<T>): String { e.booking_ref }

    // Payment-escrow accessors
    public fun payment_status<T>(e: &BookingPaymentEscrow<T>): u8          { e.status }
    public fun payment_guest<T>(e: &BookingPaymentEscrow<T>): address      { e.guest }
    public fun payment_host<T>(e: &BookingPaymentEscrow<T>): address       { e.host }
    public fun payment_aria_addr<T>(e: &BookingPaymentEscrow<T>): address  { e.aria_addr }
    public fun payment_tax_addr<T>(e: &BookingPaymentEscrow<T>): address   { e.tax_addr }
    public fun payment_arbitrator<T>(e: &BookingPaymentEscrow<T>): address { e.arbitrator }
    public fun payment_host_amount<T>(e: &BookingPaymentEscrow<T>): u64    { e.host_amount }
    public fun payment_aria_amount<T>(e: &BookingPaymentEscrow<T>): u64    { e.aria_amount }
    public fun payment_tax_amount<T>(e: &BookingPaymentEscrow<T>): u64     { e.tax_amount }
    public fun payment_release_time_ms<T>(e: &BookingPaymentEscrow<T>): u64 { e.release_time_ms }
    public fun payment_booking_ref<T>(e: &BookingPaymentEscrow<T>): String { e.booking_ref }

    public fun five_days_ms():    u64 { FIVE_DAYS_MS    }
    public fun max_expiry_ms():   u64 { MAX_EXPIRY_MS   }
    public fun status_active():   u8  { STATUS_ACTIVE   }
    public fun status_released(): u8  { STATUS_RELEASED }
    public fun status_claimed():  u8  { STATUS_CLAIMED  }
    public fun status_disputed(): u8  { STATUS_DISPUTED }
    public fun status_refunded(): u8  { STATUS_REFUNDED }

    /// Kept only for upgrade compatibility — Sui's "compatible" upgrade policy
    /// (the default, and the most permissive one available) forbids removing a
    /// public function from an already-deployed package, even though the
    /// STATUS_RESOLVED status value it once returned is no longer used anywhere
    /// (resolve_dispute deletes the object instead of setting a status). Value
    /// is now a literal since the backing constant was removed.
    public fun status_resolved(): u8  { 4 }
}
