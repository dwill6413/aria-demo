import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { authFetch } from '../lib/authFetch';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const STEPS = ['Identity', 'Property & Jurisdiction', 'Payout', 'Review & Submit'];

const inputStyle = {
  width: '100%', background: '#fff', border: '1px solid #ddd',
  borderRadius: '8px', padding: '10px 14px', color: '#222',
  fontSize: '14px', outline: 'none', boxSizing: 'border-box'
};

const labelStyle = { fontSize: '12px', color: '#717171', marginBottom: '6px', fontWeight: '600', display: 'block' };

// Basic client-side sanity check only — the server is the real authority on
// whether this is a valid, usable Sui address. This just catches obvious
// typos (wrong prefix/length) before they're submitted.
const isValidSuiAddress = (addr) => /^0x[a-fA-F0-9]{64}$/.test((addr || '').trim());

export default function BecomeHost() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [existingStatus, setExistingStatus] = useState(null);

  const [form, setForm] = useState({
    // Step 1 — Identity
    name: '', email: '', phone: '',
    // Step 2 — Property & Jurisdiction
    propertyAddress: '', city: '', state: '', zip: '', country: 'US',
    jurisdiction: '', strPermit: '',
    // Step 3 — Payout
    payoutSuiAddress: '', payoutNotes: '',
    // Step 4 — Terms
    termsAgreed: false, complianceConfirmed: false
  });

  const set = (field) => (e) => setForm(f => ({ ...f, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  useEffect(() => {
    authFetch(`${API}/auth/me`)
      .then(r => r.json())
      .then(data => {
        if (!data.address) { router.push('/'); return; }
        setUser(data);
        // Pre-fill name and email from session
        setForm(f => ({ ...f, name: data.name || '', email: data.email || '', payoutSuiAddress: data.address || '' }));
        if (data.hostStatus) setExistingStatus(data.hostStatus);
        if (data.isHost) { router.push('/host'); return; }
        setLoading(false);
      })
      .catch(() => router.push('/'));
  }, []);

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      const res = await authFetch(`${API}/host/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const data = await res.json();
      if (data.success) {
        setSubmitted(true);
      } else {
        alert(data.error || 'Submission failed. Please try again.');
      }
    } catch (err) {
      alert('Connection error. Please try again.');
    }
    setSubmitting(false);
  };

  const canProceed = () => {
    if (step === 0) return form.name.trim() && form.email.trim();
    if (step === 1) return true; // All optional
    if (step === 2) return isValidSuiAddress(form.payoutSuiAddress);
    if (step === 3) return form.termsAgreed && form.complianceConfirmed;
    return true;
  };

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#fff', color: '#222' }}>
      Loading...
    </div>
  );

  // Already applied
  if (existingStatus === 'pending') return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#fff' }}>
      <div style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '16px', padding: '48px', maxWidth: '480px', width: '100%', textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>⏳</div>
        <h2 style={{ color: '#222', fontSize: '22px', fontWeight: '700', margin: '0 0 8px' }}>Application Under Review</h2>
        <p style={{ color: '#717171', fontSize: '14px', margin: '0 0 24px', lineHeight: '1.6' }}>
          Your host application is being reviewed. You'll receive an email once approved — usually within 1–2 business days.
        </p>
        <button onClick={() => router.push('/')}
          style={{ background: '#ff385c', color: '#fff', border: 'none', borderRadius: '8px', padding: '12px 24px', fontWeight: '700', fontSize: '14px', cursor: 'pointer' }}>
          Back to ARIA
        </button>
      </div>
    </div>
  );

  // Submitted this session
  if (submitted) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#fff' }}>
      <div style={{ background: '#fff', border: '1px solid #c8ebd9', borderRadius: '16px', padding: '48px', maxWidth: '480px', width: '100%', textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>
        <div style={{ fontSize: '48px', marginBottom: '16px' }}>✅</div>
        <h2 style={{ color: '#00913f', fontSize: '22px', fontWeight: '700', margin: '0 0 8px' }}>Application Submitted!</h2>
        <p style={{ color: '#717171', fontSize: '14px', margin: '0 0 8px', lineHeight: '1.6' }}>
          Thanks {form.name} — your host application is under review.
        </p>
        <p style={{ color: '#999', fontSize: '13px', margin: '0 0 24px' }}>
          A confirmation email has been sent to {form.email}. You'll hear back within 1–2 business days.
        </p>
        <button onClick={() => router.push('/')}
          style={{ background: '#ff385c', color: '#fff', border: 'none', borderRadius: '8px', padding: '12px 24px', fontWeight: '700', fontSize: '14px', cursor: 'pointer' }}>
          Back to ARIA
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#fff', color: '#222' }}>

      {/* Header */}
      <div style={{ background: '#fff', borderBottom: '1px solid #ebebeb', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '60px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }} onClick={() => router.push('/')}>
          <span style={{ fontSize: '20px' }}>🏠</span>
          <span style={{ fontWeight: '700', fontSize: '18px', color: '#ff385c' }}>ARIA</span>
          <span style={{ background: '#222', color: '#fff', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px', marginLeft: '4px' }}>BETA</span>
        </div>
        <button onClick={() => router.push('/')} style={{ background: 'transparent', border: '1px solid #ddd', color: '#717171', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>
          Cancel
        </button>
      </div>

      <div style={{ maxWidth: '580px', margin: '0 auto', padding: '48px 24px' }}>

        {/* Title */}
        <div style={{ textAlign: 'center', marginBottom: '40px' }}>
          <div style={{ fontSize: '40px', marginBottom: '12px' }}>🏡</div>
          <h1 style={{ fontSize: '28px', fontWeight: '700', margin: '0 0 8px', color: '#222' }}>Become an ARIA Host</h1>
          <p style={{ color: '#717171', fontSize: '14px', margin: 0 }}>Share your property. Earn in SuiUSD. Keep 95% of every booking.</p>
        </div>

        {/* Progress bar */}
        <div style={{ marginBottom: '40px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
            {STEPS.map((s, i) => (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 }}>
                <div style={{
                  width: '28px', height: '28px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: i < step ? '#ff385c' : i === step ? '#ff385c' : '#f0f0f0',
                  border: `2px solid ${i <= step ? '#ff385c' : '#ddd'}`,
                  color: i <= step ? '#fff' : '#999', fontSize: '12px', fontWeight: '700', marginBottom: '6px'
                }}>
                  {i < step ? '✓' : i + 1}
                </div>
                <div style={{ fontSize: '10px', color: i === step ? '#222' : '#999', fontWeight: i === step ? '600' : '400', textAlign: 'center' }}>
                  {s}
                </div>
              </div>
            ))}
          </div>
          <div style={{ height: '2px', background: '#ebebeb', borderRadius: '1px', marginTop: '4px' }}>
            <div style={{ height: '100%', background: '#ff385c', borderRadius: '1px', width: `${(step / (STEPS.length - 1)) * 100}%`, transition: 'width 0.3s ease' }} />
          </div>
        </div>

        {/* Step content */}
        <div style={{ background: '#fff', border: '1px solid #ebebeb', borderRadius: '16px', padding: '32px', marginBottom: '24px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}>

          {/* Step 1 — Identity */}
          {step === 0 && (
            <div>
              <h2 style={{ fontSize: '18px', fontWeight: '700', margin: '0 0 4px', color: '#222' }}>Your Identity</h2>
              <p style={{ color: '#717171', fontSize: '13px', margin: '0 0 24px' }}>Tell us who you are. This information is used for your host profile and compliance records.</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <label style={labelStyle}>FULL NAME *</label>
                  <input value={form.name} onChange={set('name')} placeholder="Cecil Williams" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>EMAIL ADDRESS *</label>
                  <input value={form.email} onChange={set('email')} placeholder="you@example.com" type="email" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>PHONE NUMBER (optional)</label>
                  <input value={form.phone} onChange={set('phone')} placeholder="+1 (555) 000-0000" type="tel" style={inputStyle} />
                </div>
              </div>
            </div>
          )}

          {/* Step 2 — Property & Jurisdiction */}
          {step === 1 && (
            <div>
              <h2 style={{ fontSize: '18px', fontWeight: '700', margin: '0 0 4px', color: '#222' }}>Property & Jurisdiction</h2>
              <p style={{ color: '#717171', fontSize: '13px', margin: '0 0 24px' }}>Where is your property located? This determines your tax jurisdiction and local regulations.</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <label style={labelStyle}>PROPERTY ADDRESS</label>
                  <input value={form.propertyAddress} onChange={set('propertyAddress')} placeholder="123 Ocean Drive" style={inputStyle} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={labelStyle}>CITY</label>
                    <input value={form.city} onChange={set('city')} placeholder="Miami Beach" style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>STATE</label>
                    <input value={form.state} onChange={set('state')} placeholder="FL" style={inputStyle} />
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={labelStyle}>ZIP CODE</label>
                    <input value={form.zip} onChange={set('zip')} placeholder="33139" style={inputStyle} />
                  </div>
                  <div>
                    <label style={labelStyle}>COUNTRY</label>
                    <select value={form.country} onChange={set('country')} style={{ ...inputStyle, cursor: 'pointer' }}>
                      <option value="US">United States</option>
                      <option value="CA">Canada</option>
                      <option value="GB">United Kingdom</option>
                      <option value="AU">Australia</option>
                      <option value="OTHER">Other</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>TAX JURISDICTION</label>
                  <input value={form.jurisdiction} onChange={set('jurisdiction')} placeholder="e.g. Miami-Dade County, FL" style={inputStyle} />
                  <div style={{ fontSize: '11px', color: '#999', marginTop: '4px' }}>Used for occupancy tax remittance tracking</div>
                </div>
                <div>
                  <label style={labelStyle}>STR PERMIT / LICENSE NUMBER</label>
                  <input value={form.strPermit} onChange={set('strPermit')} placeholder="e.g. BTR-2024-12345" style={inputStyle} />
                  <div style={{ fontSize: '11px', color: '#999', marginTop: '4px' }}>Short-term rental permit required in most cities</div>
                </div>
              </div>
            </div>
          )}

          {/* Step 3 — Payout */}
          {step === 2 && (
            <div>
              <h2 style={{ fontSize: '18px', fontWeight: '700', margin: '0 0 4px', color: '#222' }}>Payout Setup</h2>
              <p style={{ color: '#717171', fontSize: '13px', margin: '0 0 24px' }}>Where should we send your earnings? ARIA pays out instantly in SuiUSD on the Sui network.</p>
              <div style={{ background: '#eaf2fc', border: '1px solid #cfe0f5', borderRadius: '8px', padding: '16px', marginBottom: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <span style={{ fontSize: '16px' }}>⚡</span>
                  <span style={{ fontWeight: '600', fontSize: '14px', color: '#1f6fd6' }}>Instant Sui Settlement</span>
                </div>
                <p style={{ color: '#3a6592', fontSize: '12px', margin: 0, lineHeight: '1.6' }}>
                  Your earnings settle directly to your Sui wallet in seconds — no 3–5 day bank delays. You keep 95% of every booking. ARIA's 5% fee is among the lowest in the industry.
                </p>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <label style={labelStyle}>SUI WALLET ADDRESS</label>
                  <input value={form.payoutSuiAddress} onChange={set('payoutSuiAddress')} placeholder="0x..."
                    style={{ ...inputStyle, fontFamily: 'monospace', fontSize: '12px', border: form.payoutSuiAddress && !isValidSuiAddress(form.payoutSuiAddress) ? '1px solid #d23f3f' : inputStyle.border }} />
                  {form.payoutSuiAddress && !isValidSuiAddress(form.payoutSuiAddress) ? (
                    <div style={{ fontSize: '11px', color: '#d23f3f', marginTop: '4px' }}>Doesn't look like a valid Sui address (expected 0x followed by 64 hex characters).</div>
                  ) : (
                    <div style={{ fontSize: '11px', color: '#999', marginTop: '4px' }}>Pre-filled with your connected wallet. Change if you prefer a different payout address.</div>
                  )}
                </div>
                <div>
                  <label style={labelStyle}>PAYOUT NOTES (optional)</label>
                  <input value={form.payoutNotes} onChange={set('payoutNotes')} placeholder="e.g. Use Transak to convert to USD" style={inputStyle} />
                </div>
                <div style={{ background: '#f7f7f7', border: '1px solid #ebebeb', borderRadius: '8px', padding: '14px' }}>
                  <div style={{ fontSize: '12px', color: '#717171', marginBottom: '4px', fontWeight: '600' }}>NEED TO CONVERT TO USD?</div>
                  <p style={{ color: '#999', fontSize: '12px', margin: 0, lineHeight: '1.6' }}>
                    Use Transak to off-ramp SuiUSD to your bank account. Available in 100+ countries. Link your Transak account after approval.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Step 4 — Review & Submit */}
          {step === 3 && (
            <div>
              <h2 style={{ fontSize: '18px', fontWeight: '700', margin: '0 0 4px', color: '#222' }}>Review & Submit</h2>
              <p style={{ color: '#717171', fontSize: '13px', margin: '0 0 24px' }}>Review your details and confirm your compliance before submitting.</p>

              {/* Summary */}
              <div style={{ background: '#f7f7f7', border: '1px solid #ebebeb', borderRadius: '8px', padding: '16px', marginBottom: '20px', fontSize: '13px' }}>
                <div style={{ fontSize: '11px', color: '#999', marginBottom: '10px', fontWeight: '600' }}>YOUR DETAILS</div>
                {[
                  ['Name', form.name],
                  ['Email', form.email],
                  form.phone && ['Phone', form.phone],
                  form.city && ['Location', `${form.city}${form.state ? ', ' + form.state : ''}`],
                  form.jurisdiction && ['Jurisdiction', form.jurisdiction],
                  form.strPermit && ['STR Permit', form.strPermit],
                  ['Payout Wallet', form.payoutSuiAddress ? form.payoutSuiAddress.slice(0, 10) + '...' + form.payoutSuiAddress.slice(-6) : '—'],
                ].filter(Boolean).map(([label, value], i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid #ebebeb' }}>
                    <span style={{ color: '#717171' }}>{label}</span>
                    <span style={{ color: '#222' }}>{value}</span>
                  </div>
                ))}
              </div>

              {/* Legal disclaimer */}
              <div style={{ background: '#fff8e1', border: '1px solid #ffe7a0', borderRadius: '8px', padding: '16px', marginBottom: '20px' }}>
                <div style={{ fontSize: '12px', color: '#a66a00', fontWeight: '600', marginBottom: '8px' }}>⚖️ HOST AGREEMENT</div>
                <p style={{ color: '#7a6228', fontSize: '12px', margin: 0, lineHeight: '1.7' }}>
                  By creating a host account you confirm you are legally permitted to operate a short-term rental in your jurisdiction. You are responsible for obtaining and maintaining all required licenses and permits. ARIA provides tools only and is not responsible for regulatory compliance.
                </p>
              </div>

              {/* Checkboxes */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <label style={{ display: 'flex', alignItems: 'start', gap: '10px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.termsAgreed} onChange={set('termsAgreed')}
                    style={{ marginTop: '2px', accentColor: '#ff385c', width: '16px', height: '16px' }} />
                  <span style={{ fontSize: '13px', color: '#222', lineHeight: '1.5' }}>
                    I agree to the ARIA Host Terms of Service and confirm I am legally permitted to operate a short-term rental in my jurisdiction.
                  </span>
                </label>
                <label style={{ display: 'flex', alignItems: 'start', gap: '10px', cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.complianceConfirmed} onChange={set('complianceConfirmed')}
                    style={{ marginTop: '2px', accentColor: '#ff385c', width: '16px', height: '16px' }} />
                  <span style={{ fontSize: '13px', color: '#222', lineHeight: '1.5' }}>
                    I confirm I will obtain and maintain all required STR licenses, permits, and insurance, and will remit occupancy taxes as required by local law.
                  </span>
                </label>
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <div style={{ display: 'flex', gap: '12px' }}>
          {step > 0 && (
            <button onClick={() => setStep(s => s - 1)}
              style={{ flex: 1, background: 'transparent', border: '1px solid #ddd', color: '#717171', borderRadius: '8px', padding: '14px', fontSize: '14px', cursor: 'pointer', fontWeight: '600' }}>
              ← Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button onClick={() => setStep(s => s + 1)} disabled={!canProceed()}
              style={{ flex: 2, background: canProceed() ? '#ff385c' : '#f0f0f0', color: canProceed() ? '#fff' : '#999', border: 'none', borderRadius: '8px', padding: '14px', fontSize: '14px', fontWeight: '700', cursor: canProceed() ? 'pointer' : 'not-allowed' }}>
              Continue →
            </button>
          ) : (
            <button onClick={handleSubmit} disabled={submitting || !canProceed()}
              style={{ flex: 2, background: submitting || !canProceed() ? '#f0f0f0' : '#ff385c', color: submitting || !canProceed() ? '#999' : '#fff', border: 'none', borderRadius: '8px', padding: '14px', fontSize: '14px', fontWeight: '700', cursor: submitting || !canProceed() ? 'not-allowed' : 'pointer' }}>
              {submitting ? 'Submitting...' : 'Submit Application 🚀'}
            </button>
          )}
        </div>

        <p style={{ textAlign: 'center', color: '#999', fontSize: '12px', marginTop: '16px' }}>
          Already applied? Check your email for status updates.
        </p>
      </div>
    </div>
  );
}
