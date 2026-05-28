import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const getStoredSid = () => { try { return localStorage.getItem('aria_sid') || ''; } catch { return ''; } };
const authFetch = (url, options = {}) => {
  const sid = getStoredSid();
  const headers = { ...(options.headers || {}) };
  if (sid) headers['x-session-id'] = sid;
  return fetch(url, { ...options, credentials: 'include', headers });
};

const PROPERTIES = [
  {
    id: 1, title: 'Oceanfront Villa', location: 'Miami Beach, FL', price: 285, rating: 4.97, reviews: 124,
    image: 'https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=800&q=80','https://images.unsplash.com/photo-1502005229762-cf1b2da7c5d6?w=800&q=80','https://images.unsplash.com/photo-1615571022219-eb45cf7faa9d?w=800&q=80','https://images.unsplash.com/photo-1571003123894-1f0594d2b5d9?w=800&q=80','https://images.unsplash.com/photo-1584132967334-10e028bd69f7?w=800&q=80'],
    beds: 4, baths: 3, tag: 'Beachfront'
  },
  {
    id: 2, title: 'Downtown Loft', location: 'Austin, TX', price: 145, rating: 4.89, reviews: 87,
    image: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800&q=80','https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&q=80','https://images.unsplash.com/photo-1484154218962-a197022b5858?w=800&q=80','https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=800&q=80','https://images.unsplash.com/photo-1507089947368-19c1da9775ae?w=800&q=80'],
    beds: 2, baths: 1, tag: 'City View'
  },
  {
    id: 3, title: 'Mountain Cabin', location: 'Asheville, NC', price: 195, rating: 4.95, reviews: 203,
    image: 'https://images.unsplash.com/photo-1542718610-a1d656d1884c?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1542718610-a1d656d1884c?w=800&q=80','https://images.unsplash.com/photo-1518780664697-55e3ad937233?w=800&q=80','https://images.unsplash.com/photo-1510798831971-661eb04b3739?w=800&q=80','https://images.unsplash.com/photo-1506974210756-8e1b8985d348?w=800&q=80','https://images.unsplash.com/photo-1449158743715-0a90ebb6d2d8?w=800&q=80'],
    beds: 3, baths: 2, tag: 'Nature'
  },
  {
    id: 4, title: 'Desert Retreat', location: 'Scottsdale, AZ', price: 225, rating: 4.92, reviews: 156,
    image: 'https://images.unsplash.com/photo-1613977257363-707ba9348227?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1613977257363-707ba9348227?w=800&q=80','https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800&q=80','https://images.unsplash.com/photo-1571055107559-3e67626fa8be?w=800&q=80','https://images.unsplash.com/photo-1596394516093-501ba68a0ba6?w=800&q=80','https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?w=800&q=80'],
    beds: 3, baths: 2, tag: 'Pool'
  },
  {
    id: 5, title: 'Lake House', location: 'Lake Tahoe, CA', price: 320, rating: 4.98, reviews: 91,
    image: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=800&q=80','https://images.unsplash.com/photo-1601918774946-25832a4be0d6?w=800&q=80','https://images.unsplash.com/photo-1505916349660-8d91a99f56e0?w=800&q=80','https://images.unsplash.com/photo-1571492913491-50e0083303f4?w=800&q=80','https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800&q=80'],
    beds: 5, baths: 4, tag: 'Waterfront'
  },
  {
    id: 6, title: 'Historic Brownstone', location: 'Brooklyn, NY', price: 175, rating: 4.85, reviews: 312,
    image: 'https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=800&q=80','https://images.unsplash.com/photo-1555636222-cae831e670b3?w=800&q=80','https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800&q=80','https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?w=800&q=80','https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800&q=80'],
    beds: 2, baths: 2, tag: 'Historic'
  },
];

const WHY_ARIA = [
  { icon: '🔑', title: 'Your Wallet, Your Control', desc: 'ARIA never holds your funds. Payments execute directly on the Sui blockchain — no middleman, no delays.' },
  { icon: '⚡', title: 'Instant Settlement', desc: 'Hosts receive payouts in seconds, not days. No 3–5 day bank holds. No Airbnb holding your money.' },
  { icon: '🔒', title: 'On-Chain Escrow', desc: 'Security deposits are held by smart contract — not by ARIA. Released automatically when you approve.' },
  { icon: '✅', title: 'You Approve Everything', desc: 'Cancellations, deposit releases, and payouts all require your action. We never act on your behalf.' },
  { icon: '📋', title: 'Permanent Audit Trail', desc: 'Every booking and payment is stored immutably on Walrus. Your receipts exist forever, independently of ARIA.' },
  { icon: '💸', title: '3% vs 15%', desc: 'Airbnb takes up to 15%. ARIA takes 3% — only on your stay cost, never on your deposit.' },
];

