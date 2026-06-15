import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const fmtDate = (d) => new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

const fmtDay = (d) => {
  const s = String(d).slice(0, 10);
  const [y, mo, day] = s.split('-').map(Number);
  if (!y || !mo || !day) return fmtDate(d);
  return new Date(y, mo - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};
const fmtDateTime = (d) => new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

const getStoredSid = () => { try { return localStorage.getItem('aria_sid') || ''; } catch { return ''; } };
const authFetch = (url, options = {}) => {
  const sid = getStoredSid();
  const headers = { ...(options.headers || {}) };
  if (sid) headers['x-session-id'] = sid;
  return fetch(url, { ...options, credentials: 'include', headers });
};

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
  const [addrCopied, setAddrCopied] = useState(false);

  const copyAddr = () => {
    navigator.clipboard.writeText(user?.address);
    setAddrCopied(true);
    setTimeout(() => setAddrCopied(false), 2000);
  };

  // Tax state
  const [taxData, setTaxData] = useState(null);
  const [taxLoading, setTaxLoading] = useState(false);
  const [remittingId, setRemittingId] = useState(null);
  const [remitModal, setRemitModal] = useState(null);
  const [remitJurisdiction, setRemitJurisdiction] = useState('');
  const [remitNotes, setRemitNotes] = useState('');
  const [taxFilter, setTaxFilter] = useState('all');

  // Applications state
  const [applications, setApplications] = useState([]);
  const [applicationsLoading, setApplicationsLoading] = useState(false);
  const [approvingId, setApprovingId] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    authFetch(`${API}/auth/me`)
      .then(res => res.json())
      .then(async data => {
        if (!data.address) { router.push('/'); return; }
        if (!data.isHost) { router.push('/?error=access_denied'); return; }
        setUser(data);
        const bkRes = await authFetch(`${API}/bookings/all`);
        const bkData = await bkRes.json();
        const bks = bkData.bookings || [];
        setBookings(bks);
        const counts = {};
        await Promise.all(bks.filter(b => b.paymentStatus !== 'cancelled').map(async b => {
          try {
            const r = await authFetch(`${API}/messages/${b.bookingRef}/count`);
            const d = await r.json();
            counts[b.bookingRef] = d.count || 0;
          } catch { counts[b.bookingRef] = 0; }
        }));
        setMessageCounts(counts);
        const rvRes = await authFetch(`${API}/reviews/all`);
        const rvData = await rvRes.json();
        setReviews(rvData.reviews || []);
        loadApplications(true);
        setLoading(false);
      })
      .catch(() => { router.push('/'); });
  }, []);

  const loadApplications = async (silent = false) => {
    if (!silent) setApplicationsLoading(true);
    try {
      const res = await authFetch(`${API}/host/applications`);
      const data = await res.json();
      setApplications(data.applications || []);
    } catch {}
    if (!silent) setApplicationsLoading(false);
  };

  useEffect(() => {
    if (activeTab === 'applications') loadApplications();
    if (activeTab === 'tax' && !taxData) loadTaxData();
  }, [activeTab]);

  const handleApprove = async (suiAddress, name) => {
    if (!confirm(`Approve ${name} as a host? They will receive an email and gain access to the Host Dashboard.`)) return;
    setApprovingId(suiAddress);
    try {
      const res = await authFetch(`${API}/host/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suiAddress })
      });
      const data = await res.json();
      if (data.success) {
        await loadApplications();
      } else {
        alert(data.error || 'Failed to approve host');
      }
    } catch { alert('Connection error'); }
    setApprovingId(null);
  };

  const loadTaxData = async () => {
    setTaxLoading(true);
    try {
      const res = await authFetch(`${API}/tax/summary`);
      const data = await res.json();
      setTaxData(data);
    } catch {}
    setTaxLoading(false);
  };

  const handleRemit = async () => {
    if (!remitModal) return;
    setRemittingId(remitModal.bookingRef);
    try {
      const res = await authFetch(`${API}/tax/remit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingRef: remitModal.bookingRef, jurisdiction: remitJurisdiction || null, notes: remitNotes || null })
      });
      const data = await res.json();
      if (data.success) { setRemitModal(null); setRemitJurisdiction(''); setRemitNotes(''); await loadTaxData(); }
      else alert(data.error || 'Failed to record remittance');
    } catch { alert('Connection error'); }
    setRemittingId(null);
  };

  const handleUnremit = async (bookingRef) => {
    if (!confirm('Remove remittance record for this booking?')) return;
    try {
      const res = await authFetch(`${API}/tax/unremit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingRef }) });
      const data = await res.json();
      if (data.success) await loadTaxData();
      else alert(data.error || 'Failed');
    } catch { alert('Connection error'); }
  };

  const exportCSV = () => {
    if (!taxData) return;
    const rows = [
      ['Booking Ref', 'Property', 'Guest', 'Check-In', 'Check-Out', 'Nights', 'Subtotal', 'Tax (8%)', 'Total', 'Remitted', 'Remitted At', 'Jurisdiction', 'Notes'],
      ...taxData.bookings.map(b => [
        b.bookingRef, b.property, b.guestName,
        fmtDay(b.checkIn), fmtDay(b.checkOut),
        b.nights, `$${b.subtotal}`, `$${b.taxAmount}`, `$${b.totalAmount}`,
        b.remitted ? 'Yes' : 'No', b.remittedAt ? fmtDate(b.remittedAt) : '',
        b.jurisdiction || '', b.notes || ''
      ])
    ];
    const csv = rows.map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `aria-tax-report-${new Date().toISOString().split('T')[0]}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  const copyICal = (propertyId) => {
    navigator.clipboard.writeText(`${API}/ical/${propertyId}`);
    setCopiedId(propertyId);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleIcalImport = async (propertyId) => {
    const url = icalInputs[propertyId];
    if (!url) return;
    setIcalSaving(prev => ({ ...prev, [propertyId]: true }));
    const res = await authFetch(`${API}/ical/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ propertyId, platform: 'airbnb', icalUrl: url }) });
    const data = await res.json();
    setIcalSaving(prev => ({ ...prev, [propertyId]: false }));
    if (data.success) { setIcalSaved(prev => ({ ...prev, [propertyId]: true })); setTimeout(() => setIcalSaved(prev => ({ ...prev, [propertyId]: false })), 3000); }
  };

  const handleReleaseDeposit = async (bookingRef) => {
    if (!confirm('Release deposit back to guest? This cannot be undone.')) return;
    setReleasingId(bookingRef);
    const res = await authFetch(`${API}/booking/release-deposit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingRef }) });
    const data = await res.json();
    if (data.success) { const bkRes = await authFetch(`${API}/bookings/all`); const bkData = await bkRes.json(); setBookings(bkData.bookings || []); }
    setReleasingId(null);
  };

  const activeBookings    = bookings.filter(b => b.paymentStatus !== 'cancelled');
  const cancelledBookings = bookings.filter(b => b.paymentStatus === 'cancelled');
  const totalRevenue      = activeBookings.reduce((sum, b) => sum + (b.breakdown?.totalPaid ? parseInt(b.breakdown.totalPaid.split(' ')[0].replace(/[^0-9]/g, '')) : (b.totalAmount || 0)), 0);
  const totalAriaFees     = activeBookings.reduce((sum, b) => sum + (b.breakdown?.ariaFee ? parseInt(b.breakdown.ariaFee.split(' ')[0].replace(/[^0-9]/g, '')) : 0), 0);
  const totalTaxes        = activeBookings.reduce((sum, b) => sum + (b.breakdown?.taxes ? parseInt(b.breakdown.taxes.split(' ')[0].replace(/[^0-9]/g, '')) : 0), 0);
  const hostEarnings      = totalRevenue - totalAriaFees - totalTaxes;
  const depositsHeld      = activeBookings.filter(b => b.depositAmount && b.depositStatus === 'held').length;
  const totalUnread       = Object.values(messageCounts).reduce((sum, c) => sum + c, 0);
  const avgRating         = reviews.length ? (reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length).toFixed(1) : 0;
  const pendingApps       = applications.filter(a => a.status === 'pending').length;

  const bookingsByProperty = PROPERTIES.map(p => ({
    ...p,
    bookings: activeBookings.filter(b => b.propertyId === p.id || b.propertyId === String(p.id)),
    revenue: activeBookings.filter(b => b.propertyId === p.id || b.propertyId === String(p.id))
      .reduce((sum, b) => sum + (b.breakdown?.totalPaid ? parseInt(b.breakdown.totalPaid.split(' ')[0].replace(/[^0-9]/g, '')) : (b.totalAmount || 0)), 0)
  }));

  const tabStyle = (tab) => ({
    background: activeTab === tab ? '#00ff44' : 'transparent',
    color: activeTab === tab ? '#000' : '#888',
    border: `1px solid ${activeTab === tab ? '#00ff44' : '#333'}`,
    padding: '8px 20px', borderRadius: '6px', fontSize: '13px', fontWeight: '600', cursor: 'pointer'
  });

  const stars = (rating) => '⭐'.repeat(rating) + '☆'.repeat(5 - rating);

  const WalrusReceipts = ({ b }) => (
    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      {b.walrusBlobId && <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${b.walrusBlobId}`} target="_blank" rel="noreferrer" style={{ background: '#0a1a0a', border: '1px solid #1a3a1a', color: '#00ff44', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', textDecoration: 'none', fontWeight: '600' }}>📄 Booking</a>}
      {b.cancellationWalrusBlobId && <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${b.cancellationWalrusBlobId}`} target="_blank" rel="noreferrer" style={{ background: '#1a0a0a', border: '1px solid #3a1a1a', color: '#ff6666', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', textDecoration: 'none', fontWeight: '600' }}>❌ Cancellation</a>}
      {b.depositReleaseWalrusBlobId && <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${b.depositReleaseWalrusBlobId}`} target="_blank" rel="noreferrer" style={{ background: '#0a0a1a', border: '1px solid #1a1a3a', color: '#4a9eff', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', textDecoration: 'none', fontWeight: '600' }}>🔓 Deposit</a>}
    </div>
  );

  const filteredTaxBookings = taxData?.bookings?.filter(b => {
    if (taxFilter === 'pending') return !b.remitted;
    if (taxFilter === 'remitted') return b.remitted;
    return true;
  }) || [];

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a0a', color: '#fff' }}>Loading host dashboard...</div>;

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#fff' }}>
      <style>{`
        .hs-nav-desktop { display: flex; align-items: center; gap: 12px; }
        .hs-nav-hamburger { display: none !important; }
        @media (max-width: 639px) {
          .hs-nav-desktop { display: none !important; }
          .hs-nav-hamburger { display: flex !important; align-items: center; gap: 8px; }
          .hs-stats-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>

      {/* Header */}
      <div style={{ background: '#111', borderBottom: '1px solid #222', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '60px', position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span onClick={() => router.push('/')} style={{ fontSize: '20px', cursor: 'pointer' }}>🏠</span>
          <span style={{ fontWeight: '700', fontSize: '18px', cursor: 'pointer' }} onClick={() => router.push('/')}>ARIA</span>
          <span style={{ background: '#00ff44', color: '#000', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px', marginLeft: '4px' }}>BETA</span>
          <span style={{ background: '#1a1a2e', border: '1px solid #333', color: '#4a9eff', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px', marginLeft: '4px' }}>HOST VIEW</span>
        </div>
        {/* Desktop */}
        <div className="hs-nav-desktop">
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '13px', fontWeight: '500' }}>{user?.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end' }}>
              <div style={{ fontSize: '11px', color: '#00ff44', fontFamily: 'monospace', wordBreak: 'break-all' }}>{user?.address}</div>
              <button onClick={copyAddr} title="Copy address" style={{ background: 'none', border: 'none', cursor: 'pointer', color: addrCopied ? '#00ff44' : '#555', fontSize: '12px', padding: '0 2px', flexShrink: 0 }}>
                {addrCopied ? '✓' : '⧉'}
              </button>
            </div>
          </div>
          <button onClick={() => router.push('/bookings')} style={{ background: 'transparent', border: '1px solid #333', color: '#888', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>Guest View</button>
          <button onClick={() => router.push('/')} style={{ background: 'transparent', border: '1px solid #333', color: '#888', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>Back to Search</button>
        </div>
        {/* Mobile */}
        <div className="hs-nav-hamburger">
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
            <div style={{ fontSize: '11px', color: '#4a9eff', marginTop: '2px', fontWeight: '700' }}>Host Dashboard</div>
          </div>
          {[
            { label: '👤 Guest View', path: '/bookings' },
            { label: '🏠 Back to Search', path: '/' },
          ].map((item, i) => (
            <button key={i} onClick={() => { router.push(item.path); setMenuOpen(false); }} style={{ background: '#1a1a1a', border: '1px solid #2a2a2a', color: '#fff', borderRadius: '8px', padding: '12px 16px', fontSize: '14px', textAlign: 'left', cursor: 'pointer' }}>
              {item.label}
            </button>
          ))}
        </div>
      )}

      <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '40px 24px' }}>
        <div style={{ marginBottom: '32px' }}>
          <h1 style={{ fontSize: '24px', fontWeight: '700', margin: '0 0 4px' }}>Host Dashboard</h1>
          <p style={{ color: '#666', fontSize: '14px', margin: 0 }}>Manage your listings, bookings, and payouts</p>
        </div>

        {/* Stats */}
        <div className="hs-stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '16px', marginBottom: '32px' }}>
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
          {['overview', 'bookings', 'listings', 'calendar', 'reviews', 'tax', 'applications'].map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} style={tabStyle(tab)}>
              {tab === 'overview'      ? '📊 Overview' :
               tab === 'bookings'     ? <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>📋 Bookings {totalUnread > 0 && <span style={{ background: '#ff4444', color: '#fff', borderRadius: '50%', fontSize: '10px', fontWeight: '700', padding: '1px 5px' }}>{totalUnread}</span>}</span> :
               tab === 'listings'     ? '🏠 Listings' :
               tab === 'calendar'     ? '📅 Calendar Sync' :
               tab === 'reviews'      ? '⭐ Reviews' :
               tab === 'tax'          ? '💰 Tax' :
               <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>👥 Applications {pendingApps > 0 && <span style={{ background: '#ffaa00', color: '#000', borderRadius: '50%', fontSize: '10px', fontWeight: '700', padding: '1px 5px' }}>{pendingApps}</span>}</span>}
            </button>
          ))}
        </div>

        {/* Overview */}
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
                  {p.bookings.length > 0 && <div style={{ background: '#0a1a0a', border: '1px solid #1a3a1a', borderRadius: '6px', padding: '4px 10px' }}><span style={{ fontSize: '11px', color: '#00ff44', fontWeight: '600' }}>● Active</span></div>}
                </div>
              ))}
            </div>
            <div style={{ background: '#0a0a1a', border: '1px solid #1a1a3a', borderRadius: '12px', padding: '20px', marginTop: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
                <span style={{ fontSize: '16px' }}>⚡</span>
                <span style={{ fontWeight: '600', fontSize: '15px' }}>DeepBook Settlement</span>
                <span style={{ background: '#1a1a3a', border: '1px solid #2a2a5a', color: '#4a9eff', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px' }}>LIVE</span>
              </div>
              <p style={{ color: '#888', fontSize: '13px', margin: '0 0 12px', lineHeight: '1.6' }}>Host payouts settle instantly via DeepBook on Sui. No 3–5 day bank delays.</p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px' }}>
                {[['Settlement Time','< 1 second','#00ff44'],['Airbnb Payout Delay','3–5 days','#ff4444'],['Your Net Rate','97% of booking','#4a9eff'],['Airbnb Net Rate','85% of booking','#ff4444']].map(([label, val, color], i) => (
                  <div key={i} style={{ background: '#111', borderRadius: '8px', padding: '12px' }}>
                    <div style={{ fontSize: '10px', color: '#555', marginBottom: '4px' }}>{label}</div>
                    <div style={{ fontSize: '16px', fontWeight: '700', color }}>{val}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Bookings */}
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
                          <span style={{ background: b.paymentStatus === 'cancelled' ? '#1a0a0a' : '#0a1a0a', border: `1px solid ${b.paymentStatus === 'cancelled' ? '#3a1a1a' : '#1a3a1a'}`, color: b.paymentStatus === 'cancelled' ? '#ff4444' : '#00ff44', fontSize: '11px', fontWeight: '600', padding: '2px 8px', borderRadius: '20px' }}>
                            {b.paymentStatus === 'cancelled' ? '✕ cancelled' : '✅ confirmed'}
                          </span>
                          {b.depositAmount && b.paymentStatus !== 'cancelled' && (
                            <span style={{ background: b.depositStatus === 'released' ? '#0a1a0a' : '#0a0a1a', border: `1px solid ${b.depositStatus === 'released' ? '#1a3a1a' : '#1a1a3a'}`, color: b.depositStatus === 'released' ? '#00ff44' : '#4a9eff', fontSize: '11px', fontWeight: '600', padding: '2px 8px', borderRadius: '20px' }}>
                              {b.depositStatus === 'released' ? '🔓 Deposit released' : `🔒 Deposit $${b.depositAmount} held`}
                            </span>
                          )}
                        </div>
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <div style={{ fontSize: '18px', fontWeight: '700', color: b.paymentStatus === 'cancelled' ? '#555' : '#00ff44', textDecoration: b.paymentStatus === 'cancelled' ? 'line-through' : 'none' }}>{b.breakdown?.totalPaid || `$${b.totalAmount}`}</div>
                        <div style={{ fontSize: '11px', color: '#555' }}>{fmtDay(b.checkIn)} → {fmtDay(b.checkOut)}</div>
                        <div style={{ fontSize: '11px', color: '#555' }}>{b.nights} night{b.nights > 1 ? 's' : ''}</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                      <div style={{ fontSize: '11px', color: '#555', fontFamily: 'monospace' }}>Ref: {b.bookingRef}</div>
                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                        <WalrusReceipts b={b} />
                        {b.paymentStatus !== 'cancelled' && (
                          <button onClick={() => router.push(`/messages?bookingRef=${b.bookingRef}&property=${encodeURIComponent(b.property)}`)}
                            style={{ background: messageCounts[b.bookingRef] > 0 ? '#1a0a0a' : 'transparent', border: `1px solid ${messageCounts[b.bookingRef] > 0 ? '#3a1a1a' : '#1a1a3a'}`, color: '#4a9eff', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px' }}>
                            💬 Messages {messageCounts[b.bookingRef] > 0 && <span style={{ background: '#ff4444', color: '#fff', borderRadius: '50%', fontSize: '10px', fontWeight: '700', padding: '1px 5px' }}>{messageCounts[b.bookingRef]}</span>}
                          </button>
                        )}
                        {b.depositAmount && b.paymentStatus !== 'cancelled' && b.depositStatus !== 'released' && (
                          <button onClick={() => handleReleaseDeposit(b.bookingRef)} disabled={releasingId === b.bookingRef}
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

        {/* Listings */}
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
                      <div style={{ fontSize: '10px', color: '#555', marginBottom: '6px', fontWeight: '600' }}>ICAL EXPORT</div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <div style={{ flex: 1, background: '#111', border: '1px solid #333', borderRadius: '6px', padding: '6px 10px', fontSize: '11px', color: '#666', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{API}/ical/{p.id}</div>
                        <button onClick={() => copyICal(p.id)} style={{ background: copiedId === p.id ? '#0a1a0a' : '#1a1a1a', border: `1px solid ${copiedId === p.id ? '#00ff44' : '#333'}`, color: copiedId === p.id ? '#00ff44' : '#888', fontSize: '11px', padding: '6px 10px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600', whiteSpace: 'nowrap' }}>
                          {copiedId === p.id ? '✓ Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      {[['BOOKINGS', activeBookings.filter(b => b.propertyId === p.id || b.propertyId === String(p.id)).length, '#00ff44'],
                        ['REVENUE', `$${activeBookings.filter(b => b.propertyId === p.id || b.propertyId === String(p.id)).reduce((s, b) => s + (parseInt((b.breakdown?.totalPaid || '0').split(' ')[0].replace(/[^0-9]/g, '')) || 0), 0).toLocaleString()}`, '#4a9eff'],
                        ['ARIA FEE', '3%', '#00ff44']].map(([label, val, color]) => (
                        <div key={label} style={{ flex: 1, background: '#1a1a1a', borderRadius: '6px', padding: '8px', textAlign: 'center' }}>
                          <div style={{ fontSize: '10px', color: '#555', marginBottom: '2px' }}>{label}</div>
                          <div style={{ fontWeight: '700', color }}>{val}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Calendar */}
        {activeTab === 'calendar' && (
          <div>
            <div style={{ background: '#0a0a1a', border: '1px solid #1a1a3a', borderRadius: '12px', padding: '20px', marginBottom: '24px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: '600', margin: '0 0 8px' }}>📅 Two-Way Calendar Sync</h3>
              <p style={{ color: '#888', fontSize: '13px', margin: 0, lineHeight: '1.6' }}>Export your ARIA calendar to Airbnb/VRBO, and import their calendars here.</p>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {PROPERTIES.map(p => (
                <div key={p.id} style={{ background: '#111', border: '1px solid #222', borderRadius: '12px', padding: '20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                    <img src={p.image} alt={p.title} style={{ width: '48px', height: '48px', objectFit: 'cover', borderRadius: '8px' }} />
                    <div><div style={{ fontSize: '15px', fontWeight: '600' }}>{p.title}</div><div style={{ fontSize: '12px', color: '#666' }}>{p.location}</div></div>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                    <div style={{ background: '#1a1a1a', borderRadius: '8px', padding: '12px' }}>
                      <div style={{ fontSize: '11px', color: '#00ff44', fontWeight: '600', marginBottom: '6px' }}>↑ EXPORT</div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <div style={{ flex: 1, background: '#111', border: '1px solid #333', borderRadius: '6px', padding: '6px 8px', fontSize: '10px', color: '#666', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{API}/ical/{p.id}</div>
                        <button onClick={() => copyICal(p.id)} style={{ background: copiedId === p.id ? '#0a1a0a' : '#111', border: `1px solid ${copiedId === p.id ? '#00ff44' : '#333'}`, color: copiedId === p.id ? '#00ff44' : '#888', fontSize: '11px', padding: '6px 8px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}>{copiedId === p.id ? '✓' : 'Copy'}</button>
                      </div>
                    </div>
                    <div style={{ background: '#1a1a1a', borderRadius: '8px', padding: '12px' }}>
                      <div style={{ fontSize: '11px', color: '#4a9eff', fontWeight: '600', marginBottom: '6px' }}>↓ IMPORT</div>
                      <div style={{ display: 'flex', gap: '6px' }}>
                        <input value={icalInputs[p.id] || ''} onChange={e => setIcalInputs(prev => ({ ...prev, [p.id]: e.target.value }))} placeholder="https://airbnb.com/calendar/ical/..." style={{ flex: 1, background: '#111', border: '1px solid #333', borderRadius: '6px', padding: '6px 8px', fontSize: '10px', color: '#fff', outline: 'none' }} />
                        <button onClick={() => handleIcalImport(p.id)} disabled={icalSaving[p.id] || !icalInputs[p.id]} style={{ background: icalSaved[p.id] ? '#0a1a0a' : '#111', border: `1px solid ${icalSaved[p.id] ? '#00ff44' : '#333'}`, color: icalSaved[p.id] ? '#00ff44' : '#888', fontSize: '11px', padding: '6px 8px', borderRadius: '6px', cursor: 'pointer', fontWeight: '600' }}>{icalSaving[p.id] ? '...' : icalSaved[p.id] ? '✓' : 'Sync'}</button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Reviews */}
        {activeTab === 'reviews' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: '600', margin: 0 }}>Guest Reviews</h3>
              <span style={{ fontSize: '13px', color: '#666' }}>{reviews.length} total · avg {avgRating} ⭐</span>
            </div>
            {reviews.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 24px', background: '#111', borderRadius: '12px', border: '1px solid #222' }}>
                <div style={{ fontSize: '48px', marginBottom: '16px' }}>⭐</div>
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
                          <div style={{ fontSize: '12px', color: '#666' }}>{r.guestName} · {fmtDate(r.timestamp)}</div>
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

        {/* Tax */}
        {activeTab === 'tax' && (
          <div>
            <div style={{ background: '#0a0a0a', border: '1px solid #2a1a00', borderRadius: '12px', padding: '16px', marginBottom: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                <span style={{ fontSize: '16px' }}>⚖️</span>
                <span style={{ fontWeight: '600', fontSize: '14px', color: '#ffaa00' }}>Occupancy Tax Compliance</span>
              </div>
              <p style={{ color: '#888', fontSize: '12px', margin: 0, lineHeight: '1.6' }}>ARIA collects 8% occupancy tax on every booking. As the host, you are responsible for remitting these taxes to the appropriate local jurisdiction.</p>
            </div>
            {taxLoading ? (
              <div style={{ textAlign: 'center', padding: '60px', color: '#555' }}>Loading tax data...</div>
            ) : !taxData ? (
              <div style={{ textAlign: 'center', padding: '60px' }}>
                <button onClick={loadTaxData} style={{ background: '#00ff44', color: '#000', border: 'none', borderRadius: '8px', padding: '12px 24px', fontWeight: '700', cursor: 'pointer' }}>Load Tax Data</button>
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '16px', marginBottom: '24px' }}>
                  {[
                    { label: 'TOTAL COLLECTED', value: `$${taxData.summary.totalCollected.toLocaleString()}`, color: '#ffaa00', sub: `${taxData.summary.bookingCount} bookings` },
                    { label: 'REMITTED', value: `$${taxData.summary.totalRemitted.toLocaleString()}`, color: '#00ff44', sub: `${taxData.summary.remittedCount} bookings` },
                    { label: 'OUTSTANDING', value: `$${taxData.summary.totalOutstanding.toLocaleString()}`, color: taxData.summary.totalOutstanding > 0 ? '#ff4444' : '#555', sub: `${taxData.summary.pendingCount} pending` },
                    { label: 'TAX RATE', value: '8%', color: '#888', sub: 'occupancy tax' },
                  ].map((s, i) => (
                    <div key={i} style={{ background: '#111', border: `1px solid ${i === 2 && taxData.summary.totalOutstanding > 0 ? '#3a1a00' : '#222'}`, borderRadius: '12px', padding: '20px' }}>
                      <div style={{ fontSize: '10px', color: '#555', marginBottom: '8px', fontWeight: '600' }}>{s.label}</div>
                      <div style={{ fontSize: '24px', fontWeight: '700', color: s.color, marginBottom: '4px' }}>{s.value}</div>
                      <div style={{ fontSize: '11px', color: '#555' }}>{s.sub}</div>
                    </div>
                  ))}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    {['all', 'pending', 'remitted'].map(f => (
                      <button key={f} onClick={() => setTaxFilter(f)}
                        style={{ background: taxFilter === f ? '#ffaa00' : 'transparent', color: taxFilter === f ? '#000' : '#888', border: `1px solid ${taxFilter === f ? '#ffaa00' : '#333'}`, padding: '6px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>
                        {f === 'all' ? `All (${taxData.summary.bookingCount})` : f === 'pending' ? `Pending (${taxData.summary.pendingCount})` : `Remitted (${taxData.summary.remittedCount})`}
                      </button>
                    ))}
                  </div>
                  <button onClick={exportCSV} style={{ background: 'transparent', border: '1px solid #333', color: '#888', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>⬇ Export CSV</button>
                </div>
                {filteredTaxBookings.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '40px', background: '#111', borderRadius: '12px', border: '1px solid #222', color: '#555' }}>No bookings in this category</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {filteredTaxBookings.map((b, i) => (
                      <div key={i} style={{ background: '#111', border: `1px solid ${b.remitted ? '#1a2a1a' : '#2a1a00'}`, borderRadius: '12px', padding: '16px 20px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', flexWrap: 'wrap', gap: '8px' }}>
                          <div style={{ flex: 1, minWidth: '200px' }}>
                            <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '2px' }}>{b.property}</div>
                            <div style={{ fontSize: '12px', color: '#666', marginBottom: '4px' }}>{b.guestName} · {fmtDay(b.checkIn)} → {fmtDay(b.checkOut)} · {b.nights} night{b.nights > 1 ? 's' : ''}</div>
                            <div style={{ fontSize: '11px', color: '#555', fontFamily: 'monospace' }}>{b.bookingRef}</div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
                            <div style={{ textAlign: 'center' }}>
                              <div style={{ fontSize: '10px', color: '#555', marginBottom: '2px' }}>SUBTOTAL</div>
                              <div style={{ fontSize: '14px', fontWeight: '600' }}>${b.subtotal}</div>
                            </div>
                            <div style={{ textAlign: 'center' }}>
                              <div style={{ fontSize: '10px', color: '#555', marginBottom: '2px' }}>TAX (8%)</div>
                              <div style={{ fontSize: '16px', fontWeight: '700', color: '#ffaa00' }}>${b.taxAmount}</div>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                              {b.remitted ? (
                                <>
                                  <span style={{ background: '#0a1a0a', border: '1px solid #1a3a1a', color: '#00ff44', fontSize: '11px', fontWeight: '600', padding: '3px 10px', borderRadius: '20px' }}>✅ Remitted {b.remittedAt ? fmtDate(b.remittedAt) : ''}</span>
                                  {b.jurisdiction && <span style={{ fontSize: '11px', color: '#555' }}>{b.jurisdiction}</span>}
                                  <button onClick={() => handleUnremit(b.bookingRef)} style={{ background: 'transparent', border: '1px solid #333', color: '#555', fontSize: '10px', padding: '2px 8px', borderRadius: '4px', cursor: 'pointer' }}>Undo</button>
                                </>
                              ) : (
                                <button onClick={() => { setRemitModal(b); setRemitJurisdiction(''); setRemitNotes(''); }}
                                  style={{ background: '#ffaa00', color: '#000', border: 'none', borderRadius: '6px', padding: '6px 14px', fontSize: '12px', fontWeight: '700', cursor: 'pointer' }}>
                                  Mark Remitted
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Applications */}
        {activeTab === 'applications' && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
              <h3 style={{ fontSize: '16px', fontWeight: '600', margin: 0 }}>Host Applications</h3>
              <button onClick={() => loadApplications()} style={{ background: 'transparent', border: '1px solid #333', color: '#888', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>↻ Refresh</button>
            </div>

            {applicationsLoading ? (
              <div style={{ textAlign: 'center', padding: '60px', color: '#555' }}>Loading applications...</div>
            ) : applications.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '60px 24px', background: '#111', borderRadius: '12px', border: '1px solid #222' }}>
                <div style={{ fontSize: '48px', marginBottom: '16px' }}>👥</div>
                <h3 style={{ fontSize: '18px', fontWeight: '600', margin: '0 0 8px' }}>No applications yet</h3>
                <p style={{ color: '#666', fontSize: '14px', margin: 0 }}>Host applications will appear here when users sign up</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div style={{ display: 'flex', gap: '12px', marginBottom: '8px' }}>
                  {[
                    { label: 'TOTAL', value: applications.length, color: '#888' },
                    { label: 'PENDING', value: applications.filter(a => a.status === 'pending').length, color: '#ffaa00' },
                    { label: 'APPROVED', value: applications.filter(a => a.status === 'approved').length, color: '#00ff44' },
                  ].map((s, i) => (
                    <div key={i} style={{ background: '#111', border: '1px solid #222', borderRadius: '8px', padding: '12px 20px', textAlign: 'center' }}>
                      <div style={{ fontSize: '10px', color: '#555', marginBottom: '4px', fontWeight: '600' }}>{s.label}</div>
                      <div style={{ fontSize: '20px', fontWeight: '700', color: s.color }}>{s.value}</div>
                    </div>
                  ))}
                </div>

                {applications.map((a, i) => (
                  <div key={i} style={{ background: '#111', border: `1px solid ${a.status === 'pending' ? '#2a2000' : '#1a2a1a'}`, borderRadius: '12px', padding: '20px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', flexWrap: 'wrap', gap: '12px' }}>
                      <div style={{ flex: 1, minWidth: '200px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                          <div style={{ fontSize: '15px', fontWeight: '600' }}>{a.name}</div>
                          <span style={{
                            background: a.status === 'pending' ? '#1a1a00' : '#0a1a0a',
                            border: `1px solid ${a.status === 'pending' ? '#3a3000' : '#1a3a1a'}`,
                            color: a.status === 'pending' ? '#ffaa00' : '#00ff44',
                            fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px'
                          }}>
                            {a.status === 'pending' ? '⏳ Pending' : '✅ Approved'}
                          </span>
                        </div>
                        <div style={{ fontSize: '13px', color: '#888', marginBottom: '4px' }}>{a.email}</div>
                        {a.city && <div style={{ fontSize: '12px', color: '#666', marginBottom: '4px' }}>📍 {a.city}{a.state ? ', ' + a.state : ''}{a.jurisdiction ? ` · ${a.jurisdiction}` : ''}</div>}
                        {a.str_permit && <div style={{ fontSize: '12px', color: '#666', marginBottom: '4px' }}>🪪 STR Permit: {a.str_permit}</div>}
                        <div style={{ fontSize: '11px', color: '#555', fontFamily: 'monospace', marginTop: '4px' }}>{a.sui_address}</div>
                        <div style={{ fontSize: '11px', color: '#555', marginTop: '4px' }}>Applied {fmtDateTime(a.created_at)}</div>
                        {a.approved_at && <div style={{ fontSize: '11px', color: '#00ff44', marginTop: '2px' }}>Approved {fmtDateTime(a.approved_at)}</div>}
                      </div>

                      {a.status === 'pending' && (
                        <button onClick={() => handleApprove(a.sui_address, a.name)} disabled={approvingId === a.sui_address}
                          style={{ background: approvingId === a.sui_address ? '#333' : '#00ff44', color: approvingId === a.sui_address ? '#555' : '#000', border: 'none', borderRadius: '8px', padding: '10px 20px', fontSize: '13px', fontWeight: '700', cursor: approvingId === a.sui_address ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
                          {approvingId === a.sui_address ? 'Approving...' : '✅ Approve Host'}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

      </div>

      {/* Remit Modal */}
      {remitModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '24px' }}>
          <div style={{ background: '#111', border: '1px solid #333', borderRadius: '16px', width: '100%', maxWidth: '480px', padding: '32px' }}>
            <h3 style={{ margin: '0 0 4px', fontSize: '20px', fontWeight: '700' }}>Mark Tax as Remitted</h3>
            <p style={{ color: '#666', fontSize: '14px', margin: '0 0 20px' }}>{remitModal.property} · {fmtDay(remitModal.checkIn)}</p>
            <div style={{ background: '#1a1a0a', border: '1px solid #3a3a00', borderRadius: '8px', padding: '12px', marginBottom: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ color: '#888', fontSize: '13px' }}>Subtotal</span>
                <span style={{ fontSize: '13px' }}>${remitModal.subtotal}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#ffaa00', fontSize: '14px', fontWeight: '600' }}>Occupancy Tax (8%)</span>
                <span style={{ color: '#ffaa00', fontSize: '16px', fontWeight: '700' }}>${remitModal.taxAmount}</span>
              </div>
            </div>
            <div style={{ marginBottom: '16px' }}>
              <div style={{ fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: '600' }}>JURISDICTION (optional)</div>
              <input value={remitJurisdiction} onChange={e => setRemitJurisdiction(e.target.value)} placeholder="e.g. Miami-Dade County, FL"
                style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', borderRadius: '8px', padding: '10px 12px', color: '#fff', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <div style={{ marginBottom: '24px' }}>
              <div style={{ fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: '600' }}>NOTES (optional)</div>
              <input value={remitNotes} onChange={e => setRemitNotes(e.target.value)} placeholder="e.g. Confirmation #12345"
                style={{ width: '100%', background: '#1a1a1a', border: '1px solid #333', borderRadius: '8px', padding: '10px 12px', color: '#fff', fontSize: '13px', outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button onClick={() => setRemitModal(null)} style={{ flex: 1, background: 'transparent', border: '1px solid #333', color: '#888', borderRadius: '8px', padding: '12px', fontSize: '14px', cursor: 'pointer' }}>Cancel</button>
              <button onClick={handleRemit} disabled={!!remittingId}
                style={{ flex: 2, background: remittingId ? '#333' : '#ffaa00', color: remittingId ? '#555' : '#000', border: 'none', borderRadius: '8px', padding: '12px', fontSize: '14px', fontWeight: '700', cursor: remittingId ? 'not-allowed' : 'pointer' }}>
                {remittingId ? 'Recording...' : `Confirm Remittance — $${remitModal.taxAmount}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
