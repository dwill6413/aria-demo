import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { authFetch } from '../lib/authFetch';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const fmtDay = (d) => {
  const s = String(d).slice(0, 10);
  const [y, mo, day] = s.split('-').map(Number);
  if (!y || !mo || !day) return s;
  return new Date(y, mo - 1, day).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// Check-in scanner (BookingPass Phase 1). The front-desk / lock operator presents
// this; the guest shows their rotating Check-in Pass QR. Paste (or, later, camera-
// scan) the payload → /checkin/verify proves it's a fresh, wallet-signed pass from
// the booking's own guest for a live on-chain booking. Host-only.
export default function Scan() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState('');
  const [status, setStatus] = useState('idle'); // idle|verifying|valid|invalid
  const [result, setResult] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch(`${API}/auth/me`);
        if (!res.ok) { router.push('/'); return; }
        const me = await res.json();
        if (!me.isHost) { setUser({ ...me, notHost: true }); setLoading(false); return; }
        setUser(me);
      } catch { router.push('/'); return; }
      setLoading(false);
    })();
  }, []);

  const verify = async () => {
    if (!token.trim()) return;
    setStatus('verifying');
    setResult(null);
    try {
      const res = await authFetch(`${API}/checkin/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });
      const data = await res.json();
      if (res.ok && data.valid) { setStatus('valid'); setResult(data); }
      else { setStatus('invalid'); setResult({ reason: data.reason || 'Pass could not be verified' }); }
    } catch (err) {
      setStatus('invalid'); setResult({ reason: err.message || 'Scan failed' });
    }
  };

  const reset = () => { setToken(''); setStatus('idle'); setResult(null); };

  const wrap = { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', background: '#fff', color: '#222', minHeight: '100vh', padding: '24px' };
  const card = { maxWidth: 520, margin: '0 auto', background: '#fff', border: '1px solid #ebebeb', borderRadius: 12, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' };

  if (loading) return <div style={wrap}><div style={card}>Loading…</div></div>;
  if (user?.notHost) return <div style={wrap}><div style={card}>This scanner is for hosts / front-desk only.</div></div>;

  return (
    <div style={wrap}>
      <div style={{ maxWidth: 520, margin: '0 auto 16px' }}>
        <a href="/host" style={{ color: '#717171', fontSize: 13, textDecoration: 'none' }}>← Host Dashboard</a>
      </div>
      <div style={card}>
        <h1 style={{ fontSize: 22, margin: '0 0 4px', color: '#222' }}>🛂 Check-in Scanner</h1>
        <p style={{ color: '#717171', fontSize: 13, lineHeight: 1.6, margin: '0 0 18px' }}>
          Ask the guest to open their <strong style={{ color: '#8b3dff' }}>Check-in Pass</strong> and scan the QR — or paste its code below.
          A valid pass is a fresh, wallet-signed proof for a live on-chain booking; stale screenshots and cancelled bookings fail.
        </p>

        {status === 'valid' ? (
          <div style={{ background: '#eafaf0', border: '1px solid #c8ebd9', borderRadius: 12, padding: 20 }}>
            <div style={{ color: '#00913f', fontWeight: 800, fontSize: 20, marginBottom: 12 }}>✅ Valid check-in</div>
            <div style={{ display: 'grid', gap: 6 }}>
              <Row k="Guest" v={result.guestName || '—'} />
              <Row k="Property" v={result.property} />
              <Row k="Check-in" v={fmtDay(result.checkIn)} />
              <Row k="Check-out" v={fmtDay(result.checkOut)} />
              <Row k="Ref" v={result.bookingRef} mono />
            </div>
            <button onClick={reset} style={{ width: '100%', marginTop: 16, background: '#00913f', border: 'none', color: '#fff', borderRadius: 8, padding: 12, fontWeight: 700, cursor: 'pointer' }}>
              Scan next guest
            </button>
          </div>
        ) : status === 'invalid' ? (
          <div style={{ background: '#fdeeee', border: '1px solid #f5d0d0', borderRadius: 12, padding: 20 }}>
            <div style={{ color: '#d23f3f', fontWeight: 800, fontSize: 20, marginBottom: 8 }}>⛔ Not valid</div>
            <div style={{ color: '#a35353', fontSize: 13 }}>{result?.reason}</div>
            <button onClick={reset} style={{ width: '100%', marginTop: 16, background: 'transparent', border: '1px solid #ddd', color: '#717171', borderRadius: 8, padding: 12, cursor: 'pointer' }}>
              Try again
            </button>
          </div>
        ) : (
          <>
            <textarea value={token} onChange={e => setToken(e.target.value)} placeholder="Paste the guest's check-in code…" rows={4}
              style={{ width: '100%', boxSizing: 'border-box', background: '#fff', border: '1px solid #ddd', borderRadius: 8, padding: 12, color: '#222', fontSize: 12, fontFamily: 'monospace', resize: 'none' }} />
            <button onClick={verify} disabled={!token.trim() || status === 'verifying'}
              style={{ width: '100%', marginTop: 10, borderRadius: 8, padding: 12, fontWeight: 700, fontSize: 14, border: 'none',
                background: (!token.trim() || status === 'verifying') ? '#eee' : '#8b3dff', color: (!token.trim() || status === 'verifying') ? '#999' : '#fff',
                cursor: (!token.trim() || status === 'verifying') ? 'not-allowed' : 'pointer' }}>
              {status === 'verifying' ? 'Verifying…' : '🛂 Verify check-in'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ k, v, mono }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: '#717171', fontSize: 12 }}>{k}</span>
      <span style={{ color: '#222', fontSize: 12, fontFamily: mono ? 'monospace' : 'inherit', textAlign: 'right', wordBreak: 'break-all' }}>{v}</span>
    </div>
  );
}
