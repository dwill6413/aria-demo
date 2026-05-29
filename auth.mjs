import { generateNonce, generateRandomness, jwtToAddress } from '@mysten/sui/zklogin';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { dotenvConfig } from './config.mjs';
import { pool } from './db.mjs';

dotenvConfig();

// ─── Session helpers — Postgres-backed ───────────────────────────────────────

export async function getSession(sessionId) {
  try {
    const result = await pool.query(
      `SELECT data FROM sessions WHERE id = $1 AND expires_at > NOW()`,
      [sessionId]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0].data;
  } catch {
    return null;
  }
}

async function saveSession(sessionId, data) {
  const expiresAt = new Date(Date.now() + 86400 * 1000); // 24 hours
  await pool.query(
    `INSERT INTO sessions (id, data, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET data = $2, expires_at = $3`,
    [sessionId, JSON.stringify(data), expiresAt]
  );
}

async function deleteSession(sessionId) {
  await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

// Purge expired sessions — called occasionally to keep the table clean
async function purgeExpiredSessions() {
  try {
    await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');
  } catch {}
}

// Run cleanup every hour
setInterval(purgeExpiredSessions, 60 * 60 * 1000);

// ─── zkLogin URL ──────────────────────────────────────────────────────────────

export async function getZkLoginUrl(request, reply) {
  const ephemeralKeypair = new Ed25519Keypair();
  const epochRes = await fetch('https://fullnode.testnet.sui.io:443', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'suix_getLatestSuiSystemState', params: [] })
  });
  const epochData = await epochRes.json();
  const maxEpoch = parseInt(epochData.result.epoch) + 10;

  const randomness = generateRandomness();
  const nonce = generateNonce(ephemeralKeypair.getPublicKey(), maxEpoch, randomness);
  const privateKey = ephemeralKeypair.getSecretKey();

  const stateData = Buffer.from(JSON.stringify({
    privateKey, maxEpoch,
    randomness: randomness.toString(),
    nonce: nonce.toString(),
    createdAt: Date.now()
  })).toString('base64url');

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    response_type: 'id_token',
    redirect_uri: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/auth/zklogin/callback',
    scope: 'openid email profile',
    nonce,
    state: stateData
  });

  const googleUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  return { url: googleUrl };
}

// ─── zkLogin Callback ─────────────────────────────────────────────────────────

export async function handleZkLoginCallback(request, reply) {
  const { state, id_token } = request.query;

  if (!state || !id_token) {
    return reply.code(400).send({ error: 'Missing state or id_token' });
  }

  let pending;
  try {
    pending = JSON.parse(Buffer.from(state, 'base64url').toString());
  } catch {
    return reply.code(400).send({ error: 'Invalid state parameter' });
  }

  if (!pending.createdAt || Date.now() - pending.createdAt > 600000) {
    return reply.code(400).send({ error: 'State expired' });
  }

  try {
    const [, payloadB64] = id_token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());

    const salt = '0';
    const suiAddress = jwtToAddress(id_token, salt, true);

    const sessionId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const sessionData = {
      suiAddress,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      ephemeralKeypair: { privateKey: pending.privateKey },
      maxEpoch: pending.maxEpoch,
      randomness: pending.randomness,
      idToken: id_token,
      createdAt: Date.now()
    };

    // Save to Postgres — survives Railway redeploys
    await saveSession(sessionId, sessionData);

    reply.setCookie('aria_session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      sameSite: process.env.NODE_ENV !== 'development' ? 'none' : 'lax',
      maxAge: 86400,
      path: '/'
    });

    // Pass sid in URL so cross-domain frontends can store it in localStorage
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    return reply.redirect(`${frontendUrl}?auth=success&sid=${sessionId}`);

  } catch (err) {
    console.error('zkLogin callback error:', err);
    return reply.code(500).send({ error: 'Authentication failed', details: err.message });
  }
}
