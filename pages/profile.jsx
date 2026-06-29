import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { authFetch } from '../lib/authFetch';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

// Phase 2 (guest PII): the guest fills in identity details, which are encrypted
// in the browser with Seal (identity = their Sui address) and stored on Walrus.
// Only the Walrus blob pointer is sent to ARIA — never the plaintext. The
// booking's host can later decrypt it via escrow.move's seal_approve gate.
//
// NOTE: demo data only. Per the Phase 2 compliance note, real PII must not flow
// through this path until mainnet hardening (audit logging, paid key servers).
const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS',
  'KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC',
  'ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
];

const ID_TYPES = [
  "Driver's License",
  'Passport',
  'State ID Card',
  'Military ID',
  'National ID Card',
];

const FIELDS = [
  { key: 'fullName', label: 'Full legal name', placeholder: 'Jordan A. Traveler' },
  { key: 'dob', label: 'Date of birth', placeholder: 'YYYY-MM-DD' },
  { key: 'phone', label: 'Phone number', placeholder: '+1 555 010 0000' },
  { key: 'idType', label: 'ID type', type: 'select', options: ID_TYPES, placeholder: 'Select ID type' },
  { key: 'idNumber', label: 'ID number', placeholder: 'X1234567' },
  { key: 'idState', label: 'ID issuing state', type: 'select', options: US_STATES, placeholder: 'Select state' },
  { key: 'address', label: 'Home address', placeholder: '123 Main St, City, ST' },
];

export default function Profile() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [verified, setVerified] = useState(false);
  const [form, setForm] = useState(Object.fromEntries(FIELDS.map(f => [f.key, ''])));
  const [status, setStatus] = useState('idle'); // idle|encrypting|storing|saving|done|error
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const meRes = await authFetch(`${API}/auth/me`);
        if (!meRes.ok) { router.push('/'); return; }
        const me = await meRes.json();
        setUser(me);
        const pRes = await authFetch(`${API}/guest/profile`);
        const p = await pRes.json();
        if (p.verified) setVerified(true);
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, []);

  const setField = (k, v) => setForm(prev => ({ ...prev, [k]: v }));
  const allFilled = FIELDS.every(f => String(form[f.key] || '').trim().length > 0);

  const handleSubmit = async () => {
    if (!allFilled || !user?.address) return;
    setError('');
    try {
      // Dynamic import so the app still builds before @mysten/seal is installed.
      const { encryptAndStorePII } = await import('../lib/seal');
      const { getZkLoginSuiClient } = await import('../lib/zklogin');
      const suiClient = getZkLoginSuiClient();

      setStatus('encrypting');
      // encryptAndStorePII encrypts then stores; we surface "storing" optimistically.
      setStatus('storing');
      const blobId = await encryptAndStorePII(suiClient, user.address, {
        ...form, verifiedAt: new Date().toISOString(),
      });

      setStatus('saving');
      const res = await authFetch(`${API}/guest/profile`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ walrusBlobId: blobId, phoneVerified: false }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Could not save your verification');

      setStatus('done');
      setVerified(true);
    } catch (err) {
      console.error('Identity verification failed:', err);
      setStatus('error');
      setError(err.message || 'Verification failed. Please try again.');
    }
  };

  const wrap = { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', background: '#fff', color: '#222', minHeight: '100vh', padding: '24px' };
  const card = { maxWidth: 560, margin: '0 auto', background: '#fff', border: '1px solid #ebebeb', borderRadius: 12, padding: 24, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' };

  if (loading) return <div style={wrap}><div style={card}>Loading…</div></div>;

  return (
    <div style={wrap}>
      <div style={{ maxWidth: 560, margin: '0 auto 16px' }}>
        <a href="/" style={{ color: '#717171', fontSize: 13, textDecoration: 'none' }}>← Back</a>
      </div>
      <div style={card}>
        <h1 style={{ fontSize: 22, margin: '0 0 6px', color: '#222' }}>Identity verification</h1>
        <p style={{ color: '#717171', fontSize: 13, lineHeight: 1.6, margin: '0 0 20px' }}>
          Your details are encrypted in your browser with Seal and stored on Walrus.
          ARIA never sees them — only the host of a booking you make can decrypt them,
          and only while that booking is active. <span style={{ color: '#999' }}>Demo data only.</span>
        </p>

        {verified ? (
          <div style={{ background: '#eafaf0', border: '1px solid #c8ebd9', borderRadius: 8, padding: 16 }}>
            <div style={{ color: '#00913f', fontWeight: 700, fontSize: 14 }}>✅ Identity verified</div>
            <p style={{ color: '#5c8a6d', fontSize: 12, margin: '6px 0 0' }}>
              Your encrypted identity is stored. You can re-submit below to update it.
            </p>
            <button onClick={() => setVerified(false)}
              style={{ marginTop: 12, background: 'transparent', color: '#1f6fd6', border: '1px solid #1f6fd6', borderRadius: 6, padding: '6px 12px', fontSize: 12, cursor: 'pointer' }}>
              Update identity
            </button>
          </div>
        ) : (
          <>
            {FIELDS.map(f => (
              <div key={f.key} style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', color: '#717171', fontSize: 12, marginBottom: 4 }}>{f.label}</label>
                {f.type === 'select' ? (
                  <select value={form[f.key]} onChange={e => setField(f.key, e.target.value)}
                    style={{ width: '100%', boxSizing: 'border-box', background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '10px', color: form[f.key] ? '#222' : '#999', fontSize: 13 }}>
                    <option value="">{f.placeholder || 'Select…'}</option>
                    {f.options.map(o => <option key={o} value={o} style={{ color: '#222' }}>{o}</option>)}
                  </select>
                ) : (
                  <input value={form[f.key]} onChange={e => setField(f.key, e.target.value)} placeholder={f.placeholder}
                    style={{ width: '100%', boxSizing: 'border-box', background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '10px', color: '#222', fontSize: 13 }} />
                )}
              </div>
            ))}

            {status !== 'idle' && status !== 'error' && (
              <div style={{ color: '#1f6fd6', fontSize: 12, margin: '8px 0' }}>
                {status === 'encrypting' && '🔐 Encrypting with Seal…'}
                {status === 'storing' && '🔐 Encrypting & storing on Walrus…'}
                {status === 'saving' && '💾 Saving your verification…'}
                {status === 'done' && '✅ Verified!'}
              </div>
            )}
            {status === 'error' && <div style={{ color: '#d23f3f', fontSize: 12, margin: '8px 0' }}>⚠️ {error}</div>}

            <button onClick={handleSubmit}
              disabled={!allFilled || ['encrypting', 'storing', 'saving'].includes(status)}
              style={{
                width: '100%', marginTop: 8, borderRadius: 8, padding: 12, fontWeight: 700, fontSize: 14, border: 'none',
                background: (!allFilled || ['encrypting', 'storing', 'saving'].includes(status)) ? '#eee' : '#ff385c',
                color: (!allFilled || ['encrypting', 'storing', 'saving'].includes(status)) ? '#999' : '#fff',
                cursor: (!allFilled || ['encrypting', 'storing', 'saving'].includes(status)) ? 'not-allowed' : 'pointer',
              }}>
              {['encrypting', 'storing', 'saving'].includes(status) ? 'Encrypting…' : 'Encrypt & verify identity'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
