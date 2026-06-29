import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import { signTransactionWithZkLogin, submitSignedTransaction } from '../lib/zklogin';
import { fromBase64 } from '@mysten/sui/utils';
import { authFetch } from '../lib/authFetch';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const GUEST_SUGGESTIONS = [
  'Show me my bookings',
  'Book the Mountain Cabin for June 10–13',
  'How much would 5 nights at the Lake House cost?',
  'Check my messages',
  'Draft a message to my host about early check-in',
  'What makes ARIA better than Airbnb?',
];

const HOST_SUGGESTIONS = [
  'Do I have any new messages?',
  'Give me a revenue summary',
  'Which property is performing best?',
  'Show me all current bookings',
  'Are there any deposits I can release?',
  'What are guests saying in reviews?',
];

// Escape HTML before any formatting so model output (which can echo
// user-controlled content) can never inject markup. Markdown tokens
// (#, -, *, `, digits, ---) are unaffected by these substitutions.
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderMarkdown(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const output = [];
  let listItems = [];
  const flushList = () => {
    if (listItems.length > 0) {
      output.push(`<ul style="margin:8px 0 8px 16px;padding:0;list-style:disc">${listItems.join('')}</ul>`);
      listItems = [];
    }
  };
  const inlineFormat = (line) =>
    line
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`(.+?)`/g, '<code style="background:#f2f2f2;color:#222;padding:1px 5px;border-radius:4px;font-size:12px;font-family:monospace">$1</code>');
  for (const rawLine of lines) {
    const line = escapeHtml(rawLine);
    if (/^---+$/.test(line.trim())) { flushList(); output.push('<hr style="border:none;border-top:1px solid #ddd;margin:12px 0"/>'); continue; }
    if (line.startsWith('### ')) { flushList(); output.push(`<div style="font-size:15px;font-weight:700;color:#222;margin:14px 0 6px">${inlineFormat(line.slice(4))}</div>`); continue; }
    if (line.startsWith('## '))  { flushList(); output.push(`<div style="font-size:16px;font-weight:700;color:#222;margin:16px 0 6px">${inlineFormat(line.slice(3))}</div>`); continue; }
    if (line.startsWith('# '))   { flushList(); output.push(`<div style="font-size:18px;font-weight:700;color:#222;margin:16px 0 8px">${inlineFormat(line.slice(2))}</div>`); continue; }
    if (/^[-*] /.test(line))     { listItems.push(`<li style="margin:3px 0;color:#444">${inlineFormat(line.slice(2))}</li>`); continue; }
    if (/^\d+\. /.test(line))    { listItems.push(`<li style="margin:3px 0;color:#444">${inlineFormat(line.replace(/^\d+\. /, ''))}</li>`); continue; }
    if (line.trim() === '')      { flushList(); output.push('<div style="height:6px"></div>'); continue; }
    flushList();
    output.push(`<div>${inlineFormat(line)}</div>`);
  }
  flushList();
  return output.join('');
}

function MessageBubble({ message, isHost }) {
  const isUser = message.role === 'user';
  if (isUser) {
    return (
      <div style={{ background: isHost ? '#ff8800' : '#8b3dff', color: '#fff', padding: '12px 16px', borderRadius: '12px 12px 2px 12px', maxWidth: '85%', fontSize: '14px', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>
        {message.content}
      </div>
    );
  }
  return (
    <div style={{ background: '#f7f7f7', color: '#222', padding: '12px 16px', borderRadius: '12px 12px 12px 2px', maxWidth: '85%', fontSize: '14px', lineHeight: '1.6', border: '1px solid #ebebeb' }}
      dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }} />
  );
}

