import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { authFetch } from '../lib/authFetch';
import { signTransactionWithZkLogin, submitSignedTransaction, signPersonalMessageWithZkLogin } from '../lib/zklogin';
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

  const copyAddr = () => {
    navigator.clipboard.writeText(user?.address);
    setAddrCopied(true);
    setTimeout(() => setAddrCopied(false), 2000);
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

  const handleCancel = async (bookingRef) => {
    if (!confirm('Cancel this booking? You will receive a full refund within 24 hours.')) return;
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
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a0a', color: '#fff' }}>
      Loading your bookings...
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#fff' }}>
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
      <div style={{ background: '#111', borderBottom: '1px solid #222', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '60px', position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span onClick={() => router.push('/')} style={{ fontSize: '20px', cursor: 'pointer' }}>🏠</span>
          <span style={{ fontWeight: '700', fontSize: '18px', cursor: 'pointer' }} onClick={() => router.push('/')}>ARIA</span>
          <span style={{ background: '#00ff44', color: '#000', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px', marginLeft: '4px' }}>BETA</span>
        </div>
        {/* Desktop */}
        <div className="bk-nav-desktop">
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '13px', fontWeight: '500' }}>{user?.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end' }}>
              <div style={{ fontSize: '11px', color: '#00ff44', fontFamily: 'monospace', wordBreak: 'break-all' }}>{user?.address}</div>
              <button onClick={copyAddr} title="Copy address" style={{ background: 'none', border: 'none', cursor: 'pointer', color: addrCopied ? '#00ff44' : '#555', fontSize: '12px', padding: '0 2px', flexShrink: 0 }}>
                {addrCopied ? '✓' : '⧉'}
              </button>
            </div>
          </div>
          <button onClick={() => router.push('/')} style={{ background: 'transparent', border: '1px solid #333', color: '#888', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>
            Back to Search
          </button>
        </div>
        {/* Mobile */}
        <div className="bk-nav-hamburger">
          <button onClick={copyAddr} title="Copy address" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: '3px' }}>
            <span style={{ fontSize: '11px', color: '#00ff44', fontFamily: 'monospace' }}>{user?.address?.slice(0, 6)}…{user?.address?.slice(-4)}</span>
            <span style={{ color: addrCopied ? '#00ff44' : '#555', fontSize: '11px' }}>{addrCopied ? '✓' : '⧉'}</span>
          </button>
          <button onClick={() => setMenuOpen(o => !o)} style={{ background: 'transparent', border: '1px solid #333', color: '#fff', borderRadius: '6px', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', cursor: 'pointer' }}>
            {menuOpen ? '×' : '☰'}
          </button>
        </div>
      </div>

      {menuOpen && (
        <div style={{ background: '#111', borderBottom: '1px solid #222', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '8px', position: 'sticky', top: '60px', zIndex: 99 }}>
          <div style={{ paddingBottom: '8px', borderBottom: '1px solid #1a1a1a' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#fff' }}>{user?.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
              <div style={{ fontSize: '11px', color: '#00ff44', fontFamily: 'monospace', wordBreak: 'break-all', flex: 1 }}>{user?.address}</div>
              <button onClick={copyAddr} title="Copy address" style={{ background: 'none', border: 'none', cursor: 'pointer', color: addrCopied ? '#00ff44' : '#555', fontSize: '13px', padding: '0 2px', flexShrink: 0 }}>
                {addrCopied ? '✓' : '⧉'}
              </button>
            </div>
          </div>
          <button onClick={() => { router.push('/'); setMenuOpen(false); }} style={{ background: '#1a1a1a', border: '1px solid #2a2a2a', color: '#fff', borderRadius: '8px', padding: '12px 16px', fontSize: '14px', textAlign: 'left', cursor: 'pointer' }}>
            🏠 Back to Search
          </button>
        </div>
      )}

      {/* Content */}
      <div style={{ maxWidth: '900px', margin: '0 auto', padding: '40px 24px' }}>
        <div style={{ marginBottom: '32px' }}>
          <h1 style={{ fontSize: '24px', fontWeight: '700', margin: '0 0 8px' }}>My Bookings</h1>
          <p style={{ color: '#666', fontSize: '14px', margin: 0 }}>
            {bookings.length === 0 ? 'No bookings yet' : `${bookings.length} booking${bookings.length > 1 ? 's' : ''} found`}
          </p>
        </div>

        {bookings.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 24px', background: '#111', borderRadius: '12px', border: '1px solid #222' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>🏖️</div>
            <h3 style={{ fontSize: '18px', fontWeight: '600', margin: '0 0 8px' }}>No bookings yet</h3>
            <p style={{ color: '#666', fontSize: '14px', margin: '0 0 24px' }}>Your confirmed bookings will appear here</p>
            <button onClick={() => router.push('/')} style={{ background: '#00ff44', color: '#000', border: 'none', borderRadius: '8px', padding: '12px 24px', fontWeight: '700', fontSize: '14px', cursor: 'pointer' }}>
              Find a property
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {bookings.map((b, i) => (
              <div key={i} style={{ background: '#111', border: `1px solid ${b.paymentStatus === 'cancelled' ? '#2a1a1a' : '#222'}`, borderRadius: '12px', padding: '24px', opacity: b.paymentStatus === 'cancelled' ? 0.85 : 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
                  <div>
                    <h3 style={{ margin: '0 0 4px', fontSize: '18px', fontWeight: '600' }}>{b.property}</h3>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                      <span style={{
                        background: b.paymentStatus === 'cancelled' ? '#1a0a0a' : '#0a1a0a',
                        border: `1px solid ${b.paymentStatus === 'cancelled' ? '#3a1a1a' : '#1a3a1a'}`,
                        color: b.paymentStatus === 'cancelled' ? '#ff4444' : '#00ff44',
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
                          background: b.depositStatus === 'released' ? '#0a1a0a' : b.depositStatus === 'held' ? '#0a0a1a' : '#1a1505',
                          border: `1px solid ${b.depositStatus === 'released' ? '#1a3a1a' : b.depositStatus === 'held' ? '#1a1a3a' : '#3a2f0a'}`,
                          color: b.depositStatus === 'released' ? '#00ff44' : b.depositStatus === 'held' ? '#4a9eff' : '#ffb84a',
                          fontSize: '11px', fontWeight: '600', padding: '3px 10px', borderRadius: '20px'
                        }}>
                          {b.depositStatus === 'released'
                            ? '🔓 Deposit returned'
                            : b.depositStatus === 'held'
                            ? `🔒 Deposit $${b.depositAmount} held`
                            : '⏳ Deposit not yet confirmed on-chain'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '20px', fontWeight: '700', color: b.paymentStatus === 'cancelled' ? '#555' : '#00ff44', textDecoration: b.paymentStatus === 'cancelled' ? 'line-through' : 'none' }}>
                      {b.chargeAmount ? `$${b.chargeAmount} SuiUSD` : b.breakdown?.totalPaid || `$${b.totalAmount}`}
                    </div>
                    <div style={{ fontSize: '11px', color: '#555', marginTop: '2px' }}>{b.paymentMethod || 'SuiUSD'}</div>
                  </div>
                </div>

                <div className="bk-stat-grid">
                  <div style={{ background: '#1a1a1a', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#555', marginBottom: '4px' }}>CHECK-IN</div>
                    <div style={{ fontSize: '14px', fontWeight: '600' }}>{fmtDay(b.checkIn)}</div>
                  </div>
                  <div style={{ background: '#1a1a1a', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#555', marginBottom: '4px' }}>CHECK-OUT</div>
                    <div style={{ fontSize: '14px', fontWeight: '600' }}>{fmtDay(b.checkOut)}</div>
                  </div>
                  <div style={{ background: '#1a1a1a', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#555', marginBottom: '4px' }}>NIGHTS</div>
                    <div style={{ fontSize: '14px', fontWeight: '600' }}>{b.nights}</div>
                  </div>
                  <div style={{ background: '#1a1a1a', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#555', marginBottom: '4px' }}>BOOKED ON</div>
                    <div style={{ fontSize: '14px', fontWeight: '600' }}>{fmtDate(b.timestamp)}</div>
                  </div>
                </div>

                {b.breakdown && (
                  <div style={{ background: '#1a1a1a', borderRadius: '8px', padding: '12px', marginBottom: '16px', fontSize: '13px' }}>
                    <div className="bk-breakdown-row" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ color: '#888' }}>Price per night</span><span>{b.breakdown.pricePerNight}</span>
                    </div>
                    <div className="bk-breakdown-row" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ color: '#888' }}>Subtotal</span><span>{b.breakdown.subtotal}</span>
                    </div>
                    <div className="bk-breakdown-row" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ color: '#888' }}>ARIA fee (stay only)</span><span style={{ color: '#00ff44' }}>{b.breakdown.ariaFee}</span>
                    </div>
                    <div className="bk-breakdown-row" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', paddingBottom: '8px', borderBottom: '1px solid #333' }}>
                      <span style={{ color: '#888' }}>Taxes</span><span>{b.breakdown.taxes}</span>
                    </div>
                    <div className="bk-breakdown-row" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontWeight: '600' }}>
                      <span>Stay total</span><span style={{ color: '#00ff44' }}>{b.breakdown.totalPaid}</span>
                    </div>
                    {b.depositAmount && (
                      <div className="bk-breakdown-row" style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', paddingBottom: '8px', borderBottom: '1px solid #333' }}>
                        <span style={{ color: '#4a9eff' }}>🔒 Refundable deposit (no ARIA fee)</span>
                        <span style={{ color: '#4a9eff' }}>${b.depositAmount}</span>
                      </div>
                    )}
                    {b.chargeAmount && (
                      <div className="bk-breakdown-row" style={{ display: 'flex', justifyContent: 'space-between', fontWeight: '700' }}>
                        <span>Total charged</span><span style={{ color: '#fff' }}>${b.chargeAmount} SuiUSD</span>
                      </div>
                    )}
                  </div>
                )}

                {b.paymentStatus === 'cancelled' && (b.walrusBlobId || b.cancellationWalrusBlobId) && (
                  <div style={{ background: '#0d0d0d', border: '1px solid #1a1a1a', borderRadius: '8px', padding: '12px', marginBottom: '16px' }}>
                    <div style={{ fontSize: '10px', color: '#555', marginBottom: '10px', fontWeight: '600', letterSpacing: '0.08em' }}>ON-CHAIN AUDIT TRAIL</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      {b.walrusBlobId && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '11px', color: '#555' }}>📄 Booking receipt</span>
                          <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${b.walrusBlobId}`}
                            target="_blank" rel="noreferrer"
                            style={{ background: '#0a1a0a', border: '1px solid #1a3a1a', color: '#00ff44', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', textDecoration: 'none', fontWeight: '600', fontFamily: 'monospace' }}>
                            {b.walrusBlobId.slice(0, 12)}... ↗
                          </a>
                        </div>
                      )}
                      {b.cancellationWalrusBlobId && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '11px', color: '#555' }}>❌ Cancellation receipt</span>
                          <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${b.cancellationWalrusBlobId}`}
                            target="_blank" rel="noreferrer"
                            style={{ background: '#1a0a0a', border: '1px solid #3a1a1a', color: '#ff6666', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', textDecoration: 'none', fontWeight: '600', fontFamily: 'monospace' }}>
                            {b.cancellationWalrusBlobId.slice(0, 12)}... ↗
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ fontSize: '11px', color: '#555', fontFamily: 'monospace' }}>Ref: {b.bookingRef}</div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                    {b.paymentStatus !== 'cancelled' && b.depositStatus === 'pending' && (
                      <button
                        onClick={() => handleResume(b.bookingRef)}
                        style={{ background: '#00ff44', border: 'none', color: '#000', fontSize: '12px', padding: '6px 14px', borderRadius: '6px', cursor: 'pointer', fontWeight: '700' }}>
                        ✍️ Complete payment & sign
                      </button>
                    )}
                    {b.paymentStatus !== 'cancelled' && b.depositStatus === 'held' && (
                      <button
                        onClick={() => openPass(b)}
                        style={{ background: 'transparent', border: '1px solid #2a2a3a', color: '#a98aff', fontSize: '12px', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}>
                        🎫 Check-in Pass
                      </button>
                    )}
                    {b.paymentStatus !== 'cancelled' && b.walrusBlobId && (
                      <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${b.walrusBlobId}`}
                        target="_blank" rel="noreferrer"
                        style={{ background: '#0a1a0a', border: '1px solid #1a3a1a', color: '#00ff44', fontSize: '11px', padding: '6px 12px', borderRadius: '6px', textDecoration: 'none', fontWeight: '600' }}>
                        🔗 View Walrus Receipt
                      </a>
                    )}
                    <button
                      onClick={() => router.push(`/messages?bookingRef=${b.bookingRef}&property=${encodeURIComponent(b.property)}`)}
                      style={{ background: 'transparent', border: '1px solid #1a1a3a', color: '#4a9eff', fontSize: '12px', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}>
                      💬 Message Host
                    </button>
                    {b.paymentStatus !== 'cancelled' && !reviewedRefs.includes(b.bookingRef) && (
                      <button
                        onClick={() => { setReviewingBooking(b); setReviewRating(5); setReviewText(''); }}
                        style={{ background: 'transparent', border: '1px solid #2a1a3a', color: '#aa44ff', fontSize: '12px', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}>
                        ⭐ Leave a Review
                      </button>
                    )}
                    {reviewedRefs.includes(b.bookingRef) && (
                      <span style={{ color: '#aa44ff', fontSize: '12px', fontWeight: '600' }}>⭐ Reviewed</span>
                    )}
                    {b.paymentStatus !== 'cancelled' ? (
                      <button
                        onClick={() => handleCancel(b.bookingRef)}
                        disabled={cancellingId === b.bookingRef}
                        style={{ background: 'transparent', border: '1px solid #441a1a', color: cancellingId === b.bookingRef ? '#555' : '#ff4444', fontSize: '12px', padding: '6px 12px', borderRadius: '6px', cursor: cancellingId === b.bookingRef ? 'not-allowed' : 'pointer', fontWeight: '600' }}>
                        {cancellingId === b.bookingRef ? 'Cancelling...' : '✕ Cancel Booking'}
                      </button>
                    ) : (
                      <span style={{ background: '#1a0a0a', border: '1px solid #3a1a1a', color: '#ff4444', fontSize: '11px', padding: '6px 12px', borderRadius: '6px', fontWeight: '600' }}>
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
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '24px' }}>
          <div style={{ background: '#111', border: '1px solid #333', borderRadius: '16px', width: '100%', maxWidth: '480px', padding: '32px' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: '700' }}>Leave a Review</h3>
            <p style={{ color: '#666', fontSize: '14px', margin: '0 0 24px' }}>{reviewingBooking.property}</p>
            <div style={{ marginBottom: '20px' }}>
              <div style={{ fontSize: '13px', color: '#888', marginBottom: '8px', fontWeight: '600' }}>YOUR RATING</div>
              <div style={{ display: 'flex', gap: '8px' }}>
                {[1,2,3,4,5].map(star => (
                  <button key={star} onClick={() => setReviewRating(star)}
                    style={{ background: 'none', border: 'none', fontSize: '32px', cursor: 'pointer', opacity: star <= reviewRating ? 1 : 0.3, transition: 'opacity 0.1s' }}>
                    ⭐
                  </button>
                ))}
              </div>
              <div style={{ fontSize: '13px', color: '#aa44ff', marginTop: '4px' }}>
                {['', 'Poor', 'Fair', 'Good', 'Great', 'Excellent'][reviewRating]}
              </div>
            </div>
            <div style={{ marginBottom: '24px' }}>
              <div style={{ fontSize: '13px', color: '#888', marginBottom: '8px', fontWeight: '600' }}>YOUR REVIEW</div>
              <textarea
                value={reviewText}
                onChange={e => setReviewText(e.target.value)}
                placeholder="Share your experience with this property..."
                rows={4}
                style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', borderRadius: '8px', padding: '12px', color: '#fff', fontSize: '14px', outline: 'none', resize: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => setReviewingBooking(null)}
                style={{ flex: 1, background: 'transparent', border: '1px solid #333', color: '#888', borderRadius: '8px', padding: '12px', fontSize: '14px', cursor: 'pointer' }}>
                Cancel
              </button>
              <button onClick={handleSubmitReview} disabled={reviewSubmitting || !reviewText.trim()}
                style={{ flex: 2, background: reviewSubmitting || !reviewText.trim() ? '#1a1a1a' : '#aa44ff', color: reviewSubmitting || !reviewText.trim() ? '#555' : '#fff', border: 'none', borderRadius: '8px', padding: '12px', fontSize: '14px', fontWeight: '700', cursor: reviewSubmitting || !reviewText.trim() ? 'not-allowed' : 'pointer' }}>
                {reviewSubmitting ? 'Submitting...' : 'Submit Review'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Resume-signing modal — complete payment for an unsigned booking */}
      {resumeModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '24px' }}>
          <div style={{ background: '#0a1410', border: '1px solid #1a3a1a', borderRadius: '16px', width: '100%', maxWidth: '460px', padding: '28px' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: '19px', fontWeight: '700' }}>Complete your booking</h3>
            <p style={{ color: '#666', fontSize: '13px', margin: '0 0 16px' }}>{resumeModal.property || ''} · Ref {resumeModal.bookingRef}</p>

            {resumeStatus === 'loading' && (
              <div style={{ color: '#4a9eff', fontSize: '13px', padding: '12px 0' }}>⏳ Preparing your transaction…</div>
            )}

            {resumeStatus === 'review' && resumeModal.paymentEscrowBuilt && (
              <div style={{ background: '#091018', border: '1px solid #1d3a55', borderRadius: '8px', padding: '12px', marginBottom: '14px' }}>
                <div style={{ color: '#4a9eff', fontWeight: 700, fontSize: '12px', marginBottom: '8px' }}>Review before you sign</div>
                {[
                  ['Rental → host', `$${resumeModal.subtotal}`, 'released to your host at check-in'],
                  ['ARIA fee (3%) → ARIA', `$${resumeModal.ariaFee}`, 'released at check-in'],
                  ['Taxes → tax remittance', `$${resumeModal.taxes}`, 'released at check-in'],
                  ['Refundable deposit → escrow', `$${resumeModal.depositAmount}`, 'returned after checkout'],
                ].map(([label, amt, note], i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '5px 0', borderBottom: i < 3 ? '1px solid #12202e' : 'none' }}>
                    <div><div style={{ color: '#cfe3f2', fontSize: '12px' }}>{label}</div><div style={{ color: '#566b7d', fontSize: '10px' }}>{note}</div></div>
                    <div style={{ color: '#fff', fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap', paddingLeft: '10px' }}>{amt}</div>
                  </div>
                ))}
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #1d3a55' }}>
                  <span style={{ color: '#fff', fontSize: '12px', fontWeight: 700 }}>Total you sign for</span>
                  <span style={{ color: '#00ff44', fontSize: '13px', fontWeight: 800 }}>${resumeModal.chargeAmount} SuiUSD</span>
                </div>
                <p style={{ color: '#789', fontSize: '10px', lineHeight: 1.5, margin: '8px 0 0' }}>
                  Cancel before check-in for a full refund of everything above. Funds sit in smart-contract escrow — never in an ARIA wallet.
                </p>
              </div>
            )}
            {resumeStatus === 'review' && !resumeModal.paymentEscrowBuilt && (
              <div style={{ color: '#4a9eff', fontSize: '12px', marginBottom: '14px' }}>
                🔒 Sign to lock your ${resumeModal.depositAmount} refundable deposit in Sui escrow.
              </div>
            )}

            {['signing', 'submitting', 'confirming', 'done'].includes(resumeStatus) && (
              <div style={{ color: '#4a9eff', fontSize: '12px', margin: '8px 0' }}>
                {resumeStatus === 'signing' && '🔏 Sign the transaction in your wallet…'}
                {resumeStatus === 'submitting' && '📡 Submitting to Sui…'}
                {resumeStatus === 'confirming' && '⏳ Confirming on-chain…'}
                {resumeStatus === 'done' && '✅ Payment escrowed — your booking is fully confirmed!'}
              </div>
            )}
            {resumeStatus === 'error' && (
              <div style={{ background: '#1a1212', border: '1px solid #2a1a1a', borderRadius: '8px', padding: '10px', color: '#ff6666', fontSize: '12px', marginBottom: '12px' }}>⚠️ {resumeError}</div>
            )}

            <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
              <button onClick={() => { setResumeModal(null); setResumeStatus('idle'); setResumeError(''); }}
                disabled={['signing', 'submitting', 'confirming'].includes(resumeStatus)}
                style={{ flex: 1, background: 'transparent', border: '1px solid #333', color: '#888', borderRadius: '8px', padding: '11px', fontSize: '13px', cursor: 'pointer' }}>
                Close
              </button>
              {(resumeStatus === 'review' || resumeStatus === 'error') && resumeModal.escrowTxBytes && (
                <button onClick={handleResumeSign}
                  style={{ flex: 2, background: '#00ff44', border: 'none', color: '#000', borderRadius: '8px', padding: '11px', fontSize: '13px', fontWeight: 700, cursor: 'pointer' }}>
                  {resumeStatus === 'error' ? 'Retry' : 'Approve & sign in wallet'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* BookingPass — dynamic, wallet-signed check-in pass (rotating QR) */}
      {passModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '24px' }}>
          <div style={{ background: '#0d0a18', border: '1px solid #2a2a3a', borderRadius: '16px', width: '100%', maxWidth: '380px', padding: '24px', textAlign: 'center' }}>
            <h3 style={{ margin: '0 0 2px', fontSize: '18px', fontWeight: '700' }}>🎫 Check-in Pass</h3>
            <p style={{ color: '#888', fontSize: '12px', margin: '0 0 16px' }}>{passModal.property} · {fmtDay(passModal.checkIn)} → {fmtDay(passModal.checkOut)}</p>

            {passError ? (
              <div style={{ background: '#1a1212', border: '1px solid #2a1a1a', borderRadius: '8px', padding: '12px', color: '#ff6666', fontSize: '12px' }}>⚠️ {passError}</div>
            ) : passPayload ? (
              <>
                <div style={{ background: '#fff', borderRadius: '12px', padding: '14px', display: 'inline-block' }}>
                  <QRCodeSVG value={passPayload} size={216} level="M" />
                </div>
                <div style={{ color: '#a98aff', fontSize: '12px', fontWeight: 600, margin: '14px 0 4px' }}>🔄 Refreshes automatically — present at check-in</div>
                <p style={{ color: '#566', fontSize: '10px', lineHeight: 1.5, margin: '0 0 12px' }}>
                  Signed by your wallet, live. A screenshot won't work — the code rotates so only the real, present holder verifies.
                </p>
                <details style={{ textAlign: 'left' }}>
                  <summary style={{ color: '#667', fontSize: '11px', cursor: 'pointer' }}>Show code (for a paste-in scanner)</summary>
                  <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                    <code style={{ flex: 1, background: '#000', border: '1px solid #222', borderRadius: '6px', padding: '6px', color: '#7a7', fontSize: '9px', wordBreak: 'break-all', maxHeight: '60px', overflow: 'auto' }}>{passPayload}</code>
                    <button onClick={() => navigator.clipboard?.writeText(passPayload)}
                      style={{ background: 'transparent', border: '1px solid #333', color: '#888', borderRadius: '6px', padding: '4px 8px', fontSize: '11px', cursor: 'pointer', whiteSpace: 'nowrap' }}>Copy</button>
                  </div>
                </details>
              </>
            ) : (
              <div style={{ color: '#a98aff', fontSize: '13px', padding: '40px 0' }}>🔏 Signing your pass…</div>
            )}

            <button onClick={closePass}
              style={{ width: '100%', marginTop: '16px', background: 'transparent', border: '1px solid #333', color: '#888', borderRadius: '8px', padding: '11px', fontSize: '13px', cursor: 'pointer' }}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
