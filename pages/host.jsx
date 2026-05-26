import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';

const PROPERTIES = [
  { id: 1, title: 'Oceanfront Villa', location: 'Miami Beach, FL', price: 285, beds: 4, baths: 3, tag: 'Beachfront', image: 'https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=600&q=80' },
  { id: 2, title: 'Downtown Loft', location: 'Austin, TX', price: 145, beds: 2, baths: 1, tag: 'City View', image: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=600&q=80' },
  { id: 3, title: 'Mountain Cabin', location: 'Asheville, NC', price: 195, beds: 3, baths: 2, tag: 'Nature', image: 'https://images.unsplash.com/photo-1542718610-a1d656d1884c?w=600&q=80' },
  { id: 4, title: 'Desert Retreat', location: 'Scottsdale, AZ', price: 225, beds: 3, baths: 2, tag: 'Pool', image: 'https://images.unsplash.com/photo-1613977257363-707ba9348227?w=600&q=80' },
  { id: 5, title: 'Lake House', location: 'Lake Tahoe, CA', price: 320, beds: 5, baths: 4, tag: 'Waterfront', image: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=600&q=80' },
  { id: 6, title: 'Historic Brownstone', location: 'Brooklyn, NY', price: 175, beds: 2, baths: 2, tag: 'Historic', image: 'https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=600&q=80' },
];

export default function Host() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [bookings, setBookings] = useState([]);
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const [copiedId, setCopiedId] = useState(null);
  const [icalInputs, setIcalInputs] = useState({});
  const [icalSaving, setIcalSaving] = useState({});
  const [icalSaved, setIcalSaved] = useState({});
  const [releasingId, setReleasingId] = useState(null);
  const [messageCounts, setMessageCounts] = useState({});

  useEffect(() => {
    fetch('https://aria-demo-production-e590.up.railway.app/auth/me', { credentials: 'include' })
      .then(res => res.json())
      .then(async data => {
        if (!data.address) { router.push('/'); return; }
        setUser(data);
        const bkRes = await fetch('https://aria-demo-production-e590.up.railway.app/bookings/all', { credentials: 'include' });
        const bkData = await bkRes.json();
        const bks = bkData.bookings || [];
        setBookings(bks);
        const counts = {};
        await Promise.all(bks.filter(b => b.paymentStatus !== 'cancelled').map(async b => {
          try {
            const r = await fetch(`https://aria-demo-production-e590.up.railway.app/messages/${b.bookingRef}/count`, { credentials: 'include' });
            const d = await r.json();
            counts[b.bookingRef] = d.count || 0;
          } catch { counts[b.bookingRef] = 0; }
        }));
        setMessageCounts(counts);
        const rvRes = await fetch('https://aria-demo-production-e590.up.railway.app/reviews/all', { credentials: 'include' });
        const rvData = await rvRes.json();
        setReviews(rvData.reviews || []);
        setLoading(false);
      })
      .catch(() => { router.push('/'); });
  }, []);

  const copyICal = (propertyId) => {
    const url = `https://aria-demo-production-e590.up.railway.app/ical/${propertyId}`;
    navigator.clipboard.writeText(url);
    setCopiedId(propertyId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleIcalImport = async (propertyId) => {
    const url = icalInputs[propertyId];
    if (!url) return;
    setIcalSaving(prev => ({ ...prev, [propertyId]: true }));
    const res = await fetch('https://aria-demo-production-e590.up.railway.app/ical/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ propertyId, platform: 'airbnb', icalUrl: url })
    });
    const data = await res.json();
    setIcalSaving(prev => ({ ...prev, [propertyId]: false }));
    if (data.success) {
      setIcalSaved(prev => ({ ...prev, [propertyId]: true }));
      setTimeout(() => setIcalSaved(prev => ({ ...prev, [propertyId]: false })), 3000);
    }
  };

  const handleReleaseDeposit = async (bookingRef) => {
    if (!confirm('Release deposit back to guest? This cannot be undone.')) return;
    setReleasingId(bookingRef);
    const res = await fetch('https://aria-demo-production-e590.up.railway.app/booking/release-deposit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ bookingRef })
    });
    const data = await res.json();
    if (data.success) {
      // Refresh from server to get depositReleaseWalrusBlobId
      const bkRes = await fetch('https://aria-demo-production-e590.up.railway.app/bookings/all', { credentials: 'include' });
      const bkData = await bkRes.json();
      setBookings(bkData.bookings || []);
    }
    setReleasingId(null);
  };

  const activeBookings  = bookings.filter(b => b.paymentStatus !== 'cancelled');
  const cancelledBookings = bookings.filter(b => b.paymentStatus === 'cancelled');
  const totalRevenue    = activeBookings.reduce((sum, b) => {
    const amt = b.breakdown?.totalPaid ? parseInt(b.breakdown.totalPaid.split(' ')[0].replace(/[^0-9]/g, '')) : (b.totalAmount || 0);
    return sum + amt;
  }, 0);
  const totalAriaFees   = activeBookings.reduce((sum, b) => {
    const fee = b.breakdown?.ariaFee ? parseInt(b.breakdown.ariaFee.split(' ')[0].replace(/[^0-9]/g, '')) : 0;
    return sum + fee;
  }, 0);
  const totalTaxes      = activeBookings.reduce((sum, b) => {
    const t = b.breakdown?.taxes ? parseInt(b.breakdown.taxes.split(' ')[0].replace(/[^0-9]/g, '')) : 0;
    return sum + t;
  }, 0);
  const hostEarnings    = totalRevenue - totalAriaFees - totalTaxes;
  const depositsHeld    = activeBookings.filter(b => b.depositAmount && b.depositStatus === 'held').length;
  const totalUnread     = Object.values(messageCounts).reduce((sum, c) => sum + c, 0);
  const avgRating       = reviews.length ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1) : 0;

  const bookingsByProperty = PROPERTIES.map(p => ({
    ...p,
    bookings: activeBookings.filter(b => b.propertyId === p.id || b.propertyId === String(p.id)),
    revenue: activeBookings
      .filter(b => b.propertyId === p.id || b.propertyId === String(p.id))
      .reduce((sum, b) => {
        const amt = b.breakdown?.totalPaid ? parseInt(b.breakdown.totalPaid.split(' ')[0].replace(/[^0-9]/g, '')) : (b.totalAmount || 0);
        return sum + amt;
      }, 0)
  }));

  const tabStyle = (tab) => ({
    background: activeTab === tab ? '#00ff44' : 'transparent',
    color: activeTab === tab ? '#000' : '#888',
    border: `1px solid ${activeTab === tab ? '#00ff44' : '#333'}`,
    padding: '8px 20px', borderRadius: '6px', fontSize: '13px', fontWeight: '600', cursor: 'pointer'
  });

  const stars = (rating) => '⭐'.repeat(rating) + '☆'.repeat(5 - rating);

  // Walrus receipt buttons — shows all available receipts for a booking
  const WalrusReceipts = ({ b }) => (
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      {b.walrusBlobId && (
        <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${b.walrusBlobId}`}
          target="_blank" rel="noreferrer"
          style={{ background: '#0a1a0a', border: '1px solid #1a3a1a', color: '#00ff44', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', textDecoration: 'none', fontWeight: '600' }}>
          📄 Booking
        </a>
      )}
      {b.cancellationWalrusBlobId && (
        <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${b.cancellationWalrusBlobId}`}
          target="_blank" rel="noreferrer"
          style={{ background: '#1a0a0a', border: '1px solid #3a1a1a', color: '#ff6666', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', textDecoration: 'none', fontWeight: '600' }}>
          ❌ Cancellation
        </a>
      )}
      {b.depositReleaseWalrusBlobId && (
        <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${b.depositReleaseWalrusBlobId}`}
          target="_blank" rel="noreferrer"
          style={{ background: '#0a0a1a', border: '1px solid #1a1a3a', color: '#4a9eff', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', textDecoration: 'none', fontWeight: '600' }}>
          🔓 Deposit
        </a>
      )}
    </div>
  );

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a0a', color: '#fff' }}>
      Loading host dashboard...
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
          <span style={{ background: '#1a1a2e', border: '1px solid #333', color: '#4a9eff', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px', marginLeft: '4px' }}>HOST VIEW</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '13px', fontWeight: '500' }}>{user?.name}</div>
            <div style={{ fontSize: '11px', color: '#00ff44', fontFamily: 'monospace' }}>{user?.address?.slice(0, 8)}...{user?.address?.slice(-6)}</div>
          </div>
          <button onClick={() => router.push('/bookings')} style={{ background: 'transparent', border: '1px solid #333', color: '#888', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>Guest View</button>
          <button onClick={() => router.push('/')} style={{ background: 'transparent', border: '1px solid #333', color: '#888', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>Back to Search</button>
        </div>
      </div>

      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '40px 24px' }}>
        <div style={{ marginBottom: '32px' }}>
          <h1 style={{ fontSize: '24px', fontWeight: '700', margin: '0 0 4px' }}>Host Dashboard</h1>
          <p style={{ color: '#666', fontSize: '14px', margin: 0 }}>Manage your listings, bookings, and payouts</p>
        </div>

        {/* Stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '16px', marginBottom: '32px' }}>
          {[
            { label: 'TOTAL BOOKINGS', value: activeBookings.length, color: '#00ff44', sub: `${cancelledBookings.length} cancelled` },
            { label: 'GROSS REVENUE', value: `$${totalRevenue.toLocaleString()}`, color: '#00ff44', sub: 'SuiUSD' },
            { label: 'ARIA FEES (3%)', value: `$${totalAriaFees.toLocaleString()}`, color: '#ff4444', sub: 'vs 15% Airbnb' },
            { label: 'YOUR EARNINGS', value: `$${hostEarnings.toLocaleString()}`, color: '#4a9eff', sub: 'net payout' },
            { label: 'ACTIVE LISTINGS', value: PROPERTIES.length, color: '#00ff44', sub: 'properties' },
            { label: 'TAXES COLLECTED', value: `$${totalTaxes.toLocaleString()}`, color: '#ffaa00', sub: '8% occupancy tax' },
            { label: 'DEPOSITS HELD', value: depositsHeld, color: '#4a9eff', sub: 'in Sui escrow' },
            { label: 'MESSAGES', value: totalUnread, color: totalUnread > 0 ? '#ff4444' : '#555', sub: totalUnread > 0 ? 'need attention' : 'all caught up' },
            { label: 'AVG RATING', value: avgRating > 0 ? `${avgRating} ⭐` : '—', color: '#ffaa00', sub: `${reviews.length} review${reviews.length !== 1 ? 's' : ''}` },
          ].map((s, i) => (
            <div key={i} style={{ background: '#111', border: `1px solid ${i === 7 && totalUnread > 0 ? '#3a1a1a' : '#222'}`, borderRadius: '12px', padding: '20px' }}>
              <div style={{ fontSize: '10px', color: '#555', marginBottom: '8px', fontWeight: '600' }}>{s.label}</div>
              <div style={{ fontSize: '24px', fontWeight: '700', color: s.color, marginBottom: '4px' }}>{s.value}</div>
              <div style={{ fontSize: '11px', color: '#555' }}>{s.sub}</div>
            </div>
          ))}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: '24px', flexWrap: 'wrap' }}>
          {['overview', 'bookings', 'listings', 'calendar', 'reviews'].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={tabStyle(tab)}>
              {tab === 'overview' ? '📊 Overview' :
               tab === 'bookings' ? <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>📋 Bookings {totalUnread > 0 && <span style={{ background: '#ff4444', color: '#fff', borderRadius: '50%', fontSize: '10px', fontWeight: '700', padding: '1px 5px' }}>{totalUnread}</span>}</span> :
               tab === 'listings' ? '🏠 Listings' :
               tab === 'calendar' ? '📅 Calendar Sync' : '⭐ Reviews'}
            </button>
          ))}
        </div>

        {/* Overview tab */}
        {activeTab === 'overview' && (
          <div>
            <h3 style={{ fontSize: '16px', fontWeight: '600', margin: '0 0 16px' }}>Revenue by Property</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {bookingsByProperty.map(p => (
                <div key={p.id} style={{ background: '#111', border: '1px solid #222', borderRadius: '12px', padding: '16px', display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                  <img src={p.image} alt={p.title} style={{ width: '60px', height: '60px', objectFit: 'cover', borderRadius: '8px' }} />
                  <div style={{ flex: 1, minWidth: '150px' }}>
                    <div style={{ fontSize: '15px', fontWeight: '600', marginBottom: '2px' }}>{p.title}</div>
                    <div style={{ fontSize: '12px', color: '#666' }}>{p.location}</div>
                  </div>
                  <div style={{ textAlign: 'center', minWidth: '80px' }}>
                    <div style={{ fontSize: '20px', fontWeight: '700', color: '#00ff44' }}>{p.bookings.length}</div>
                    <div style={{ fontSize: '10px', color: '#555' }}>BOOKINGS</div>
                  </div>
                  <div style={{ textAlign: 'center', minWidth: '100px' }}>
                    <div style={{ fontSize: '20px', fontWeight: '700', color: '#4a9eff' }}>${p.revenue.toLocaleString()}</div>
                    <div style={{ fontSize: '10px', color: '#555' }}>REVENUE</div>
                  </div>
                  <div style={{ textAlign: 'center', minWidth: '80px' }}>
                    <div style={{ fontSize: '16px', fontWeight: '700', color: '#888' }}>${p.price}</div>
                    <div style={{ fontSize: '10px', color: '#555' }}>PER NIGHT</div>
                  </div>
                  {p.bookings.length > 0 && (
                    <div style={{ background: '#0a1a0a', border: '1px solid #1a3a1a', borderRadius: '6px', padding: '4px 10px' }}>
                      <span style={{ fontSize: '11px', color: '#00ff44', fontWeight: '600' }}>● Active</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div style={{ background: '#0a0a1a', border: '1px solid #1a1a3a', borderRadius: '12px', padding: '20px', marginTop: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <span style={{ fontSize: '16px' }}>⚡</span>
                <span style={{ fontWeight: '600', fontSize: '15px' }}>DeepBook Settlement</span>
                <span style={{ background: '#1a1a3a', border: '1px solid #2a2a5a', color: '#4a9eff', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px' }}>LIVE</span>
              </div>
              <p style={{ color: '#888', fontSize: '13px', margin: '0 0 12px', lineHeight: '1.6' }}>
                Host payouts settle instantly via DeepBook on Sui. No 3–5 day bank delays.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px' }}>
                {[
                  { label: 'Settlement Time', value: '< 1 second', color: '#00ff44' },
                  { label: 'Airbnb Payout Delay', value: '3–5 days', color: '#ff4444' },
                  { label: 'Your Net Rate', value: '97% of booking', color: '#4a9eff' },
                  { label: 'Airbnb Net Rate', value: '85% of booking', color: '#ff4444' },
                ].map((item, i) => (
                  <div key={i} style={{ background: '#111', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#555', marginBottom: '4px' }}>{item.label}</div>
                    <div style={{ fontSize: '16px', fontWeight: '700', color: item.color }}>{item.value}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Bookings tab */}
        {activeTab === 'bookings' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: '600', margin: 0 }}>All Bookings</h3>
              <span style={{ fontSize: '13px', color: '#666' }}>{bookings.length} total</span>
            </div>
            {bookings.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 24px', background: '#111', borderRadius: '12px', border: '1px solid #222' }}>
                <div style={{ fontSize: '48px', marginBottom: '16px' }}>📋</div>
                <h3 style={{ fontSize: '18px', fontWeight: '600', margin: '0 0 8px' }}>No bookings yet</h3>
                <p style={{ color: '#666', fontSize: '14px', margin: 0 }}>Bookings will appear here once guests start booking</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {bookings.map((b, i) => (
                  <div key={i} style={{ background: '#111', border: `1px solid ${b.paymentStatus === 'cancelled' ? '#2a1a1a' : '#222'}`, borderRadius: '12px', padding: '20px', opacity: b.paymentStatus === 'cancelled' ? 0.75 : 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
                      <div>
                        <div style={{ fontSize: '15px', fontWeight: '600', marginBottom: '4px' }}>{b.property}</div>
                        <div style={{ fontSize: '12px', color: '#666', marginBottom: '6px' }}>{b.guestName || 'Guest'} · {b.guestEmail || ''}</div>
                        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                          <span style={{
                            background: b.paymentStatus === 'cancelled' ? '#1a0a0a' : '#0a1a0a',
                            border: `1px solid ${b.paymentStatus === 'cancelled' ? '#3a1a1a' : '#1a3a1a'}`,
                            color: b.paymentStatus === 'cancelled' ? '#ff4444' : '#00ff44',
                            fontSize: '11px', fontWeight: '600', padding: '2px 8px', borderRadius: '20px'
                          }}>
                            {b.paymentStatus === 'cancelled' ? '✕ cancelled' : '✅ confirmed'}
                          </span>
                          {b.depositAmount && b.paymentStatus !== 'cancelled' && (
                            <span style={{
                              background: b.depositStatus === 'released' ? '#0a1a0a' : '#0a0a1a',
                              border: `1px solid ${b.depositStatus === 'released' ? '#1a3a1a' : '#1a1a3a'}`,
                              color: b.depositStatus === 'released' ? '#00ff44' : '#4a9eff',
                              fontSize: '11px', fontWeight: '600', padding: '2px 8px', borderRadius: '20px'
                            }}>
                              {b.depositStatus === 'released' ? '🔓 Deposit released' : `🔒 Deposit $${b.depositAmount} held`}
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '18px', fontWeight: '700', color: b.paymentStatus === 'cancelled' ? '#555' : '#00ff44', textDecoration: b.paymentStatus === 'cancelled' ? 'line-through' : 'none' }}>
                          {b.breakdown?.totalPaid || `$${b.totalAmount}`}
                        </div>
                        <div style={{ fontSize: '11px', color: '#555' }}>{b.checkIn} → {b.checkOut}</div>
                        <div style={{ fontSize: '11px', color: '#555' }}>{b.nights} night{b.nights > 1 ? 's' : ''}</div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ fontSize: '11px', color: '#555', fontFamily: 'monospace' }}>Ref: {b.bookingRef}</div>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>

                        {/* All Walrus receipts for this booking */}
                        <WalrusReceipts b={b} />

                        {b.paymentStatus !== 'cancelled' && (
                          <button
                            onClick={() => router.push(`/messages?bookingRef=${b.bookingRef}&property=${encodeURIComponent(b.property)}`)}
                            style={{ background: messageCounts[b.bookingRef] > 0 ? '#1a0a0a' : 'transparent', border: `1px solid ${messageCounts[b.bookingRef] > 0 ? '#3a1a1a' : '#1a1a3a'}`, color: '#4a9eff', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            💬 Messages
                            {messageCounts[b.bookingRef] > 0 && (
                              <span style={{ background: '#ff4444', color: '#fff', borderRadius: '50%', fontSize: '10px', fontWeight: '700', padding: '1px 5px' }}>
                                {messageCounts[b.bookingRef]}
                              </span>
                            )}
                          </button>
                        )}

                        {b.depositAmount && b.paymentStatus !== 'cancelled' && b.depositStatus !== 'released' && (
                          <button
                            onClick={() => handleReleaseDeposit(b.bookingRef)}
                            disabled={releasingId === b.bookingRef}
                            style={{ background: '#0a0a1a', border: '1px solid #1a1a3a', color: releasingId === b.bookingRef ? '#555' : '#4a9eff', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', cursor: releasingId === b.bookingRef ? 'not-allowed' : 'pointer', fontWeight: '600' }}>
                            {releasingId === b.bookingRef ? 'Releasing...' : '🔓 Release Deposit'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Listings tab */}
        {activeTab === 'listings' && (
          <div>
            <h3 style={{ fontSize: '16px', fontWeight: '600', margin: '0 0 16px' }}>Your Listings</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '16px' }}>
              {PROPERTIES.map(p => (
                <div key={p.id} style={{ background: '#111', border: '1px solid #222', borderRadius: '12px', overflow: 'hidden' }}>
                  <div style={{ height: '160px', overflow: 'hidden', position: 'relative' }}>
                    <img src={p.image} alt={p.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    <span style={{ position: 'absolute', top: '10px', left: '10px', background: 'rgba(0,0,0,0.7)', color: '#fff', fontSize: '11px', fontWeight: '600', padding: '3px 8px', borderRadius: '6px' }}>{p.tag}</span>
                    <span style={{ position: 'absolute', top: '10px', right: '10px', background: '#0a1a0a', border: '1px solid #1a3a1a', color: '#00ff44', fontSize: '11px', fontWeight: '600', padding: '3px 8px', borderRadius: '6px' }}>● Listed</span>
                  </div>
                  <div style={{ padding: '16px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <h4 style={{ margin: 0, fontSize: '15px', fontWeight: '600' }}>{p.title}</h4>
                      <span style={{ fontSize: '15px', fontWeight: '700', color: '#00ff44' }}>${p.price}<span style={{ fontSize: '11px', color: '#555' }}>/night</span></span>
                    </div>
                    <p style={{ color: '#666', fontSize: '12px', margin: '0 0 12px' }}>{p.location} · {p.beds} beds · {p.baths} baths</p>
                    <div style={{ background: '#1a1a1a', borderRadius: '8px', padding: '10px', marginBottom: '10px' }}>
                      <div style={{ fontSize: '10px', color: '#555', marginBottom: '6px', fontWeight: '600' }}>ICAL EXPORT — paste into Airbnb/VRBO</div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <div style={{ flex: 1, background: '#111', border: '1px solid #333', borderRadius: '6px', padding: '6px 10px', fontSize: '11px', color: '#666', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          localhost:3001/ical/{p.id}
                        </div>
                        <button onClick={() => copyICal(p.id)} style={{ background: copiedId === p.id ? '#0a1a0a' : '#1a1a1a', border: `1px solid ${copiedId === p.id ? '#00ff44' : '#333'}`, color: copiedId === p.id ? '#00ff44' : '#888', fontSize: '11px', padding: '6px 10px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600', whiteSpace: 'nowrap' }}>
                          {copiedId === p.id ? '✓ Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', fontSize: '12px' }}>
                      <div style={{ flex: 1, background: '#1a1a1a', borderRadius: '6px', padding: '8px', textAlign: 'center' }}>
                        <div style={{ fontSize: '10px', color: '#555', marginBottom: '2px' }}>BOOKINGS</div>
                        <div style={{ fontWeight: '700', color: '#00ff44' }}>{activeBookings.filter(b => b.propertyId === p.id || b.propertyId === String(p.id)).length}</div>
                      </div>
                      <div style={{ flex: 1, background: '#1a1a1a', borderRadius: '6px', padding: '8px', textAlign: 'center' }}>
                        <div style={{ fontSize: '10px', color: '#555', marginBottom: '2px' }}>REVENUE</div>
                        <div style={{ fontWeight: '700', color: '#4a9eff' }}>
                          ${activeBookings.filter(b => b.propertyId === p.id || b.propertyId === String(p.id)).reduce((sum, b) => sum + (parseInt((b.breakdown?.totalPaid || '0').split(' ')[0].replace(/[^0-9]/g, '')) || 0), 0).toLocaleString()}
                        </div>
                      </div>
                      <div style={{ flex: 1, background: '#1a1a1a', borderRadius: '6px', padding: '8px', textAlign: 'center' }}>
                        <div style={{ fontSize: '10px', color: '#555', marginBottom: '2px' }}>ARIA FEE</div>
                        <div style={{ fontWeight: '700', color: '#00ff44' }}>3%</div>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Calendar tab */}
        {activeTab === 'calendar' && (
          <div>
            <div style={{ background: '#0a0a1a', border: '1px solid #1a1a3a', borderRadius: '12px', padding: '20px', marginBottom: '24px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: '600', margin: '0 0 8px' }}>📅 Two-Way Calendar Sync</h3>
              <p style={{ color: '#888', fontSize: '13px', margin: 0, lineHeight: '1.6' }}>
                ARIA prevents double bookings across all platforms. Export your ARIA calendar to Airbnb/VRBO, and import their calendars here. ARIA is always the source of truth.
              </p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {PROPERTIES.map(p => (
                <div key={p.id} style={{ background: '#111', border: '1px solid #222', borderRadius: '12px', padding: '20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                    <img src={p.image} alt={p.title} style={{ width: '48px', height: '48px', objectFit: 'cover', borderRadius: '8px' }} />
                    <div>
                      <div style={{ fontSize: '15px', fontWeight: '600' }}>{p.title}</div>
                      <div style={{ fontSize: '12px', color: '#666' }}>{p.location}</div>
                    </div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div style={{ background: '#1a1a1a', borderRadius: '8px', padding: '12px' }}>
                      <div style={{ fontSize: '11px', color: '#00ff44', fontWeight: '600', marginBottom: '6px' }}>↑ EXPORT — paste into Airbnb/VRBO</div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <div style={{ flex: 1, background: '#111', border: '1px solid #333', borderRadius: '6px', padding: '6px 8px', fontSize: '10px', color: '#666', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          localhost:3001/ical/{p.id}
                        </div>
                        <button onClick={() => copyICal(p.id)} style={{ background: copiedId === p.id ? '#0a1a0a' : '#111', border: `1px solid ${copiedId === p.id ? '#00ff44' : '#333'}`, color: copiedId === p.id ? '#00ff44' : '#888', fontSize: '11px', padding: '6px 8px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600', whiteSpace: 'nowrap' }}>
                          {copiedId === p.id ? '✓' : 'Copy'}
                        </button>
                      </div>
                    </div>
                    <div style={{ background: '#1a1a1a', borderRadius: '8px', padding: '12px' }}>
                      <div style={{ fontSize: '11px', color: '#4a9eff', fontWeight: '600', marginBottom: '6px' }}>↓ IMPORT — paste Airbnb/VRBO iCal URL</div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <input value={icalInputs[p.id] || ''} onChange={e => setIcalInputs(prev => ({ ...prev, [p.id]: e.target.value }))}
                          placeholder="https://airbnb.com/calendar/ical/..."
                          style={{ flex: 1, background: '#111', border: '1px solid #333', borderRadius: '6px', padding: '6px 8px', fontSize: '10px', color: '#fff', outline: 'none' }} />
                        <button onClick={() => handleIcalImport(p.id)} disabled={icalSaving[p.id] || !icalInputs[p.id]}
                          style={{ background: icalSaved[p.id] ? '#0a1a0a' : '#111', border: `1px solid ${icalSaved[p.id] ? '#00ff44' : '#333'}`, color: icalSaved[p.id] ? '#00ff44' : '#888', fontSize: '11px', padding: '6px 8px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600', whiteSpace: 'nowrap' }}>
                          {icalSaving[p.id] ? '...' : icalSaved[p.id] ? '✓' : 'Sync'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Reviews tab */}
        {activeTab === 'reviews' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: '600', margin: 0 }}>Guest Reviews</h3>
              <span style={{ fontSize: '13px', color: '#666' }}>{reviews.length} total · avg {avgRating} ⭐</span>
            </div>
            {reviews.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 24px', background: '#111', borderRadius: '12px', border: '1px solid #222' }}>
                <div style={{ fontSize: '48px', marginBottom: '16px' }}>⭐</div>
                <h3 style={{ fontSize: '18px', fontWeight: '600', margin: '0 0 8px' }}>No reviews yet</h3>
                <p style={{ color: '#666', fontSize: '14px', margin: 0 }}>Guest reviews will appear here after their stay</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {reviews.map((r, i) => {
                  const prop = PROPERTIES.find(p => p.id === r.propertyId || String(p.id) === String(r.propertyId));
                  return (
                    <div key={i} style={{ background: '#111', border: '1px solid #222', borderRadius: '12px', padding: '20px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
                        <div>
                          <div style={{ fontSize: '15px', fontWeight: '600', marginBottom: '2px' }}>{prop?.title || `Property ${r.propertyId}`}</div>
                          <div style={{ fontSize: '12px', color: '#666' }}>{r.guestName} · {new Date(r.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
                        </div>
                        <div style={{ fontSize: '20px' }}>{stars(r.rating)}</div>
                      </div>
                      <p style={{ color: '#ccc', fontSize: '14px', margin: '0 0 8px', lineHeight: '1.6' }}>{r.review}</p>
                      <div style={{ fontSize: '11px', color: '#555', fontFamily: 'monospace' }}>Ref: {r.bookingRef}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
