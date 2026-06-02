import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const getStoredSid = () => { try { return localStorage.getItem('aria_sid') || ''; } catch { return ''; } };
const authFetch = (url, options = {}) => {
  const sid = getStoredSid();
  const headers = { ...(options.headers || {}) };
  if (sid) headers['x-session-id'] = sid;
  return fetch(url, { ...options, credentials: 'include', headers });
};

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
      .replace(/`(.+?)`/g, '<code style="background:#2a2a2a;padding:1px 5px;border-radius:4px;font-size:12px;font-family:monospace">$1</code>');
  for (const rawLine of lines) {
    const line = escapeHtml(rawLine);
    if (/^---+$/.test(line.trim())) { flushList(); output.push('<hr style="border:none;border-top:1px solid #333;margin:12px 0"/>'); continue; }
    if (line.startsWith('### ')) { flushList(); output.push(`<div style="font-size:15px;font-weight:700;color:#fff;margin:14px 0 6px">${inlineFormat(line.slice(4))}</div>`); continue; }
    if (line.startsWith('## '))  { flushList(); output.push(`<div style="font-size:16px;font-weight:700;color:#fff;margin:16px 0 6px">${inlineFormat(line.slice(3))}</div>`); continue; }
    if (line.startsWith('# '))   { flushList(); output.push(`<div style="font-size:18px;font-weight:700;color:#fff;margin:16px 0 8px">${inlineFormat(line.slice(2))}</div>`); continue; }
    if (/^[-*] /.test(line))     { listItems.push(`<li style="margin:3px 0;color:#ccc">${inlineFormat(line.slice(2))}</li>`); continue; }
    if (/^\d+\. /.test(line))    { listItems.push(`<li style="margin:3px 0;color:#ccc">${inlineFormat(line.replace(/^\d+\. /, ''))}</li>`); continue; }
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
      <div style={{ background: isHost ? '#ff8800' : '#aa44ff', color: '#fff', padding: '12px 16px', borderRadius: '12px 12px 2px 12px', maxWidth: '85%', fontSize: '14px', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>
        {message.content}
      </div>
    );
  }
  return (
    <div style={{ background: '#1a1a1a', color: '#ccc', padding: '12px 16px', borderRadius: '12px 12px 12px 2px', maxWidth: '85%', fontSize: '14px', lineHeight: '1.6', border: '1px solid #333' }}
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
      setMessages(prev => [...prev, { role: 'assistant', content: data.response }]);
    } catch (err) {
      setMessages(prev => [...prev, { role: 'assistant', content: `Sorry, something went wrong: ${err.message}. Please try again.` }]);
    }
    setSending(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const SUGGESTIONS = isHost ? HOST_SUGGESTIONS : GUEST_SUGGESTIONS;

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a0a', color: '#fff' }}>
      Loading AI Assistant...
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#0a0a0a', color: '#fff', display: 'flex', flexDirection: 'column' }}>
      <div style={{ background: '#111', borderBottom: '1px solid #222', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '60px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span onClick={() => router.push('/')} style={{ fontSize: '20px', cursor: 'pointer' }}>🏠</span>
          <span style={{ fontWeight: '700', fontSize: '18px', cursor: 'pointer' }} onClick={() => router.push('/')}>ARIA</span>
          <span style={{ background: '#00ff44', color: '#000', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px', marginLeft: '4px' }}>BETA</span>
          <span style={{ background: isHost ? '#1a0a00' : '#1a0a2e', border: '1px solid #333', color: isHost ? '#ff8800' : '#aa44ff', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px', marginLeft: '4px' }}>
            {isHost ? '🏡 HOST AGENT' : '🤖 AI AGENT'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{ display: 'flex', background: '#1a1a1a', border: '1px solid #333', borderRadius: '8px', overflow: 'hidden' }}>
            <button onClick={() => toggleMode(false)} style={{ background: !isHost ? '#aa44ff' : 'transparent', color: !isHost ? '#fff' : '#666', border: 'none', padding: '6px 14px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>Guest</button>
            <button onClick={() => toggleMode(true)} style={{ background: isHost ? '#ff8800' : 'transparent', color: isHost ? '#fff' : '#666', border: 'none', padding: '6px 14px', fontSize: '12px', fontWeight: '600', cursor: 'pointer' }}>Host</button>
          </div>
          <button onClick={() => router.back()} style={{ background: 'transparent', border: '1px solid #333', color: '#888', padding: '6px 14px', borderRadius: '6px', fontSize: '12px', cursor: 'pointer' }}>← Back</button>
        </div>
      </div>

      <div style={{ flex: 1, maxWidth: '800px', width: '100%', margin: '0 auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', padding: '40px 24px' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>{isHost ? '🏡' : '🤖'}</div>
            <h2 style={{ fontSize: '22px', fontWeight: '700', margin: '0 0 8px' }}>{isHost ? 'ARIA Host Agent' : 'ARIA AI Agent'}</h2>
            <p style={{ color: '#666', fontSize: '14px', margin: '0 0 4px' }}>Powered by Grok — built into ARIA</p>
            <p style={{ color: isHost ? '#ff8800' : '#aa44ff', fontSize: '13px', margin: '0 0 24px', fontWeight: '600' }}>
              {isHost ? '⚡ Check messages, view revenue, release deposits, manage bookings' : '⚡ Book, cancel, message hosts, and manage your reservations'}
            </p>
            <p style={{ color: '#555', fontSize: '13px', margin: '0 0 16px' }}>Try asking:</p>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', justifyContent: 'center' }}>
              {SUGGESTIONS.map((s, i) => (
                <button key={i} onClick={() => setInput(s)} style={{ background: '#111', border: '1px solid #333', color: '#888', fontSize: '12px', padding: '8px 14px', borderRadius: '20px', cursor: 'pointer' }}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={{ fontSize: '11px', color: '#555', marginBottom: '4px' }}>{m.role === 'user' ? 'You' : isHost ? '🏡 ARIA Host Agent' : '🤖 ARIA Agent'}</div>
            <MessageBubble message={m} isHost={isHost} />
          </div>
        ))}

        {sending && (
          <div style={{ display: 'flex', alignItems: 'flex-start' }}>
            <div style={{ background: isHost ? '#1a0f00' : '#0a0a1a', border: `1px solid ${isHost ? '#3a2000' : '#1a1a3a'}`, borderRadius: '12px 12px 12px 2px', padding: '10px 14px', fontSize: '13px', color: isHost ? '#ff8800' : '#aa44ff' }}>
              {isHost ? '🏡 Thinking...' : '🤖 Thinking...'}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ background: '#111', borderTop: '1px solid #222', padding: '16px 24px', position: 'sticky', bottom: 0 }}>
        <div style={{ maxWidth: '800px', margin: '0 auto', display: 'flex', gap: '8px' }}>
          <textarea value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown}
            placeholder={isHost ? 'Ask anything — check messages, revenue, release deposits...' : 'Ask anything or say "Book the Mountain Cabin for June 10–13"...'}
            disabled={sending} rows={2}
            style={{ flex: 1, background: '#1a1a1a', border: '1px solid #333', borderRadius: '8px', padding: '10px 14px', color: '#fff', fontSize: '14px', outline: 'none', resize: 'none', fontFamily: 'inherit', lineHeight: '1.5' }} />
          <button onClick={sendMessage} disabled={sending || !input.trim()}
            style={{ background: (sending || !input.trim()) ? '#1a1a1a' : (isHost ? '#ff8800' : '#aa44ff'), color: (sending || !input.trim()) ? '#555' : '#fff', border: 'none', borderRadius: '8px', padding: '0 20px', fontWeight: '700', fontSize: '14px', cursor: (sending || !input.trim()) ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
            {sending ? '...' : 'Send →'}
          </button>
        </div>
        <div style={{ maxWidth: '800px', margin: '8px auto 0', fontSize: '11px', color: '#333', textAlign: 'center' }}>
          ⚡ Powered by Grok · Agent can take real actions on ARIA
        </div>
      </div>
    </div>
  );
}
