import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import { beginZkLogin, signTransactionWithZkLogin, submitSignedTransaction } from '../../lib/zklogin';
import { useWalletBalance } from '../../lib/useWalletBalance';
import { fromBase64 } from '@mysten/sui/utils';
import { authFetch } from '../../lib/authFetch';
import { PROPERTY_DISPLAY, PLACEHOLDER_IMAGE, mergeProperty } from '../../lib/propertyDisplay';
import { getJurisdiction, getSubtotal, getAriaFee, getTax, getBookingTotal, getDeposit, getChargeTotal, getCardTotal } from '../../lib/pricing';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const GOOGLE_CALLBACK_URL = process.env.NEXT_PUBLIC_GOOGLE_CALLBACK_URL || (typeof window !== 'undefined' ? `${window.location.origin}/auth/zklogin/callback` : '');

// Dedicated, shareable page for a single property — replaces the old
// click-to-open booking modal on the homepage (pages/index.jsx) with a real
// route (/listing/:id), matching Airbnb's listing-page pattern. Booking logic
// (handleBooking/handleEscrowSign/handleCardPayment, the escrow review/sign/
// confirm states) is the same flow that used to live in index.jsx's modal —
// moved here wholesale rather than split across a shared hook, to stay
// consistent with how every other page in this app (profile.jsx, bookings.jsx,
// host.jsx) independently owns its own auth bootstrap and handlers.
export default function Listing() {
  const router = useRouter();
  const { id } = router.query;

  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [property, setProperty] = useState(null);
  const [propLoading, setPropLoading] = useState(true);
  const [liveRating, setLiveRating] = useState(null);
  const [photoIndex, setPhotoIndex] = useState(0);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [checkIn, setCheckIn] = useState(null);
  const [checkOut, setCheckOut] = useState(null);
  const [guests, setGuests] = useState(1);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [booking, setBooking] = useState(null);
  const [bookingLoading, setBookingLoading] = useState(false);
  const [escrowStatus, setEscrowStatus] = useState(null);
  const [escrowError, setEscrowError] = useState('');
  const [addrCopied, setAddrCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const wallet = useWalletBalance(user?.address);

  const nights = checkIn && checkOut ? Math.round((checkOut - checkIn) / (1000 * 60 * 60 * 24)) : 0;

  const copyAddr = () => {
    navigator.clipboard.writeText(user.address);
    setAddrCopied(true);
    setTimeout(() => setAddrCopied(false), 2000);
  };

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  useEffect(() => {
    authFetch(`${API}/auth/me`)
      .then(res => res.json())
      .then(data => { if (data.address) setUser(data); setAuthLoading(false); })
      .catch(() => setAuthLoading(false));
  }, []);

  // There's no GET /properties/:id endpoint, so this mirrors the same
  // fetch-the-whole-catalog-then-merge approach pages/index.jsx uses (see
  // lib/propertyDisplay.js mergeProperty) rather than inventing a second
  // code path against the backend.
  useEffect(() => {
    if (!router.isReady || !id) return;
    setPropLoading(true);
    fetch(`${API}/properties`).then(r => r.json()).then(d => {
      if (!Array.isArray(d.properties)) { setProperty(null); setPropLoading(false); return; }
      const match = d.properties.find(p => String(p.id) === String(id));
      if (!match) { setProperty(null); setPropLoading(false); return; }
      const merged = mergeProperty(match, PROPERTY_DISPLAY);
      setProperty(merged);
      setPropLoading(false);
      fetch(`${API}/reviews/${merged.id}`).then(r => r.json())
        .then(d2 => setLiveRating({ rating: d2.averageRating, count: d2.count, verifiedCount: d2.verifiedCount || 0 }))
        .catch(() => {});
    }).catch(() => { setProperty(null); setPropLoading(false); });
  }, [router.isReady, id]);

  const getDisplayRating = () => {
    if (liveRating && liveRating.count > 0) return { rating: liveRating.rating.toFixed(2), count: liveRating.count, verifiedCount: liveRating.verifiedCount || 0, isLive: true };
    return property ? { rating: property.rating, count: property.reviews, verifiedCount: 0, isLive: false } : { rating: 0, count: 0, verifiedCount: 0, isLive: false };
  };

  const handleLogin = async () => {
    if (!GOOGLE_CLIENT_ID) { alert('Sign-in is misconfigured (missing Google client ID). Please try again later.'); return; }
    try {
      const nonce = await beginZkLogin();
      const params = new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, response_type: 'id_token', redirect_uri: GOOGLE_CALLBACK_URL, scope: 'openid email profile', nonce });
      window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    } catch (err) {
      console.error('Failed to start sign-in:', err);
      alert('Could not start sign-in. Please check your connection and try again.');
    }
  };

  const handleBooking = async () => {
    if (!checkIn || !checkOut) { alert('Please select check-in and check-out dates'); return; }
    if (nights < 1) { alert('Check-out must be after check-in'); return; }
    if (!guests || guests < 1) { alert('Please enter at least 1 guest'); return; }
    if (property?.maxGuests && guests > property.maxGuests) { alert(`This property sleeps up to ${property.maxGuests} guests`); return; }
    if (user && user.hasGuestProfile === false) {
      alert('Please complete identity verification before booking — hosts need this for accountability. Redirecting to your profile.');
      router.push('/profile');
      return;
    }
    setBookingLoading(true);
    setEscrowStatus(null);
    setEscrowError('');
    const res = await authFetch(`${API}/booking/create`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ propertyId: property.id, checkIn: checkIn.toISOString().split('T')[0], checkOut: checkOut.toISOString().split('T')[0], guests }) // server derives title/price/nights/total from catalog.mjs
    });
    const data = await res.json();
    if (data.error === 'Property not available for selected dates') { alert('Sorry — those dates are already booked. Please select different dates.'); setBookingLoading(false); return; }
    if (!res.ok && data.needsVerification) {
      alert('Complete identity verification first. Redirecting to your profile.');
      setBookingLoading(false);
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
    // with the guest as sender. The guest's own browser must sign and submit it.
    if (data.escrowTxBytes) {
      if (data.paymentEscrowBuilt) {
        setEscrowStatus('review');
      } else {
        handleEscrowSign(data.bookingRef, data.escrowTxBytes);
      }
    }
  };

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
    const res = await authFetch(`${API}/payment/create-intent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ propertyId: property.id, nights }) });
    const data = await res.json();
    if (data.clientSecret) { setBooking({ bookingRef: 'STRIPE-' + Date.now(), stripeIntent: true }); }
    setBookingLoading(false);
  };

  if (authLoading || propLoading) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#fff', color: '#222' }}>Loading...</div>;
  }

  if (!property) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#fff', color: '#222', gap: '14px' }}>
        <div style={{ fontSize: '15px' }}>This listing isn't available anymore.</div>
        <button onClick={() => router.push('/')} style={{ background: '#ff385c', color: '#fff', border: 'none', borderRadius: '8px', padding: '10px 18px', fontSize: '14px', cursor: 'pointer' }}>Back to listings</button>
      </div>
    );
  }

  const { rating, count: ratingCount, verifiedCount, isLive } = getDisplayRating();
  const photos = property.images && property.images.length ? property.images : [property.image || PLACEHOLDER_IMAGE];

  return (
    <div style={{ minHeight: '100vh', background: '#fff', color: '#222' }}>
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
        .listing-photo-grid { display: grid; grid-template-columns: 1.2fr 1fr; gap: 8px; height: 380px; }
        .listing-photo-main { height: 100%; overflow: hidden; border-radius: 12px 0 0 12px; }
        .listing-photo-main img:hover { opacity: 0.92; }
        .listing-photo-side { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 8px; height: 100%; }
        .listing-photo-thumb { overflow: hidden; }
        .listing-photo-thumb img:hover { opacity: 0.92; }
        .listing-body { display: flex; gap: 40px; align-items: flex-start; }
        .listing-main { flex: 1.6; min-width: 0; }
        .listing-sidebar { flex: 1; min-width: 280px; max-width: 360px; position: sticky; top: 80px; }
        .gallery-arrow { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255,255,255,0.15); border: none; color: #fff; font-size: 22px; cursor: pointer; border-radius: 50%; width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; backdrop-filter: blur(4px); transition: background 0.15s; z-index: 2; }
        .gallery-arrow:hover { background: rgba(255,255,255,0.3); }
        @media (max-width: 900px) {
          .listing-photo-grid { grid-template-columns: 1fr; height: 280px; }
          .listing-photo-main { border-radius: 12px; }
          .listing-photo-side { display: none; }
          .listing-body { flex-direction: column; }
          .listing-sidebar { position: static; max-width: 100%; width: 100%; top: auto; }
        }
      `}</style>

      {/* Header */}
      <div style={{ background: '#fff', borderBottom: '1px solid #ebebeb', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '60px', position: 'sticky', top: 0, zIndex: 50 }}>
        <button onClick={() => router.push('/')} style={{ background: 'transparent', border: 'none', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', padding: '6px 0' }}>
          <span style={{ fontSize: '20px' }}>🏠</span>
          <span style={{ fontWeight: '700', fontSize: '18px', color: '#ff385c' }}>ARIA</span>
        </button>
        {user ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '12px', color: '#717171' }}>{user.name}</span>
            <span style={{ fontSize: '12px', color: wallet.lowBalance ? '#d23f3f' : '#717171', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '4px' }}>
              {wallet.display ?? (wallet.loading ? '···' : '0 SUI')}
              <button onClick={wallet.refresh} title="Refresh balance" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '12px', padding: 0 }}>↻</button>
            </span>
            {wallet.lowBalance && (
              <a href="https://faucet.sui.io/" target="_blank" rel="noreferrer" style={{ color: '#1f6fd6', fontSize: '12px', textDecoration: 'underline' }}>Get testnet SUI</a>
            )}
            <button onClick={() => router.push('/bookings')} style={{ background: 'transparent', border: '1px solid #ddd', color: '#444', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>My Bookings</button>
          </div>
        ) : (
          <button onClick={handleLogin} style={{ background: '#222', color: '#fff', border: 'none', borderRadius: '8px', padding: '8px 16px', fontSize: '13px', fontWeight: '600', cursor: 'pointer' }}>Sign in</button>
        )}
      </div>

      <div style={{ maxWidth: '1120px', margin: '0 auto', padding: '24px 24px 64px' }}>
        {/* Title row */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '16px', gap: '12px' }}>
          <h1 style={{ fontSize: '22px', fontWeight: '600', margin: 0 }}>{property.title}</h1>
          <button onClick={copyLink} style={{ background: 'transparent', border: 'none', color: '#222', fontSize: '13px', fontWeight: '600', textDecoration: 'underline', cursor: 'pointer', flexShrink: 0, whiteSpace: 'nowrap' }}>
            {linkCopied ? '✓ Link copied' : '⤴ Share'}
          </button>
        </div>

        {/* Photo grid */}
        <div className="listing-photo-grid" style={{ borderRadius: '12px', overflow: 'hidden', marginBottom: '28px', position: 'relative' }}>
          <div className="listing-photo-main" onClick={() => { setPhotoIndex(0); setGalleryOpen(true); }}>
            <img src={photos[0]} alt={property.title} style={{ width: '100%', height: '100%', objectFit: 'cover', cursor: 'pointer', display: 'block' }} />
          </div>
          <div className="listing-photo-side">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="listing-photo-thumb" onClick={() => { setPhotoIndex(Math.min(i, photos.length - 1)); setGalleryOpen(true); }}>
                {photos[i] ? <img src={photos[i]} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', cursor: 'pointer', display: 'block' }} /> : <div style={{ width: '100%', height: '100%', background: '#f2f2f2' }} />}
              </div>
            ))}
          </div>
          {photos.length > 1 && (
            <button onClick={() => { setPhotoIndex(0); setGalleryOpen(true); }} style={{ position: 'absolute', bottom: '16px', right: '16px', background: '#fff', border: '1px solid #222', borderRadius: '8px', padding: '8px 14px', fontSize: '13px', fontWeight: '600', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px' }}>
              ⊞ Show all photos
            </button>
          )}
        </div>

        {/* Body: details + booking sidebar */}
        <div className="listing-body">
          <div className="listing-main">
            <div style={{ paddingBottom: '20px', borderBottom: '1px solid #ebebeb', marginBottom: '20px' }}>
              <h2 style={{ fontSize: '17px', fontWeight: '600', margin: '0 0 6px' }}>{property.tag ? `${property.tag} stay` : 'Stay'} in {property.location}</h2>
              <div style={{ fontSize: '13px', color: '#717171' }}>{property.beds} bed{property.beds !== 1 ? 's' : ''} · {property.baths} bath{property.baths !== 1 ? 's' : ''} · Up to {property.maxGuests} guests</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', marginTop: '8px' }}>
                <span>★</span><span>{rating}</span>
                {isLive && ratingCount > 0 && <span style={{ color: '#717171' }}>· {ratingCount} review{ratingCount !== 1 ? 's' : ''}</span>}
                {verifiedCount > 0 && <span title={`${verifiedCount} review${verifiedCount > 1 ? 's' : ''} from a real on-chain-escrow stay`} style={{ color: '#00913f', fontWeight: '700' }}>✓{verifiedCount} verified</span>}
              </div>
            </div>

            <div style={{ paddingBottom: '20px', borderBottom: '1px solid #ebebeb', marginBottom: '20px' }}>
              <h3 style={{ fontSize: '15px', fontWeight: '600', margin: '0 0 8px' }}>About this place</h3>
              <p style={{ fontSize: '14px', color: '#444', lineHeight: '1.6', margin: 0 }}>
                {property.description && property.description.trim()
                  ? property.description
                  : `A ${(property.tag || 'comfortable').toLowerCase()} ${property.beds}-bedroom stay in ${property.location}, sleeping up to ${property.maxGuests} guests. Booked and paid for directly on-chain — no middleman holding your money.`}
              </p>
            </div>

            <div>
              <h3 style={{ fontSize: '15px', fontWeight: '600', margin: '0 0 10px' }}>Why book with ARIA</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {[
                  '🔑 Your wallet, your funds — ARIA never holds your money',
                  '⚡ Instant on-chain settlement, no 3–5 day bank holds',
                  '🔒 Refundable deposit held by smart contract, not ARIA',
                  '💸 5% platform fee vs. up to 15% on Airbnb',
                ].map((item, i) => (
                  <div key={i} style={{ fontSize: '13px', color: '#444' }}>{item}</div>
                ))}
              </div>
            </div>
          </div>

          {/* Booking sidebar */}
          <div className="listing-sidebar">
            <div style={{ border: '1px solid #ddd', borderRadius: '12px', padding: '20px', boxShadow: '0 6px 16px rgba(0,0,0,0.08)' }}>
              {!user ? (
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '17px', fontWeight: '700', marginBottom: '4px' }}>${property.price} <span style={{ fontSize: '13px', fontWeight: '400', color: '#717171' }}>night</span></div>
                  <p style={{ fontSize: '12px', color: '#717171', margin: '8px 0 14px' }}>Sign in to see the full price breakdown and book this stay.</p>
                  <button onClick={handleLogin} style={{ width: '100%', background: '#222', color: '#fff', border: 'none', borderRadius: '8px', padding: '12px', fontWeight: '600', fontSize: '14px', cursor: 'pointer' }}>Sign in with Google</button>
                </div>
              ) : (
                <>
                  <div style={{ fontSize: '17px', fontWeight: '700', marginBottom: '16px' }}>${property.price} <span style={{ fontSize: '13px', fontWeight: '400', color: '#717171' }}>night</span></div>

                  <div style={{ marginBottom: '14px' }}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <div style={{ flex: 1, border: '1px solid #ddd', borderRadius: '8px', padding: '10px 12px' }}>
                        <div style={{ fontSize: '10px', color: '#999' }}>CHECK-IN</div>
                        <DatePicker selected={checkIn} onChange={date => { setCheckIn(date); if (checkOut && date >= checkOut) setCheckOut(null); }} selectsStart startDate={checkIn} endDate={checkOut} minDate={new Date()} placeholderText="Add date" dateFormat="MMM d, yyyy" className="date-input" />
                      </div>
                      <div style={{ flex: 1, border: '1px solid #ddd', borderRadius: '8px', padding: '10px 12px' }}>
                        <div style={{ fontSize: '10px', color: '#999' }}>CHECK-OUT</div>
                        <DatePicker selected={checkOut} onChange={date => setCheckOut(date)} selectsEnd startDate={checkIn} endDate={checkOut} minDate={checkIn ? new Date(checkIn.getTime() + 86400000) : new Date()} placeholderText="Add date" dateFormat="MMM d, yyyy" className="date-input" />
                      </div>
                    </div>
                    {checkIn && checkOut && nights > 0 && <div style={{ marginTop: '6px', fontSize: '12px', color: '#00913f', textAlign: 'center' }}>{nights} night{nights > 1 ? 's' : ''} selected</div>}
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#f7f7f7', border: '1px solid #ddd', borderRadius: '8px', padding: '10px 12px', marginBottom: '16px' }}>
                    <span style={{ fontSize: '13px' }}>Guests {property.maxGuests && <span style={{ color: '#999', fontSize: '11px' }}>(max {property.maxGuests})</span>}</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <button type="button" onClick={() => setGuests(g => Math.max(1, g - 1))} disabled={guests <= 1} style={{ width: '26px', height: '26px', borderRadius: '50%', border: '1px solid #ccc', background: '#fff', color: guests <= 1 ? '#ccc' : '#222', cursor: guests <= 1 ? 'not-allowed' : 'pointer' }}>−</button>
                      <span style={{ fontSize: '14px', fontWeight: '600', minWidth: '14px', textAlign: 'center' }}>{guests}</span>
                      <button type="button" onClick={() => setGuests(g => Math.min(property.maxGuests || 16, g + 1))} disabled={property.maxGuests && guests >= property.maxGuests} style={{ width: '26px', height: '26px', borderRadius: '50%', border: '1px solid #ccc', background: '#fff', color: (property.maxGuests && guests >= property.maxGuests) ? '#ccc' : '#222', cursor: (property.maxGuests && guests >= property.maxGuests) ? 'not-allowed' : 'pointer' }}>+</button>
                    </div>
                  </div>

                  {checkIn && checkOut && nights > 0 && (
                    <div style={{ background: '#f7f7f7', border: '1px solid #ebebeb', borderRadius: '8px', padding: '14px', marginBottom: '16px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <span style={{ color: '#717171', fontSize: '13px' }}>${property.price} × {nights} night{nights > 1 ? 's' : ''}</span>
                        <span style={{ fontSize: '13px' }}>${getSubtotal(property, nights)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <span style={{ color: '#717171', fontSize: '13px' }}>ARIA fee (5%)</span>
                        <span style={{ fontSize: '13px', color: '#00913f' }}>${getAriaFee(property, nights)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', paddingBottom: '12px', borderBottom: '1px solid #ddd' }}>
                        <span style={{ color: '#717171', fontSize: '13px' }}>Occupancy tax ({(getJurisdiction(property).rate * 100).toFixed(2)}%)</span>
                        <span style={{ fontSize: '13px', color: '#717171' }}>${getTax(property, nights)}</span>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                        <span style={{ fontSize: '13px', fontWeight: '600' }}>Stay total</span>
                        <span style={{ fontSize: '13px', fontWeight: '700', color: '#00913f' }}>${getBookingTotal(property, nights)}</span>
                      </div>
                      <div style={{ background: '#eef5ff', border: '1px solid #cfe3f7', borderRadius: '6px', padding: '10px', marginBottom: '10px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: '12px', color: '#1f6fd6', fontWeight: '600' }}>🔒 Refundable deposit</span>
                          <span style={{ fontSize: '12px', color: '#1f6fd6', fontWeight: '700' }}>${getDeposit(property, nights)}</span>
                        </div>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fff', border: '1px solid #ddd', borderRadius: '6px', padding: '10px' }}>
                        <span style={{ fontSize: '13px', fontWeight: '700' }}>Total today</span>
                        <span style={{ fontSize: '17px', fontWeight: '700' }}>${getChargeTotal(property, nights)}</span>
                      </div>
                    </div>
                  )}

                  {checkIn && checkOut && nights > 0 && user.hasGuestProfile === false && (
                    <div style={{ background: '#fdf6e3', border: '1px solid #f0d999', borderRadius: '8px', padding: '12px', marginBottom: '12px', fontSize: '12px' }}>
                      <div style={{ color: '#b06d00', fontWeight: '600', marginBottom: '4px' }}>⚠️ Identity verification required</div>
                      <p style={{ color: '#717171', margin: '0 0 8px', lineHeight: '1.5' }}>Hosts need to be able to verify who's staying. Your ID is encrypted client-side and stored on Walrus via Seal.</p>
                      <button onClick={() => router.push('/profile')} style={{ background: 'transparent', color: '#b06d00', border: '1px solid #b06d00', borderRadius: '6px', padding: '6px 10px', fontSize: '11px', cursor: 'pointer' }}>Verify identity now</button>
                    </div>
                  )}

                  {checkIn && checkOut && nights > 0 && (
                    <label style={{ display: 'flex', alignItems: 'start', gap: '8px', marginBottom: '12px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={termsAccepted} onChange={e => setTermsAccepted(e.target.checked)} style={{ marginTop: '2px', accentColor: '#00913f', width: '15px', height: '15px', flexShrink: 0 }} />
                      <span style={{ fontSize: '11px', color: '#717171', lineHeight: '1.5' }}>
                        I understand ARIA is non-custodial and payments execute on Sui. I accept the{' '}
                        <span onClick={(e) => { e.preventDefault(); window.open('/terms', '_blank'); }} style={{ color: '#00913f', cursor: 'pointer', textDecoration: 'underline' }}>Terms of Service</span>.
                      </span>
                    </label>
                  )}

                  <button onClick={handleBooking} disabled={bookingLoading || !checkIn || !checkOut || (checkIn && checkOut && !termsAccepted)}
                    style={{ width: '100%', background: bookingLoading ? '#ccc' : (!checkIn || !checkOut || !termsAccepted) ? '#eee' : '#ff385c', color: (!checkIn || !checkOut || !termsAccepted) ? '#999' : '#fff', border: 'none', borderRadius: '8px', padding: '13px', fontWeight: '700', fontSize: '14px', cursor: (!checkIn || !checkOut || !termsAccepted) ? 'not-allowed' : 'pointer', marginBottom: '8px' }}>
                    {bookingLoading ? 'Processing on Sui...' : (!checkIn || !checkOut) ? 'Select dates to book' : !termsAccepted ? 'Accept terms to continue' : `Book Now – $${getChargeTotal(property, nights)} SuiUSD`}
                  </button>
                  <button onClick={handleCardPayment} disabled={bookingLoading || !checkIn || !checkOut}
                    style={{ width: '100%', background: 'transparent', color: (!checkIn || !checkOut) ? '#ccc' : '#222', border: '1px solid #ccc', borderRadius: '8px', padding: '13px', fontWeight: '600', fontSize: '14px', cursor: (!checkIn || !checkOut) ? 'not-allowed' : 'pointer' }}>
                    {(!checkIn || !checkOut) ? 'Pay with Card (Stripe)' : `Pay with Card – $${getCardTotal(property, nights)}`}
                  </button>

                  {booking && (
                    <div style={{ marginTop: '16px', background: '#eafaf0', border: '1px solid #00913f', borderRadius: '8px', padding: '16px', fontSize: '12px', color: '#00913f', textAlign: 'center' }}>
                      ✅ Booking confirmed! Ref: {booking.bookingRef}

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
                          {escrowStatus === 'done' && (
                            <>
                              {booking.paymentEscrowBuilt
                                ? `🔒 Payment escrowed ($${booking.chargeAmount}) — rental released to your host at check-in, $${booking.depositAmount} deposit returned after checkout`
                                : `🔒 $${booking.depositAmount} deposit held in Sui escrow — you control release`}
                              <button onClick={() => router.push('/bookings')}
                                style={{ display: 'block', margin: '8px auto 0', background: 'transparent', color: '#1f6fd6', border: '1px solid #1f6fd6', borderRadius: '6px', padding: '6px 10px', fontSize: '11px', cursor: 'pointer' }}>
                                View My Bookings
                              </button>
                            </>
                          )}
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
                          {booking.escrowBuildErrorCode === 'insufficient_balance' && (
                            <a href="https://faucet.sui.io/" target="_blank" rel="noreferrer"
                              style={{ display: 'block', marginTop: '6px', color: '#1f6fd6', fontSize: '11px', textDecoration: 'underline' }}>
                              Get testnet SUI from the faucet →
                            </a>
                          )}
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
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Full-screen photo gallery */}
      {galleryOpen && (
        <div style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 200, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#fff', fontSize: '13px' }}>{photoIndex + 1} / {photos.length}</span>
            <button onClick={() => setGalleryOpen(false)} style={{ background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff', fontSize: '20px', cursor: 'pointer', borderRadius: '50%', width: '36px', height: '36px' }}>×</button>
          </div>
          <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <img src={photos[photoIndex]} alt="" style={{ maxWidth: '90%', maxHeight: '80vh', objectFit: 'contain' }} />
            {photoIndex > 0 && <button className="gallery-arrow" onClick={() => setPhotoIndex(i => i - 1)} style={{ left: '16px' }}>‹</button>}
            {photoIndex < photos.length - 1 && <button className="gallery-arrow" onClick={() => setPhotoIndex(i => i + 1)} style={{ right: '16px' }}>›</button>}
          </div>
        </div>
      )}
    </div>
  );
}
