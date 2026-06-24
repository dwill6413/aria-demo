// ─── ARIA Escrow — Unit Tests ─────────────────────────────────────────────────
//
// Run:  cd contracts/aria_escrow && sui move test
//
// Tests use short timestamps (milliseconds from epoch) so you don't have to
// wait real time. The Clock object is manipulated with set_for_testing.
//
// Coin type: sui::sui::SUI (testnet SUI from faucet).
// On mainnet, the coin type changes but the test logic is identical.
// ─────────────────────────────────────────────────────────────────────────────

#[test_only]
module aria_escrow::escrow_tests {

    use aria_escrow::escrow::{Self, BookingEscrow};
    use sui::clock;
    use sui::coin;
    use sui::sui::SUI;
    use sui::test_scenario as ts;
    use std::string::{Self, String};

    // ── Test Addresses ─────────────────────────────────────────────────────────
    const GUEST:      address = @0x100;
    const HOST:       address = @0x200;
    const ARBITRATOR: address = @0x300;
    const STRANGER:   address = @0x999; // not a party to any escrow

    // ── Test Values ────────────────────────────────────────────────────────────
    const DEPOSIT:   u64 = 1_000_000_000; // 1 SUI (1e9 MIST)
    const CLAIM:     u64 =   200_000_000; // 0.2 SUI — partial damage claim
    const T_BEFORE:  u64 =         5_000; // 5s — inside inspection window
    const T_EXPIRY:  u64 =        10_000; // 10s — the expiry timestamp
    const T_AFTER:   u64 =        15_000; // 15s — past expiry

    fun ref_str(): String { string::utf8(b"ARIA-1-1234567890") }

    // ── Helpers ────────────────────────────────────────────────────────────────

