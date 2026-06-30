import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { authFetch } from '../lib/authFetch';
import { signTransactionWithZkLogin, submitSignedTransaction, signPersonalMessageWithZkLogin } from '../lib/zklogin';
import { useWalletBalance } from '../lib/useWalletBalance';
import { fromBase64 } from '@mysten/sui/utils';
import { QRCodeSVG } from 'qrcode.react';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const fmtDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const fmtDay = (d) => {
  const s = String(d).slice(0, 10);
  const [y, mo, day] = s.split('-').map(Number);
  if (!y || !mo || !day) return fmtDate(d);
  return new Date(y, mo - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

export default function Bookings() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [cancellingId, setCancellingId] = useState(null);
  const [reviewingBooking, setReviewingBooking] = useState(null);
  const [reviewRating, setReviewRating] = useState(5);
  const [reviewText, setReviewText] = useState('');
  const [reviewSubmitting, setReviewSubmitting] = useState(false);
  const [reviewedRefs, setReviewedRefs] = useState([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [addrCopied, setAddrCopied] = useState(false);
  // Resume-signing for bookings whose escrow was never funded (deposit_status='pending').
  const [resumeModal, setResumeModal] = useState(null); // rebuild payload for the booking being resumed
  const [resumeStatus, setResumeStatus] = useState('idle'); // idle|loading|review|signing|submitting|confirming|done|error
  const [resumeError, setResumeError] = useState('');
  // BookingPass check-in: dynamic, wallet-signed presentation (rotating QR).
  const [passModal, setPassModal] = useState(null); // the booking whose pass is open
  const [passPayload, setPassPayload] = useState(''); // current signed payload (base64 JSON)
  const [passError, setPassError] = useState('');
  // Phase 2c resale: list-for-resale modal + the buyer marketplace.
  const [listModal, setListModal] = useState(null);   // booking being listed for resale
  const [listPrice, setListPrice] = useState('');     // seller's ask (dollars)
  const [resaleStatus, setResaleStatus] = useState('idle'); // idle|signing|submitting|confirming|done|error
  const [resaleError, setResaleError] = useState('');
  const [resaleBusyRef, setResaleBusyRef] = useState(null); // bookingRef with an in-flight cancel/buy
  const [marketOpen, setMarketOpen] = useState(false);
  const [market, setMarket] = useState([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const wallet = useWalletBalance(user?.address);
  // Plain wallet send (P3) — move SUI out of this ARIA wallet to any address,
  // no external Sui Wallet extension required (zkLogin already gives this
  // browser session full signing authority over the user's own funds).
  const [sendOpen, setSendOpen] = useState(false);
  const [sendToAddress, setSendToAddress] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [sendStatus, setSendStatus] = useState('idle'); // idle|signing|submitting|confirming|done|error
  const [sendError, setSendError] = useState('');
  const [sendDigest, setSendDigest] = useState('');

  const copyAddr = () => {
    navigator.clipboard.writeText(user?.address);
    setAddrCopied(true);
    setTimeout(() => setAddrCopied(false), 2000);
  };

  const openSend = () => {
    setSendError(''); setSendStatus('idle'); setSendDigest('');
    setSendToAddress(''); setSendAmount('');
    setSendOpen(true);
  };

  const submitSend = async () => {
    const to = sendToAddress.trim();
    const amt = Number(sendAmount);
    if (!to) { setSendError('Enter a recipient address.'); return; }
    if (!Number.isFinite(amt) || amt <= 0) { setSendError('Enter a valid amount.'); return; }
    setSendError('');
    try {
      setSendStatus('signing');
      const buildRes = await authFetch(`${API}/wallet/send/build`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toAddress: to, amount: sendAmount }),
      });
      const built = await buildRes.json();
      if (!buildRes.ok || !built.sendTxBytes) throw new Error(built.error || 'Could not prepare this transfer');
      const signature = await signTransactionWithZkLogin(fromBase64(built.sendTxBytes));
      setSendStatus('submitting');
      const digest = await submitSignedTransaction(built.sendTxBytes, signature);
      setSendStatus('confirming');
      const confirmRes = await authFetch(`${API}/wallet/send/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ digest, toAddress: to, amount: sendAmount }),
      });
      const confirmData = await confirmRes.json();
      if (!confirmRes.ok || !confirmData.success) {
        const msg = confirmData.error || 'Transfer could not be verified on-chain';
        throw new Error(confirmData.retryable ? `${msg} It may already have gone through — check your balance before retrying.` : msg);
      }
      setSendDigest(digest);
      setSendStatus('done');
      wallet.refresh();
    } catch (err) {
      console.error('Send failed:', err);
      setSendError(err.message || 'Could not complete this transfer.');
      setSendStatus('error');
    }
  };

  const handleSubmitReview = async () => {
    if (!reviewText.trim()) return;
    setReviewSubmitting(true);
    const res = await authFetch(`${API}/reviews/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        propertyId: reviewingBooking.propertyId,
        bookingRef: reviewingBooking.bookingRef,
        rating: reviewRating,
        review: reviewText.trim()
      })
    });
    const data = await res.json();
    if (data.success) {
      setReviewedRefs(prev => [...prev, reviewingBooking.bookingRef]);
      setReviewingBooking(null);
      setReviewText('');
      setReviewRating(5);
    }
    setReviewSubmitting(false);
  };

  const handleCancel = async (booking) => {
    const bookingRef = booking.bookingRef;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const checkInDate = new Date(booking.checkIn);
    const daysUntilCheckIn = Math.ceil((checkInDate - today) / (1000 * 60 * 60 * 24));
    const confirmMsg = daysUntilCheckIn >= 15
      ? 'Cancel this booking? It\'s 15+ days before check-in, so you\'ll receive a full refund of the stay cost. Your deposit is also released.'
      : 'Cancel this booking? You\'re within 14 days of check-in, so the stay cost (rental + ARIA fee + tax) is non-refundable — only your security deposit will be released. Consider listing it on the resale market instead to recover funds. Continue with cancellation?';
    if (!confirm(confirmMsg)) return;
    setCancellingId(bookingRef);
    const res = await authFetch(`${API}/booking/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bookingRef })
    });
    const data = await res.json();
    if (data.success) {
      const updated = await authFetch(`${API}/bookings/history`);
      const updatedData = await updated.json();
      setBookings(updatedData.bookings || []);
    }
    setCancellingId(null);
  };

  const refreshBookings = async () => {
    try {
      const res = await authFetch(`${API}/bookings/history`);
      const data = await res.json();
      setBookings(data.bookings || []);
    } catch {}
  };

  // ── Phase 2c resale: list / cancel-listing / buy ───────────────────────────
  // Each is the same non-custodial build → sign → submit → confirm path as a
  // fresh booking's escrow, just for the resale PTBs.
  const openList = (b) => { setResaleError(''); setResaleStatus('idle'); setListPrice(String(b.faceValue || '')); setListModal(b); };

  const submitListResale = async () => {
    const b = listModal;
    const ask = Number(listPrice);
    if (!b || !Number.isFinite(ask) || ask <= 0) { setResaleError('Enter a valid asking price.'); return; }
    setResaleError('');
    try {
      setResaleStatus('signing');
      const buildRes = await authFetch(`${API}/pass/${b.bookingRef}/list-resale`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ askPrice: ask }),
      });
      const built = await buildRes.json();
      if (!buildRes.ok) {
        const msg = built.error || 'Could not prepare the listing';
        throw new Error(built.retryable ? `${msg} Please try again in a moment.` : msg);
      }
      // Self-heal path: the backend detected this exact listing already
      // succeeded on-chain from an earlier attempt (e.g. confirm failed last
      // time after the tx had already landed) and reconciled it directly —
      // there's nothing left to sign.
      if (built.alreadyListed) {
        setResaleStatus('done');
        await refreshBookings();
        setTimeout(() => { setListModal(null); setResaleStatus('idle'); }, 1200);
        return;
      }
      if (!built.listTxBytes) throw new Error(built.error || 'Could not prepare the listing');
      const signature = await signTransactionWithZkLogin(fromBase64(built.listTxBytes));
      setResaleStatus('submitting');
      const digest = await submitSignedTransaction(built.listTxBytes, signature);
      setResaleStatus('confirming');
      const confirmRes = await authFetch(`${API}/pass/${b.bookingRef}/list-resale/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ digest, askPrice: ask }),
      });
      const confirmData = await confirmRes.json();
      if (!confirmRes.ok || !confirmData.success) {
        const msg = confirmData.error || 'Listing could not be verified on-chain';
        // Retryable (e.g. a transient RPC blip): the tx most likely already
        // succeeded on-chain. Clicking "List for Resale" again will re-check
        // on-chain state first and self-heal instead of rebuilding blind.
        throw new Error(confirmData.retryable
          ? `${msg} It may already be confirmed — try "List for Resale" again in a moment.`
          : msg);
      }
      setResaleStatus('done');
      await refreshBookings();
      setTimeout(() => { setListModal(null); setResaleStatus('idle'); }, 1200);
    } catch (err) {
      console.error('List for resale failed:', err);
      setResaleError(err.message || 'Could not list this booking.');
      setResaleStatus('error');
    }
  };

  const handleCancelListing = async (b) => {
    if (!confirm('Remove this booking from the resale market? Your check-in pass is reissued to you.')) return;
    setResaleBusyRef(b.bookingRef);
    try {
      const buildRes = await authFetch(`${API}/pass/${b.bookingRef}/cancel-resale`, { method: 'POST' });
      const built = await buildRes.json();
      if (!buildRes.ok) throw new Error(built.error || 'Could not prepare the cancellation');
      // Self-heal path — see submitListResale's comment above for why this
      // can happen and why there's nothing left to sign here.
      if (built.alreadyUnlisted) { await refreshBookings(); setResaleBusyRef(null); return; }
      if (!built.cancelTxBytes) throw new Error(built.error || 'Could not prepare the cancellation');
      const signature = await signTransactionWithZkLogin(fromBase64(built.cancelTxBytes));
      const digest = await submitSignedTransaction(built.cancelTxBytes, signature);
      const confirmRes = await authFetch(`${API}/pass/${b.bookingRef}/cancel-resale/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ digest }),
      });
      const confirmData = await confirmRes.json();
      if (!confirmRes.ok || !confirmData.success) {
        const msg = confirmData.error || 'Could not verify the cancellation';
        throw new Error(confirmData.retryable ? `${msg} Try again in a moment.` : msg);
      }
      await refreshBookings();
    } catch (err) {
      console.error('Cancel listing failed:', err);
      alert(err.message || 'Could not cancel the listing.');
    }
    setResaleBusyRef(null);
  };

  const loadMarket = async () => {
    setMarketLoading(true);
    try {
      const res = await authFetch(`${API}/resale/listings`);
      const data = await res.json();
      setMarket(data.listings || []);
    } catch { setMarket([]); }
    setMarketLoading(false);
  };

  const openMarket = () => { setMarketOpen(true); loadMarket(); };

  // Deep-link: /bookings?market=1 (e.g. the homepage "Resale Market" button) opens
  // the marketplace automatically once the user/session is ready.
  useEffect(() => {
    if (router.isReady && router.query.market === '1' && user && !marketOpen) openMarket();
  }, [router.isReady, user]);

  const buyListing = async (item) => {
    if (!confirm(`Buy ${item.property} for $${item.askPrice}? Identity verification is required and the host will see who's staying.`)) return;
    setResaleBusyRef(item.bookingRef);
    try {
      const buildRes = await authFetch(`${API}/pass/${item.bookingRef}/transfer/build`, { method: 'POST' });
      const built = await buildRes.json();
      if (buildRes.status === 400 && built.needsVerification) {
        alert('Complete identity verification first. Redirecting to your profile.');
        router.push('/profile');
        return;
      }
      if (!buildRes.ok || !built.buyTxBytes) throw new Error(built.error || 'Could not prepare the purchase');
      const signature = await signTransactionWithZkLogin(fromBase64(built.buyTxBytes));
      const digest = await submitSignedTransaction(built.buyTxBytes, signature);
      const confirmRes = await authFetch(`${API}/pass/${item.bookingRef}/transfer/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ digest }),
      });
      const confirmData = await confirmRes.json();
      if (!confirmRes.ok || !confirmData.success) throw new Error(confirmData.error || 'Purchase could not be verified on-chain');
      await Promise.all([refreshBookings(), loadMarket()]);
      alert('Booking purchased — it now appears in your bookings, and your check-in pass has been minted.');
    } catch (err) {
      console.error('Buy resale failed:', err);
      alert(err.message || 'Could not complete the purchase.');
    }
    setResaleBusyRef(null);
  };

  // Resume an unsigned booking: ask the backend to rebuild the escrow PTB, show
  // the pre-sign disclosure, then sign+submit+confirm — same path as a fresh
  // booking, just recovered from My Bookings.
  const handleResume = async (bookingRef) => {
    setResumeError('');
    setResumeStatus('loading');
    setResumeModal({ bookingRef });
    try {
      const res = await authFetch(`${API}/booking/${bookingRef}/escrow/rebuild`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not prepare this booking for signing');
      if (data.alreadyConfirmed) { await refreshBookings(); setResumeModal(null); setResumeStatus('idle'); return; }
      setResumeModal({ bookingRef, ...data });
      setResumeStatus('review');
    } catch (err) {
      setResumeError(err.message || 'Could not prepare this booking');
      setResumeStatus('error');
    }
  };

  const handleResumeSign = async () => {
    const m = resumeModal;
    if (!m?.escrowTxBytes) return;
    setResumeError('');
    try {
      setResumeStatus('signing');
      const signature = await signTransactionWithZkLogin(fromBase64(m.escrowTxBytes));
      setResumeStatus('submitting');
      const digest = await submitSignedTransaction(m.escrowTxBytes, signature);
      setResumeStatus('confirming');
      const confirmRes = await authFetch(`${API}/booking/${m.bookingRef}/escrow/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ digest }),
      });
      const confirmData = await confirmRes.json();
      if (!confirmRes.ok || !confirmData.success) throw new Error(confirmData.error || 'Escrow could not be verified on-chain');
      setResumeStatus('done');
      await refreshBookings();
      setTimeout(() => { setResumeModal(null); setResumeStatus('idle'); }, 1500);
    } catch (err) {
      console.error('Resume signing failed:', err);
      setResumeError(err.message || 'Could not complete the payment.');
      setResumeStatus('error');
    }
  };

  const openPass = (b) => { setPassPayload(''); setPassError(''); setPassModal(b); };
  const closePass = () => { setPassModal(null); setPassPayload(''); setPassError(''); };

  // While a pass is open, sign a FRESH check-in message every ~18s so the QR
  // rotates — a screenshot goes stale (the backend rejects an old timestamp).
  useEffect(() => {
    if (!passModal || !user?.address) return;
    let cancelled = false;
    const gen = async () => {
      try {
        const ts = Date.now();
        const nonce = (window.crypto?.randomUUID?.() || String(Math.random())).replace(/-/g, '').slice(0, 16);
        const message = new TextEncoder().encode(`ARIA-CHECKIN:${passModal.bookingRef}:${ts}:${nonce}`);
        const signature = await signPersonalMessageWithZkLogin(message);
        if (cancelled) return;
        setPassPayload(btoa(JSON.stringify({ bookingRef: passModal.bookingRef, ts, nonce, address: user.address, signature })));
        setPassError('');
      } catch (err) {
        if (!cancelled) setPassError(err.message || 'Could not generate your check-in pass');
      }
    };
    gen();
    const id = setInterval(gen, 18000);
    return () => { cancelled = true; clearInterval(id); };
  }, [passModal, user]);

  useEffect(() => {
    authFetch(`${API}/auth/me`)
      .then(res => res.json())
      .then(data => {
        if (!data.address) { router.push('/'); return; }
        setUser(data);
        return authFetch(`${API}/bookings/history`);
      })
      .then(res => res.json())
      .then(data => {
        setBookings(data.bookings || []);
        setLoading(false);
      })
      .catch(() => { router.push('/'); });
  }, []);

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#fff', color: '#222' }}>
      Loading your bookings...
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#fff', color: '#222' }}>
      <style>{`
        .bk-nav-desktop { display: flex; align-items: center; gap: 12px; }
        .bk-nav-hamburger { display: none !important; }
        .bk-stat-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 16px; }
        @media (max-width: 639px) {
          .bk-nav-desktop { display: none !important; }
          .bk-nav-hamburger { display: flex !important; align-items: center; gap: 8px; }
          .bk-breakdown-row { flex-direction: column !important; gap: 2px !important; align-items: flex-start !important; }
          .bk-breakdown-row span:last-child { text-align: left !important; }
        }
      `}</style>

      {/* Header */}
      <div style={{ background: '#fff', borderBottom: '1px solid #ebebeb', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '60px', position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span onClick={() => router.push('/')} style={{ fontSize: '20px', cursor: 'pointer' }}>🏠</span>
          <span style={{ fontWeight: '700', fontSize: '18px', cursor: 'pointer', color: '#ff385c' }} onClick={() => router.push('/')}>ARIA</span>
          <span style={{ background: '#222', color: '#fff', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px', marginLeft: '4px' }}>BETA</span>
        </div>
        {/* Desktop */}
        <div className="bk-nav-desktop">
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '13px', fontWeight: '500', color: '#222' }}>{user?.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end' }}>
              <div style={{ fontSize: '11px', color: '#717171', fontFamily: 'monospace', wordBreak: 'break-all' }}>{user?.address}</div>
              <button onClick={copyAddr} title="Copy address" style={{ background: 'none', border: 'none', cursor: 'pointer', color: addrCopied ? '#00913f' : '#999', fontSize: '12px', padding: '0 2px', flexShrink: 0 }}>
                {addrCopied ? '✓' : '⧉'}
              </button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', justifyContent: 'flex-end', marginTop: '2px' }}>
              <span style={{ fontSize: '11px', color: wallet.lowBalance ? '#d23f3f' : '#717171', fontWeight: '600' }}>
                {wallet.display ?? (wallet.loading ? '···' : '0 SUI')}
              </span>
              <button onClick={wallet.refresh} title="Refresh balance" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '11px', padding: 0 }}>↻</button>
              <button onClick={openSend} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1f6fd6', fontSize: '11px', fontWeight: '600', padding: 0, textDecoration: 'underline' }}>Send</button>
              {wallet.lowBalance && (
                <a href="https://faucet.sui.io/" target="_blank" rel="noreferrer" style={{ color: '#1f6fd6', fontSize: '11px', textDecoration: 'underline' }}>Get testnet SUI</a>
              )}
            </div>
          </div>
          <button onClick={() => router.push('/profile')}
            style={{ background: 'transparent', border: `1px solid ${user?.hasGuestProfile === false ? '#ffe7a0' : '#ddd'}`, color: user?.hasGuestProfile === false ? '#a66a00' : '#717171', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: user?.hasGuestProfile === false ? '600' : '400' }}>
            🪪 {user?.hasGuestProfile === false ? 'Verify Identity' : 'Identity'}
          </button>
          <button onClick={() => router.push('/')} style={{ background: 'transparent', border: '1px solid #ddd', color: '#717171', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>
            Back to Search
          </button>
        </div>
        {/* Mobile */}
        <div className="bk-nav-hamburger">
          <button onClick={copyAddr} title="Copy address" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: '3px' }}>
            <span style={{ fontSize: '11px', color: '#717171', fontFamily: 'monospace' }}>{user?.address?.slice(0, 6)}…{user?.address?.slice(-4)}</span>
            <span style={{ color: addrCopied ? '#00913f' : '#999', fontSize: '11px' }}>{addrCopied ? '✓' : '⧉'}</span>
          </button>
          <button onClick={() => setMenuOpen(o => !o)} style={{ background: 'transparent', border: '1px solid #ddd', color: '#222', borderRadius: '6px', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', cursor: 'pointer' }}>
            {menuOpen ? '×' : '☰'}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div style={{ background: '#fff', borderBottom: '1px solid #ebebeb', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '8px', position: 'sticky', top: '60px', zIndex: 99 }}>
          <div style={{ paddingBottom: '8px', borderBottom: '1px solid #ebebeb' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#222' }}>{user?.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
              <div style={{ fontSize: '11px', color: '#717171', fontFamily: 'monospace', wordBreak: 'break-all', flex: 1 }}>{user?.address}</div>
              <button onClick={copyAddr} title="Copy address" style={{ background: 'none', border: 'none', cursor: 'pointer', color: addrCopied ? '#00913f' : '#999', fontSize: '13px', padding: '0 2px', flexShrink: 0 }}>
                {addrCopied ? '✓' : '⧉'}
              </button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' }}>
              <span style={{ fontSize: '12px', color: wallet.lowBalance ? '#d23f3f' : '#717171', fontWeight: '600' }}>
                💰 {wallet.display ?? (wallet.loading ? '···' : '0 SUI')}
              </span>
              <button onClick={wallet.refresh} title="Refresh balance" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '12px', padding: 0 }}>↻</button>
              <button onClick={() => { setMenuOpen(false); openSend(); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1f6fd6', fontSize: '12px', fontWeight: '600', padding: 0, textDecoration: 'underline' }}>Send</button>
              {wallet.lowBalance && (
                <a href="https://faucet.sui.io/" target="_blank" rel="noreferrer" style={{ color: '#1f6fd6', fontSize: '12px', textDecoration: 'underline' }}>Get testnet SUI</a>
              )}
            </div>
          </div>
          <button onClick={() => { router.push('/profile'); setMenuOpen(false); }} style={{ background: '#f7f7f7', border: '1px solid #ebebeb', color: '#222', borderRadius: '8px', padding: '12px 16px', fontSize: '14px', textAlign: 'left', cursor: 'pointer' }}>
            🪪 {user?.hasGuestProfile === false ? 'Verify Identity' : 'Identity'}
          </button>
          <button onClick={() => { router.push('/'); setMenuOpen(false); }} style={{ background: '#f7f7f7', border: '1px solid #ebebeb', color: '#222', borderRadius: '8px', padding: '12px 16px', fontSize: '14px', textAlign: 'left', cursor: 'pointer' }}>
            🏠 Back to Search
          </button>
        </div>
      )}

      {/* Content */}
      <div style={{ maxWidth: '900px', margin: '0 auto', padding: '40px 24px' }}>
        <div style={{ marginBottom: '32px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '16px', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: '24px', fontWeight: '700', margin: '0 0 8px', color: '#222' }}>My Bookings</h1>
            <p style={{ color: '#717171', fontSize: '14px', margin: 0 }}>
              {bookings.length === 0 ? 'No bookings yet' : `${bookings.length} booking${bookings.length > 1 ? 's' : ''} found`}
            </p>
          </div>
          <button onClick={openMarket}
            style={{ background: 'transparent', border: '1px solid #ffe7a0', color: '#a66a00', padding: '10px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: '700', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            🏷️ Resale Market
          </button>
        </div>

        {bookings.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 24px', background: '#f7f7f7', borderRadius: '12px', border: '1px solid #ebebeb' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>🏖️</div>
            <h3 style={{ fontSize: '18px', fontWeight: '600', margin: '0 0 8px', color: '#222' }}>No bookings yet</h3>
            <p style={{ color: '#717171', fontSize: '14px', margin: '0 0 24px' }}>Your confirmed bookings will appear here</p>
            <button onClick={() => router.push('/')} style={{ background: '#ff385c', color: '#fff', border: 'none', borderRadius: '8px', padding: '12px 24px', fontWeight: '700', fontSize: '14px', cursor: 'pointer' }}>
              Find a property
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {bookings.map((b, i) => (
              <div key={i} style={{ background: '#fff', border: `1px solid ${b.paymentStatus === 'cancelled' ? '#f5d0d0' : '#ebebeb'}`, borderRadius: '12px', padding: '24px', opacity: b.paymentStatus === 'cancelled' ? 0.85 : 1, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
                  <div>
                    <h3 style={{ margin: '0 0 4px', fontSize: '18px', fontWeight: '600', color: '#222' }}>{b.property}</h3>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                      <span style={{
                        background: b.paymentStatus === 'cancelled' ? '#fdeeee' : '#eafaf0',
                        border: `1px solid ${b.paymentStatus === 'cancelled' ? '#f5d0d0' : '#c8ebd9'}`,
                        color: b.paymentStatus === 'cancelled' ? '#d23f3f' : '#00913f',
                        fontSize: '11px', fontWeight: '600', padding: '3px 10px', borderRadius: '20px'
                      }}>
                        {b.paymentStatus === 'cancelled' ? '✕ cancelled' : `✅ ${b.paymentStatus || 'confirmed'}`}
                      </span>
                      {b.depositAmount && b.paymentStatus !== 'cancelled' && (
                        // Bug fix: this used to render "🔒 Deposit held" for ANY
                        // non-released, non-cancelled booking — including ones
                        // whose escrow tx never actually got verified on-chain
                        // (depositStatus stays 'pending' until POST
                        // /booking/:ref/escrow/confirm succeeds against
                        // verifyEscrowTransaction). That misrepresented unverified
                        // deposits as "held in escrow". Now branches on the real
                        // depositStatus value instead of just != 'released'.
                        <span style={{
                          background: b.depositStatus === 'released' ? '#eafaf0' : b.depositStatus === 'held' ? '#eaf2fc' : '#fff8e1',
                          border: `1px solid ${b.depositStatus === 'released' ? '#c8ebd9' : b.depositStatus === 'held' ? '#cfe0f5' : '#ffe7a0'}`,
                          color: b.depositStatus === 'released' ? '#00913f' : b.depositStatus === 'held' ? '#1f6fd6' : '#a66a00',
                          fontSize: '11px', fontWeight: '600', padding: '3px 10px', borderRadius: '20px'
                        }}>
                          {b.depositStatus === 'released'
                            ? '🔓 Deposit returned'
                            : b.depositStatus === 'held'
                            ? `🔒 Deposit $${b.depositAmount} held`
                            : '⏳ Deposit not yet confirmed on-chain'}
                        </span>
                      )}
                      {b.bookingPassObjectId && (
                        <a href={`https://suiscan.xyz/testnet/object/${b.bookingPassObjectId}`} target="_blank" rel="noreferrer"
                          title="Your BookingPass — a soulbound NFT in your wallet"
                          style={{ background: '#f3e8ff', border: '1px solid #e0c8fa', color: '#8b3dff', fontSize: '11px', fontWeight: '600', padding: '3px 10px', borderRadius: '20px', textDecoration: 'none' }}>
                          🎫 BookingPass on-chain ↗
                        </a>
                      )}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '20px', fontWeight: '700', color: b.paymentStatus === 'cancelled' ? '#999' : '#00913f', textDecoration: b.paymentStatus === 'cancelled' ? 'line-through' : 'none' }}>
                      {b.chargeAmount ? `$${b.chargeAmount} SuiUSD` : b.breakdown?.totalPaid || `$${b.totalAmount}`}
                    </div>
                    <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>{b.paymentMethod || 'SuiUSD'}</div>
                  </div>
                </div>

                <div className="bk-stat-grid">
                  <div style={{ background: '#f7f7f7', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#999', marginBottom: '4px' }}>CHECK-IN</div>
                    <div style={{ fontSize: '14px', fontWeight: '600', color: '#222' }}>{fmtDay(b.checkIn)}</div>
                  </div>
                  <div style={{ background: '#f7f7f7', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#999', marginBottom: '4px' }}>CHECK-OUT</div>
                    <div style={{ fontSize: '14px', fontWeight: '600', color: '#222' }}>{fmtDay(b.checkOut)}</div>
                  </div>
                  <div style={{ background: '#f7f7f7', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#999', marginBottom: '4px' }}>NIGHTS</div>
                    <div style={{ fontSize: '14px', fontWeight: '600', color: '#222' }}>{b.nights}</div>
                  </div>
                  <div style={{ background: '#f7f7f7', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#999', marginBottom: '4px' }}>BOOKED ON</div>
                    <div style={{ fontSize: '14px', fontWeight: '600', color: '#222' }}>{fmtDate(b.timestamp)}</div>
                  </div>
                </div>

                {b.breakdown && (
                  <div style={{ background: '#f7f7f7', borderRadius: '8px', padding: '12px', marginBottom: '16px', fontSize: '13px', color: '#222' }}>
                    <div className="bk-breakdown-row" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ color: '#717171' }}>Price per night</span><span>{b.breakdown.pricePerNight}</span>
                    </div>
                    <div className="bk-breakdown-row" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ color: '#717171' }}>Subtotal</span><span>{b.breakdown.subtotal}</span>
                    </div>
                    <div className="bk-breakdown-row" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ color: '#717171' }}>ARIA fee (stay only)</span><span style={{ color: '#00913f' }}>{b.breakdown.ariaFee}</span>
                    </div>
                    <div className="bk-breakdown-row" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', paddingBottom: '8px', borderBottom: '1px solid #ddd' }}>
                      <span style={{ color: '#717171' }}>Taxes</span><span>{b.breakdown.taxes}</span>
                    </div>
                    <div className="bk-breakdown-row" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontWeight: '600' }}>
                      <span>Stay total</span><span style={{ color: '#00913f' }}>{b.breakdown.totalPaid}</span>
                    </div>
                    {b.depositAmount && (
                      <div className="bk-breakdown-row" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', paddingBottom: '8px', borderBottom: '1px solid #ddd' }}>
                        <span style={{ color: '#1f6fd6' }}>🔒 Refundable deposit (no ARIA fee)</span>
                        <span style={{ color: '#1f6fd6' }}>${b.depositAmount}</span>
                      </div>
                    )}
                    {b.chargeAmount && (
                      <div className="bk-breakdown-row" style={{ display: 'flex', justifyContent: 'space-between', fontWeight: '700' }}>
                        <span>Total charged</span><span style={{ color: '#222' }}>${b.chargeAmount} SuiUSD</span>
                      </div>
                    )}
                  </div>
                )}

                {b.paymentStatus === 'cancelled' && (b.walrusBlobId || b.cancellationWalrusBlobId) && (
                  <div style={{ background: '#f7f7f7', border: '1px solid #ebebeb', borderRadius: '8px', padding: '12px', marginBottom: '16px' }}>
                    <div style={{ fontSize: '10px', color: '#999', marginBottom: '10px', fontWeight: '600', letterSpacing: '0.08em' }}>ON-CHAIN AUDIT TRAIL</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {b.walrusBlobId && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '11px', color: '#717171' }}>📄 Booking receipt</span>
                          <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${b.walrusBlobId}`}
                            target="_blank" rel="noreferrer"
                            style={{ background: '#eafaf0', border: '1px solid #c8ebd9', color: '#00913f', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', textDecoration: 'none', fontWeight: '600', fontFamily: 'monospace' }}>
                            {b.walrusBlobId.slice(0, 12)}... ↗
                          </a>
                        </div>
                      )}
                      {b.cancellationWalrusBlobId && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '11px', color: '#717171' }}>❌ Cancellation receipt</span>
                          <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${b.cancellationWalrusBlobId}`}
                            target="_blank" rel="noreferrer"
                            style={{ background: '#fdeeee', border: '1px solid #f5d0d0', color: '#d23f3f', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', textDecoration: 'none', fontWeight: '600', fontFamily: 'monospace' }}>
                            {b.cancellationWalrusBlobId.slice(0, 12)}... ↗
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ fontSize: '11px', color: '#999', fontFamily: 'monospace' }}>Ref: {b.bookingRef}</div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    {b.paymentStatus !== 'cancelled' && b.depositStatus === 'pending' && (
                      <button
                        onClick={() => handleResume(b.bookingRef)}
                        style={{ background: '#00913f', border: 'none', color: '#fff', fontSize: '12px', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: '700' }}>
                        ✍️ Complete payment & sign
                      </button>
                    )}
                    {b.paymentStatus !== 'cancelled' && b.depositStatus === 'held' && (
                      <button
                        onClick={() => openPass(b)}
                        style={{ background: 'transparent', border: '1px solid #e0c8fa', color: '#8b3dff', fontSize: '12px', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}>
                        🎫 Check-in Pass
                      </button>
                    )}
                    {b.paymentStatus !== 'cancelled' && b.walrusBlobId && (
                      <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${b.walrusBlobId}`}
                        target="_blank" rel="noreferrer"
                        style={{ background: '#eafaf0', border: '1px solid #c8ebd9', color: '#00913f', fontSize: '11px', padding: '6px 12px', borderRadius: '6px', textDecoration: 'none', fontWeight: '600' }}>
                        🔗 View Walrus Receipt
                      </a>
                    )}
                    <button
                      onClick={() => router.push(`/messages?bookingRef=${b.bookingRef}&property=${encodeURIComponent(b.property)}`)}
                      style={{ background: 'transparent', border: '1px solid #cfe0f5', color: '#1f6fd6', fontSize: '12px', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}>
                      💬 Message Host
                    </button>
                    {b.paymentStatus !== 'cancelled' && !reviewedRefs.includes(b.bookingRef) && (
                      <button
                        onClick={() => { setReviewingBooking(b); setReviewRating(5); setReviewText(''); }}
                        style={{ background: 'transparent', border: '1px solid #e0c8fa', color: '#8b3dff', fontSize: '12px', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}>
                        ⭐ Leave a Review
                      </button>
                    )}
                    {reviewedRefs.includes(b.bookingRef) && (
                      <span style={{ color: '#8b3dff', fontSize: '12px', fontWeight: '600' }}>⭐ Reviewed</span>
                    )}
                    {b.resaleListed && b.paymentStatus !== 'cancelled' && (
                      <>
                        <span style={{ background: '#fff8e1', border: '1px solid #ffe7a0', color: '#a66a00', fontSize: '11px', padding: '6px 12px', borderRadius: '6px', fontWeight: '600' }}>
                          🏷️ Listed for ${b.resaleAskPrice}
                        </span>
                        <button
                          onClick={() => handleCancelListing(b)}
                          disabled={resaleBusyRef === b.bookingRef}
                          style={{ background: 'transparent', border: '1px solid #ffe7a0', color: resaleBusyRef === b.bookingRef ? '#999' : '#a66a00', fontSize: '12px', padding: '6px 12px', borderRadius: '6px', cursor: resaleBusyRef === b.bookingRef ? 'not-allowed' : 'pointer', fontWeight: '600' }}>
                          {resaleBusyRef === b.bookingRef ? 'Working…' : 'Remove Listing'}
                        </button>
                      </>
                    )}
                    {b.resaleable && !b.resaleListed && b.paymentStatus !== 'cancelled' && (
                      <button
                        onClick={() => openList(b)}
                        style={{ background: 'transparent', border: '1px solid #ffe7a0', color: '#a66a00', fontSize: '12px', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}>
                        🏷️ List for Resale
                      </button>
                    )}
                    {b.paymentStatus !== 'cancelled' ? (
                      <button
                        onClick={() => handleCancel(b)}
                        disabled={cancellingId === b.bookingRef}
                        style={{ background: 'transparent', border: '1px solid #f5d0d0', color: cancellingId === b.bookingRef ? '#999' : '#d23f3f', fontSize: '12px', padding: '6px 12px', borderRadius: '6px', cursor: cancellingId === b.bookingRef ? 'not-allowed' : 'pointer', fontWeight: '600' }}>
                        {cancellingId === b.bookingRef ? 'Cancelling...' : '✕ Cancel Booking'}
                      </button>
                    ) : (
                      <span style={{ background: '#fdeeee', border: '1px solid #f5d0d0', color: '#d23f3f', fontSize: '11px', padding: '6px 12px', borderRadius: '6px', fontWeight: '600' }}>
                        ✕ Cancelled
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Review Modal */}
      {reviewingBooking && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '24px' }}>
          <div style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '16px', width: '100%', maxWidth: '480px', padding: '32px', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: '700', color: '#222' }}>Leave a Review</h3>
            <p style={{ color: '#717171', fontSize: '14px', margin: '0 0 24px' }}>{reviewingBooking.property}</p>
            <div style={{ marginBottom: '20px' }}>
              <div style={{ fontSize: '13px', color: '#717171', marginBottom: '8px', fontWeight: '600' }}>YOUR RATING</div>
              <div style={{ display: 'flex', gap: '8px' }}>
                {[1,2,3,4,5].map(star => (
                  <button key={star} onClick={() => setReviewRating(star)}
                    style={{ background: 'none', border: 'none', fontSize: '32px', cursor: 'pointer', opacity: star <= reviewRating ? 1 : 0.3, transition: 'opacity 0.1s' }}>
                    ⭐
                  </button>
                ))}
              </div>
              <div style={{ fontSize: '13px', color: '#8b3dff', marginTop: '4px' }}>
                {['', 'Poor', 'Fair', 'Good', 'Great', 'Excellent'][reviewRating]}
              </div>
            </div>
            <div style={{ marginBottom: '24px' }}>
              <div style={{ fontSize: '13px', color: '#717171', marginBottom: '8px', fontWeight: '600' }}>YOUR REVIEW</div>
              <textarea
                value={reviewText}
                onChange={e => setReviewText(e.target.value)}
                placeholder="Share your experience with this property..."
                rows={4}
                style={{ width: '100%', background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '12px', color: '#222', fontSize: '14px', outline: 'none', resize: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => setReviewingBooking(null)}
                style={{ flex: 1, background: 'transparent', border: '1px solid #ddd', color: '#717171', borderRadius: '8px', padding: '12px', fontSize: '14px', cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={handleSubmitReview} disabled={reviewSubmitting || !reviewText.trim()}
                style={{ flex: 2, background: reviewSubmitting || !reviewText.trim() ? '#eee' : '#8b3dff', color: reviewSubmitting || !reviewText.trim() ? '#999' : '#fff', border: 'none', borderRadius: '8px', padding: '12px', fontSize: '14px', fontWeight: '700', cursor: reviewSubmitting || !reviewText.trim() ? 'not-allowed' : 'pointer' }}>
                {reviewSubmitting ? 'Submitting...' : 'Submit Review'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Resume-signing modal — complete payment for an unsigned booking */}
      {resumeModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '24px' }}>
          <div style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '16px', width: '100%', maxWidth: '460px', padding: '28px', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: '19px', fontWeight: '700', color: '#222' }}>Complete your booking</h3>
            <p style={{ color: '#717171', fontSize: '13px', margin: '0 0 16px' }}>{resumeModal.property || ''} · Ref {resumeModal.bookingRef}</p>

            {resumeStatus === 'loading' && (
              <div style={{ color: '#1f6fd6', fontSize: '13px', padding: '12px 0' }}>⏳ Preparing your transaction…</div>
            )}

            {resumeStatus === 'review' && resumeModal.paymentEscrowBuilt && (
              <div style={{ background: '#eaf2fc', border: '1px solid #cfe0f5', borderRadius: '8px', padding: '12px', marginBottom: '14px' }}>
                <div style={{ color: '#1f6fd6', fontWeight: 700, fontSize: '12px', marginBottom: '8px' }}>Review before you sign</div>
                {[
                  ['Rental → host', `$${resumeModal.subtotal}`, 'released to your host at check-in'],
                  ['ARIA fee (5%) → ARIA', `$${resumeModal.ariaFee}`, 'released at check-in'],
                  ['Taxes → tax remittance', `$${resumeModal.taxes}`, 'released at check-in'],
                  ['Refundable deposit → escrow', `$${resumeModal.depositAmount}`, 'returned after checkout'],
                ].map(([label, amt, note], i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '5px 0', borderBottom: i < 3 ? '1px solid #cfe0f5' : 'none' }}>
                    <div><div style={{ color: '#222', fontSize: '12px' }}>{label}</div><div style={{ color: '#717171', fontSize: '10px' }}>{note}</div></div>
                    <div style={{ color: '#222', fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap', paddingLeft: '10px' }}>{amt}</div>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #cfe0f5' }}>
                  <span style={{ color: '#222', fontSize: '12px', fontWeight: 700 }}>Total you sign for</span>
                  <span style={{ color: '#00913f', fontSize: '13px', fontWeight: 800 }}>${resumeModal.chargeAmount} SuiUSD</span>
                </div>
                <p style={{ color: '#717171', fontSize: '10px', lineHeight: 1.5, margin: '8px 0 0' }}>
                  Cancel 15+ days before check-in for a full refund of everything above. Inside 14 days of check-in, the stay cost is non-refundable — list it on the resale market instead. Funds sit in smart-contract escrow — never in an ARIA wallet.
                </p>
              </div>
            )}
            {resumeStatus === 'review' && !resumeModal.paymentEscrowBuilt && (
              <div style={{ color: '#1f6fd6', fontSize: '12px', marginBottom: '14px' }}>
                🔒 Sign to lock your ${resumeModal.depositAmount} refundable deposit in Sui escrow.
              </div>
            )}

            {['signing', 'submitting', 'confirming', 'done'].includes(resumeStatus) && (
              <div style={{ color: '#1f6fd6', fontSize: '12px', margin: '8px 0' }}>
                {resumeStatus === 'signing' && '🔏 Sign the transaction in your wallet…'}
                {resumeStatus === 'submitting' && '📡 Submitting to Sui…'}
                {resumeStatus === 'confirming' && '⏳ Confirming on-chain…'}
                {resumeStatus === 'done' && '✅ Payment escrowed — your booking is fully confirmed!'}
              </div>
            )}
            {resumeStatus === 'error' && (
              <div style={{ background: '#fdeeee', border: '1px solid #f5d0d0', borderRadius: '8px', padding: '10px', color: '#d23f3f', fontSize: '12px', marginBottom: '12px' }}>⚠️ {resumeError}</div>
            )}

            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              <button onClick={() => { setResumeModal(null); setResumeStatus('idle'); setResumeError(''); }}
                disabled={['signing', 'submitting', 'confirming'].includes(resumeStatus)}
                style={{ flex: 1, background: 'transparent', border: '1px solid #ddd', color: '#717171', borderRadius: '8px', padding: '11px', fontSize: '13px', cursor: 'pointer' }}>
                Close
              </button>
              {(resumeStatus === 'review' || resumeStatus === 'error') && resumeModal.escrowTxBytes && (
                <button onClick={handleResumeSign}
                  style={{ flex: 2, background: '#00913f', border: 'none', color: '#fff', borderRadius: '8px', padding: '11px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>
                  {resumeStatus === 'error' ? 'Retry' : 'Approve & sign in wallet'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* BookingPass — dynamic, wallet-signed check-in pass (rotating QR) */}
      {passModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '24px' }}>
          <div style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '16px', width: '100%', maxWidth: '380px', padding: '24px', textAlign: 'center', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <h3 style={{ margin: '0 0 2px', fontSize: '18px', fontWeight: '700', color: '#222' }}>🎫 Check-in Pass</h3>
            <p style={{ color: '#717171', fontSize: '12px', margin: '0 0 16px' }}>{passModal.property} · {fmtDay(passModal.checkIn)} → {fmtDay(passModal.checkOut)}</p>

            {passError ? (
              <div style={{ background: '#fdeeee', border: '1px solid #f5d0d0', borderRadius: '8px', padding: '12px', color: '#d23f3f', fontSize: '12px' }}>⚠️ {passError}</div>
            ) : passPayload ? (
              <>
                <div style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '12px', padding: '14px', display: 'inline-block' }}>
                  <QRCodeSVG value={passPayload} size={216} level="M" />
                </div>
                <div style={{ color: '#8b3dff', fontSize: '12px', fontWeight: 600, margin: '14px 0 4px' }}>🔄 Refreshes automatically — present at check-in</div>
                <p style={{ color: '#717171', fontSize: '10px', lineHeight: 1.5, margin: '0 0 12px' }}>
                  Signed by your wallet, live. A screenshot won't work — the code rotates so only the real, present holder verifies.
                </p>
                <details style={{ textAlign: 'left' }}>
                  <summary style={{ color: '#717171', fontSize: '11px', cursor: 'pointer' }}>Show code (for a paste-in scanner)</summary>
                  <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                    <code style={{ flex: 1, background: '#f7f7f7', border: '1px solid #ddd', borderRadius: '6px', padding: '6px', color: '#222', fontSize: '9px', wordBreak: 'break-all', maxHeight: '60px', overflow: 'auto' }}>{passPayload}</code>
                    <button onClick={() => navigator.clipboard?.writeText(passPayload)}
                      style={{ background: 'transparent', border: '1px solid #ddd', color: '#717171', borderRadius: '6px', padding: '4px 8px', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' }}>Copy</button>
                  </div>
                </details>
              </>
            ) : (
              <div style={{ color: '#8b3dff', fontSize: '13px', padding: '40px 0' }}>🔏 Signing your pass…</div>
            )}

            <button onClick={closePass}
              style={{ width: '100%', marginTop: '16px', background: 'transparent', border: '1px solid #ddd', color: '#717171', borderRadius: '8px', padding: '11px', fontSize: '13px', cursor: 'pointer' }}>
              Close
            </button>
          </div>
        </div>
      )}

      {/* Send funds modal — plain SUI transfer out of this wallet, no external wallet needed */}
      {sendOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '24px' }}>
          <div style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '16px', width: '100%', maxWidth: '440px', padding: '32px', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: '700', color: '#222' }}>💸 Send SUI</h3>
            <p style={{ color: '#717171', fontSize: '13px', margin: '0 0 20px' }}>
              From your ARIA wallet ({wallet.display ?? '0 SUI'} available) to any Sui address — your own Sui Wallet, an exchange, anywhere.
            </p>
            {sendStatus === 'done' ? (
              <>
                <div style={{ background: '#eafaf0', border: '1px solid #c8ecd9', borderRadius: '8px', padding: '14px', marginBottom: '20px', fontSize: '13px', color: '#00913f' }}>
                  ✓ Sent. <a href={`https://suiscan.xyz/testnet/tx/${sendDigest}`} target="_blank" rel="noreferrer" style={{ color: '#00913f', textDecoration: 'underline' }}>View on explorer</a>
                </div>
                <button onClick={() => setSendOpen(false)} style={{ width: '100%', background: '#222', color: '#fff', border: 'none', borderRadius: '8px', padding: '11px', fontSize: '13px', fontWeight: '700', cursor: 'pointer' }}>Done</button>
              </>
            ) : (
              <>
                <label style={{ fontSize: '12px', color: '#717171', fontWeight: '600' }}>RECIPIENT ADDRESS</label>
                <input type="text" placeholder="0x…" value={sendToAddress} onChange={e => setSendToAddress(e.target.value)}
                  disabled={['signing','submitting','confirming'].includes(sendStatus)}
                  style={{ width: '100%', marginTop: '6px', marginBottom: '14px', background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '10px 12px', color: '#222', fontSize: '13px', outline: 'none', boxSizing: 'border-box', fontFamily: 'monospace' }} />
                <label style={{ fontSize: '12px', color: '#717171', fontWeight: '600' }}>AMOUNT (SUI)</label>
                <input type="number" min="0" step="0.0001" placeholder="0.00" value={sendAmount} onChange={e => setSendAmount(e.target.value)}
                  disabled={['signing','submitting','confirming'].includes(sendStatus)}
                  style={{ width: '100%', marginTop: '6px', marginBottom: '8px', background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '10px 12px', color: '#222', fontSize: '15px', outline: 'none', boxSizing: 'border-box' }} />
                <p style={{ color: '#999', fontSize: '11px', margin: '0 0 16px' }}>Leave a little SUI behind to cover gas on future transactions.</p>
                {sendError && <p style={{ color: '#d23f3f', fontSize: '12px', margin: '0 0 12px' }}>{sendError}</p>}
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button onClick={() => setSendOpen(false)}
                    disabled={['signing','submitting','confirming'].includes(sendStatus)}
                    style={{ flex: 1, background: 'transparent', border: '1px solid #ddd', color: '#717171', borderRadius: '8px', padding: '11px', fontSize: '13px', cursor: 'pointer' }}>
                    Cancel
                  </button>
                  <button onClick={submitSend}
                    disabled={['signing','submitting','confirming'].includes(sendStatus)}
                    style={{ flex: 2, background: '#222', color: '#fff', border: 'none', borderRadius: '8px', padding: '11px', fontSize: '13px', fontWeight: '700', cursor: 'pointer' }}>
                    {sendStatus === 'signing' ? 'Sign in wallet…' : sendStatus === 'submitting' ? 'Submitting…' : sendStatus === 'confirming' ? 'Confirming…' : 'Send'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* List-for-resale modal */}
      {listModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '24px' }}>
          <div style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '16px', width: '100%', maxWidth: '460px', padding: '32px', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: '700', color: '#222' }}>🏷️ List for Resale</h3>
            <p style={{ color: '#717171', fontSize: '14px', margin: '0 0 20px' }}>{listModal.property}</p>
            <div style={{ background: '#f7f7f7', border: '1px solid #ebebeb', borderRadius: '8px', padding: '14px', marginBottom: '16px', fontSize: '12px', color: '#717171', lineHeight: 1.6 }}>
              You paid <span style={{ color: '#222' }}>${listModal.faceValue}</span> (face value). On a sale, you always keep the full face; any markup splits <span style={{ color: '#a66a00' }}>ARIA 10% · host 45% · you 45%</span>. Listing burns your check-in pass until you sell or cancel.
            </div>
            <label style={{ fontSize: '12px', color: '#717171', fontWeight: '600' }}>ASKING PRICE (USD)</label>
            <input type="number" min={listModal.faceValue} value={listPrice} onChange={e => setListPrice(e.target.value)}
              style={{ width: '100%', marginTop: '6px', marginBottom: '8px', background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '10px 12px', color: '#222', fontSize: '15px', outline: 'none', boxSizing: 'border-box' }} />
            <p style={{ color: '#999', fontSize: '11px', margin: '0 0 16px' }}>Minimum ${listModal.faceValue}. The host's price cap is enforced on-chain.</p>
            {resaleError && <p style={{ color: '#d23f3f', fontSize: '12px', margin: '0 0 12px' }}>{resaleError}</p>}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button onClick={() => { setListModal(null); setResaleStatus('idle'); }}
                disabled={['signing','submitting','confirming'].includes(resaleStatus)}
                style={{ flex: 1, background: 'transparent', border: '1px solid #ddd', color: '#717171', borderRadius: '8px', padding: '11px', fontSize: '13px', cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={submitListResale}
                disabled={['signing','submitting','confirming','done'].includes(resaleStatus)}
                style={{ flex: 2, background: resaleStatus === 'done' ? '#eafaf0' : '#a66a00', color: resaleStatus === 'done' ? '#00913f' : '#fff', border: 'none', borderRadius: '8px', padding: '11px', fontSize: '13px', fontWeight: '700', cursor: 'pointer' }}>
                {resaleStatus === 'signing' ? 'Sign in wallet…' : resaleStatus === 'submitting' ? 'Submitting…' : resaleStatus === 'confirming' ? 'Confirming…' : resaleStatus === 'done' ? '✓ Listed' : 'List for Resale'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Buyer resale marketplace */}
      {marketOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 100, padding: '24px', overflowY: 'auto' }}>
          <div style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '16px', width: '100%', maxWidth: '640px', padding: '32px', margin: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <h3 style={{ margin: 0, fontSize: '20px', fontWeight: '700', color: '#222' }}>🏷️ Resale Market</h3>
              <button onClick={() => setMarketOpen(false)} style={{ background: 'transparent', border: 'none', color: '#717171', fontSize: '22px', cursor: 'pointer', lineHeight: 1 }}>×</button>
            </div>
            <p style={{ color: '#717171', fontSize: '13px', margin: '0 0 20px' }}>Verified, capped resales. Buying requires identity verification — the host will know who's staying.</p>
            {marketLoading ? (
              <div style={{ color: '#717171', fontSize: '13px', padding: '30px 0', textAlign: 'center' }}>Loading listings…</div>
            ) : market.length === 0 ? (
              <div style={{ color: '#717171', fontSize: '13px', padding: '30px 0', textAlign: 'center' }}>No bookings are listed for resale right now.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {market.map(item => (
                  <div key={item.bookingRef} style={{ background: '#f7f7f7', border: '1px solid #ebebeb', borderRadius: '10px', padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: '700', fontSize: '15px', color: '#222' }}>{item.property}</div>
                      <div style={{ color: '#717171', fontSize: '12px', margin: '4px 0' }}>{fmtDay(item.checkIn)} → {fmtDay(item.checkOut)} · {item.nights} night{item.nights > 1 ? 's' : ''}</div>
                      <div style={{ fontSize: '12px', color: '#717171' }}>
                        Face ${item.faceValue}{item.upcharge > 0 && <span style={{ color: '#a66a00' }}> · +${item.upcharge} markup</span>}
                        {item.sellerFlips > 0 && <span style={{ color: '#d23f3f', marginLeft: '8px' }} title="Times this seller has resold without staying">⚠ {item.sellerFlips} prior flip{item.sellerFlips > 1 ? 's' : ''}</span>}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: '700', fontSize: '18px', color: '#00913f', marginBottom: '6px' }}>${item.askPrice}</div>
                      {item.isOwnListing ? (
                        <span style={{ color: '#717171', fontSize: '12px' }}>Your listing</span>
                      ) : (
                        <button onClick={() => buyListing(item)} disabled={resaleBusyRef === item.bookingRef}
                          style={{ background: resaleBusyRef === item.bookingRef ? '#eee' : '#00913f', color: resaleBusyRef === item.bookingRef ? '#999' : '#fff', border: 'none', borderRadius: '8px', padding: '9px 18px', fontSize: '13px', fontWeight: '700', cursor: resaleBusyRef === item.bookingRef ? 'not-allowed' : 'pointer' }}>
                          {resaleBusyRef === item.bookingRef ? 'Working…' : 'Buy'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
