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
}
