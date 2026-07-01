// Extracted verbatim from server.mjs (R1 route-module split, July 1 2026).
import { handleZkLoginCallback, handleZkLoginSalt, deleteSession } from '../auth.mjs';
import { pool } from '../db.mjs';
import { isHost, getAuthedSession } from '../authz.mjs';

export default async function authRoutes(fastify) {
// Auth
// Ephemeral key + nonce generation moved client-side (lib/zklogin.js) — the
// backend no longer issues the Google OAuth URL itself. This is now a POST
// because the frontend sends {id_token, nonce} as a JSON body rather than
// the GET query+state pattern used when the backend minted the state blob.
fastify.post('/auth/zklogin/callback', async (request, reply) => {
  return handleZkLoginCallback(request, reply);
});

// M3: per-user zkLogin salt lookup. Called by the callback page BEFORE
// /auth/zklogin/callback so the browser can compute its addressSeed with the
// same salt the backend is about to use — see handleZkLoginSalt in auth.mjs.
fastify.post('/auth/zklogin/salt', {
  config: { rateLimit: { max: 30, timeWindow: '10 minutes', errorResponseBuilder: () => ({ error: 'Too many attempts.' }) } }
}, async (request, reply) => {
  return handleZkLoginSalt(request, reply);
});

fastify.get('/auth/me', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;

  let hostStatus = null;
  try {
    const hp = await pool.query(
      'SELECT status FROM host_profiles WHERE email = $1',
      [session.email.toLowerCase()]
    );
    if (hp.rows.length > 0) hostStatus = hp.rows[0].status;
  } catch {}

  // Phase 2f: whether this guest has completed identity verification (a
  // guest_verifications row), so the frontend can gate booking + prompt /profile.
  let hasGuestProfile = false;
  try {
    const gv = await pool.query('SELECT 1 FROM guest_verifications WHERE sui_address = $1', [session.suiAddress]);
    hasGuestProfile = gv.rows.length > 0;
  } catch {}

  return {
    address: session.suiAddress,
    email: session.email,
    name: session.name,
    isHost: await isHost(session),
    hostStatus,
    hasGuestProfile
  };
});

fastify.get('/auth/logout', async (request, reply) => {
  // Revoke server-side, not just the cookie: a copied aria_session (cookie or the
  // x-session-id fallback) must stop working immediately on logout, not linger
  // until expiry. deleteSession removes the Postgres session row.
  const sessionId = request.cookies.aria_session || request.headers['x-session-id'];
  if (sessionId) {
    try { await deleteSession(sessionId); }
    catch (err) { fastify.log.warn({ err }, '/auth/logout: session row delete failed'); }
  }
  reply.clearCookie('aria_session');
  return { success: true };
});
}