export default function AI() {
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [isHost, setIsHost] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    const storedMode = sessionStorage.getItem('aria_ai_mode');
    if (storedMode === 'host') setIsHost(true);
    authFetch(`${API}/auth/me`)
      .then(r => r.json())
      .then(data => {
        if (!data.address) { router.push('/'); return; }
        setUser(data);
        if (data.isHost && !storedMode) setIsHost(true);
        setLoading(false);
      })
      .catch(() => router.push('/'));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, sending]);

  const toggleMode = (host) => {
    setIsHost(host);
    sessionStorage.setItem('aria_ai_mode', host ? 'host' : 'guest');
    setMessages([]);
  };

  const sendMessage = async () => {
    if (!input.trim() || sending) return;
    const userMsg = { role: 'user', content: input.trim() };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setInput('');
    setSending(true);
    try {
      const res = await authFetch(`${API}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages, mode: isHost ? 'host' : 'guest' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Request failed');
      // data.booking (when present) means create_booking succeeded and the
      // backend built a guest-signed escrow tx (see ai_route.mjs) — attach it
      // to this message so the bubble can render a "sign to lock deposit"
      // button, same non-custodial flow pages/index.jsx already uses.
      setMessages(prev => [...prev, { role: 'assistant', content: data.response, booking: data.booking ? { ...data.booking, status: null, error: '' } : undefined }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Sorry, something went wrong: ${err.message}. Please try again.` }]);
    }
    setSending(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  // Signs the backend-built escrow PTB with the guest's zkLogin session,
  // submits it directly to Sui from the browser, then reports just the
  // resulting digest to the backend so it can independently verify on-chain
  // before writing escrow_object_id / flipping deposit_status to 'held'.
  // Mirrors pages/index.jsx's handleEscrowSign exactly — same non-custodial
  // guarantee applies whether the booking came from the REST flow or here.
  const setMsgBooking = (msgIndex, patch) => {
    setMessages(prev => prev.map((m, idx) => idx === msgIndex ? { ...m, booking: { ...m.booking, ...patch } } : m));
  };

  const handleEscrowSign = async (msgIndex, bookingRef, escrowTxBytes) => {
    setMsgBooking(msgIndex, { status: 'signing', error: '' });
    try {
      const txBytes = fromBase64(escrowTxBytes);
      const signature = await signTransactionWithZkLogin(txBytes);

      setMsgBooking(msgIndex, { status: 'submitting' });
      const digest = await submitSignedTransaction(escrowTxBytes, signature);

      setMsgBooking(msgIndex, { status: 'confirming' });
      const confirmRes = await authFetch(`${API}/booking/${bookingRef}/escrow/confirm`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ digest }),
      });
      const confirmData = await confirmRes.json();
      if (!confirmRes.ok || !confirmData.success) {
        throw new Error(confirmData.error || 'Escrow could not be verified on-chain');
      }
      setMsgBooking(msgIndex, { status: 'done' });
    } catch (err) {
      console.error('Escrow signing failed:', err);
      setMsgBooking(msgIndex, { status: 'error', error: err.message || 'Could not complete the escrow deposit.' });
    }
  };

  const SUGGESTIONS = isHost ? HOST_SUGGESTIONS : GUEST_SUGGESTIONS;

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#fff', color: '#222' }}>
      Loading AI Assistant...
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#fff', color: '#222', display: 'flex', flexDirection: 'column' }}>
      <style>{`
        .ai-agent-badge { display: inline-flex; }
        @media (max-width: 639px) {
          .ai-agent-badge { display: none !important; }
          .ai-nav-back span { display: none; }
        }
      `}</style>
      <div style={{ background: '#fff', borderBottom: '1px solid #ebebeb', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '60px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span onClick={() => router.push('/')} style={{ fontSize: '20px', cursor: 'pointer' }}>🏠</span>
          <span style={{ fontWeight: '700', fontSize: '18px', cursor: 'pointer', color: '#ff385c' }} onClick={() => router.push('/')}>ARIA</span>
          <span style={{ background: '#222', color: '#fff', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px', marginLeft: '4px' }}>BETA</span>
          <span className="ai-agent-badge" style={{ background: isHost ? '#fff4e6' : '#f3e8ff', border: `1px solid ${isHost ? '#ffd9a8' : '#e0c8fa'}`, color: isHost ? '#b35f00' : '#8b3dff', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px', marginLeft: '4px' }}>
            {isHost ? '🏡 HOST AGENT' : '🤖 AI AGENT'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ display: 'flex', background: '#f7f7f7', border: '1px solid #ddd', borderRadius: '8px', overflow: 'hidden' }}>
            <button onClick={() => toggleMode(false)} style={{ background: !isHost ? '#8b3dff' : 'transparent', color: !isHost ? '#fff' : '#717171', border: 'none', padding: '6px 14px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>Guest</button>
            <button onClick={() => toggleMode(true)} style={{ background: isHost ? '#ff8800' : 'transparent', color: isHost ? '#fff' : '#717171', border: 'none', padding: '6px 14px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>Host</button>
          </div>
          <button onClick={() => router.back()} style={{ background: 'transparent', border: '1px solid #ddd', color: '#717171', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>← Back</button>
        </div>
      </div>

      <div style={{ flex: 1, maxWidth: '800px', width: '100%', margin: '0 auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {!isHost && user && user.hasGuestProfile === false && (
          <div style={{ background: '#fff8e1', border: '1px solid #ffe7a0', borderRadius: '10px', padding: '12px 14px', fontSize: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
            <span style={{ color: '#a66a00' }}>⚠️ Hosts need to verify who's staying — complete identity verification before booking (encrypted via Seal, stored on Walrus, never seen by ARIA).</span>
            <button onClick={() => router.push('/profile')} style={{ background: 'transparent', color: '#a66a00', border: '1px solid #a66a00', borderRadius: '6px', padding: '6px 10px', fontSize: '11px', cursor: 'pointer', flexShrink: 0 }}>
              Verify now
            </button>
          </div>
        )}
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 24px' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>{isHost ? '🏡' : '🤖'}</div>
            <h2 style={{ fontSize: '22px', fontWeight: '700', margin: '0 0 8px', color: '#222' }}>{isHost ? 'ARIA Host Agent' : 'ARIA AI Agent'}</h2>
            <p style={{ color: '#717171', fontSize: '14px', margin: '0 0 4px' }}>Powered by Grok — built into ARIA</p>
            <p style={{ color: isHost ? '#b35f00' : '#8b3dff', fontSize: '13px', margin: '0 0 24px', fontWeight: '600' }}>
              {isHost ? '⚡ Check messages, view revenue, release deposits, manage bookings' : '⚡ Book, cancel, message hosts, and manage your reservations'}
            </p>
            <p style={{ color: '#999', fontSize: '13px', margin: '0 0 16px' }}>Try asking:</p>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
              {SUGGESTIONS.map((s, i) => (
                <button key={i} onClick={() => setInput(s)} style={{ background: '#fff', border: '1px solid #ddd', color: '#717171', fontSize: '12px', padding: '8px 14px', borderRadius: '20px', cursor: 'pointer' }}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px' }}>{m.role === 'user' ? 'You' : isHost ? '🏡 ARIA Host Agent' : '🤖 ARIA Agent'}</div>
            <MessageBubble message={m} isHost={isHost} />
            {m.booking && (
              <div style={{ marginTop: '8px', background: '#eafaf0', border: '1px solid #c8ebd9', borderRadius: '10px', padding: '12px 14px', maxWidth: '85%' }}>
                {m.booking.paymentEscrowBuilt ? (
                  <div style={{ fontSize: '12px', color: '#5c8a6d', marginBottom: '8px' }}>
                    <div style={{ color: '#222', fontWeight: 600, marginBottom: '4px' }}>{m.booking.property} — review before you sign</div>
                    <div style={{ color: '#5c8a6d', fontSize: '11px', lineHeight: 1.6 }}>
                      Rental → host ${m.booking.subtotal} · ARIA fee → ARIA ${m.booking.ariaFee} · taxes → remittance ${m.booking.taxes}, all released to those destinations at check-in. Refundable deposit ${m.booking.depositAmount} returned after checkout. One signature funds it all from your own wallet (${m.booking.chargeAmount} SuiUSD total).
                    </div>
                    <div style={{ color: '#5c8a6d', fontSize: '10px', marginTop: '4px' }}>
                      Cancel 15+ days before check-in for a full refund (fee included); within 14 days, the stay cost is non-refundable — list it on the resale market instead of losing the funds.
                    </div>
                  </div>
                ) : (
                  <div style={{ fontSize: '12px', color: '#5c8a6d', marginBottom: '8px' }}>
                    🔒 Refundable deposit for <strong style={{ color: '#222' }}>{m.booking.property}</strong>: ${m.booking.depositAmount} SuiUSD
                  </div>
                )}
                {m.booking.status === 'done' ? (
                  <div style={{ color: '#00913f', fontSize: '13px', fontWeight: '600' }}>{m.booking.paymentEscrowBuilt ? '✅ Payment + deposit escrowed on-chain' : '✅ Escrow deposit confirmed on-chain'}</div>
                ) : !m.booking.escrowTxBytes ? (
                  // The backend's best-effort escrow build failed (e.g. the guest's
                  // wallet has no testnet SUI yet) — there's no tx to sign, so don't
                  // render a sign button that would just throw. Booking is still
                  // saved; point the guest at My Bookings to finish once resolved.
                  <div style={{ color: '#d23f3f', fontSize: '12px' }}>
                    ⚠️ {m.booking.escrowBuildErrorMessage || 'Could not prepare the escrow transaction.'} Your dates are held, but no money has moved — finish this from <strong>My Bookings</strong> once resolved.
                  </div>
                ) : (
                  <>
                    <button
                      onClick={() => handleEscrowSign(i, m.booking.bookingRef, m.booking.escrowTxBytes)}
                      disabled={['signing', 'submitting', 'confirming'].includes(m.booking.status)}
                      style={{
                        background: ['signing', 'submitting', 'confirming'].includes(m.booking.status) ? '#eee' : '#00913f',
                        color: ['signing', 'submitting', 'confirming'].includes(m.booking.status) ? '#999' : '#fff',
                        border: 'none', borderRadius: '6px', padding: '8px 16px', fontWeight: '700', fontSize: '13px',
                        cursor: ['signing', 'submitting', 'confirming'].includes(m.booking.status) ? 'not-allowed' : 'pointer'
                      }}>
                      {m.booking.status === 'signing' ? 'Signing...' : m.booking.status === 'submitting' ? 'Submitting...' : m.booking.status === 'confirming' ? 'Confirming...' : (m.booking.paymentEscrowBuilt ? 'Approve & sign in wallet' : 'Sign to lock deposit in escrow')}
                    </button>
                    {m.booking.status === 'error' && (
                      <div style={{ color: '#d23f3f', fontSize: '12px', marginTop: '6px' }}>{m.booking.error}</div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        ))}

        {sending && (
          <div style={{ display: 'flex', alignItems: 'flex-start' }}>
            <div style={{ background: isHost ? '#fff4e6' : '#f3e8ff', border: `1px solid ${isHost ? '#ffd9a8' : '#e0c8fa'}`, borderRadius: '12px 12px 12px 2px', padding: '10px 14px', fontSize: '13px', color: isHost ? '#b35f00' : '#8b3dff' }}>
              {isHost ? '🏡 Thinking...' : '🤖 Thinking...'}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ background: '#fff', borderTop: '1px solid #ebebeb', padding: '16px 24px', position: 'sticky', bottom: 0 }}>
        <div style={{ maxWidth: '800px', margin: '0 auto', display: 'flex', gap: '8px' }}>
          <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder={isHost ? 'Ask anything — check messages, revenue, release deposits...' : 'Ask anything or say "Book the Mountain Cabin for June 10–13"...'}
            disabled={sending} rows={2}
            style={{ flex: 1, background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '10px 14px', color: '#222', fontSize: '14px', outline: 'none', resize: 'none', fontFamily: 'inherit', lineHeight: '1.5' }} />
          <button onClick={sendMessage} disabled={sending || !input.trim()}
            style={{ background: (sending || !input.trim()) ? '#eee' : (isHost ? '#ff8800' : '#8b3dff'), color: (sending || !input.trim()) ? '#999' : '#fff', border: 'none', borderRadius: '8px', padding: '0 20px', fontWeight: '700', fontSize: '14px', cursor: (sending || !input.trim()) ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
            {sending ? '...' : 'Send →'}
          </button>
        </div>
        <div style={{ maxWidth: '800px', margin: '8px auto 0', fontSize: '11px', color: '#999', textAlign: 'center' }}>
          ⚡ Powered by Grok · Agent can take real actions on ARIA
        </div>
      </div>
    </div>
  );
}