export default function Home() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [booking, setBooking] = useState(null);
  const [bookingLoading, setBookingLoading] = useState(false);
  const [checkIn, setCheckIn] = useState(null);
  const [checkOut, setCheckOut] = useState(null);
  const [searchLocation, setSearchLocation] = useState('All Locations');
  const [searchCheckIn, setSearchCheckIn] = useState(null);
  const [searchCheckOut, setSearchCheckOut] = useState(null);
  const [filteredProperties, setFilteredProperties] = useState(PROPERTIES);
  const [searched, setSearched] = useState(false);
  const [liveRatings, setLiveRatings] = useState({});
  const [photoIndex, setPhotoIndex] = useState(0);
  const [termsAccepted, setTermsAccepted] = useState(false);

  const nights = checkIn && checkOut ? Math.round((checkOut - checkIn) / (1000 * 60 * 60 * 24)) : 0;

  const getSubtotal    = (p, n) => p.price * n;
  const getAriaFee     = (p, n) => Math.round(getSubtotal(p, n) * 0.03);
  const getTax         = (p, n) => Math.round(getSubtotal(p, n) * 0.08);
  const getBookingTotal= (p, n) => getSubtotal(p, n) + getAriaFee(p, n) + getTax(p, n);
  const getDeposit     = (p, n) => Math.round(getBookingTotal(p, n) * 0.20);
  const getChargeTotal = (p, n) => getBookingTotal(p, n) + getDeposit(p, n);
  const getCardTotal   = (p, n) => (getChargeTotal(p, n) * 1.029 + 0.30).toFixed(2);
  const getCardFee     = (p, n) => (getChargeTotal(p, n) * 0.029 + 0.30).toFixed(2);

  const openModal  = (p) => { setSelected(p); setBooking(null); setCheckIn(null); setCheckOut(null); setPhotoIndex(0); setTermsAccepted(false); };
  const closeModal = () => { setSelected(null); setBooking(null); setCheckIn(null); setCheckOut(null); setPhotoIndex(0); setTermsAccepted(false); };

  const handleSearch = () => {
    let results = PROPERTIES;
    if (searchLocation !== 'All Locations') results = results.filter(p => p.location === searchLocation);
    setFilteredProperties(results);
    setSearched(true);
  };

  const handleClearSearch = () => {
    setSearchLocation('All Locations'); setSearchCheckIn(null); setSearchCheckOut(null);
    setFilteredProperties(PROPERTIES); setSearched(false);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sid = params.get('sid');
    if (sid) { try { localStorage.setItem('aria_sid', sid); } catch {} window.history.replaceState({}, '', '/'); }

    authFetch(`${API}/auth/me`)
      .then(res => res.json())
      .then(data => { if (data.address) setUser(data); setLoading(false); })
      .catch(() => setLoading(false));

    Promise.all(PROPERTIES.map(p =>
      fetch(`${API}/reviews/${p.id}`).then(r => r.json()).then(d => ({ id: p.id, rating: d.averageRating, count: d.count })).catch(() => ({ id: p.id, rating: 0, count: 0 }))
    )).then(results => {
      const ratings = {};
      results.forEach(r => { ratings[r.id] = { rating: r.rating, count: r.count }; });
      setLiveRatings(ratings);
    });
  }, []);

  const getDisplayRating = (p) => {
    const live = liveRatings[p.id];
    if (live && live.count > 0) return { rating: live.rating.toFixed(2), count: live.count, isLive: true };
    return { rating: p.rating, count: p.reviews, isLive: false };
  };

  const handleLogin = async () => {
    const res = await fetch(`${API}/auth/zklogin/init`);
    const { url } = await res.json();
    window.location.href = url;
  };

  const handleLogout = async () => {
    await authFetch(`${API}/auth/logout`);
    try { localStorage.removeItem('aria_sid'); } catch {}
    setUser(null);
  };

  const handleBooking = async () => {
    if (!checkIn || !checkOut) { alert('Please select check-in and check-out dates'); return; }
    if (nights < 1) { alert('Check-out must be after check-in'); return; }
    setBookingLoading(true);
    const res = await authFetch(`${API}/booking/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ propertyId: selected.id, propertyTitle: selected.title, pricePerNight: selected.price, nights, totalAmount: getBookingTotal(selected, nights), checkIn: checkIn.toISOString().split('T')[0], checkOut: checkOut.toISOString().split('T')[0] })
    });
    const data = await res.json();
    if (data.error === 'Property not available for selected dates') { alert('Sorry — those dates are already booked. Please select different dates.'); setBookingLoading(false); return; }
    setBooking(data);
    setBookingLoading(false);
  };

  const handleCardPayment = async () => {
    if (!checkIn || !checkOut) { alert('Please select check-in and check-out dates'); return; }
    setBookingLoading(true);
    const res = await authFetch(`${API}/payment/create-intent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: getChargeTotal(selected, nights), propertyTitle: selected.title }) });
    const data = await res.json();
    if (data.clientSecret) { setBooking({ bookingRef: 'STRIPE-' + Date.now(), stripeIntent: true }); }
    setBookingLoading(false);
  };

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a0a', color: '#fff' }}>Loading...</div>;

  if (!user) return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', display: 'flex', flexDirection: 'column' }}>
      {/* Login hero */}
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 24px' }}>
        <div style={{ width: '100%', maxWidth: '420px' }}>
          <div style={{ textAlign: 'center', marginBottom: '40px' }}>
            <div style={{ fontSize: '48px', marginBottom: '12px' }}>🏠</div>
            <h1 style={{ color: '#fff', fontSize: '32px', fontWeight: '700', margin: '0 0 8px' }}>ARIA</h1>
            <p style={{ color: '#666', fontSize: '14px', margin: '0 0 4px' }}>Vacation Rental Platform — Built on Sui</p>
            <p style={{ color: '#ccc', fontSize: '15px', lineHeight: '1.6', margin: '0 0 32px' }}>The Airbnb killer. Lower fees. Instant settlement. You stay in control.</p>
            <button onClick={handleLogin} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', width: '100%', padding: '14px', background: '#fff', color: '#000', border: 'none', borderRadius: '8px', fontSize: '15px', fontWeight: '600', cursor: 'pointer' }}>
              <span>G</span> Sign in with Google
            </button>
            <p style={{ color: '#555', fontSize: '12px', marginTop: '12px' }}>No wallet needed. No seed phrase. Just Google.</p>
          </div>

          {/* Why ARIA — shown on login screen */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {WHY_ARIA.slice(0, 3).map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'start', gap: '12px', background: '#111', border: '1px solid #222', borderRadius: '10px', padding: '14px' }}>
                <span style={{ fontSize: '20px', flexShrink: 0 }}>{item.icon}</span>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: '600', color: '#fff', marginBottom: '2px' }}>{item.title}</div>
                  <div style={{ fontSize: '12px', color: '#666', lineHeight: '1.5' }}>{item.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* Footer */}
      <div style={{ borderTop: '1px solid #1a1a1a', padding: '20px 24px', textAlign: 'center' }}>
        <p style={{ color: '#444', fontSize: '11px', margin: 0, lineHeight: '1.7' }}>
          ⚠️ ARIA is a non-custodial platform. We do not hold your funds. All payments execute directly on the Sui blockchain. ARIA has no ability to reverse, freeze, or recover transactions. You are solely responsible for your wallet and transactions.
        </p>
        <p style={{ color: '#333', fontSize: '11px', margin: '6px 0 0' }}>© 2026 ARIA · Built on Sui · Powered by DeepBook & Walrus</p>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#fff', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        .react-datepicker { background: #1a1a1a !important; border: 1px solid #333 !important; color: #fff !important; }
        .react-datepicker__header { background: #111 !important; border-bottom: 1px solid #333 !important; }
        .react-datepicker__current-month, .react-datepicker__day-name { color: #fff !important; }
        .react-datepicker__day { color: #ccc !important; }
        .react-datepicker__day:hover { background: #333 !important; color: #fff !important; }
        .react-datepicker__day--selected, .react-datepicker__day--in-range { background: #00ff44 !important; color: #000 !important; }
        .react-datepicker__day--keyboard-selected { background: #00cc33 !important; color: #000 !important; }
        .react-datepicker__day--disabled { color: #444 !important; }
        .react-datepicker__navigation-icon::before { border-color: #fff !important; }
        .react-datepicker-wrapper { width: 100%; }
        .date-input { width: 100%; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 10px 14px; color: #fff; font-size: 14px; outline: none; cursor: pointer; box-sizing: border-box; }
        .property-img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.3s ease; }
        .property-card:hover .property-img { transform: scale(1.05); }
        .gallery-arrow { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(0,0,0,0.55); border: none; color: #fff; font-size: 22px; cursor: pointer; border-radius: 50%; width: 38px; height: 38px; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px); transition: background 0.15s; z-index: 2; }
        .gallery-arrow:hover { background: rgba(0,0,0,0.85); }
        .gallery-thumb { flex: 1; height: 54px; overflow: hidden; cursor: pointer; border-radius: 4px; transition: opacity 0.15s, border-color 0.15s; }
        .gallery-thumb:hover { opacity: 1 !important; }
        .gallery-dot { border: none; cursor: pointer; padding: 0; border-radius: 4px; transition: all 0.2s ease; }
      `}</style>

      {/* Header */}
      <div style={{ background: '#111', borderBottom: '1px solid #222', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '60px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '20px' }}>🏠</span>
          <span style={{ fontWeight: '700', fontSize: '18px' }}>ARIA</span>
          <span style={{ background: '#00ff44', color: '#000', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px', marginLeft: '4px' }}>BETA</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '13px', fontWeight: '500' }}>{user.name}</div>
            <div style={{ fontSize: '11px', color: '#00ff44', fontFamily: 'monospace' }}>{user.address.slice(0, 8)}...{user.address.slice(-6)}</div>
          </div>
          <button onClick={() => router.push('/bookings')} style={{ background: 'transparent', border: '1px solid #333', color: '#888', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>My Bookings</button>
          {user.isHost && <button onClick={() => router.push('/host')} style={{ background: 'transparent', border: '1px solid #333', color: '#888', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>Host Dashboard</button>}
          {!user.isHost && user.hostStatus !== 'pending' && (
            <button onClick={() => router.push('/become-host')} style={{ background: 'transparent', border: '1px solid #00ff44', color: '#00ff44', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: '600' }}>🏡 Become a Host</button>
          )}
          {user.hostStatus === 'pending' && <span style={{ fontSize: '12px', color: '#ffaa00', fontWeight: '600' }}>⏳ Application Pending</span>}
          <button onClick={() => router.push('/ai')} style={{ background: 'transparent', border: '1px solid #2a1a3a', color: '#aa44ff', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: '600' }}>🤖 AI</button>
          <button onClick={handleLogout} style={{ background: 'transparent', border: '1px solid #333', color: '#888', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>Sign out</button>
        </div>
      </div>

      {/* Hero / Search */}
      <div style={{ background: 'linear-gradient(180deg,#111 0%,#0a0a0a 100%)', padding: '40px 24px', textAlign: 'center' }}>
        <h2 style={{ fontSize: '28px', fontWeight: '700', margin: '0 0 8px' }}>Find your perfect stay</h2>
        <p style={{ color: '#666', fontSize: '14px', margin: '0 0 24px' }}>Book instantly. Pay with SuiUSD. You stay in control — always.</p>
        <div style={{ display: 'flex', gap: '8px', maxWidth: '700px', margin: '0 auto', flexWrap: 'wrap' }}>
          <select value={searchLocation} onChange={e => setSearchLocation(e.target.value)}
            style={{ flex: 2, minWidth: '180px', background: '#1a1a1a', border: '1px solid #333', borderRadius: '8px', padding: '12px 16px', color: '#fff', fontSize: '14px', outline: 'none', cursor: 'pointer' }}>
            <option value="All Locations">📍 Where are you going?</option>
            <option value="Miami Beach, FL">📍 Miami Beach, FL</option>
            <option value="Austin, TX">📍 Austin, TX</option>
            <option value="Asheville, NC">📍 Asheville, NC</option>
            <option value="Scottsdale, AZ">📍 Scottsdale, AZ</option>
            <option value="Lake Tahoe, CA">📍 Lake Tahoe, CA</option>
            <option value="Brooklyn, NY">📍 Brooklyn, NY</option>
          </select>
          <div style={{ flex: 1, minWidth: '130px' }}>
            <DatePicker selected={searchCheckIn} onChange={date => setSearchCheckIn(date)} minDate={new Date()} placeholderText="📅 Check-in" dateFormat="MMM d" className="date-input" />
          </div>
          <div style={{ flex: 1, minWidth: '130px' }}>
            <DatePicker selected={searchCheckOut} onChange={date => setSearchCheckOut(date)} minDate={searchCheckIn ? new Date(searchCheckIn.getTime() + 86400000) : new Date()} placeholderText="📅 Check-out" dateFormat="MMM d" className="date-input" />
          </div>
          <button onClick={handleSearch} style={{ background: '#00ff44', color: '#000', border: 'none', borderRadius: '8px', padding: '12px 24px', fontWeight: '700', fontSize: '14px', cursor: 'pointer' }}>Search</button>
        </div>
        {searched && (
          <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
            <span style={{ fontSize: '13px', color: '#888' }}>{filteredProperties.length} propert{filteredProperties.length === 1 ? 'y' : 'ies'} found{searchLocation !== 'All Locations' ? ` in ${searchLocation}` : ''}</span>
            <button onClick={handleClearSearch} style={{ background: 'transparent', border: '1px solid #444', color: '#888', padding: '4px 10px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>Clear</button>
          </div>
        )}
      </div>

      {/* Why ARIA section */}
      <div style={{ background: '#0a0a0a', borderTop: '1px solid #1a1a1a', borderBottom: '1px solid #1a1a1a', padding: '48px 24px' }}>
        <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '32px' }}>
            <h2 style={{ fontSize: '22px', fontWeight: '700', margin: '0 0 8px' }}>Why ARIA?</h2>
            <p style={{ color: '#666', fontSize: '14px', margin: 0 }}>Unlike Airbnb, you stay in control of your money — always.</p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
            {WHY_ARIA.map((item, i) => (
              <div key={i} style={{ background: '#111', border: '1px solid #222', borderRadius: '12px', padding: '20px', display: 'flex', alignItems: 'start', gap: '14px' }}>
                <span style={{ fontSize: '24px', flexShrink: 0 }}>{item.icon}</span>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: '600', color: '#fff', marginBottom: '6px' }}>{item.title}</div>
                  <div style={{ fontSize: '13px', color: '#666', lineHeight: '1.6' }}>{item.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Property Grid */}
      <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '32px 24px', flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <h3 style={{ fontSize: '18px', fontWeight: '600', margin: 0 }}>Featured Properties</h3>
          <span style={{ fontSize: '13px', color: '#666' }}>{filteredProperties.length} properties available</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(320px,1fr))', gap: '20px' }}>
          {filteredProperties.map(p => {
            const { rating, count, isLive } = getDisplayRating(p);
            return (
              <div key={p.id} className="property-card" onClick={() => openModal(p)}
                style={{ background: '#111', border: '1px solid #222', borderRadius: '12px', overflow: 'hidden', cursor: 'pointer', transition: 'border-color 0.2s' }}
                onMouseEnter={e => e.currentTarget.style.borderColor = '#444'}
                onMouseLeave={e => e.currentTarget.style.borderColor = '#222'}>
                <div style={{ height: '200px', background: '#1a1a1a', overflow: 'hidden', position: 'relative' }}>
                  <img src={p.image} alt={p.title} className="property-img" />
                  <span style={{ position: 'absolute', top: '12px', left: '12px', background: 'rgba(0,0,0,0.7)', color: '#fff', fontSize: '11px', fontWeight: '600', padding: '4px 10px', borderRadius: '6px', backdropFilter: 'blur(4px)' }}>{p.tag}</span>
                  {isLive && <span style={{ position: 'absolute', top: '12px', right: '12px', background: 'rgba(170,68,255,0.85)', color: '#fff', fontSize: '10px', fontWeight: '700', padding: '3px 8px', borderRadius: '6px' }}>ARIA VERIFIED</span>}
                  <span style={{ position: 'absolute', bottom: '10px', right: '10px', background: 'rgba(0,0,0,0.65)', color: '#fff', fontSize: '10px', fontWeight: '600', padding: '3px 8px', borderRadius: '6px', backdropFilter: 'blur(4px)' }}>📷 {p.images.length}</span>
                </div>
                <div style={{ padding: '16px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '4px' }}>
                    <h4 style={{ margin: 0, fontSize: '15px', fontWeight: '600' }}>{p.title}</h4>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px' }}>
                      <span style={{ color: isLive ? '#aa44ff' : '#888' }}>★</span>
                      <span style={{ color: isLive ? '#aa44ff' : '#fff', fontWeight: isLive ? '700' : '400' }}>{rating}</span>
                      <span style={{ color: '#555', fontSize: '11px' }}>({count})</span>
                    </div>
                  </div>
                  <p style={{ color: '#666', fontSize: '13px', margin: '0 0 12px' }}>{p.location}</p>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ fontSize: '13px', color: '#555' }}>{p.beds} beds · {p.baths} baths</div>
                    <div><span style={{ fontSize: '17px', fontWeight: '700' }}>${p.price}</span><span style={{ color: '#666', fontSize: '13px' }}>/night</span></div>
                  </div>
                  <div style={{ marginTop: '12px', display: 'flex', gap: '8px' }}>
                    {[['ARIA FEE','3%','#00ff44'],['AIRBNB FEE','15%','#ff4444'],['SETTLEMENT','instant','#4a9eff']].map(([label,val,color]) => (
                      <div key={label} style={{ flex: 1, background: '#1a1a1a', borderRadius: '6px', padding: '8px', textAlign: 'center' }}>
                        <div style={{ fontSize: '10px', color: '#555', marginBottom: '2px' }}>{label}</div>
                        <div style={{ fontSize: '13px', fontWeight: '600', color }}>{val}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer */}
      <div style={{ borderTop: '1px solid #1a1a1a', padding: '24px', textAlign: 'center', marginTop: 'auto' }}>
        <p style={{ color: '#444', fontSize: '11px', margin: '0 0 6px', lineHeight: '1.7', maxWidth: '700px', marginLeft: 'auto', marginRight: 'auto' }}>
          ⚠️ ARIA is a non-custodial platform. We do not hold your funds. All payments execute directly on the Sui blockchain. ARIA has no ability to reverse, freeze, or recover transactions. You are solely responsible for your wallet and transactions.
        </p>
        <p style={{ color: '#333', fontSize: '11px', margin: 0 }}>© 2026 ARIA · Built on Sui · Powered by DeepBook & Walrus · <span style={{ color: '#444' }}>Non-custodial · You stay in control</span> · <span onClick={() => router.push('/terms')} style={{ color: '#444', cursor: 'pointer', textDecoration: 'underline' }}>Terms of Service</span></p>
      </div>

      {/* Booking Modal */}
      {selected && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '24px' }}
          onClick={e => { if (e.target === e.currentTarget) closeModal(); }}>
          <div style={{ background: '#111', border: '1px solid #333', borderRadius: '16px', width: '100%', maxWidth: '500px', maxHeight: '92vh', overflowY: 'auto' }}>
            <div style={{ borderRadius: '16px 16px 0 0', position: 'relative', background: '#000' }}>
              <div style={{ height: '260px', overflow: 'hidden', position: 'relative' }}>
                <img src={selected.images[photoIndex]} alt={selected.title} style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'opacity 0.2s ease' }} />
                <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, transparent 45%, rgba(0,0,0,0.85) 100%)' }} />
                <button onClick={closeModal} style={{ position: 'absolute', top: '12px', right: '12px', background: 'rgba(0,0,0,0.6)', border: 'none', color: '#fff', fontSize: '20px', cursor: 'pointer', borderRadius: '50%', width: '34px', height: '34px', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)', zIndex: 3 }}>×</button>
                <div style={{ position: 'absolute', top: '12px', left: '12px', background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: '11px', fontWeight: '600', padding: '4px 10px', borderRadius: '6px', backdropFilter: 'blur(4px)', zIndex: 3 }}>{photoIndex + 1} / {selected.images.length}</div>
                {photoIndex > 0 && <button className="gallery-arrow" onClick={e => { e.stopPropagation(); setPhotoIndex(i => i - 1); }} style={{ left: '12px' }}>‹</button>}
                {photoIndex < selected.images.length - 1 && <button className="gallery-arrow" onClick={e => { e.stopPropagation(); setPhotoIndex(i => i + 1); }} style={{ right: '12px' }}>›</button>}
                <div style={{ position: 'absolute', bottom: '50px', left: '50%', transform: 'translateX(-50%)', display: 'flex', gap: '6px', zIndex: 3 }}>
                  {selected.images.map((_, i) => (
                    <button key={i} className="gallery-dot" onClick={e => { e.stopPropagation(); setPhotoIndex(i); }} style={{ width: i === photoIndex ? '22px' : '8px', height: '8px', background: i === photoIndex ? '#fff' : 'rgba(255,255,255,0.45)' }} />
                  ))}
                </div>
                <div style={{ position: 'absolute', bottom: '16px', left: '16px', zIndex: 3 }}>
                  <h3 style={{ margin: '0 0 4px', fontSize: '20px', color: '#fff', fontWeight: '700' }}>{selected.title}</h3>
                  <p style={{ color: '#ccc', margin: 0, fontSize: '14px' }}>{selected.location}</p>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '4px', padding: '4px', background: '#000' }}>
                {selected.images.map((img, i) => (
                  <div key={i} className="gallery-thumb" onClick={e => { e.stopPropagation(); setPhotoIndex(i); }} style={{ border: i === photoIndex ? '2px solid #00ff44' : '2px solid transparent', opacity: i === photoIndex ? 1 : 0.5 }}>
                    <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  </div>
                ))}
              </div>
            </div>

            <div style={{ padding: '24px' }}>
              <div style={{ marginBottom: '20px' }}>
                <div style={{ fontSize: '13px', color: '#888', marginBottom: '8px', fontWeight: '600' }}>SELECT YOUR DATES</div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '11px', color: '#555', marginBottom: '4px' }}>CHECK-IN</div>
                    <DatePicker selected={checkIn} onChange={date => { setCheckIn(date); if (checkOut && date >= checkOut) setCheckOut(null); }} selectsStart startDate={checkIn} endDate={checkOut} minDate={new Date()} placeholderText="Select date" dateFormat="MMM d, yyyy" className="date-input" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '11px', color: '#555', marginBottom: '4px' }}>CHECK-OUT</div>
                    <DatePicker selected={checkOut} onChange={date => setCheckOut(date)} selectsEnd startDate={checkIn} endDate={checkOut} minDate={checkIn ? new Date(checkIn.getTime() + 86400000) : new Date()} placeholderText="Select date" dateFormat="MMM d, yyyy" className="date-input" />
                  </div>
                </div>
                {checkIn && checkOut && nights > 0 && <div style={{ marginTop: '8px', fontSize: '13px', color: '#00ff44', textAlign: 'center' }}>{nights} night{nights > 1 ? 's' : ''} selected</div>}
              </div>

              {checkIn && checkOut && nights > 0 && (
                <div style={{ background: '#1a1a1a', borderRadius: '8px', padding: '16px', marginBottom: '20px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ color: '#888', fontSize: '14px' }}>${selected.price} × {nights} night{nights > 1 ? 's' : ''}</span>
                    <span style={{ fontSize: '14px' }}>${getSubtotal(selected, nights)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ color: '#888', fontSize: '14px' }}>ARIA fee (3% of stay cost)</span>
                    <span style={{ fontSize: '14px', color: '#00ff44' }}>${getAriaFee(selected, nights)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', paddingBottom: '12px', borderBottom: '1px solid #333' }}>
                    <span style={{ color: '#888', fontSize: '14px' }}>Occupancy tax (8%)</span>
                    <span style={{ fontSize: '14px', color: '#888' }}>${getTax(selected, nights)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <span style={{ fontSize: '14px', fontWeight: '600', color: '#fff' }}>Stay total</span>
                    <span style={{ fontSize: '14px', fontWeight: '700', color: '#00ff44' }}>${getBookingTotal(selected, nights)}</span>
                  </div>
                  <div style={{ background: '#0a0a1a', border: '1px solid #1a1a3a', borderRadius: '6px', padding: '10px', marginBottom: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ fontSize: '13px', color: '#4a9eff', fontWeight: '600' }}>🔒 Refundable security deposit</span>
                      <span style={{ fontSize: '13px', color: '#4a9eff', fontWeight: '700' }}>${getDeposit(selected, nights)}</span>
                    </div>
                    <p style={{ color: '#555', fontSize: '11px', margin: 0, lineHeight: '1.5' }}>Held by smart contract on Sui — not by ARIA. Released when you approve.</p>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#0d0d0d', border: '1px solid #333', borderRadius: '6px', padding: '12px', marginBottom: '12px' }}>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: '700', color: '#fff' }}>Total charged today</div>
                      <div style={{ fontSize: '11px', color: '#555', marginTop: '2px' }}>Stay + refundable deposit</div>
                    </div>
                    <span style={{ fontSize: '20px', fontWeight: '700', color: '#fff' }}>${getChargeTotal(selected, nights)}</span>
                  </div>
                  <div style={{ background: '#0a1a0a', border: '1px solid #1a3a1a', borderRadius: '6px', padding: '10px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ fontSize: '12px', color: '#00ff44', fontWeight: '600' }}>Pay with SuiUSD</span>
                      <span style={{ fontSize: '11px', color: '#555' }}>recommended</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ color: '#666', fontSize: '12px' }}>Gas fee ~$0.02</span>
                      <span style={{ fontWeight: '700', fontSize: '16px', color: '#00ff44' }}>${getChargeTotal(selected, nights)}<span style={{ fontSize: '11px', color: '#555' }}>.02</span></span>
                    </div>
                  </div>
                  <div style={{ background: '#1a1212', border: '1px solid #2a1a1a', borderRadius: '6px', padding: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ fontSize: '12px', color: '#ff6666', fontWeight: '600' }}>Pay with Card</span>
                      <span style={{ fontSize: '11px', color: '#555' }}>Stripe 2.9% + $0.30</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ color: '#666', fontSize: '12px' }}>Processing fee ${getCardFee(selected, nights)}</span>
                      <span style={{ fontWeight: '700', fontSize: '16px', color: '#ff6666' }}>${getCardTotal(selected, nights)}</span>
                    </div>
                  </div>
                </div>
              )}

              {(!checkIn || !checkOut) ? (
                <div style={{ background: '#1a1a0a', border: '1px solid #333a00', borderRadius: '8px', padding: '12px', marginBottom: '20px', fontSize: '13px', color: '#888', textAlign: 'center' }}>
                  👆 Select your dates above to see pricing
                </div>
              ) : (
                <>
                  {/* Non-custodial disclaimer in booking flow */}
                  <div style={{ background: '#0a0a0a', border: '1px solid #1a1a1a', borderRadius: '8px', padding: '12px', marginBottom: '12px' }}>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
                      {['🔑 Your wallet, your funds','⚡ Instant on-chain settlement','✅ You control deposit release'].map((item, i) => (
                        <span key={i} style={{ background: '#111', border: '1px solid #222', borderRadius: '20px', padding: '3px 10px', fontSize: '11px', color: '#888' }}>{item}</span>
                      ))}
                    </div>
                    <p style={{ color: '#444', fontSize: '11px', margin: 0, lineHeight: '1.6' }}>
                      ARIA is non-custodial. Payments execute directly on Sui. We cannot reverse or freeze transactions.
                    </p>
                  </div>
                  <div style={{ background: '#111', border: '1px solid #222', borderRadius: '8px', padding: '12px', marginBottom: '20px', fontSize: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                      <span style={{ color: '#00ff44', fontSize: '14px' }}>🛡️</span>
                      <span style={{ color: '#fff', fontWeight: '600', fontSize: '13px' }}>Flexible Cancellation</span>
                    </div>
                    <p style={{ color: '#888', margin: 0, lineHeight: '1.5' }}>Full refund if cancelled at least 24 hours before check-in. Cancel within 24 hours for a 50% refund.</p>
                  </div>
                </>
              )}

              {checkIn && checkOut && nights > 0 && (
                <label style={{ display: 'flex', alignItems: 'start', gap: '10px', marginBottom: '12px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={termsAccepted} onChange={e => setTermsAccepted(e.target.checked)}
                    style={{ marginTop: '2px', accentColor: '#00ff44', width: '16px', height: '16px', flexShrink: 0 }} />
                  <span style={{ fontSize: '12px', color: '#888', lineHeight: '1.5' }}>
                    I understand ARIA is non-custodial. Payments execute on the Sui blockchain and cannot be reversed by ARIA. I accept the{' '}
                    <span onClick={(e) => { e.preventDefault(); window.open('/terms', '_blank'); }} style={{ color: '#00ff44', cursor: 'pointer', textDecoration: 'underline' }}>Terms of Service</span>.
                  </span>
                </label>
              )}

              <button onClick={handleBooking} disabled={bookingLoading || !checkIn || !checkOut || (checkIn && checkOut && !termsAccepted)}
                style={{ width: '100%', background: bookingLoading ? '#444' : (!checkIn || !checkOut || !termsAccepted) ? '#1a2a1a' : '#00ff44', color: (!checkIn || !checkOut || !termsAccepted) ? '#555' : '#000', border: 'none', borderRadius: '8px', padding: '14px', fontWeight: '700', fontSize: '15px', cursor: (!checkIn || !checkOut || !termsAccepted) ? 'not-allowed' : 'pointer', marginBottom: '8px' }}>
                {bookingLoading ? 'Processing on Sui...' : (!checkIn || !checkOut) ? 'Select dates to book' : !termsAccepted ? 'Accept terms to continue' : `Book Now – Pay $${getChargeTotal(selected, nights)} SuiUSD`}
              </button>
              <button onClick={handleCardPayment} disabled={bookingLoading || !checkIn || !checkOut}
                style={{ width: '100%', background: 'transparent', color: (!checkIn || !checkOut) ? '#444' : '#fff', border: '1px solid #444', borderRadius: '8px', padding: '14px', fontWeight: '600', fontSize: '15px', cursor: (!checkIn || !checkOut) ? 'not-allowed' : 'pointer' }}>
                {(!checkIn || !checkOut) ? 'Pay with Card (Stripe)' : `Pay with Card – $${getCardTotal(selected, nights)}`}
              </button>

              {booking && (
                <div style={{ marginTop: '16px', background: '#0a1a0a', border: '1px solid #00ff44', borderRadius: '8px', padding: '16px', fontSize: '12px', color: '#00ff44', textAlign: 'center' }}>
                  ✅ Booking confirmed! Ref: {booking.bookingRef}
                  {booking.depositAmount && <div style={{ marginTop: '8px', color: '#4a9eff', fontSize: '11px' }}>🔒 ${booking.depositAmount} deposit held in Sui escrow — you control release</div>}
                  {booking.walrusBlobId && (
                    <div style={{ marginTop: '10px', background: '#050f05', borderRadius: '6px', padding: '10px' }}>
                      <div style={{ color: '#555', fontSize: '10px', marginBottom: '4px' }}>RECEIPT STORED PERMANENTLY ON WALRUS</div>
                      <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${booking.walrusBlobId}`} target="_blank" rel="noreferrer" style={{ color: '#00ff44', fontFamily: 'monospace', fontSize: '10px', wordBreak: 'break-all' }}>{booking.walrusBlobId}</a>
                    </div>
                  )}
                  <p style={{ textAlign: 'center', color: '#555', fontSize: '11px', marginTop: '8px', marginBottom: 0 }}>{'Wallet: ' + user.address.slice(0, 10) + '…' + user.address.slice(-8)}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