    /// Create an escrow and share it. Returns the test scenario advanced to the
    /// next transaction so callers can immediately take the shared object.
    fun setup_escrow(scenario: &mut ts::Scenario) {
        ts::next_tx(scenario, GUEST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(scenario));
            clock::set_for_testing(&mut clock, T_BEFORE);
            let coin = coin::mint_for_testing<SUI>(DEPOSIT, ts::ctx(scenario));
            escrow::create_escrow<SUI>(
                ref_str(), GUEST, HOST, ARBITRATOR, T_EXPIRY,
                coin, &clock, ts::ctx(scenario)
            );
            clock::destroy_for_testing(clock);
        };
    }

    /// Host files a damage claim of CLAIM amount.
    fun setup_claim(scenario: &mut ts::Scenario) {
        setup_escrow(scenario);
        ts::next_tx(scenario, HOST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(scenario));
            clock::set_for_testing(&mut clock, T_BEFORE);
            let mut e = ts::take_shared<BookingEscrow<SUI>>(scenario);
            escrow::claim_damage<SUI>(&mut e, CLAIM, &clock, ts::ctx(scenario));
            ts::return_shared(e);
            clock::destroy_for_testing(clock);
        };
    }

    /// Guest disputes the existing claim.
    fun setup_dispute(scenario: &mut ts::Scenario) {
        setup_claim(scenario);
        ts::next_tx(scenario, GUEST);
        {
            let mut e = ts::take_shared<BookingEscrow<SUI>>(scenario);
            escrow::dispute_claim<SUI>(&mut e, ts::ctx(scenario));
            ts::return_shared(e);
        };
    }

    // ── Happy-Path Tests ───────────────────────────────────────────────────────

    /// Full clean stay: no damage, deposit returns to guest after 5 days.
    #[test]
    fun test_auto_release_happy_path() {
        let mut s = ts::begin(GUEST);
        setup_escrow(&mut s);

        ts::next_tx(&mut s, GUEST); // anyone can call auto_release
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_AFTER); // past expiry
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            // status must be ACTIVE before release
            assert!(escrow::status(&e) == escrow::status_active(), 0);
            escrow::auto_release<SUI>(e, &clock, ts::ctx(&mut s));
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// Host files a partial claim; guest accepts without dispute.
    #[test]
    fun test_partial_claim_accepted() {
        let mut s = ts::begin(GUEST);
        setup_claim(&mut s);

        ts::next_tx(&mut s, GUEST);
        {
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            // Verify escrow is in CLAIMED state with correct claim amount
            assert!(escrow::status(&e)       == escrow::status_claimed(), 0);
            assert!(escrow::claim_amount(&e) == CLAIM, 1);
            escrow::accept_claim<SUI>(e, ts::ctx(&mut s));
            // Object consumed — no return_shared needed
        };
        ts::end(s);
    }

    /// Host claims 100% of deposit; guest accepts.
    #[test]
    fun test_full_forfeit_accepted() {
        let mut s = ts::begin(GUEST);
        setup_escrow(&mut s);

        ts::next_tx(&mut s, HOST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE);
            let mut e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::claim_damage<SUI>(&mut e, DEPOSIT, &clock, ts::ctx(&mut s));
            ts::return_shared(e);
            clock::destroy_for_testing(clock);
        };

        ts::next_tx(&mut s, GUEST);
        {
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::accept_claim<SUI>(e, ts::ctx(&mut s));
        };
        ts::end(s);
    }

    /// Guest disputes; arbitrator resolves with a partial split.
    #[test]
    fun test_dispute_resolved_split() {
        let mut s = ts::begin(GUEST);
        setup_dispute(&mut s);

        ts::next_tx(&mut s, ARBITRATOR);
        {
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            assert!(escrow::status(&e) == escrow::status_disputed(), 0);
            // Arbitrator gives 80% back to guest, 20% to host
            let host_share  = DEPOSIT / 5;
            let guest_share = DEPOSIT - host_share;
            escrow::resolve_dispute<SUI>(e, guest_share, host_share, ts::ctx(&mut s));
        };
        ts::end(s);
    }

    /// Guest disputes; arbitrator gives everything back to guest.
    #[test]
    fun test_dispute_full_refund() {
        let mut s = ts::begin(GUEST);
        setup_dispute(&mut s);

        ts::next_tx(&mut s, ARBITRATOR);
        {
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::resolve_dispute<SUI>(e, DEPOSIT, 0, ts::ctx(&mut s));
        };
        ts::end(s);
    }

    /// Guest disputes; arbitrator gives everything to host.
    #[test]
    fun test_dispute_full_forfeit() {
        let mut s = ts::begin(GUEST);
        setup_dispute(&mut s);

        ts::next_tx(&mut s, ARBITRATOR);
        {
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::resolve_dispute<SUI>(e, 0, DEPOSIT, ts::ctx(&mut s));
        };
        ts::end(s);
    }

    /// Anyone (including the ARIA backend) can call auto_release after expiry.
    #[test]
    fun test_stranger_can_trigger_auto_release() {
        let mut s = ts::begin(GUEST);
        setup_escrow(&mut s);

        ts::next_tx(&mut s, STRANGER);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_AFTER);
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::auto_release<SUI>(e, &clock, ts::ctx(&mut s));
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// Host claims, guest goes silent, inspection window passes — anyone can
    /// finalize the claim so funds aren't locked forever (CLAIMED deadlock fix).
    #[test]
    fun test_finalize_claim_after_expiry_succeeds() {
        let mut s = ts::begin(GUEST);
        setup_claim(&mut s); // escrow now STATUS_CLAIMED with CLAIM filed

        ts::next_tx(&mut s, STRANGER); // not guest, not host — anyone may call
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_AFTER); // past expiry
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            assert!(escrow::status(&e) == escrow::status_claimed(), 0);
            escrow::finalize_claim<SUI>(e, &clock, ts::ctx(&mut s));
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// finalize_claim before the inspection window closes must fail — the guest
    /// still has time to accept or dispute, so the timeout path isn't open yet.
    #[test, expected_failure(abort_code = aria_escrow::escrow::ENotExpired)]
    fun test_finalize_claim_before_expiry_fails() {
        let mut s = ts::begin(GUEST);
        setup_claim(&mut s);

        ts::next_tx(&mut s, STRANGER);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE); // still inside window
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::finalize_claim<SUI>(e, &clock, ts::ctx(&mut s));
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// finalize_claim on an un-claimed (still ACTIVE) escrow must fail — there's
    /// no claim to finalize; that path is auto_release's job.
    #[test, expected_failure(abort_code = aria_escrow::escrow::EWrongStatus)]
    fun test_finalize_claim_on_active_fails() {
        let mut s = ts::begin(GUEST);
        setup_escrow(&mut s);

        ts::next_tx(&mut s, STRANGER);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_AFTER);
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::finalize_claim<SUI>(e, &clock, ts::ctx(&mut s));
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    // ── Accessor Tests ─────────────────────────────────────────────────────────

    #[test]
    fun test_accessors_return_correct_values() {
        let mut s = ts::begin(GUEST);
        setup_escrow(&mut s);

        ts::next_tx(&mut s, GUEST);
        {
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            assert!(escrow::status(&e)       == escrow::status_active(),  0);
            assert!(escrow::amount(&e)       == DEPOSIT,                  1);
            assert!(escrow::guest(&e)        == GUEST,                    2);
            assert!(escrow::host(&e)         == HOST,                     3);
            assert!(escrow::expiry_ms(&e)    == T_EXPIRY,                 4);
            assert!(escrow::claim_amount(&e) == 0,                        5);
            ts::return_shared(e);
        };
        ts::end(s);
    }

    // ── Failure Tests: Wrong Status ────────────────────────────────────────────

    /// auto_release on an escrow that has an active damage claim must fail.
    #[test, expected_failure(abort_code = aria_escrow::escrow::EWrongStatus)]
    fun test_auto_release_after_claim_fails() {
        let mut s = ts::begin(GUEST);
        setup_claim(&mut s);

        ts::next_tx(&mut s, GUEST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_AFTER);
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::auto_release<SUI>(e, &clock, ts::ctx(&mut s));
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// Calling claim_damage twice must fail (already in CLAIMED status).
    #[test, expected_failure(abort_code = aria_escrow::escrow::EWrongStatus)]
    fun test_double_claim_fails() {
        let mut s = ts::begin(GUEST);
        setup_claim(&mut s);

        ts::next_tx(&mut s, HOST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE);
            let mut e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::claim_damage<SUI>(&mut e, CLAIM, &clock, ts::ctx(&mut s));
            ts::return_shared(e);
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// Disputing an ACTIVE (not yet claimed) escrow must fail.
    #[test, expected_failure(abort_code = aria_escrow::escrow::EWrongStatus)]
    fun test_dispute_active_escrow_fails() {
        let mut s = ts::begin(GUEST);
        setup_escrow(&mut s);

        ts::next_tx(&mut s, GUEST);
        {
            let mut e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::dispute_claim<SUI>(&mut e, ts::ctx(&mut s));
            ts::return_shared(e);
        };
        ts::end(s);
    }

    // ── Failure Tests: Wrong Caller ────────────────────────────────────────────

    /// Claiming before expiry by a non-host address must fail.
    #[test, expected_failure(abort_code = aria_escrow::escrow::ENotHost)]
    fun test_claim_by_guest_fails() {
        let mut s = ts::begin(GUEST);
        setup_escrow(&mut s);

        ts::next_tx(&mut s, GUEST); // guest, not host
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE);
            let mut e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::claim_damage<SUI>(&mut e, CLAIM, &clock, ts::ctx(&mut s));
            ts::return_shared(e);
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// Claiming by a stranger must fail.
    #[test, expected_failure(abort_code = aria_escrow::escrow::ENotHost)]
    fun test_claim_by_stranger_fails() {
        let mut s = ts::begin(GUEST);
        setup_escrow(&mut s);

        ts::next_tx(&mut s, STRANGER);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE);
            let mut e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::claim_damage<SUI>(&mut e, CLAIM, &clock, ts::ctx(&mut s));
            ts::return_shared(e);
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// Host accepting their own claim (instead of the guest) must fail.
    #[test, expected_failure(abort_code = aria_escrow::escrow::ENotGuest)]
    fun test_host_accepts_own_claim_fails() {
        let mut s = ts::begin(GUEST);
        setup_claim(&mut s);

        ts::next_tx(&mut s, HOST); // host, not guest
        {
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::accept_claim<SUI>(e, ts::ctx(&mut s));
        };
        ts::end(s);
    }

    /// Host disputing their own claim must fail.
    #[test, expected_failure(abort_code = aria_escrow::escrow::ENotGuest)]
    fun test_host_disputes_own_claim_fails() {
        let mut s = ts::begin(GUEST);
        setup_claim(&mut s);

        ts::next_tx(&mut s, HOST); // host, not guest
        {
            let mut e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::dispute_claim<SUI>(&mut e, ts::ctx(&mut s));
            ts::return_shared(e);
        };
        ts::end(s);
    }

    /// Non-arbitrator trying to resolve a dispute must fail.
    #[test, expected_failure(abort_code = aria_escrow::escrow::ENotArbitrator)]
    fun test_resolve_by_host_fails() {
        let mut s = ts::begin(GUEST);
        setup_dispute(&mut s);

        ts::next_tx(&mut s, HOST); // host, not arbitrator
        {
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::resolve_dispute<SUI>(e, 0, DEPOSIT, ts::ctx(&mut s));
        };
        ts::end(s);
    }

    /// Stranger trying to resolve a dispute must fail.
    #[test, expected_failure(abort_code = aria_escrow::escrow::ENotArbitrator)]
    fun test_resolve_by_stranger_fails() {
        let mut s = ts::begin(GUEST);
        setup_dispute(&mut s);

        ts::next_tx(&mut s, STRANGER);
        {
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::resolve_dispute<SUI>(e, DEPOSIT / 2, DEPOSIT / 2, ts::ctx(&mut s));
        };
        ts::end(s);
    }

    // ── Failure Tests: Amount Invariants ──────────────────────────────────────

    /// Zero-value escrow must be rejected at creation.
    #[test, expected_failure(abort_code = aria_escrow::escrow::EZeroAmount)]
    fun test_zero_deposit_fails() {
        let mut s = ts::begin(GUEST);
        ts::next_tx(&mut s, GUEST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE);
            let coin = coin::mint_for_testing<SUI>(0, ts::ctx(&mut s));
            escrow::create_escrow<SUI>(
                ref_str(), GUEST, HOST, ARBITRATOR, T_EXPIRY,
                coin, &clock, ts::ctx(&mut s)
            );
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// Claiming more than the deposit must fail.
    #[test, expected_failure(abort_code = aria_escrow::escrow::EClaimExceedsDeposit)]
    fun test_claim_exceeds_deposit_fails() {
        let mut s = ts::begin(GUEST);
        setup_escrow(&mut s);

        ts::next_tx(&mut s, HOST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE);
            let mut e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::claim_damage<SUI>(&mut e, DEPOSIT + 1, &clock, ts::ctx(&mut s));
            ts::return_shared(e);
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// Resolve split that doesn't sum to escrow.amount must fail.
    #[test, expected_failure(abort_code = aria_escrow::escrow::ESplitMismatch)]
    fun test_split_mismatch_fails() {
        let mut s = ts::begin(GUEST);
        setup_dispute(&mut s);

        ts::next_tx(&mut s, ARBITRATOR);
        {
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            // guest + host = DEPOSIT - 1 ≠ DEPOSIT
            escrow::resolve_dispute<SUI>(e, DEPOSIT / 2, DEPOSIT / 2 - 1, ts::ctx(&mut s));
        };
        ts::end(s);
    }

    // ── Failure Tests: Timing ─────────────────────────────────────────────────

    /// auto_release before expiry must fail — the key guest protection.
    #[test, expected_failure(abort_code = aria_escrow::escrow::ENotExpired)]
    fun test_auto_release_before_expiry_fails() {
        let mut s = ts::begin(GUEST);
        setup_escrow(&mut s);

        ts::next_tx(&mut s, GUEST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE); // still inside window
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::auto_release<SUI>(e, &clock, ts::ctx(&mut s));
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// Damage claim after the inspection window has closed must fail.
    #[test, expected_failure(abort_code = aria_escrow::escrow::EAlreadyExpired)]
    fun test_claim_after_expiry_fails() {
        let mut s = ts::begin(GUEST);
        setup_escrow(&mut s);

        ts::next_tx(&mut s, HOST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_AFTER); // past expiry
            let mut e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::claim_damage<SUI>(&mut e, CLAIM, &clock, ts::ctx(&mut s));
            ts::return_shared(e);
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// Creating an escrow with an expiry in the past must fail.
    #[test, expected_failure(abort_code = aria_escrow::escrow::EExpiryInPast)]
    fun test_create_with_past_expiry_fails() {
        let mut s = ts::begin(GUEST);
        ts::next_tx(&mut s, GUEST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_AFTER); // now = T_AFTER
            let coin = coin::mint_for_testing<SUI>(DEPOSIT, ts::ctx(&mut s));
            // expiry = T_BEFORE < T_AFTER — already in the past
            escrow::create_escrow<SUI>(
                ref_str(), GUEST, HOST, ARBITRATOR, T_BEFORE,
                coin, &clock, ts::ctx(&mut s)
            );
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// Creating an escrow with an expiry more than MAX_EXPIRY_MS (30 days) out must fail.
    #[test, expected_failure(abort_code = aria_escrow::escrow::EExpiryTooFar)]
    fun test_create_with_expiry_too_far_fails() {
        let mut s = ts::begin(GUEST);
        ts::next_tx(&mut s, GUEST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE); // now = T_BEFORE
            let coin = coin::mint_for_testing<SUI>(DEPOSIT, ts::ctx(&mut s));
            // expiry = now + MAX_EXPIRY_MS + 1 — one millisecond past the cap
            let too_far = T_BEFORE + escrow::max_expiry_ms() + 1;
            escrow::create_escrow<SUI>(
                ref_str(), GUEST, HOST, ARBITRATOR, too_far,
                coin, &clock, ts::ctx(&mut s)
            );
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// An expiry exactly at the MAX_EXPIRY_MS boundary (now + 30 days) must succeed.
    #[test]
    fun test_create_with_expiry_at_max_boundary_succeeds() {
        let mut s = ts::begin(GUEST);
        ts::next_tx(&mut s, GUEST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE); // now = T_BEFORE
            let coin = coin::mint_for_testing<SUI>(DEPOSIT, ts::ctx(&mut s));
            let at_max = T_BEFORE + escrow::max_expiry_ms();
            escrow::create_escrow<SUI>(
                ref_str(), GUEST, HOST, ARBITRATOR, at_max,
                coin, &clock, ts::ctx(&mut s)
            );
            clock::destroy_for_testing(clock);
        };
        ts::next_tx(&mut s, GUEST);
        {
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            assert!(escrow::expiry_ms(&e) == T_BEFORE + escrow::max_expiry_ms(), 0);
            ts::return_shared(e);
        };
        ts::end(s);
    }

    // ── Payment Escrow Tests (rental + ARIA fee + tax) ──────────────────────────
    //
    // Industry-standard "fee follows refund": before check-in a cancel refunds
    // rental + fee + tax to the guest; at check-in the funds split three ways to
    // host / ARIA / tax remittance. release_time_ms (check-in) is T_EXPIRY here.

    const ARIA_ADDR: address = @0x400; // ARIA fee wallet
    const TAX_ADDR:  address = @0x500; // tax remittance wallet

    const P_HOST:  u64 = 600_000_000; // rental subtotal -> host
    const P_ARIA:  u64 =  60_000_000; // ARIA fee
    const P_TAX:   u64 =  40_000_000; // taxes
    const P_TOTAL: u64 = 700_000_000; // == P_HOST + P_ARIA + P_TAX

    /// Create a payment escrow funded with P_TOTAL, release_time = T_EXPIRY,
    /// at now = T_BEFORE (so release_time is in the future).
    fun setup_payment_escrow(scenario: &mut ts::Scenario) {
        ts::next_tx(scenario, GUEST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(scenario));
            clock::set_for_testing(&mut clock, T_BEFORE);
            let coin = coin::mint_for_testing<SUI>(P_TOTAL, ts::ctx(scenario));
            escrow::create_payment_escrow<SUI>(
                ref_str(), GUEST, HOST, ARIA_ADDR, TAX_ADDR, ARBITRATOR,
                P_HOST, P_ARIA, P_TAX, T_EXPIRY, coin, &clock, ts::ctx(scenario)
            );
            clock::destroy_for_testing(clock);
        };
    }

    /// Assert `addr` holds exactly one Coin<SUI> of `expected` value, then burn it.
    fun assert_received(scenario: &mut ts::Scenario, addr: address, expected: u64) {
        ts::next_tx(scenario, addr);
        let c = ts::take_from_address<coin::Coin<SUI>>(scenario, addr);
        assert!(coin::value(&c) == expected, 0);
        coin::burn_for_testing(c);
    }

    /// Create records all three legs, both treasury addresses, and ACTIVE status.
    #[test]
    fun test_create_payment_escrow_succeeds() {
        let mut s = ts::begin(GUEST);
        setup_payment_escrow(&mut s);

        ts::next_tx(&mut s, GUEST);
        {
            let e = ts::take_shared<escrow::BookingPaymentEscrow<SUI>>(&s);
            assert!(escrow::payment_status(&e)          == escrow::status_active(), 0);
            assert!(escrow::payment_host_amount(&e)     == P_HOST, 1);
            assert!(escrow::payment_aria_amount(&e)     == P_ARIA, 2);
            assert!(escrow::payment_tax_amount(&e)      == P_TAX,  3);
            assert!(escrow::payment_host(&e)            == HOST,      4);
            assert!(escrow::payment_aria_addr(&e)       == ARIA_ADDR, 5);
            assert!(escrow::payment_tax_addr(&e)        == TAX_ADDR,  6);
            assert!(escrow::payment_arbitrator(&e)      == ARBITRATOR, 7);
            assert!(escrow::payment_release_time_ms(&e) == T_EXPIRY,  8);
            ts::return_shared(e);
        };
        ts::end(s);
    }

    /// At check-in, release_payment splits exactly to host / ARIA / tax.
    #[test]
    fun test_release_payment_splits_three_ways() {
        let mut s = ts::begin(GUEST);
        setup_payment_escrow(&mut s);

        ts::next_tx(&mut s, STRANGER); // permissionless caller
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_AFTER); // at/after check-in
            let e = ts::take_shared<escrow::BookingPaymentEscrow<SUI>>(&s);
            escrow::release_payment<SUI>(e, &clock, ts::ctx(&mut s));
            clock::destroy_for_testing(clock);
        };

        assert_received(&mut s, HOST,      P_HOST);
        assert_received(&mut s, ARIA_ADDR, P_ARIA);
        assert_received(&mut s, TAX_ADDR,  P_TAX);
        ts::end(s);
    }

    /// release_payment is permissionless — exercised above via STRANGER; this also
    /// confirms it works exactly at the release_time boundary (now == release_time).
    #[test]
    fun test_release_payment_at_boundary_succeeds() {
        let mut s = ts::begin(GUEST);
        setup_payment_escrow(&mut s);

        ts::next_tx(&mut s, STRANGER);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_EXPIRY); // exactly check-in
            let e = ts::take_shared<escrow::BookingPaymentEscrow<SUI>>(&s);
            escrow::release_payment<SUI>(e, &clock, ts::ctx(&mut s));
            clock::destroy_for_testing(clock);
        };
        assert_received(&mut s, HOST, P_HOST);
        assert_received(&mut s, ARIA_ADDR, P_ARIA);
        assert_received(&mut s, TAX_ADDR, P_TAX);
        ts::end(s);
    }

    /// release_payment before check-in must fail — funds aren't releasable yet.
    #[test, expected_failure(abort_code = aria_escrow::escrow::ENotReleaseTime)]
    fun test_release_payment_before_checkin_fails() {
        let mut s = ts::begin(GUEST);
        setup_payment_escrow(&mut s);

        ts::next_tx(&mut s, STRANGER);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE); // before check-in
            let e = ts::take_shared<escrow::BookingPaymentEscrow<SUI>>(&s);
            escrow::release_payment<SUI>(e, &clock, ts::ctx(&mut s));
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// Zero-tax booking: tax leg is skipped, host + ARIA still paid, no dust coin.
    #[test]
    fun test_release_payment_zero_tax_leg() {
        let mut s = ts::begin(GUEST);
        ts::next_tx(&mut s, GUEST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE);
            // host + aria == total, tax == 0
            let coin = coin::mint_for_testing<SUI>(P_HOST + P_ARIA, ts::ctx(&mut s));
            escrow::create_payment_escrow<SUI>(
                ref_str(), GUEST, HOST, ARIA_ADDR, TAX_ADDR, ARBITRATOR,
                P_HOST, P_ARIA, 0, T_EXPIRY, coin, &clock, ts::ctx(&mut s)
            );
            clock::destroy_for_testing(clock);
        };

        ts::next_tx(&mut s, STRANGER);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_AFTER);
            let e = ts::take_shared<escrow::BookingPaymentEscrow<SUI>>(&s);
            escrow::release_payment<SUI>(e, &clock, ts::ctx(&mut s));
            clock::destroy_for_testing(clock);
        };
        assert_received(&mut s, HOST, P_HOST);
        assert_received(&mut s, ARIA_ADDR, P_ARIA);
        ts::end(s);
    }

    /// Cancel before check-in: arbitrator refunds the WHOLE payment to the guest
    /// (rental + fee + tax), matching Airbnb/Vrbo "fee follows refund".
    #[test]
    fun test_refund_payment_full_to_guest() {
        let mut s = ts::begin(GUEST);
        setup_payment_escrow(&mut s);

        ts::next_tx(&mut s, ARBITRATOR);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE); // before check-in
            let e = ts::take_shared<escrow::BookingPaymentEscrow<SUI>>(&s);
            escrow::refund_payment<SUI>(e, &clock, ts::ctx(&mut s));
            clock::destroy_for_testing(clock);
        };
        assert_received(&mut s, GUEST, P_TOTAL); // guest gets everything back
        ts::end(s);
    }

    /// Only the arbitrator may refund — a stranger cannot.
    #[test, expected_failure(abort_code = aria_escrow::escrow::ENotArbitrator)]
    fun test_refund_payment_non_arbitrator_fails() {
        let mut s = ts::begin(GUEST);
        setup_payment_escrow(&mut s);

        ts::next_tx(&mut s, STRANGER);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE);
            let e = ts::take_shared<escrow::BookingPaymentEscrow<SUI>>(&s);
            escrow::refund_payment<SUI>(e, &clock, ts::ctx(&mut s));
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// Refund is hard-blocked once check-in is reached — only release_payment is
    /// valid from then on (the two are mutually exclusive at release_time_ms).
    #[test, expected_failure(abort_code = aria_escrow::escrow::ERefundTooLate)]
    fun test_refund_payment_after_checkin_fails() {
        let mut s = ts::begin(GUEST);
        setup_payment_escrow(&mut s);

        ts::next_tx(&mut s, ARBITRATOR);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_AFTER); // at/after check-in
            let e = ts::take_shared<escrow::BookingPaymentEscrow<SUI>>(&s);
            escrow::refund_payment<SUI>(e, &clock, ts::ctx(&mut s));
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// The three legs must sum to the funded coin — under/over-funding is rejected.
    #[test, expected_failure(abort_code = aria_escrow::escrow::ESplitMismatch)]
    fun test_create_payment_escrow_sum_mismatch_fails() {
        let mut s = ts::begin(GUEST);
        ts::next_tx(&mut s, GUEST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE);
            // coin is 1 MIST short of the declared legs
            let coin = coin::mint_for_testing<SUI>(P_TOTAL - 1, ts::ctx(&mut s));
            escrow::create_payment_escrow<SUI>(
                ref_str(), GUEST, HOST, ARIA_ADDR, TAX_ADDR, ARBITRATOR,
                P_HOST, P_ARIA, P_TAX, T_EXPIRY, coin, &clock, ts::ctx(&mut s)
            );
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// A release_time in the past is rejected at creation.
    #[test, expected_failure(abort_code = aria_escrow::escrow::EReleaseTimeInPast)]
    fun test_create_payment_escrow_past_release_fails() {
        let mut s = ts::begin(GUEST);
        ts::next_tx(&mut s, GUEST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_AFTER); // now is AFTER release_time
            let coin = coin::mint_for_testing<SUI>(P_TOTAL, ts::ctx(&mut s));
            escrow::create_payment_escrow<SUI>(
                ref_str(), GUEST, HOST, ARIA_ADDR, TAX_ADDR, ARBITRATOR,
                P_HOST, P_ARIA, P_TAX, T_EXPIRY, coin, &clock, ts::ctx(&mut s)
            );
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// refund_deposit: arbitrator returns the security deposit to the guest
    /// instantly on cancel (instead of waiting for auto_release at expiry).
    #[test]
    fun test_refund_deposit_to_guest() {
        let mut s = ts::begin(GUEST);
        setup_escrow(&mut s); // deposit escrow of DEPOSIT, guest = GUEST

        ts::next_tx(&mut s, ARBITRATOR);
        {
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            assert!(escrow::status(&e) == escrow::status_active(), 0);
            escrow::refund_deposit<SUI>(e, ts::ctx(&mut s));
        };
        assert_received(&mut s, GUEST, DEPOSIT);
        ts::end(s);
    }

    /// Only the arbitrator may refund the deposit early.
    #[test, expected_failure(abort_code = aria_escrow::escrow::ENotArbitrator)]
    fun test_refund_deposit_non_arbitrator_fails() {
        let mut s = ts::begin(GUEST);
        setup_escrow(&mut s);

        ts::next_tx(&mut s, STRANGER);
        {
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::refund_deposit<SUI>(e, ts::ctx(&mut s));
        };
        ts::end(s);
    }

    // ── Seal access control (Phase 2 — guest PII) ───────────────────────────────
    // seal_approve gates PII decryption: it must pass for this booking's host with
    // the guest's address as the Seal identity, and abort otherwise.

    /// The booking's host, with the correct guest-address identity, is authorized.
    #[test]
    fun test_seal_approve_authorized_host() {
        let mut s = ts::begin(GUEST);
        setup_escrow(&mut s);

        ts::next_tx(&mut s, HOST);
        {
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::seal_approve<SUI>(sui::address::to_bytes(GUEST), &e, ts::ctx(&mut s));
            ts::return_shared(e);
        };
        ts::end(s);
    }

    /// A non-host (here, the guest) cannot unlock the host-only PII.
    #[test, expected_failure(abort_code = aria_escrow::escrow::ENotHost)]
    fun test_seal_approve_non_host_fails() {
        let mut s = ts::begin(GUEST);
        setup_escrow(&mut s);

        ts::next_tx(&mut s, GUEST); // guest is not the host
        {
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            escrow::seal_approve<SUI>(sui::address::to_bytes(GUEST), &e, ts::ctx(&mut s));
            ts::return_shared(e);
        };
        ts::end(s);
    }

    /// The host cannot use this escrow to unlock a DIFFERENT guest's blob — the
    /// identity bytes must equal this escrow's guest address.
    #[test, expected_failure(abort_code = aria_escrow::escrow::ENotGuest)]
    fun test_seal_approve_wrong_identity_fails() {
        let mut s = ts::begin(GUEST);
        setup_escrow(&mut s);

        ts::next_tx(&mut s, HOST);
        {
            let e = ts::take_shared<BookingEscrow<SUI>>(&s);
            // STRANGER's address, not this escrow's guest — must abort.
            escrow::seal_approve<SUI>(sui::address::to_bytes(STRANGER), &e, ts::ctx(&mut s));
            ts::return_shared(e);
        };
        ts::end(s);
    }

    // ── BookingPass (Phase 2a — soulbound owned proof of booking) ───────────────

    /// mint_booking_pass mints a BookingPass OWNED by the guest with the right
    /// fields. (It's owned, so it's taken from the guest's address — confirming it
    /// landed in their wallet, not shared.)
    #[test]
    fun test_mint_booking_pass() {
        let mut s = ts::begin(GUEST);
        ts::next_tx(&mut s, GUEST);
        {
            escrow::mint_booking_pass(ref_str(), GUEST, HOST, 1, 1000, 2000, ts::ctx(&mut s));
        };
        ts::next_tx(&mut s, GUEST);
        {
            let p = ts::take_from_address<escrow::BookingPass>(&s, GUEST);
            assert!(escrow::pass_guest(&p)        == GUEST, 0);
            assert!(escrow::pass_host(&p)         == HOST,  1);
            assert!(escrow::pass_property_id(&p)  == 1,     2);
            assert!(escrow::pass_check_in_ms(&p)  == 1000,  3);
            assert!(escrow::pass_check_out_ms(&p) == 2000,  4);
            assert!(escrow::pass_booking_ref(&p)  == ref_str(), 5);
            ts::return_to_address(GUEST, p);
        };
        ts::end(s);
    }

    // ── Resale (Phase 2c — list / buy / cancel) ─────────────────────────────────
    const BUYER:         address = @0x600;
    const RS_CAP:        u64 = 2000;          // 20% premium cap (basis points)
    const RS_RELEASE:    u64 = 200_000_000;   // check-in — far enough out for the 48h window
    const RS_WINDOW:     u64 = 172_800_000;   // 48h no-transfer window (mainnet default)
    const RS_PROP:       u64 = 7;
    const RS_CHECKIN:    u64 = 200_000_000;
    const RS_CHECKOUT:   u64 = 250_000_000;
    const RS_FACE:       u64 = 1_700_000_000; // DEPOSIT (1e9) + P_TOTAL (7e8)
    const RS_ASK:        u64 = 1_800_000_000; // face + 100M upcharge (within cap)
    const RS_ARIA_CUT:   u64 =    10_000_000; // 10% of upcharge
    const RS_HOST_CUT:   u64 =    45_000_000; // 45% of upcharge
    const RS_SELLER_CUT: u64 = 1_745_000_000; // face + 45% of upcharge
    const RS_LATE:       u64 = 100_000_000;   // now inside the 48h window (abort)
    const RS_OVERASK:    u64 = 2_100_000_000; // face + 400M upcharge (> 20% cap, abort)

    /// Build a full resale-ready booking owned by GUEST: deposit escrow, payment
    /// escrow (release far out), ResalePolicy, and the soulbound pass.
    fun setup_resale(scenario: &mut ts::Scenario, transferable: bool, cap_bps: u64) {
        ts::next_tx(scenario, GUEST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(scenario));
            clock::set_for_testing(&mut clock, T_BEFORE);
            let dcoin = coin::mint_for_testing<SUI>(DEPOSIT, ts::ctx(scenario));
            escrow::create_escrow<SUI>(
                ref_str(), GUEST, HOST, ARBITRATOR, T_EXPIRY, dcoin, &clock, ts::ctx(scenario)
            );
            let pcoin = coin::mint_for_testing<SUI>(P_TOTAL, ts::ctx(scenario));
            escrow::create_payment_escrow<SUI>(
                ref_str(), GUEST, HOST, ARIA_ADDR, TAX_ADDR, ARBITRATOR,
                P_HOST, P_ARIA, P_TAX, RS_RELEASE, pcoin, &clock, ts::ctx(scenario)
            );
            escrow::create_resale_policy(
                ref_str(), HOST, transferable, cap_bps, RS_RELEASE, RS_WINDOW,
                RS_PROP, RS_CHECKIN, RS_CHECKOUT, ts::ctx(scenario)
            );
            escrow::mint_booking_pass(
                ref_str(), GUEST, HOST, RS_PROP, RS_CHECKIN, RS_CHECKOUT, ts::ctx(scenario)
            );
            clock::destroy_for_testing(clock);
        };
    }

    /// GUEST lists the booking at `ask`, with the clock at `now_ms`.
    fun do_list(scenario: &mut ts::Scenario, ask: u64, now_ms: u64) {
        ts::next_tx(scenario, GUEST);
        {
            let mut clock = clock::create_for_testing(ts::ctx(scenario));
            clock::set_for_testing(&mut clock, now_ms);
            let mut de  = ts::take_shared<BookingEscrow<SUI>>(scenario);
            let mut pe  = ts::take_shared<escrow::BookingPaymentEscrow<SUI>>(scenario);
            let mut pol = ts::take_shared<escrow::ResalePolicy>(scenario);
            let pass = ts::take_from_address<escrow::BookingPass>(scenario, GUEST);
            escrow::list_for_resale<SUI>(&mut de, &mut pe, &mut pol, pass, ask, &clock, ts::ctx(scenario));
            ts::return_shared(de);
            ts::return_shared(pe);
            ts::return_shared(pol);
            clock::destroy_for_testing(clock);
        };
    }

    /// Happy path: list with a premium, buyer buys → splits, reassignment, fresh pass.
    #[test]
    fun test_resale_list_and_buy_happy_path() {
        let mut s = ts::begin(GUEST);
        setup_resale(&mut s, true, RS_CAP);
        do_list(&mut s, RS_ASK, T_BEFORE);

        ts::next_tx(&mut s, BUYER);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE);
            let mut de  = ts::take_shared<BookingEscrow<SUI>>(&s);
            let mut pe  = ts::take_shared<escrow::BookingPaymentEscrow<SUI>>(&s);
            let mut pol = ts::take_shared<escrow::ResalePolicy>(&s);
            let c = coin::mint_for_testing<SUI>(RS_ASK, ts::ctx(&mut s));
            escrow::buy_resale<SUI>(&mut de, &mut pe, &mut pol, c, &clock, ts::ctx(&mut s));
            assert!(escrow::guest<SUI>(&de)          == BUYER, 0);
            assert!(escrow::payment_guest<SUI>(&pe)  == BUYER, 1);
            assert!(escrow::policy_resale_count(&pol) == 1,    2);
            assert!(!escrow::policy_listed(&pol),              3);
            ts::return_shared(de);
            ts::return_shared(pe);
            ts::return_shared(pol);
            clock::destroy_for_testing(clock);
        };

        // Upcharge split: ARIA 10%, host 45%, seller keeps face + 45%.
        assert_received(&mut s, ARIA_ADDR, RS_ARIA_CUT);
        assert_received(&mut s, HOST,      RS_HOST_CUT);
        assert_received(&mut s, GUEST,     RS_SELLER_CUT);

        // Buyer holds a fresh soulbound pass.
        ts::next_tx(&mut s, BUYER);
        {
            let np = ts::take_from_address<escrow::BookingPass>(&s, BUYER);
            assert!(escrow::pass_guest(&np)       == BUYER,     4);
            assert!(escrow::pass_booking_ref(&np) == ref_str(), 5);
            assert!(escrow::pass_property_id(&np) == RS_PROP,   6);
            ts::return_to_address(BUYER, np);
        };
        ts::end(s);
    }

    /// Face-value resale (ask == face): no ARIA/host cut, seller gets the whole face.
    #[test]
    fun test_resale_face_value_no_cuts() {
        let mut s = ts::begin(GUEST);
        setup_resale(&mut s, true, RS_CAP);
        do_list(&mut s, RS_FACE, T_BEFORE);

        ts::next_tx(&mut s, BUYER);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE);
            let mut de  = ts::take_shared<BookingEscrow<SUI>>(&s);
            let mut pe  = ts::take_shared<escrow::BookingPaymentEscrow<SUI>>(&s);
            let mut pol = ts::take_shared<escrow::ResalePolicy>(&s);
            let c = coin::mint_for_testing<SUI>(RS_FACE, ts::ctx(&mut s));
            escrow::buy_resale<SUI>(&mut de, &mut pe, &mut pol, c, &clock, ts::ctx(&mut s));
            ts::return_shared(de);
            ts::return_shared(pe);
            ts::return_shared(pol);
            clock::destroy_for_testing(clock);
        };
        assert_received(&mut s, GUEST, RS_FACE);
        ts::end(s);
    }

    /// Listing a non-transferable booking aborts.
    #[test, expected_failure(abort_code = aria_escrow::escrow::EResaleNotAllowed)]
    fun test_resale_disabled_listing_fails() {
        let mut s = ts::begin(GUEST);
        setup_resale(&mut s, false, RS_CAP);
        do_list(&mut s, RS_ASK, T_BEFORE);
        ts::end(s);
    }

    /// Listing above the host's premium cap aborts.
    #[test, expected_failure(abort_code = aria_escrow::escrow::EPremiumTooHigh)]
    fun test_resale_over_cap_fails() {
        let mut s = ts::begin(GUEST);
        setup_resale(&mut s, true, RS_CAP);
        do_list(&mut s, RS_OVERASK, T_BEFORE);
        ts::end(s);
    }

    /// Listing inside the final 48h window aborts.
    #[test, expected_failure(abort_code = aria_escrow::escrow::EResaleWindowClosed)]
    fun test_resale_inside_window_fails() {
        let mut s = ts::begin(GUEST);
        setup_resale(&mut s, true, RS_CAP);
        do_list(&mut s, RS_ASK, RS_LATE);
        ts::end(s);
    }

    /// Buyer paying the wrong price aborts.
    #[test, expected_failure(abort_code = aria_escrow::escrow::EPriceMismatch)]
    fun test_resale_wrong_price_fails() {
        let mut s = ts::begin(GUEST);
        setup_resale(&mut s, true, RS_CAP);
        do_list(&mut s, RS_ASK, T_BEFORE);
        ts::next_tx(&mut s, BUYER);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE);
            let mut de  = ts::take_shared<BookingEscrow<SUI>>(&s);
            let mut pe  = ts::take_shared<escrow::BookingPaymentEscrow<SUI>>(&s);
            let mut pol = ts::take_shared<escrow::ResalePolicy>(&s);
            let c = coin::mint_for_testing<SUI>(RS_ASK - 1, ts::ctx(&mut s));
            escrow::buy_resale<SUI>(&mut de, &mut pe, &mut pol, c, &clock, ts::ctx(&mut s));
            ts::return_shared(de);
            ts::return_shared(pe);
            ts::return_shared(pol);
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// A second hop is rejected (one hop only): after a buy, the buyer can't relist.
    #[test, expected_failure(abort_code = aria_escrow::escrow::EMaxHopsReached)]
    fun test_resale_second_hop_fails() {
        let mut s = ts::begin(GUEST);
        setup_resale(&mut s, true, RS_CAP);
        do_list(&mut s, RS_ASK, T_BEFORE);
        ts::next_tx(&mut s, BUYER);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE);
            let mut de  = ts::take_shared<BookingEscrow<SUI>>(&s);
            let mut pe  = ts::take_shared<escrow::BookingPaymentEscrow<SUI>>(&s);
            let mut pol = ts::take_shared<escrow::ResalePolicy>(&s);
            let c = coin::mint_for_testing<SUI>(RS_ASK, ts::ctx(&mut s));
            escrow::buy_resale<SUI>(&mut de, &mut pe, &mut pol, c, &clock, ts::ctx(&mut s));
            ts::return_shared(de);
            ts::return_shared(pe);
            ts::return_shared(pol);
            clock::destroy_for_testing(clock);
        };
        // Buyer now owns the booking + a fresh pass; relisting must abort (hop == 1).
        ts::next_tx(&mut s, BUYER);
        {
            let mut clock = clock::create_for_testing(ts::ctx(&mut s));
            clock::set_for_testing(&mut clock, T_BEFORE);
            let mut de  = ts::take_shared<BookingEscrow<SUI>>(&s);
            let mut pe  = ts::take_shared<escrow::BookingPaymentEscrow<SUI>>(&s);
            let mut pol = ts::take_shared<escrow::ResalePolicy>(&s);
            let pass = ts::take_from_address<escrow::BookingPass>(&s, BUYER);
            escrow::list_for_resale<SUI>(&mut de, &mut pe, &mut pol, pass, RS_ASK, &clock, ts::ctx(&mut s));
            ts::return_shared(de);
            ts::return_shared(pe);
            ts::return_shared(pol);
            clock::destroy_for_testing(clock);
        };
        ts::end(s);
    }

    /// Cancelling a listing remints the pass to the seller and clears `listed`.
    #[test]
    fun test_resale_cancel_remints_pass() {
        let mut s = ts::begin(GUEST);
        setup_resale(&mut s, true, RS_CAP);
        do_list(&mut s, RS_ASK, T_BEFORE);

        ts::next_tx(&mut s, GUEST);
        {
            let mut pol = ts::take_shared<escrow::ResalePolicy>(&s);
            escrow::cancel_resale_listing(&mut pol, ts::ctx(&mut s));
            assert!(!escrow::policy_listed(&pol), 0);
            ts::return_shared(pol);
        };
        ts::next_tx(&mut s, GUEST);
        {
            let p = ts::take_from_address<escrow::BookingPass>(&s, GUEST);
            assert!(escrow::pass_guest(&p) == GUEST, 1);
            ts::return_to_address(GUEST, p);
        };
        ts::end(s);
    }
}
