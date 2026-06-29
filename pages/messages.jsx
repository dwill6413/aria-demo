import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/router';
import { authFetch } from '../lib/authFetch';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export default function Messages() {
  const router = useRouter();
  const { bookingRef, property } = router.query;
  const [user, setUser] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sendError, setSendError] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    authFetch(`${API}/auth/me`)
      .then(res => res.json())
      .then(data => {
        if (!data.address) { router.push('/'); return; }
        setUser(data);
        setLoading(false);
      })
      .catch(() => router.push('/'));
  }, []);

  useEffect(() => {
    if (!bookingRef || !user) return;
    fetchMessages();
    const interval = setInterval(fetchMessages, 5000);
    return () => clearInterval(interval);
  }, [bookingRef, user]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const fetchMessages = async () => {
    if (!bookingRef) return;
    try {
      const res  = await authFetch(`${API}/messages/${bookingRef}`);
      const data = await res.json();
      setMessages(data.messages || []);
      authFetch(`${API}/messages/${bookingRef}/read`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to fetch messages:', err);
    }
  };

  const handleSend = async () => {
    if (!newMessage.trim()) return;
    setSending(true);
    setSendError('');
    try {
      const res  = await authFetch(`${API}/messages/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bookingRef, message: newMessage.trim() })
      });
      const data = await res.json();
      if (data.success) {
        setNewMessage('');
        await fetchMessages();
      } else {
        setSendError('Message failed to send. Please try again.');
      }
    } catch (err) {
      setSendError('Connection error. Please try again.');
    }
    setSending(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  if (loading) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#fff', color: '#222' }}>
      Loading messages...
    </div>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#fff', color: '#222', display: 'flex', flexDirection: 'column' }}>
      <div style={{ background: '#fff', borderBottom: '1px solid #ebebeb', padding: '0 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '60px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span onClick={() => router.back()} style={{ fontSize: '20px', cursor: 'pointer', color: '#222' }}>←</span>
          <span style={{ fontWeight: '700', fontSize: '18px', cursor: 'pointer', color: '#ff385c' }} onClick={() => router.push('/')}>ARIA</span>
          <span style={{ background: '#222', color: '#fff', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '10px', marginLeft: '4px' }}>BETA</span>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '14px', fontWeight: '600', color: '#222' }}>💬 {property || 'Booking'}</div>
          <div style={{ fontSize: '11px', color: '#999', fontFamily: 'monospace' }}>{bookingRef}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '13px', fontWeight: '500', color: '#222' }}>{user?.name}</div>
          <div style={{ fontSize: '11px', color: '#717171', fontFamily: 'monospace' }}>{user?.address?.slice(0, 8)}...{user?.address?.slice(-6)}</div>
        </div>
      </div>

      <div style={{ flex: 1, maxWidth: '700px', width: '100%', margin: '0 auto', padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ background: '#eaf2fc', border: '1px solid #cfe0f5', borderRadius: '8px', padding: '12px', marginBottom: '8px' }}>
          <p style={{ color: '#1f6fd6', fontSize: '12px', margin: 0, textAlign: 'center' }}>
            🔒 Messages are private and tied to booking ref {bookingRef}. Only the guest and host can view this thread.
          </p>
        </div>

        {messages.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px 24px', background: '#f7f7f7', borderRadius: '12px', border: '1px solid #ebebeb' }}>
            <div style={{ fontSize: '48px', marginBottom: '16px' }}>💬</div>
            <h3 style={{ fontSize: '18px', fontWeight: '600', margin: '0 0 8px', color: '#222' }}>No messages yet</h3>
            <p style={{ color: '#717171', fontSize: '14px', margin: 0 }}>Send the first message below</p>
          </div>
        ) : (
          messages.map((m, i) => {
            const isMe = m.email === user?.email;
            return (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: isMe ? 'flex-end' : 'flex-start' }}>
                <div style={{ fontSize: '11px', color: '#999', marginBottom: '4px' }}>
                  {isMe ? 'You' : m.from} · {new Date(m.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} {new Date(m.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </div>
                <div style={{ background: isMe ? '#ff385c' : '#f0f0f0', color: isMe ? '#fff' : '#222', padding: '10px 14px', borderRadius: isMe ? '12px 12px 2px 12px' : '12px 12px 12px 2px', maxWidth: '80%', fontSize: '14px', lineHeight: '1.5' }}>
                  {m.message}
                </div>
              </div>
            );
          })
        )}

        {sendError && (
          <div style={{ background: '#fdeeee', border: '1px solid #f5d0d0', borderRadius: '8px', padding: '10px 14px', fontSize: '13px', color: '#d23f3f', textAlign: 'center' }}>
            {sendError}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ background: '#fff', borderTop: '1px solid #ebebeb', padding: '16px 24px', position: 'sticky', bottom: 0 }}>
        <div style={{ maxWidth: '700px', margin: '0 auto', display: 'flex', gap: '8px' }}>
          <textarea value={newMessage} onChange={e => { setNewMessage(e.target.value); setSendError(''); }} onKeyDown={handleKeyDown}
            placeholder="Type a message... (Enter to send)" rows={2}
            style={{ flex: 1, background: '#fff', border: '1px solid #ddd', borderRadius: '8px', padding: '10px 14px', color: '#222', fontSize: '14px', outline: 'none', resize: 'none', fontFamily: 'inherit', lineHeight: '1.5' }} />
          <button onClick={handleSend} disabled={sending || !newMessage.trim()}
            style={{ background: sending || !newMessage.trim() ? '#eee' : '#ff385c', color: sending || !newMessage.trim() ? '#999' : '#fff', border: 'none', borderRadius: '8px', padding: '0 20px', fontWeight: '700', fontSize: '14px', cursor: sending || !newMessage.trim() ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap' }}>
            {sending ? 'Sending...' : 'Send →'}
          </button>
        </div>
      </div>
    </div>
  );
}
