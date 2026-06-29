import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import { beginZkLogin, signTransactionWithZkLogin, submitSignedTransaction } from '../lib/zklogin';
import { fromBase64 } from '@mysten/sui/utils';
import { authFetch } from '../lib/authFetch';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const GOOGLE_CALLBACK_URL = process.env.NEXT_PUBLIC_GOOGLE_CALLBACK_URL || (typeof window !== 'undefined' ? `${window.location.origin}/auth/zklogin/callback` : '');

// PROPERTY_DISPLAY holds cosmetic/display-only fields (images, location,
// rating, beds/baths, tag) that have no backend equivalent. price/title/
// taxRate/taxName below are fallback defaults only — on mount we fetch the
// authoritative values from GET /properties (backed by catalog.mjs) and
// merge them in, so there's a single source of truth for anything that
// affects money (Phase 2a fix; was previously duplicated three ways across
// catalog.mjs, server.mjs, and this file).
const PROPERTY_DISPLAY = [
  {
    id: 1, title: 'Oceanfront Villa', location: 'Miami Beach, FL', price: 285, rating: 4.97, reviews: 124,
    image: 'https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=800&q=80','https://images.unsplash.com/photo-1502005229762-cf1b2da7c5d6?w=800&q=80','https://images.unsplash.com/photo-1615571022219-eb45cf7faa9d?w=800&q=80','https://images.unsplash.com/photo-1571003123894-1f0594d2b5d9?w=800&q=80','https://images.unsplash.com/photo-1584132967334-10e028bd69f7?w=800&q=80'],
    beds: 4, baths: 3, maxGuests: 8, tag: 'Beachfront'
  },
  {
    id: 2, title: 'Downtown Loft', location: 'Austin, TX', price: 145, rating: 4.89, reviews: 87,
    image: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800&q=80','https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&q=80','https://images.unsplash.com/photo-1484154218962-a197022b5858?w=800&q=80','https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=800&q=80','https://images.unsplash.com/photo-1507089947368-19c1da9775ae?w=800&q=80'],
    beds: 2, baths: 1, maxGuests: 4, tag: 'City View'
  },
  {
    id: 3, title: 'Mountain Cabin', location: 'Asheville, NC', price: 195, rating: 4.95, reviews: 203,
    image: 'https://images.unsplash.com/photo-1542718610-a1d656d1884c?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1542718610-a1d656d1884c?w=800&q=80','https://images.unsplash.com/photo-1518780664697-55e3ad937233?w=800&q=80','https://images.unsplash.com/photo-1510798831971-661eb04b3739?w=800&q=80','https://images.unsplash.com/photo-1506974210756-8e1b8985d348?w=800&q=80','https://images.unsplash.com/photo-1449158743715-0a90ebb6d2d8?w=800&q=80'],
    beds: 3, baths: 2, maxGuests: 6, tag: 'Nature'
  },
  {
    id: 4, title: 'Desert Retreat', location: 'Scottsdale, AZ', price: 225, rating: 4.92, reviews: 156,
    image: 'https://images.unsplash.com/photo-1613977257363-707ba9348227?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1613977257363-707ba9348227?w=800&q=80','https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800&q=80','https://images.unsplash.com/photo-1571055107559-3e67626fa8be?w=800&q=80','https://images.unsplash.com/photo-1596394516093-501ba68a0ba6?w=800&q=80','https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?w=800&q=80'],
    beds: 3, baths: 2, maxGuests: 6, tag: 'Pool'
  },
  {
    id: 5, title: 'Lake House', location: 'Lake Tahoe, CA', price: 320, rating: 4.98, reviews: 91,
    image: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=800&q=80','https://images.unsplash.com/photo-1601918774946-25832a4be0d6?w=800&q=80','https://images.unsplash.com/photo-1505916349660-8d91a99f56e0?w=800&q=80','https://images.unsplash.com/photo-1571492913491-50e0083303f4?w=800&q=80','https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800&q=80'],
    beds: 5, baths: 4, maxGuests: 10, tag: 'Waterfront'
  },
  {
    id: 6, title: 'Historic Brownstone', location: 'Brooklyn, NY', price: 175, rating: 4.85, reviews: 312,
    image: 'https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=800&q=80','https://images.unsplash.com/photo-1555636222-cae831e670b3?w=800&q=80','https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800&q=80','https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?w=800&q=80','https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800&q=80'],
    beds: 2, baths: 2, maxGuests: 4, tag: 'Historic'
  },
];

// Phase 3a: fallback image for host-created listings that have no photos yet.
const PLACEHOLDER_IMAGE = 'https://images.unsplash.com/photo-1560448204-603b3fc33ddc?w=600&q=80';

