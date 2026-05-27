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

    fetch(`${API}/auth/zklogin/callback?state=${state}&id_token=${id_token}`, {
      credentials: 'include',
      redirect: 'manual'
    })
    .then(res => {
      if (res.ok || res.type === 'opaqueredirect') {
        router.push('/');
      } else {
        return res.json().then(data => {
          if (data.address) {
            localStorage.setItem('aria_user', JSON.stringify(data));
            router.push('/');
          } else {
            router.push('/?error=auth_failed');
          }
        });
      }
    })
    .catch(() => router.push('/?error=network'));
  }, []);

  return (
    <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh',background:'#0a0a0a',color:'#fff'}}>
      <p>Completing sign in...</p>
    </div>
  );
}
