/**
 * ARIA DeepBook Integration
 * Handles host payout calculations and platform fee settlement via SuiUSD
 * DeepBook v3 on Sui testnet
 */

/**
 * Get current SuiUSD liquidity info for a given amount
 * Used for host payout calculations and platform fee settlement
 */
export async function getSuiUSDLiquidity(amountUSD) {
  try {
    // Query DeepBook testnet aggregator directly — must stay on testnet to
    // match every other on-chain call in this app (escrow, zkLogin, fullnode).
    const res = await fetch(
      'https://deepbook-indexer.testnet.mystenlabs.com/get_pools',
      { method: 'GET', headers: { 'Content-Type': 'application/json' } }
    );
    const pools = await res.json();
    return {
      available: true,
      amountUSD,
      pools: Array.isArray(pools) ? pools.length : 0,
      message: 'DeepBook liquidity available'
    };
  } catch (err) {
    console.warn('DeepBook liquidity check failed:', err.message);
    return {
      available: false,
      amountUSD,
      message: 'DeepBook unavailable — using direct SuiUSD settlement'
    };
  }
}

/**
 * Host payout in SuiUSD.
 *
 * The 3% ARIA fee is a GUEST-SIDE add-on — it is already part of bookingTotal
 * and is collected from the guest separately at settlement. It is NOT deducted
 * from the host. The host therefore receives the FULL subtotal. `ariaFee` is
 * returned for reference only.
 *
 * This fixes the prior double-count where the fee was both added on top of the
 * guest's subtotal AND subtracted from the host. See ARIA_FEE_DESIGN.md
 * (guest-side fee incidence).
 */
export function calculateHostPayout(totalAmount) {
  const ariaFee = Math.round(totalAmount * 0.03); // guest-side add-on, for reference only
  const hostPayout = totalAmount;                 // host receives the full subtotal
  return {
    totalAmount,
    ariaFee,
    hostPayout,
    currency: 'SuiUSD',
    settlementMethod: 'BookingPaymentEscrow',
    note: 'Host receives the full rental subtotal; the 3% ARIA fee is a guest-side add-on, not a host deduction'
  };
}