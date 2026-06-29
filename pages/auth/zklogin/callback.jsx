import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { completeZkLogin } from '../../../lib/zklogin';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export default function Callback() {
  const router = useRouter();

  useEffect(() => {
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const id_token = params.get('id_token');

    if (!id_token) {
      router.push('/?error=missing_token');
      return;
    }

    (async () => {
      try {
        // Fetches and caches the ZK proof for this login using the ephemeral
        // key generated client-side in handleLogin (lib/zklogin.js:
        // beginZkLogin). This is the step that makes it possible for the
        // guest to later sign transactions (e.g. P0b escrow creation) as
        // their own zkLogin address — nothing server-side holds this material.
        const { nonce } = await completeZkLogin(id_token);

        const res = await fetch(`${API}/auth/zklogin/callback`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id_token, nonce }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          console.error('Auth error:', data);
          router.push('/?error=auth_failed');
          return;
        }

        const data = await res.json();
        if (data.sid) {
          try { localStorage.setItem('aria_sid', data.sid); } catch {}
        }
        router.push('/');
      } catch (err) {
        console.error('Callback error:', err);
        router.push('/?error=network');
      }
    })();
  }, []);

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#fff', color: '#222', flexDirection: 'column', gap: '12px' }}>
      <div style={{ fontSize: '32px' }}>🏠</div>
      <p style={{ color: '#717171', fontSize: '14px' }}>Completing sign in...</p>
    </div>
  );
}
