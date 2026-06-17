module aria_escrow::escrow {

    // === Imports ===

    use sui::coin::{Self, Coin};
    use sui::clock::{Self, Clock};
    use sui::event;
    use sui::object::{Self, ID, UID};
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};
    use std::string::String;

    // === Status Constants ===
    const STATUS_ACTIVE:   u8 = 0;
    const STATUS_RELEASED: u8 = 1;
    const STATUS_CLAIMED:  u8 = 2;
    const STATUS_DISPUTED: u8 = 3;

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

    // === Read-Only Accessors ===

    public fun status<T>(e: &BookingEscrow<T>): u8        { e.status }
    public fun amount<T>(e: &BookingEscrow<T>): u64       { e.amount }
    public fun guest<T>(e: &BookingEscrow<T>): address    { e.guest }
    public fun host<T>(e: &BookingEscrow<T>): address     { e.host }
    public fun expiry_ms<T>(e: &BookingEscrow<T>): u64    { e.expiry_ms }
    public fun claim_amount<T>(e: &BookingEscrow<T>): u64 { e.claim_amount }
    public fun booking_ref<T>(e: &BookingEscrow<T>): String { e.booking_ref }

    public fun five_days_ms():    u64 { FIVE_DAYS_MS    }
    public fun max_expiry_ms():   u64 { MAX_EXPIRY_MS   }
    public fun status_active():   u8  { STATUS_ACTIVE   }
    public fun status_released(): u8  { STATUS_RELEASED }
    public fun status_claimed():  u8  { STATUS_CLAIMED  }
    public fun status_disputed(): u8  { STATUS_DISPUTED }
}
