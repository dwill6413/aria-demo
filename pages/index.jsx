import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import { beginZkLogin, signTransactionWithZkLogin, submitSignedTransaction } from '../lib/zklogin';
import { fromBase64 } from '@mysten/sui/utils';
import { authFetch } from '../lib/authFetch';
import { PROPERTY_DISPLAY, mergeProperty } from '../lib/propertyDisplay';
import { useWalletBalance } from '../lib/useWalletBalance';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
const GOOGLE_CALLBACK_URL = process.env.NEXT_PUBLIC_GOOGLE_CALLBACK_URL || (typeof window !== 'undefined' ? `${window.location.origin}/auth/zklogin/callback` : '');

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
  const [searchLocation, setSearchLocation] = useState('All Locations');
  const [searchCheckIn, setSearchCheckIn] = useState(null);
  const [searchCheckOut, setSearchCheckOut] = useState(null);
  const [searchGuests, setSearchGuests] = useState(1);
  const [properties, setProperties] = useState(PROPERTY_DISPLAY);
  const [filteredProperties, setFilteredProperties] = useState(PROPERTY_DISPLAY);
  const [searched, setSearched] = useState(false);
  const [liveRatings, setLiveRatings] = useState({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [addrCopied, setAddrCopied] = useState(false);
  const wallet = useWalletBalance(user?.address);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendToAddress, setSendToAddress] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [sendStatus, setSendStatus] = useState('idle');
  const [sendError, setSendError] = useState('');
  const [sendDigest, setSendDigest] = useState('');
  // Horizontal scroll row (Airbnb-style "Popular homes" carousel) — ref lets
  // the arrow buttons scroll the row without re-rendering on every scroll event.
  const scrollRowRef = useRef(null);
  const scrollRow = (dir) => { scrollRowRef.current?.scrollBy({ left: dir * 320, behavior: 'smooth' }); };

  const copyAddr = () => {
    navigator.clipboard.writeText(user.address);
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
    const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
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
        throw new Error(confirmData.retryable ? `${msg} It may already have gone through — check your balance.` : msg);
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
      const merged = d.properties.map(p => mergeProperty(p, PROPERTY_DISPLAY));
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
        .become-host-link:hover { background: #f7f7f7 !important; }
        .nav-hamburger { display: none !important; }
        .search-pill { display: flex; align-items: center; background: #fff; border: 1px solid #ddd; border-radius: 40px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); max-width: 760px; margin: 0 auto; }
        .search-field { padding: 12px 22px; cursor: pointer; min-width: 0; }
        .search-divider { width: 1px; height: 32px; background: #ddd; flex-shrink: 0; }
        .search-step-btn { width: 26px; height: 26px; border-radius: 50%; border: 1px solid #ccc; background: #fff; color: #222; cursor: pointer; font-size: 14px; display: flex; align-items: center; justify-content: center; }
        .search-step-btn:disabled { color: #ccc; cursor: not-allowed; }
        .property-scroll-row { scrollbar-width: none; -ms-overflow-style: none; }
        .property-scroll-row::-webkit-scrollbar { display: none; }
        .scroll-arrow { position: absolute; top: 96px; transform: translateY(-50%); background: #fff; border: 1px solid #ddd; color: #222; font-size: 20px; cursor: pointer; border-radius: 50%; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 8px rgba(0,0,0,0.15); z-index: 2; transition: transform 0.15s ease; }
        .scroll-arrow:hover { transform: translateY(-50%) scale(1.08); }
        .scroll-arrow-left { left: -14px; }
        .scroll-arrow-right { right: -14px; }
        @media (max-width: 639px) {
          .scroll-arrow { display: none; }
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
          {user.isHost ? (
            <button onClick={() => router.push('/host')} style={{ background: 'transparent', border: 'none', color: '#222', padding: '10px 12px', borderRadius: '22px', fontSize: '14px', fontWeight: '600', cursor: 'pointer' }}>Host Dashboard</button>
          ) : user.hostStatus === 'pending' ? (
            <span style={{ fontSize: '14px', color: '#b06d00', fontWeight: '600', padding: '10px 12px' }}>⏳ Application Pending</span>
          ) : (
            <button onClick={() => router.push('/become-host')} className="become-host-link" style={{ background: 'transparent', border: 'none', color: '#222', padding: '10px 12px', borderRadius: '22px', fontSize: '14px', fontWeight: '600', cursor: 'pointer' }}>Become a host</button>
          )}
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '13px', fontWeight: '500', color: '#222' }}>{user.name}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', justifyContent: 'flex-end' }}>
              <div style={{ fontSize: '11px', color: '#00913f', fontFamily: 'monospace', wordBreak: 'break-all' }}>{user.address}</div>
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
          <button onClick={() => router.push('/bookings')} style={{ background: 'transparent', border: '1px solid #ddd', color: '#444', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>My Bookings</button>
          <button onClick={() => router.push('/profile')}
            style={{ background: 'transparent', border: `1px solid ${user.hasGuestProfile === false ? '#ffd699' : '#ddd'}`, color: user.hasGuestProfile === false ? '#b06d00' : '#444', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: user.hasGuestProfile === false ? '600' : '400' }}>
            🪪 {user.hasGuestProfile === false ? 'Verify Identity' : 'Identity'}
          </button>
          <button onClick={() => router.push('/bookings?market=1')} style={{ background: 'transparent', border: '1px solid #ffd699', color: '#b06d00', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer', fontWeight: '600' }}>🏷️ Resale Market</button>
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
      <div style={{ maxWidth: '1200px', margin: '0 auto', padding: '32px 24px', flex: 1, position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <h3 style={{ fontSize: '18px', fontWeight: '600', margin: 0, color: '#222' }}>Popular homes</h3>
          <span style={{ fontSize: '13px', color: '#717171' }}>{filteredProperties.length} properties available</span>
        </div>
        <div style={{ position: 'relative' }}>
          <button type="button" aria-label="Scroll left" onClick={() => scrollRow(-1)} className="scroll-arrow scroll-arrow-left">‹</button>
          <div ref={scrollRowRef} className="property-scroll-row" style={{ display: 'flex', gap: '20px', overflowX: 'auto', scrollSnapType: 'x mandatory', paddingBottom: '8px' }}>
            {filteredProperties.map(p => {
              const { rating, count, verifiedCount, isLive } = getDisplayRating(p);
              return (
                <div key={p.id} className="property-card" onClick={() => router.push('/listing/' + p.id)} style={{ cursor: 'pointer', borderRadius: '12px', flex: '0 0 260px', minWidth: '260px', maxWidth: '260px', scrollSnapAlign: 'start' }}>
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
          <button type="button" aria-label="Scroll right" onClick={() => scrollRow(1)} className="scroll-arrow scroll-arrow-right">›</button>
        </div>
      </div>

      {/* Send funds modal */}
      {sendOpen && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: '24px' }}>
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

      {/* Footer */}
      <div style={{ borderTop: '1px solid #ebebeb', padding: '24px', textAlign: 'center', marginTop: 'auto' }}>
        <p style={{ color: '#717171', fontSize: '11px', margin: '0 0 6px', lineHeight: '1.7', maxWidth: '700px', marginLeft: 'auto', marginRight: 'auto' }}>
          ⚠️ ARIA is a non-custodial platform. We do not hold your funds. All payments execute directly on the Sui blockchain. ARIA has no ability to reverse, freeze, or recover transactions. You are solely responsible for your wallet and transactions.
        </p>
        <p style={{ color: '#999', fontSize: '11px', margin: 0 }}>© 2026 ARIA · Built on Sui · Powered by DeepBook & Walrus · <span style={{ color: '#999' }}>Non-custodial · You stay in control</span> · <span onClick={() => router.push('/terms')} style={{ color: '#999', cursor: 'pointer', textDecoration: 'underline' }}>Terms of Service</span></p>
      </div>

    </div>
  );
}
