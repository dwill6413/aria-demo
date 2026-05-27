import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';

const fmtDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

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

  const handleSubmitReview = async () => {
    if (!reviewText.trim()) return;
    setReviewSubmitting(true);
    const res = await fetch('https://aria-demo-production-e590.up.railway.app/reviews/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
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
    const res = await fetch('https://aria-demo-production-e590.up.railway.app/booking/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ bookingRef })
    });
    const data = await res.json();
    if (data.success) {
      const updated = await fetch('https://aria-demo-production-e590.up.railway.app/bookings/history', { credentials: 'include' });
      const updatedData = await updated.json();
      setBookings(updatedData.bookings || []);
    }
    setCancellingId(null);
  };

  useEffect(() => {
    fetch('https://aria-demo-production-e590.up.railway.app/auth/me', { credentials: 'include' })
      .then(res => res.json())
      .then(data => {
        if (!data.address) { router.push('/'); return; }
        setUser(data);
        return fetch('https://aria-demo-production-e590.up.railway.app/bookings/history', { credentials: 'include' });
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

      {/* Header */}
      <div style={{ background: '#111', borderBottom: '1px solid #222', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '60px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span onClick={() => router.push('/')} style={{ fontSize: '20px', cursor: 'pointer' }}>🏠</span>
          <span style={{ fontWeight: '700', fontSize: '18px', cursor: 'pointer' }} onClick={() => router.push('/')}>ARIA</span>
          <span style={{ background: '#00ff44', color: '#000', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px', marginLeft: '4px' }}>BETA</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '13px', fontWeight: '500' }}>{user?.name}</div>
            <div style={{ fontSize: '11px', color: '#00ff44', fontFamily: 'monospace' }}>{user?.address?.slice(0, 8)}...{user?.address?.slice(-6)}</div>
          </div>
          <button onClick={() => router.push('/')} style={{ background: 'transparent', border: '1px solid #333', color: '#888', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>
            Back to Search
          </button>
        </div>
      </div>

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

                {/* Title + Status */}
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
                        <span style={{
                          background: b.depositStatus === 'released' ? '#0a1a0a' : '#0a0a1a',
                          border: `1px solid ${b.depositStatus === 'released' ? '#1a3a1a' : '#1a1a3a'}`,
                          color: b.depositStatus === 'released' ? '#00ff44' : '#4a9eff',
                          fontSize: '11px', fontWeight: '600', padding: '3px 10px', borderRadius: '20px'
                        }}>
                          {b.depositStatus === 'released' ? '🔓 Deposit returned' : `🔒 Deposit $${b.depositAmount} held`}
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

                {/* Date grid */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '12px', marginBottom: '16px' }}>
                  <div style={{ background: '#1a1a1a', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#555', marginBottom: '4px' }}>CHECK-IN</div>
                    <div style={{ fontSize: '14px', fontWeight: '600' }}>{fmtDate(b.checkIn)}</div>
                  </div>
                  <div style={{ background: '#1a1a1a', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#555', marginBottom: '4px' }}>CHECK-OUT</div>
                    <div style={{ fontSize: '14px', fontWeight: '600' }}>{fmtDate(b.checkOut)}</div>
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

                {/* Price breakdown */}
                {b.breakdown && (
                  <div style={{ background: '#1a1a1a', borderRadius: '8px', padding: '12px', marginBottom: '16px', fontSize: '13px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ color: '#888' }}>Price per night</span><span>{b.breakdown.pricePerNight}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ color: '#888' }}>Subtotal</span><span>{b.breakdown.subtotal}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ color: '#888' }}>ARIA fee (stay only)</span><span style={{ color: '#00ff44' }}>{b.breakdown.ariaFee}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', paddingBottom: '8px', borderBottom: '1px solid #333' }}>
                      <span style={{ color: '#888' }}>Taxes</span><span>{b.breakdown.taxes}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', fontWeight: '600' }}>
                      <span>Stay total</span><span style={{ color: '#00ff44' }}>{b.breakdown.totalPaid}</span>
                    </div>
                    {b.depositAmount && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', paddingBottom: '8px', borderBottom: '1px solid #333' }}>
                        <span style={{ color: '#4a9eff' }}>🔒 Refundable deposit (no ARIA fee)</span>
                        <span style={{ color: '#4a9eff' }}>${b.depositAmount}</span>
                      </div>
                    )}
                    {b.chargeAmount && (
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: '700' }}>
                        <span>Total charged</span><span style={{ color: '#fff' }}>${b.chargeAmount} SuiUSD</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Walrus receipts — show both on cancelled bookings */}
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

                {/* Action buttons */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ fontSize: '11px', color: '#555', fontFamily: 'monospace' }}>
                    Ref: {b.bookingRef}
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>

                    {/* Single Walrus button for active bookings */}
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
    </div>
  );
}
