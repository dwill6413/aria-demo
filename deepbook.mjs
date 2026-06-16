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
 * Calculate host payout after ARIA fee
 * Host receives 97% of booking in SuiUSD
 * ARIA retains 3% fee settled via DeepBook
 */
export function calculateHostPayout(totalAmount) {
  const ariaFee = Math.round(totalAmount * 0.03);
  const hostPayout = totalAmount - ariaFee;
  return {
    totalAmount,
    ariaFee,
    hostPayout,
    currency: 'SuiUSD',
    settlementMethod: 'DeepBook',
    note: 'Host receives instant payout in SuiUSD via Sui testnet'
  };
}