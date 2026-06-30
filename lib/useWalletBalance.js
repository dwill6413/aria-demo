// Shared hook for showing a user's on-chain Sui wallet balance in the UI.
// Reuses the same gRPC fullnode connection zklogin.js already opens (one
// connection per browser tab, not one per component) via getZkLoginSuiClient().
//
// Surfaced because there was previously no way to see your wallet balance
// anywhere in the ARIA UI — a guest/host had to guess whether they had
// enough testnet SUI to book/pay out, and only found out by hitting the
// 'insufficient_balance' error mid-transaction (see escrow.mjs).
import { useState, useEffect, useCallback, useRef } from 'react';

const MIST_PER_SUI = 1_000_000_000n;
const POLL_MS = 30_000;

// Mist (on-chain u64 string) -> a short human string, e.g. "12.4503 SUI".
// Trims trailing zeros so a round balance like "5 SUI" doesn't show "5.0000".
export function formatSui(mist) {
  if (mist == null) return null;
  const n = BigInt(mist);
  const whole = n / MIST_PER_SUI;
  const frac = n % MIST_PER_SUI;
  if (frac === 0n) return `${whole} SUI`;
  const fracStr = frac.toString().padStart(9, '0').slice(0, 4).replace(/0+$/, '');
  return `${whole}${fracStr ? '.' + fracStr : ''} SUI`;
}

// address: the wallet to look up (user.address / session.suiAddress).
// Returns { mist, display, loading, error, lowBalance, refresh }.
//   - mist: raw balance as a string (smallest unit), or null while loading/on error.
//   - display: formatted string like "3.21 SUI", or null.
//   - lowBalance: true once we have a confirmed reading and it's under 0.05 SUI
//     (the rough cost of one booking PTB's gas) — used to surface a faucet link.
export function useWalletBalance(address) {
  const [mist, setMist] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const mountedRef = useRef(true);

  const fetchBalance = useCallback(async () => {
    if (!address) { setMist(null); setLoading(false); return; }
    try {
      const { getZkLoginSuiClient } = await import('./zklogin');
      const suiClient = getZkLoginSuiClient();
      const { balance } = await suiClient.core.getBalance({ owner: address });
      if (!mountedRef.current) return;
      setMist(balance?.balance ?? '0');
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      // Leave the last-known balance in place on a transient fetch error
      // rather than flashing the badge to blank/zero.
      setError(err?.message || 'Could not fetch balance');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    fetchBalance();
    const interval = setInterval(fetchBalance, POLL_MS);
    return () => { mountedRef.current = false; clearInterval(interval); };
  }, [fetchBalance]);

  const lowBalanceThresholdMist = 50_000_000n; // 0.05 SUI
  const lowBalance = mist != null && BigInt(mist) < lowBalanceThresholdMist;

  return {
    mist,
    display: formatSui(mist),
    loading,
    error,
    lowBalance,
    refresh: fetchBalance,
  };
}
