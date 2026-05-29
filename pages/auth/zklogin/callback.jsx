import { useEffect } from 'react';
import { useRouter } from 'next/router';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export default function Callback() {
  const router = useRouter();

  useEffect(() => {
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const id_token = params.get('id_token');
    const state = params.get('state');

    if (!id_token || !state) {
      router.push('/?error=missing_token');
      return;
    }

    fetch(`${API}/auth/zklogin/callback?state=${encodeURIComponent(state)}&id_token=${encodeURIComponent(id_token)}`, {
      credentials: 'include'
    })
    .then(res => {
      // Backend redirects to FRONTEND_URL?auth=success&sid=XXX
      // fetch follows the redirect — final URL contains sid
      const url = new URL(res.url);
      const sid = url.searchParams.get('sid');
      if (sid) {
        try { localStorage.setItem('aria_sid', sid); } catch {}
        router.push('/');
      } else if (res.ok) {
        router.push('/');
      } else {
        return res.json().then(data => {
          console.error('Auth error:', data);
          router.push('/?error=auth_failed');
        }).catch(() => router.push('/?error=auth_failed'));
      }
    })
    .catch(err => {
      console.error('Callback fetch error:', err);
      router.push('/?error=network');
    });
  }, []);

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', background: '#0a0a0a', color: '#fff', flexDirection: 'column', gap: '12px' }}>
      <div style={{ fontSize: '32px' }}>🏠</div>
      <p style={{ color: '#888', fontSize: '14px' }}>Completing sign in...</p>
    </div>
  );
}