const WHY_ARIA = [
  { icon: '🔑', title: 'Your Wallet, Your Control', desc: 'ARIA never holds your funds. Payments execute directly on the Sui blockchain — no middleman, no delays.' },
  { icon: '⚡', title: 'Instant Settlement', desc: 'Hosts receive payouts in seconds, not days. No 3–5 day bank holds. No Airbnb holding your money.' },
  { icon: '🔒', title: 'On-Chain Escrow', desc: 'Security deposits are held by smart contract — not by ARIA. Released automatically when you approve.' },
  { icon: '✅', title: 'You Approve Everything', desc: 'Cancellations, deposit releases, and payouts all require your action. We never act on your behalf.' },
  { icon: '📋', title: 'Permanent Audit Trail', desc: 'Every booking and payment is stored immutably on Walrus. Your receipts exist forever, independently of ARIA.' },
  { icon: '💸', title: '5% vs 15%', desc: 'Airbnb takes up to 15%. ARIA takes 5% — only on your stay cost, never on your deposit.' },
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
  // Guest count (June 29, 2026) — doesn't affect pricing, just an occupancy
  // cap check against the selected property's maxGuests (see catalog.mjs /
  // bookings.mjs). Reset to 1 whenever the modal opens/closes.
  const [guests, setGuests] = useState(1);
  const [searchLocation, setSearchLocation] = useState('All Locations');
  const [searchCheckIn, setSearchCheckIn] = useState(null);
  const [searchCheckOut, setSearchCheckOut] = useState(null);
  const [searchGuests, setSearchGuests] = useState(1);
  const [properties, setProperties] = useState(PROPERTY_DISPLAY);
  const [filteredProperties, setFilteredProperties] = useState(PROPERTY_DISPLAY);
  const [searched, setSearched] = useState(false);
  const [liveRatings, setLiveRatings] = useState({});
  const [photoIndex, setPhotoIndex] = useState(0);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [addrCopied, setAddrCopied] = useState(false);
  // escrowStatus: null | 'signing' | 'submitting' | 'confirming' | 'done' | 'error'
  // Tracks the guest-side half of P0b — signing + submitting the escrow PTB
  // the backend built (escrowTxBytes), then reporting the digest back so the
  // backend can verify on-chain before recording anything.
  const [escrowStatus, setEscrowStatus] = useState(null);
  const [escrowError, setEscrowError] = useState('');

  const copyAddr = () => {
    navigator.clipboard.writeText(user.address);
    setAddrCopied(true);
    setTimeout(() => setAddrCopied(false), 2000);
  };

  const nights = checkIn && checkOut ? Math.round((checkOut - checkIn) / (1000 * 60 * 60 * 24)) : 0;

  const getJurisdiction  = (p) => (p?.taxRate != null ? { rate: p.taxRate, name: p.taxName } : { rate: 0.08, name: 'Occupancy Tax' });
  const getSubtotal      = (p, n) => p.price * n;
  const getAriaFee       = (p, n) => Math.round(getSubtotal(p, n) * 0.05);
  const getTax           = (p, n) => Math.round(getSubtotal(p, n) * getJurisdiction(p).rate);
  const getBookingTotal  = (p, n) => getSubtotal(p, n) + getAriaFee(p, n) + getTax(p, n);
  const getDeposit       = (p, n) => Math.round(getBookingTotal(p, n) * 0.20);
  const getChargeTotal   = (p, n) => getBookingTotal(p, n) + getDeposit(p, n);
  const getCardTotal     = (p, n) => (getChargeTotal(p, n) * 1.029 + 0.30).toFixed(2);
  const getCardFee       = (p, n) => (getChargeTotal(p, n) * 0.029 + 0.30).toFixed(2);

  const openModal  = (p) => { setSelected(p); setBooking(null); setCheckIn(null); setCheckOut(null); setGuests(1); setPhotoIndex(0); setTermsAccepted(false); setEscrowStatus(null); setEscrowError(''); };
  const closeModal = () => { setSelected(null); setBooking(null); setCheckIn(null); setCheckOut(null); setGuests(1); setPhotoIndex(0); setTermsAccepted(false); setEscrowStatus(null); setEscrowError(''); };

  const handleSearch = () => {
    let results = properties;
    if (searchLocation !== 'All Locations') results = results.filter(p => p.location === searchLocation);
    if (searchGuests > 1) results = results.filter(p => (p.maxGuests ?? 2) >= searchGuests);
    setFilteredProperties(results);
    setSearched(true);
  };

  const handleClearSearch = () => {
    setSearchLocation('All Locations'); setSearchCheckIn(null); setSearchCheckOut(null); setSearchGuests(1);
    setFilteredProperties(properties); setSearched(false);
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sid = params.get('sid');
    if (sid) { try { localStorage.setItem('aria_sid', sid); } catch {} window.history.replaceState({}, '', '/'); }

    authFetch(`${API}/auth/me`)
      .then(res => res.json())
      .then(data => { if (data.address) setUser(data); setLoading(false); })
      .catch(() => setLoading(false));

    // Merge in the authoritative price/title/tax fields from the backend
    // (catalog.mjs via GET /properties) so this page can't silently drift
    // from what the server will actually charge (Phase 2a fix). Cosmetic
    // fields (images, location, rating, beds/baths, tag) stay local for the
    // 6 fixed demo properties — those aren't a correctness risk and have no
    // backend equivalent. Phase 3a: GET /properties can now also return
    // host-created listings that aren't in PROPERTY_DISPLAY at all — those
    // are synthesized into a display object here instead of being silently
    // dropped (same fix already applied to the host dashboard).
    fetch(`${API}/properties`).then(r => r.json()).then(d => {
      if (!Array.isArray(d.properties)) return;
      const merged = d.properties.map(p => {
        // Match on source==='catalog', not just id — a host-created listing's
        // DB-assigned SERIAL id can collide with one of the 6 fixed demo ids
        // (the `properties` table also starts counting at 1), which would
        // otherwise overlay the wrong demo property's display fields here.
        const fixed = p.source === 'catalog' ? PROPERTY_DISPLAY.find(f => f.id === p.id) : null;
        if (fixed) return { ...fixed, title: p.title, price: p.price, taxRate: p.taxRate, taxName: p.taxName, maxGuests: p.maxGuests ?? fixed.maxGuests };
        return {
          id: p.id, title: p.title, price: p.price, taxRate: p.taxRate, taxName: p.taxName,
          location: p.location || 'Location not set', rating: 0, reviews: 0,
          image: (p.images && p.images[0]) || PLACEHOLDER_IMAGE,
          images: (p.images && p.images.length ? p.images : [PLACEHOLDER_IMAGE]),
          beds: p.beds ?? 1, baths: p.baths ?? 1, maxGuests: p.maxGuests ?? 2, tag: p.tag || 'New Listing',
        };
      });
      setProperties(merged);
      setFilteredProperties(prev => prev === PROPERTY_DISPLAY ? merged : prev);

      // Live review ratings, fetched for the full merged set (including any
      // host-created listings) now that we know every id that exists.
      Promise.all(merged.map(p =>
        fetch(`${API}/reviews/${p.id}`).then(r => r.json()).then(d2 => ({ id: p.id, rating: d2.averageRating, count: d2.count, verifiedCount: d2.verifiedCount || 0 })).catch(() => ({ id: p.id, rating: 0, count: 0, verifiedCount: 0 }))
      )).then(results => {
        const ratings = {};
        results.forEach(r => { ratings[r.id] = { rating: r.rating, count: r.count, verifiedCount: r.verifiedCount }; });
        setLiveRatings(ratings);
      });
    }).catch(() => {});
  }, []);

  const getDisplayRating = (p) => {
    const live = liveRatings[p.id];
    if (live && live.count > 0) return { rating: live.rating.toFixed(2), count: live.count, verifiedCount: live.verifiedCount || 0, isLive: true };
    return { rating: p.rating, count: p.reviews, verifiedCount: 0, isLive: false };
  };

  const handleLogin = async () => {
    if (!GOOGLE_CLIENT_ID) { alert('Sign-in is misconfigured (missing Google client ID). Please try again later.'); return; }
    try {
      // Generates the ephemeral keypair + nonce client-side and stashes it in
      // sessionStorage — the backend never sees or holds this key material.
      // See lib/zklogin.js for why this moved out of the backend.
      const nonce = await beginZkLogin();
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        response_type: 'id_token',
        redirect_uri: GOOGLE_CALLBACK_URL,
        scope: 'openid email profile',
        nonce,
      });
      window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    } catch (err) {
      console.error('Failed to start sign-in:', err);
      alert('Could not start sign-in. Please check your connection and try again.');
    }
  };

  const handleLogout = async () => {
    await authFetch(`${API}/auth/logout`);
    try { localStorage.removeItem('aria_sid'); } catch {}
    setUser(null);
  };

  const handleBooking = async () => {
    if (!checkIn || !checkOut) { alert('Please select check-in and check-out dates'); return; }
    if (nights < 1) { alert('Check-out must be after check-in'); return; }
    if (!guests || guests < 1) { alert('Please enter at least 1 guest'); return; }
    if (selected?.maxGuests && guests > selected.maxGuests) { alert(`This property sleeps up to ${selected.maxGuests} guests`); return; }
    // Proactive gate: if we already know this guest hasn't completed Seal/Walrus
    // identity verification, send them to /profile before even hitting the
    // backend (which will reject it anyway once REQUIRE_GUEST_VERIFICATION is
    // on). Avoids the guest filling out dates/terms just to get bounced.
    if (user && user.hasGuestProfile === false) {
      alert('Please complete identity verification before booking — hosts need this for accountability. Redirecting to your profile.');
      closeModal();
      router.push('/profile');
      return;
    }
    setBookingLoading(true);
    setEscrowStatus(null);
    setEscrowError('');
    const res = await authFetch(`${API}/booking/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ propertyId: selected.id, checkIn: checkIn.toISOString().split('T')[0], checkOut: checkOut.toISOString().split('T')[0], guests }) // R7: server derives title/price/nights/total from catalog.mjs
    });
    const data = await res.json();
    if (data.error === 'Property not available for selected dates') { alert('Sorry — those dates are already booked. Please select different dates.'); setBookingLoading(false); return; }
    // Reactive gate: backend rejected because guest_verifications has no row
    // for this address (covers the proactive check above being stale/skipped,
    // and is the only gate at all once REQUIRE_GUEST_VERIFICATION flips on for
    // guests who logged in before this client-side check shipped).
    if (!res.ok && data.needsVerification) {
      alert('Complete identity verification first. Redirecting to your profile.');
      setBookingLoading(false);
      closeModal();
      router.push('/profile');
      return;
    }
    if (!res.ok) {
      alert(data.error || 'Could not create booking. Please try again.');
      setBookingLoading(false);
      return;
    }
    setBooking(data);
    setBookingLoading(false);
    // Non-custodial: the backend only built an unsigned PTB (data.escrowTxBytes)
    // with the guest as sender. The guest's own browser must sign and submit it —
    // ARIA's backend never holds a key that could move these funds.
    if (data.escrowTxBytes) {
      if (data.paymentEscrowBuilt) {
        // Phase 1h.5: the combined PTB moves real money (rental + fee + tax),
        // not just a refundable deposit. Show the guest exactly where each leg
        // goes, the release schedule, and the cancellation policy, and require
        // an explicit approval before signing (DoD §11).
        setEscrowStatus('review');
      } else {
        // Legacy deposit-only path: just a refundable deposit — auto-sign as before.
        handleEscrowSign(data.bookingRef, data.escrowTxBytes);
      }
    }
  };

  // Signs the backend-built escrow PTB with the guest's zkLogin session,
  // submits it directly to Sui from the browser, then reports just the
  // resulting digest to the backend so it can independently verify on-chain
  // before writing escrow_object_id / flipping deposit_status to 'held'.
  const handleEscrowSign = async (bookingRef, escrowTxBytes) => {
    setEscrowStatus('signing');
    setEscrowError('');
    try {
      const txBytes = fromBase64(escrowTxBytes);
      const signature = await signTransactionWithZkLogin(txBytes);

      setEscrowStatus('submitting');
      const digest = await submitSignedTransaction(escrowTxBytes, signature);

      setEscrowStatus('confirming');
      const confirmRes = await authFetch(`${API}/booking/${bookingRef}/escrow/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ digest }),
      });
      const confirmData = await confirmRes.json();
      if (!confirmRes.ok || !confirmData.success) {
        throw new Error(confirmData.error || 'Escrow could not be verified on-chain');
      }

      setEscrowStatus('done');
      setBooking(prev => (prev && prev.bookingRef === bookingRef)
        ? { ...prev, escrowObjectId: confirmData.escrowObjectId, escrowConfirmed: true }
        : prev);
    } catch (err) {
      console.error('Escrow signing failed:', err);
      setEscrowStatus('error');
      setEscrowError(err.message || 'Could not complete the escrow deposit.');
    }
  };

  const handleCardPayment = async () => {
    if (!checkIn || !checkOut) { alert('Please select check-in and check-out dates'); return; }
    setBookingLoading(true);
    // Server recomputes the charge amount from propertyId+nights — it never
    // trusts a client-sent amount for a real Stripe charge (Finding #1).
    const res = await authFetch(`${API}/payment/create-intent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ propertyId: selected.id, nights }) });
    const data = await res.json();
    if (data.clientSecret) { setBooking({ bookingRef: 'STRIPE-' + Date.now(), stripeIntent: true }); }
    setBookingLoading(false);
  };

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#fff', color: '#222' }}>Loading...</div>;

  if (!user) return (
    <div style={{ minHeight: '100vh', background: '#fff', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 24px' }}>
        <div style={{ width: '100%', maxWidth: '420px' }}>
          <div style={{ textAlign: 'center', marginBottom: '40px' }}>
            <div style={{ fontSize: '48px', marginBottom: '12px' }}>🏠</div>
            <h1 style={{ color: '#ff385c', fontSize: '32px', fontWeight: '700', margin: '0 0 8px' }}>ARIA</h1>
            <p style={{ color: '#717171', fontSize: '14px', margin: '0 0 4px' }}>Vacation Rental Platform — Built on Sui</p>
            <p style={{ color: '#444', fontSize: '15px', lineHeight: '1.6', margin: '0 0 32px' }}>The Airbnb killer. Lower fees. Instant settlement. You stay in control.</p>
            <button onClick={handleLogin} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', width: '100%', padding: '14px', background: '#222', color: '#fff', border: 'none', borderRadius: '8px', fontSize: '15px', fontWeight: '600', cursor: 'pointer' }}>
              <span>G</span> Sign in with Google
            </button>
            <p style={{ color: '#999', fontSize: '12px', marginTop: '12px' }}>No wallet needed. No seed phrase. Just Google.</p>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {WHY_ARIA.slice(0, 3).map((item, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'start', gap: '12px', background: '#f7f7f7', border: '1px solid #ebebeb', borderRadius: '10px', padding: '14px' }}>
                <span style={{ fontSize: '20px', flexShrink: 0 }}>{item.icon}</span>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: '600', color: '#222', marginBottom: '2px' }}>{item.title}</div>
                  <div style={{ fontSize: '12px', color: '#717171', lineHeight: '1.5' }}>{item.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div style={{ borderTop: '1px solid #ebebeb', padding: '20px 24px', textAlign: 'center' }}>
        <p style={{ color: '#717171', fontSize: '11px', margin: 0, lineHeight: '1.7' }}>
          ⚠️ ARIA is a non-custodial platform. We do not hold your funds. All payments execute directly on the Sui blockchain. ARIA has no ability to reverse, freeze, or recover transactions. You are solely responsible for your wallet and transactions.
        </p>
        <p style={{ color: '#999', fontSize: '11px', margin: '6px 0 0' }}>© 2026 ARIA · Built on Sui · Powered by DeepBook & Walrus</p>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#fff', color: '#222', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        .react-datepicker { background: #fff !important; border: 1px solid #ddd !important; color: #222 !important; box-shadow: 0 4px 18px rgba(0,0,0,0.12); }
        .react-datepicker__header { background: #fff !important; border-bottom: 1px solid #eee !important; }
        .react-datepicker__current-month, .react-datepicker__day-name { color: #222 !important; }
        .react-datepicker__day { color: #444 !important; }
        .react-datepicker__day:hover { background: #f2f2f2 !important; color: #222 !important; }
        .react-datepicker__day--selected, .react-datepicker__day--in-range { background: #222 !important; color: #fff !important; }
        .react-datepicker__day--keyboard-selected { background: #444 !important; color: #fff !important; }
        .react-datepicker__day--disabled { color: #ccc !important; }
        .react-datepicker__navigation-icon::before { border-color: #222 !important; }
        .react-datepicker-wrapper { width: 100%; }
        .date-input { width: 100%; background: transparent; border: none; border-radius: 0; padding: 0; color: #222; font-size: 14px; outline: none; cursor: pointer; box-sizing: border-box; }
        .date-input::placeholder { color: #717171; }
        .property-img { width: 100%; height: 100%; object-fit: cover; transition: transform 0.3s ease; }
        .property-card:hover .property-img { transform: scale(1.04); }
        .property-card { transition: box-shadow 0.2s ease; }
        .property-card:hover { box-shadow: 0 6px 20px rgba(0,0,0,0.12); }
        .gallery-arrow { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(0,0,0,0.55); border: none; color: #fff; font-size: 22px; cursor: pointer; border-radius: 50%; width: 38px; height: 38px; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px); transition: background 0.15s; z-index: 2; }
        .gallery-arrow:hover { background: rgba(0,0,0,0.85); }
        .gallery-thumb { flex: 1; height: 54px; overflow: hidden; cursor: pointer; border-radius: 4px; transition: opacity 0.15s, border-color 0.15s; }
        .gallery-thumb:hover { opacity: 1 !important; }
        .gallery-dot { border: none; cursor: pointer; padding: 0; border-radius: 4px; transition: all 0.2s ease; }
        .nav-desktop { display: flex; align-items: center; gap: 12px; }
        .nav-hamburger { display: none !important; }
        .search-pill { display: flex; align-items: center; background: #fff; border: 1px solid #ddd; border-radius: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); max-width: 760px; margin: 0 auto; }
        .search-field { padding: 12px 22px; cursor: pointer; min-width: 0; }
        .search-divider { width: 1px; height: 32px; background: #ddd; flex-shrink: 0; }
        .search-step-btn { width: 26px; height: 26px; border-radius: 50%; border: 1px solid #ccc; background: #fff; color: #222; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; }
        .search-step-btn:disabled { color: #ccc; cursor: not-allowed; }
        @media (max-width: 639px) {
          .nav-desktop { display: none !important; }
          .nav-hamburger { display: flex !important; align-items: center; gap: 8px; }
          .search-pill { flex-direction: column !important; border-radius: 16px !important; max-width: 100% !important; }
          .search-pill .search-field { width: 100% !important; box-sizing: border-box; }
          .search-pill .search-divider { width: 100% !important; height: 1px !important; }
          .search-pill .search-btn-wrap { width: 100% !important; padding: 12px !important; }
          .search-pill .search-btn { width: 100% !important; border-radius: 24px !important; }
        }
      `}</style>

      {/* Header */}
      <div style={{ background: '#fff', borderBottom: '1px solid #ebebeb', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '60px', position: 'sticky', top: 0, zIndex: 100 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '20px' }}>🏠</span>
          <span style={{ fontWeight: '700', fontSize: '18px', color: '#ff385c' }}>ARIA</span>
          <span style={{ background: '#00c853', color: '#fff', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px', marginLeft: '4px' }}>BETA</span>
        </div>

        {/* Desktop nav */}
        <div className="nav-desktop">
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '13px', fontWeight: '500', color: '#222' }}>{user.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end' }}>
              <div style={{ fontSize: '11px', color: '#00913f', fontFamily: 'monospace', wordBreak: 'break-all' }}>{user.address}</div>
              <button onClick={copyAddr} title="Copy address" style={{ background: 'none', border: 'none', cursor: 'pointer', color: addrCopied ? '#00913f' : '#999', fontSize: '12px', padding: '0 2px', flexShrink: 0 }}>
                {addrCopied ? '✓' : '⧉'}
              </button>
            </div>
          </div>
          <button onClick={() => router.push('/bookings')} style={{ background: 'transparent', border: '1px solid #ddd', color: '#444', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>My Bookings</button>
          <button onClick={() => router.push('/profile')}
            style={{ background: 'transparent', border: `1px solid ${user.hasGuestProfile === false ? '#ffd699' : '#ddd'}`, color: user.hasGuestProfile === false ? '#b06d00' : '#444', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: user.hasGuestProfile === false ? '600' : '400' }}>
            🪪 {user.hasGuestProfile === false ? 'Verify Identity' : 'Identity'}
          </button>
          <button onClick={() => router.push('/bookings?market=1')} style={{ background: 'transparent', border: '1px solid #ffd699', color: '#b06d00', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: '600' }}>🏷️ Resale Market</button>
          {user.isHost && <button onClick={() => router.push('/host')} style={{ background: 'transparent', border: '1px solid #ddd', color: '#444', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>Host Dashboard</button>}
          {!user.isHost && user.hostStatus !== 'pending' && (
            <button onClick={() => router.push('/become-host')} style={{ background: 'transparent', border: '1px solid #00913f', color: '#00913f', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: '600' }}>🏡 Become a Host</button>
          )}
          {user.hostStatus === 'pending' && <span style={{ fontSize: '12px', color: '#b06d00', fontWeight: '600' }}>⏳ Application Pending</span>}
          <button onClick={() => router.push('/ai')} style={{ background: 'transparent', border: '1px solid #e4d4ff', color: '#8b3dff', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: '600' }}>🤖 AI</button>
          <button onClick={handleLogout} style={{ background: 'transparent', border: '1px solid #ddd', color: '#444', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>Sign out</button>
        </div>

        {/* Mobile nav */}
        <div className="nav-hamburger">
          <button onClick={copyAddr} title="Copy address" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', gap: '3px' }}>
            <span style={{ fontSize: '11px', color: '#00913f', fontFamily: 'monospace' }}>{user.address.slice(0, 6)}…{user.address.slice(-4)}</span>
            <span style={{ color: addrCopied ? '#00913f' : '#999', fontSize: '11px' }}>{addrCopied ? '✓' : '⧉'}</span>
          </button>
          <button onClick={() => setMenuOpen(o => !o)}
            style={{ background: 'transparent', border: '1px solid #ddd', color: '#222', borderRadius: '6px', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '20px', cursor: 'pointer', lineHeight: 1 }}>
            {menuOpen ? '×' : '☰'}
          </button>
        </div>
      </div>

      {/* Mobile dropdown menu */}
      {menuOpen && (
        <div style={{ background: '#fff', borderBottom: '1px solid #ebebeb', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: '8px', position: 'sticky', top: '60px', zIndex: 99 }}>
          <div style={{ paddingBottom: '8px', borderBottom: '1px solid #eee', marginBottom: '4px' }}>
            <div style={{ fontSize: '13px', fontWeight: '600', color: '#222' }}>{user.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
              <div style={{ fontSize: '11px', color: '#00913f', fontFamily: 'monospace', wordBreak: 'break-all', flex: 1 }}>{user.address}</div>
              <button onClick={copyAddr} title="Copy address" style={{ background: 'none', border: 'none', cursor: 'pointer', color: addrCopied ? '#00913f' : '#999', fontSize: '13px', padding: '0 2px', flexShrink: 0 }}>
                {addrCopied ? '✓' : '⧉'}
              </button>
            </div>
          </div>
          {[
            { label: '📋 My Bookings', action: () => { router.push('/bookings'); setMenuOpen(false); } },
            { label: `🪪 ${user.hasGuestProfile === false ? 'Verify Identity' : 'Identity'}`, action: () => { router.push('/profile'); setMenuOpen(false); } },
            { label: '🏷️ Resale Market', action: () => { router.push('/bookings?market=1'); setMenuOpen(false); } },
            user.isHost ? { label: '🏡 Host Dashboard', action: () => { router.push('/host'); setMenuOpen(false); } } : null,
            (!user.isHost && user.hostStatus !== 'pending') ? { label: '🏡 Become a Host', action: () => { router.push('/become-host'); setMenuOpen(false); } } : null,
            { label: '🤖 AI Assistant', action: () => { router.push('/ai'); setMenuOpen(false); } },
          ].filter(Boolean).map((item, i) => (
            <button key={i} onClick={item.action}
              style={{ background: '#fafafa', border: '1px solid #eee', color: '#222', borderRadius: '8px', padding: '12px 16px', fontSize: '14px', textAlign: 'left', cursor: 'pointer', width: '100%' }}>
              {item.label}
            </button>
          ))}
          {user.hostStatus === 'pending' && <div style={{ color: '#b06d00', fontSize: '13px', padding: '4px 0' }}>⏳ Host Application Pending</div>}
          <button onClick={() => { handleLogout(); setMenuOpen(false); }}
            style={{ background: 'transparent', border: '1px solid #ddd', color: '#444', borderRadius: '8px', padding: '12px 16px', fontSize: '14px', textAlign: 'left', cursor: 'pointer', width: '100%', marginTop: '4px' }}>
            Sign out
          </button>
        </div>
      )}

      {/* Hero / Search */}
      <div style={{ background: '#fff', padding: '40px 24px', textAlign: 'center' }}>
        <h2 style={{ fontSize: '28px', fontWeight: '700', margin: '0 0 8px', color: '#222' }}>Find your perfect stay</h2>
        <p style={{ color: '#717171', fontSize: '14px', margin: '0 0 24px' }}>Book instantly. Pay with SuiUSD. You stay in control — always.</p>
        <div className="search-pill">
          <div className="search-field" style={{ flex: '1.4', textAlign: 'left' }}>
            <div style={{ fontSize: '11px', fontWeight: '700', color: '#222' }}>Where</div>
            <select value={searchLocation} onChange={e => setSearchLocation(e.target.value)}
              style={{ width: '100%', background: 'transparent', border: 'none', padding: 0, color: searchLocation === 'All Locations' ? '#717171' : '#222', fontSize: '14px', outline: 'none', cursor: 'pointer' }}>
              <option value="All Locations">Search destinations</option>
              {/* Phase 3a: derived from live properties (not just the 6 fixed demo
                  ones) so host-created listings' locations are filterable too. */}
              {[...new Set(properties.map(p => p.location))].filter(Boolean).map(loc => (
                <option key={loc} value={loc}>{loc}</option>
              ))}
            </select>
          </div>
          <div className="search-divider" />
          <div className="search-field" style={{ flex: '1', textAlign: 'left' }}>
            <div style={{ fontSize: '11px', fontWeight: '700', color: '#222' }}>Check in</div>
            <DatePicker selected={searchCheckIn} onChange={date => setSearchCheckIn(date)} minDate={new Date()} placeholderText="Add dates" dateFormat="MMM d" className="date-input" />
          </div>
          <div className="search-divider" />
          <div className="search-field" style={{ flex: '1', textAlign: 'left' }}>
            <div style={{ fontSize: '11px', fontWeight: '700', color: '#222' }}>Check out</div>
            <DatePicker selected={searchCheckOut} onChange={date => setSearchCheckOut(date)} minDate={searchCheckIn ? new Date(searchCheckIn.getTime() + 86400000) : new Date()} placeholderText="Add dates" dateFormat="MMM d" className="date-input" />
          </div>
          <div className="search-divider" />
          <div className="search-field" style={{ flex: '1.1', textAlign: 'left' }}>
            <div style={{ fontSize: '11px', fontWeight: '700', color: '#222' }}>Who</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
              <span style={{ fontSize: '14px', color: searchGuests > 1 ? '#222' : '#717171' }}>{searchGuests} guest{searchGuests > 1 ? 's' : ''}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                <button type="button" className="search-step-btn" onClick={e => { e.stopPropagation(); setSearchGuests(g => Math.max(1, g - 1)); }} disabled={searchGuests <= 1}>−</button>
                <button type="button" className="search-step-btn" onClick={e => { e.stopPropagation(); setSearchGuests(g => Math.min(16, g + 1)); }}>+</button>
              </div>
            </div>
          </div>
          <div className="search-btn-wrap" style={{ padding: '8px' }}>
            <button className="search-btn" onClick={handleSearch} title="Search" style={{ background: '#ff385c', color: '#fff', border: 'none', borderRadius: '50%', width: '48px', height: '48px', fontWeight: '700', fontSize: '16px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>🔍</button>
          </div>
        </div>
        {searched && (
          <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px' }}>
            <span style={{ fontSize: '13px', color: '#717171' }}>{filteredProperties.length} propert{filteredProperties.length === 1 ? 'y' : 'ies'} found{searchLocation !== 'All Locations' ? ` in ${searchLocation}` : ''}</span>
            <button onClick={handleClearSearch} style={{ background: 'transparent', border: '1px solid #ddd', color: '#444', padding: '4px 10px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>Clear</button>
          </div>
        )}
      </div>

      {/* Why ARIA section */}
      <div style={{ background: '#f7f7f7', borderTop: '1px solid #ebebeb', borderBottom: '1px solid #ebebeb', padding: '48px 24px' }}>
        <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
          <div style={{ textAlign: 'center', marginBottom: '32px' }}>
            <h2 style={{ fontSize: '22px', fontWeight: '700', margin: '0 0 8px', color: '#222' }}>Why ARIA?</h2>
            <p style={{ color: '#717171', fontSize: '14px', margin: 0 }}>Unlike Airbnb, you stay in control of your money — always.</p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: '16px' }}>
            {WHY_ARIA.map((item, i) => (
              <div key={i} style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '12px', padding: '20px', display: 'flex', alignItems: 'start', gap: '14px' }}>
                <span style={{ fontSize: '24px', flexShrink: 0 }}>{item.icon}</span>
                <div>
                  <div style={{ fontSize: '14px', fontWeight: '600', color: '#222', marginBottom: '6px' }}>{item.title}</div>
                  <div style={{ fontSize: '13px', color: '#717171', lineHeight: '1.6' }}>{item.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Property Grid */}
      <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '32px 24px', flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <h3 style={{ fontSize: '18px', fontWeight: '600', margin: 0, color: '#222' }}>Popular homes</h3>
          <span style={{ fontSize: '13px', color: '#717171' }}>{filteredProperties.length} properties available</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(260px,1fr))', gap: '28px 20px' }}>
          {filteredProperties.map(p => {
            const { rating, count, verifiedCount, isLive } = getDisplayRating(p);
            return (
              <div key={p.id} className="property-card" onClick={() => openModal(p)} style={{ cursor: 'pointer', borderRadius: '12px' }}>
                <div style={{ height: '220px', background: '#eee', overflow: 'hidden', position: 'relative', borderRadius: '12px' }}>
                  <img src={p.image} alt={p.title} className="property-img" />
                  {isLive && <span style={{ position: 'absolute', top: '12px', left: '12px', background: '#fff', color: '#8b3dff', fontSize: '10px', fontWeight: '700', padding: '4px 9px', borderRadius: '6px', boxShadow: '0 1px 4px rgba(0,0,0,0.2)' }}>ARIA Verified</span>}
                  <span style={{ position: 'absolute', bottom: '10px', right: '10px', background: 'rgba(0,0,0,0.55)', color: '#fff', fontSize: '10px', fontWeight: '600', padding: '3px 8px', borderRadius: '6px', backdropFilter: 'blur(4px)' }}>📷 {p.images.length}</span>
                </div>
                <div style={{ padding: '10px 2px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '2px' }}>
                    <h4 style={{ margin: 0, fontSize: '14px', fontWeight: '600', color: '#222' }}>{p.title}</h4>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', flexShrink: 0, marginLeft: '8px' }}>
                      <span style={{ color: '#222' }}>★</span>
                      <span style={{ color: '#222' }}>{rating}</span>
                      {verifiedCount > 0 && (
                        <span title={`${verifiedCount} review${verifiedCount > 1 ? 's' : ''} from a real on-chain-escrow stay`} style={{ color: '#00913f', fontSize: '11px', fontWeight: '700' }}>✓{verifiedCount}</span>
                      )}
                    </div>
                  </div>
                  <p style={{ color: '#717171', fontSize: '13px', margin: '0 0 2px' }}>{p.location}</p>
                  <p style={{ color: '#717171', fontSize: '13px', margin: '0 0 6px' }}>{p.tag}</p>
                  <div style={{ fontSize: '14px', color: '#222' }}><span style={{ fontWeight: '600' }}>${p.price}</span> night</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Footer */}
      <div style={{ borderTop: '1px solid #ebebeb', padding: '24px', textAlign: 'center', marginTop: 'auto' }}>
        <p style={{ color: '#717171', fontSize: '11px', margin: '0 0 6px', lineHeight: '1.7', maxWidth: '700px', marginLeft: 'auto', marginRight: 'auto' }}>
          ⚠️ ARIA is a non-custodial platform. We do not hold your funds. All payments execute directly on the Sui blockchain. ARIA has no ability to reverse, freeze, or recover transactions. You are solely responsible for your wallet and transactions.
        </p>
        <p style={{ color: '#999', fontSize: '11px', margin: 0 }}>© 2026 ARIA · Built on Sui · Powered by DeepBook & Walrus · <span style={{ color: '#999' }}>Non-custodial · You stay in control</span> · <span onClick={() => router.push('/terms')} style={{ color: '#999', cursor: 'pointer', textDecoration: 'underline' }}>Terms of Service</span></p>
      </div>

      {/* Booking Modal */}
      {selected && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: '24px' }}
          onClick={e => { if (e.target === e.currentTarget) closeModal(); }}>
          <div style={{ background: '#fff', border: '1px solid #ddd', borderRadius: '16px', width: '100%', maxWidth: '500px', maxHeight: '92vh', overflowY: 'auto' }}>
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
                  <div key={i} className="gallery-thumb" onClick={e => { e.stopPropagation(); setPhotoIndex(i); }} style={{ border: i === photoIndex ? '2px solid #00913f' : '2px solid transparent', opacity: i === photoIndex ? 1 : 0.5 }}>
                    <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                  </div>
                ))}
              </div>
            </div>

            <div style={{ padding: '24px' }}>
              <div style={{ marginBottom: '20px' }}>
                <div style={{ fontSize: '13px', color: '#717171', marginBottom: '8px', fontWeight: '600' }}>SELECT YOUR DATES</div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <div style={{ flex: 1, border: '1px solid #ddd', borderRadius: '8px', padding: '10px 14px' }}>
                    <div style={{ fontSize: '11px', color: '#999' }}>CHECK-IN</div>
                    <DatePicker selected={checkIn} onChange={date => { setCheckIn(date); if (checkOut && date >= checkOut) setCheckOut(null); }} selectsStart startDate={checkIn} endDate={checkOut} minDate={new Date()} placeholderText="Select date" dateFormat="MMM d, yyyy" className="date-input" />
                  </div>
                  <div style={{ flex: 1, border: '1px solid #ddd', borderRadius: '8px', padding: '10px 14px' }}>
                    <div style={{ fontSize: '11px', color: '#999' }}>CHECK-OUT</div>
                    <DatePicker selected={checkOut} onChange={date => setCheckOut(date)} selectsEnd startDate={checkIn} endDate={checkOut} minDate={checkIn ? new Date(checkIn.getTime() + 86400000) : new Date()} placeholderText="Select date" dateFormat="MMM d, yyyy" className="date-input" />
                  </div>
                </div>
                {checkIn && checkOut && nights > 0 && <div style={{ marginTop: '8px', fontSize: '13px', color: '#00913f', textAlign: 'center' }}>{nights} night{nights > 1 ? 's' : ''} selected</div>}
              </div>

              <div style={{ marginBottom: '20px' }}>
                <div style={{ fontSize: '13px', color: '#717171', marginBottom: '8px', fontWeight: '600' }}>GUESTS</div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#f7f7f7', border: '1px solid #ddd', borderRadius: '8px', padding: '10px 14px' }}>
                  <span style={{ fontSize: '14px', color: '#222' }}>
                    Number of guests
                    {selected?.maxGuests && <span style={{ color: '#999', fontSize: '12px' }}> (max {selected.maxGuests})</span>}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <button type="button" onClick={() => setGuests(g => Math.max(1, g - 1))} disabled={guests <= 1} className="guest-step-btn" style={{ width: '28px', height: '28px', borderRadius: '50%', border: '1px solid #ccc', background: '#fff', color: guests <= 1 ? '#ccc' : '#222', cursor: guests <= 1 ? 'not-allowed' : 'pointer' }}>−</button>
                    <span style={{ fontSize: '15px', fontWeight: '600', minWidth: '16px', textAlign: 'center', color: '#222' }}>{guests}</span>
                    <button type="button" onClick={() => setGuests(g => Math.min(selected?.maxGuests || 16, g + 1))} disabled={selected?.maxGuests && guests >= selected.maxGuests} className="guest-step-btn" style={{ width: '28px', height: '28px', borderRadius: '50%', border: '1px solid #ccc', background: '#fff', color: (selected?.maxGuests && guests >= selected.maxGuests) ? '#ccc' : '#222', cursor: (selected?.maxGuests && guests >= selected.maxGuests) ? 'not-allowed' : 'pointer' }}>+</button>
                  </div>
                </div>
              </div>

              {checkIn && checkOut && nights > 0 && (
                <div style={{ background: '#f7f7f7', border: '1px solid #ebebeb', borderRadius: '8px', padding: '16px', marginBottom: '20px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ color: '#717171', fontSize: '14px' }}>${selected.price} × {nights} night{nights > 1 ? 's' : ''}</span>
                    <span style={{ fontSize: '14px', color: '#222' }}>${getSubtotal(selected, nights)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                    <span style={{ color: '#717171', fontSize: '14px' }}>ARIA fee (5% of stay cost)</span>
                    <span style={{ fontSize: '14px', color: '#00913f' }}>${getAriaFee(selected, nights)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', paddingBottom: '12px', borderBottom: '1px solid #ddd' }}>
                    <span style={{ color: '#717171', fontSize: '14px' }}>
                      Occupancy tax ({(getJurisdiction(selected).rate * 100).toFixed(2)}% — {getJurisdiction(selected).name})
                    </span>
                    <span style={{ fontSize: '14px', color: '#717171' }}>${getTax(selected, nights)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
                    <span style={{ fontSize: '14px', fontWeight: '600', color: '#222' }}>Stay total</span>
                    <span style={{ fontSize: '14px', fontWeight: '700', color: '#00913f' }}>${getBookingTotal(selected, nights)}</span>
                  </div>
                  <div style={{ background: '#eef5ff', border: '1px solid #cfe3f7', borderRadius: '6px', padding: '10px', marginBottom: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ fontSize: '13px', color: '#1f6fd6', fontWeight: '600' }}>🔒 Refundable security deposit</span>
                      <span style={{ fontSize: '13px', color: '#1f6fd6', fontWeight: '700' }}>${getDeposit(selected, nights)}</span>
                    </div>
                    <p style={{ color: '#5c7693', fontSize: '11px', margin: 0, lineHeight: '1.5' }}>Held by smart contract on Sui — not by ARIA. Released when you approve.</p>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fff', border: '1px solid #ddd', borderRadius: '6px', padding: '12px', marginBottom: '12px' }}>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: '700', color: '#222' }}>Total charged today</div>
                      <div style={{ fontSize: '11px', color: '#999', marginTop: '2px' }}>Stay + refundable deposit</div>
                    </div>
                    <span style={{ fontSize: '20px', fontWeight: '700', color: '#222' }}>${getChargeTotal(selected, nights)}</span>
                  </div>
                  <div style={{ background: '#eafaf0', border: '1px solid #bfe8cf', borderRadius: '6px', padding: '10px', marginBottom: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ fontSize: '12px', color: '#00913f', fontWeight: '600' }}>Pay with SuiUSD</span>
                      <span style={{ fontSize: '11px', color: '#5c8a6d' }}>recommended</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ color: '#5c8a6d', fontSize: '12px' }}>Gas fee ~$0.02</span>
                      <span style={{ fontWeight: '700', fontSize: '16px', color: '#00913f' }}>${getChargeTotal(selected, nights)}<span style={{ fontSize: '11px', color: '#5c8a6d' }}>.02</span></span>
                    </div>
                  </div>
                  <div style={{ background: '#fdeeee', border: '1px solid #f5cccc', borderRadius: '6px', padding: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                      <span style={{ fontSize: '12px', color: '#d23f3f', fontWeight: '600' }}>Pay with Card</span>
                      <span style={{ fontSize: '11px', color: '#a37070' }}>Stripe 2.9% + $0.30</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ color: '#a37070', fontSize: '12px' }}>Processing fee ${getCardFee(selected, nights)}</span>
                      <span style={{ fontWeight: '700', fontSize: '16px', color: '#d23f3f' }}>${getCardTotal(selected, nights)}</span>
                    </div>
                  </div>
                </div>
              )}

              {(!checkIn || !checkOut) ? (
                <div style={{ background: '#fdf8ee', border: '1px solid #f0e2bb', borderRadius: '8px', padding: '12px', marginBottom: '20px', fontSize: '13px', color: '#717171', textAlign: 'center' }}>
                  👆 Select your dates above to see pricing
                </div>
              ) : (
                <>
                  <div style={{ background: '#f7f7f7', border: '1px solid #ebebeb', borderRadius: '8px', padding: '12px', marginBottom: '12px' }}>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
                      {['🔑 Your wallet, your funds','⚡ Instant on-chain settlement','✅ You control deposit release'].map((item, i) => (
                        <span key={i} style={{ background: '#fff', border: '1px solid #ddd', borderRadius: '20px', padding: '3px 10px', fontSize: '11px', color: '#444' }}>{item}</span>
                      ))}
                    </div>
                    <p style={{ color: '#999', fontSize: '11px', margin: 0, lineHeight: '1.6' }}>
                      ARIA is non-custodial. Payments execute directly on Sui. We cannot reverse or freeze transactions.
                    </p>
                  </div>
                  <div style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '8px', padding: '12px', marginBottom: '20px', fontSize: '12px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                      <span style={{ color: '#00913f', fontSize: '14px' }}>🛡️</span>
                      <span style={{ color: '#222', fontWeight: '600', fontSize: '13px' }}>Cancellation Policy</span>
                    </div>
                    <p style={{ color: '#717171', margin: 0, lineHeight: '1.5' }}>Cancel <strong style={{ color: '#222' }}>15+ days before check-in</strong> for a full refund of your stay payment — ARIA's fee included. Your deposit is always refunded on cancellation. Inside 14 days of check-in, the stay payment is non-refundable; you can list the booking on the resale market instead of losing the funds.</p>
                  </div>
                </>
              )}

              {checkIn && checkOut && nights > 0 && user && user.hasGuestProfile === false && (
                <div style={{ background: '#fdf6e3', border: '1px solid #f0d999', borderRadius: '8px', padding: '12px', marginBottom: '12px', fontSize: '12px' }}>
                  <div style={{ color: '#b06d00', fontWeight: '600', marginBottom: '4px' }}>⚠️ Identity verification required</div>
                  <p style={{ color: '#717171', margin: '0 0 8px', lineHeight: '1.5' }}>
                    Hosts need to be able to verify who's staying. Your ID is encrypted client-side and stored on Walrus via Seal — ARIA's backend never sees it; only your host can decrypt it for this booking.
                  </p>
                  <button onClick={() => { closeModal(); router.push('/profile'); }}
                    style={{ background: 'transparent', color: '#b06d00', border: '1px solid #b06d00', borderRadius: '6px', padding: '6px 10px', fontSize: '11px', cursor: 'pointer' }}>
                    Verify identity now
                  </button>
                </div>
              )}

              {checkIn && checkOut && nights > 0 && (
                <label style={{ display: 'flex', alignItems: 'start', gap: '10px', marginBottom: '12px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={termsAccepted} onChange={e => setTermsAccepted(e.target.checked)}
                    style={{ marginTop: '2px', accentColor: '#00913f', width: '16px', height: '16px', flexShrink: 0 }} />
                  <span style={{ fontSize: '12px', color: '#717171', lineHeight: '1.5' }}>
                    I understand ARIA is non-custodial. Payments execute on the Sui blockchain and cannot be reversed by ARIA. I accept the{' '}
                    <span onClick={(e) => { e.preventDefault(); window.open('/terms', '_blank'); }} style={{ color: '#00913f', cursor: 'pointer', textDecoration: 'underline' }}>Terms of Service</span>.
                  </span>
                </label>
              )}

              <button onClick={handleBooking} disabled={bookingLoading || !checkIn || !checkOut || (checkIn && checkOut && !termsAccepted)}
                style={{ width: '100%', background: bookingLoading ? '#ccc' : (!checkIn || !checkOut || !termsAccepted) ? '#eee' : '#ff385c', color: (!checkIn || !checkOut || !termsAccepted) ? '#999' : '#fff', border: 'none', borderRadius: '8px', padding: '14px', fontWeight: '700', fontSize: '15px', cursor: (!checkIn || !checkOut || !termsAccepted) ? 'not-allowed' : 'pointer', marginBottom: '8px' }}>
                {bookingLoading ? 'Processing on Sui...' : (!checkIn || !checkOut) ? 'Select dates to book' : !termsAccepted ? 'Accept terms to continue' : `Book Now – Pay $${getChargeTotal(selected, nights)} SuiUSD`}
              </button>
              <button onClick={handleCardPayment} disabled={bookingLoading || !checkIn || !checkOut}
                style={{ width: '100%', background: 'transparent', color: (!checkIn || !checkOut) ? '#ccc' : '#222', border: '1px solid #ccc', borderRadius: '8px', padding: '14px', fontWeight: '600', fontSize: '15px', cursor: (!checkIn || !checkOut) ? 'not-allowed' : 'pointer' }}>
                {(!checkIn || !checkOut) ? 'Pay with Card (Stripe)' : `Pay with Card – $${getCardTotal(selected, nights)}`}
              </button>

              {booking && (
                <div style={{ marginTop: '16px', background: '#eafaf0', border: '1px solid #00913f', borderRadius: '8px', padding: '16px', fontSize: '12px', color: '#00913f', textAlign: 'center' }}>
                  ✅ Booking confirmed! Ref: {booking.bookingRef}

                  {/* Phase 1h.5: pre-sign disclosure for the combined payment+deposit PTB */}
                  {escrowStatus === 'review' && booking.paymentEscrowBuilt && (
                    <div style={{ marginTop: '12px', textAlign: 'left', background: '#eef5ff', border: '1px solid #cfe3f7', borderRadius: '8px', padding: '12px' }}>
                      <div style={{ color: '#1f6fd6', fontWeight: 700, fontSize: '12px', marginBottom: '6px' }}>Review before you sign</div>
                      <div style={{ fontSize: '11px', color: '#5c7693', marginBottom: '10px', lineHeight: 1.5 }}>
                        One wallet signature funds two on-chain escrows from your own balance. Here's exactly where your money goes — and when:
                      </div>
                      {[
                        ['Rental → host', `$${booking.subtotal}`, 'released to your host at check-in'],
                        ['ARIA fee (5%) → ARIA', `$${booking.ariaFee}`, 'released at check-in'],
                        ['Taxes → tax remittance', `$${booking.taxes}`, 'released at check-in'],
                        ['Refundable deposit → escrow', `$${booking.depositAmount}`, 'returned after checkout'],
                      ].map(([label, amt, note], i) => (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '5px 0', borderBottom: i < 3 ? '1px solid #dce8f5' : 'none' }}>
                          <div><div style={{ color: '#2c4a66', fontSize: '12px' }}>{label}</div><div style={{ color: '#7c93a8', fontSize: '10px' }}>{note}</div></div>
                          <div style={{ color: '#222', fontSize: '12px', fontWeight: 700, whiteSpace: 'nowrap', paddingLeft: '10px' }}>{amt}</div>
                        </div>
                      ))}
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', paddingTop: '8px', borderTop: '1px solid #cfe3f7' }}>
                        <span style={{ color: '#222', fontSize: '12px', fontWeight: 700 }}>Total you sign for</span>
                        <span style={{ color: '#00913f', fontSize: '13px', fontWeight: 800 }}>${booking.chargeAmount} SuiUSD</span>
                      </div>
                      <p style={{ color: '#5c7693', fontSize: '10px', lineHeight: 1.5, margin: '8px 0 10px' }}>
                        Cancel <strong style={{ color: '#2c4a66' }}>15+ days before check-in</strong> for a full refund of everything above, ARIA's fee included. Inside 14 days of check-in, the rental, fee, and tax are non-refundable — list the booking on the resale market to recover funds instead; your deposit still returns after checkout either way. Funds sit in smart-contract escrow — never in an ARIA wallet.
                      </p>
                      <button onClick={() => handleEscrowSign(booking.bookingRef, booking.escrowTxBytes)}
                        style={{ width: '100%', background: '#00913f', color: '#fff', border: 'none', borderRadius: '6px', padding: '11px', fontWeight: 700, fontSize: '13px', cursor: 'pointer' }}>
                        Approve & sign in wallet
                      </button>
                    </div>
                  )}

                  {booking.depositAmount && booking.escrowTxBytes && escrowStatus !== 'review' && (
                    <div style={{ marginTop: '8px', color: '#1f6fd6', fontSize: '11px' }}>
                      {escrowStatus === 'signing' && '🔏 Sign the transaction in your wallet…'}
                      {escrowStatus === 'submitting' && (booking.paymentEscrowBuilt ? '📡 Submitting your payment + deposit to Sui…' : '📡 Submitting your deposit to Sui…')}
                      {escrowStatus === 'confirming' && '⏳ Confirming on-chain…'}
                      {escrowStatus === 'done' && (booking.paymentEscrowBuilt
                        ? `🔒 Payment escrowed ($${booking.chargeAmount}) — rental released to your host at check-in, $${booking.depositAmount} deposit returned after checkout`
                        : `🔒 $${booking.depositAmount} deposit held in Sui escrow — you control release`)}
                      {escrowStatus === 'error' && (
                        <>
                          <div style={{ color: '#d23f3f' }}>⚠️ {booking.paymentEscrowBuilt ? 'Payment escrow' : 'Deposit escrow'} not completed: {escrowError}</div>
                          <button onClick={() => handleEscrowSign(booking.bookingRef, booking.escrowTxBytes)}
                            style={{ marginTop: '6px', background: 'transparent', color: '#1f6fd6', border: '1px solid #1f6fd6', borderRadius: '6px', padding: '6px 10px', fontSize: '11px', cursor: 'pointer' }}>
                            Retry
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {booking.depositAmount && !booking.escrowTxBytes && (
                    <div style={{ marginTop: '8px', color: '#d23f3f', fontSize: '11px', textAlign: 'left' }}>
                      ⚠️ {booking.escrowBuildErrorMessage || 'We couldn’t prepare your escrow transaction, so nothing is funded yet.'} Your dates are held, but no money has moved.
                      <button onClick={() => router.push('/bookings')}
                        style={{ display: 'block', marginTop: '6px', background: 'transparent', color: '#1f6fd6', border: '1px solid #1f6fd6', borderRadius: '6px', padding: '6px 10px', fontSize: '11px', cursor: 'pointer' }}>
                        Go to My Bookings to finish
                      </button>
                    </div>
                  )}
                  {booking.walrusBlobId && (
                    <div style={{ marginTop: '10px', background: '#fff', border: '1px solid #d5ecdf', borderRadius: '6px', padding: '10px' }}>
                      <div style={{ color: '#999', fontSize: '10px', marginBottom: '4px' }}>RECEIPT STORED PERMANENTLY ON WALRUS</div>

                      <a href={`https://aggregator.walrus-testnet.walrus.space/v1/blobs/${booking.walrusBlobId}`} target="_blank" rel="noreferrer" style={{ color: '#00913f', fontFamily: 'monospace', fontSize: '10px', wordBreak: 'break-all' }}>{booking.walrusBlobId}</a>
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', marginTop: '8px' }}>
                    <span style={{ color: '#5c8a6d', fontSize: '11px', fontFamily: 'monospace', wordBreak: 'break-all' }}>{user.address}</span>
                    <button onClick={copyAddr} title="Copy address" style={{ background: 'none', border: 'none', cursor: 'pointer', color: addrCopied ? '#00913f' : '#5c8a6d', fontSize: '12px', padding: '0', flexShrink: 0 }}>
                      {addrCopied ? '✓' : '⧉'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
