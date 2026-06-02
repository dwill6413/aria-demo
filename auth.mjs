import crypto from 'node:crypto';
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

// ─── Google ID-token verification (no external dependency) ────────────────────
// Verifies the RS256 signature against Google's published JWKS and validates
// the standard claims. Without this, a forged token could mint any session.

let _jwksCache = { keys: [], fetchedAt: 0 };

async function getGoogleKeys() {
  const now = Date.now();
  if (_jwksCache.keys.length && now - _jwksCache.fetchedAt < 60 * 60 * 1000) {
    return _jwksCache.keys;
  }
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  const data = await res.json();
  _jwksCache = { keys: data.keys || [], fetchedAt: now };
  return _jwksCache.keys;
}

function b64urlToBuffer(s) {
  return Buffer.from(s, 'base64url');
}

async function verifyGoogleIdToken(idToken) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [headerB64, payloadB64, sigB64] = parts;

  const header  = JSON.parse(b64urlToBuffer(headerB64).toString('utf8'));
  const payload = JSON.parse(b64urlToBuffer(payloadB64).toString('utf8'));

  if (header.alg !== 'RS256') throw new Error('Unexpected token algorithm');

  const keys = await getGoogleKeys();
  const jwk  = keys.find(k => k.kid === header.kid);
  if (!jwk) throw new Error('Token signing key not found');

  const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const signed    = Buffer.from(`${headerB64}.${payloadB64}`);
  const valid     = crypto.verify('RSA-SHA256', signed, publicKey, b64urlToBuffer(sigB64));
  if (!valid) throw new Error('Invalid token signature');

  const expectedAud = process.env.GOOGLE_CLIENT_ID;
  if (expectedAud && payload.aud !== expectedAud) throw new Error('Audience mismatch');
  if (payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    throw new Error('Issuer mismatch');
  }
  if (!payload.exp || payload.exp * 1000 < Date.now()) throw new Error('Token expired');

  return payload;
}

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
    // Verify signature + claims against Google BEFORE trusting anything.
    const payload = await verifyGoogleIdToken(id_token);

    // Bind the token to this login attempt — the nonce must match the one we
    // generated and sent to Google in getZkLoginUrl.
    if (!pending.nonce || String(payload.nonce) !== String(pending.nonce)) {
      throw new Error('Nonce mismatch');
    }

    // NOTE: salt is kept at '0' to preserve existing derived addresses.
    // Rotating to a per-user secret salt is a separate, data-migrating change.
    const salt = '0';
    const suiAddress = jwtToAddress(id_token, salt, true);

    // Cryptographically strong, opaque session id (was Math.random()).
    const sessionId = crypto.randomBytes(32).toString('base64url');

    // Store only what the app actually reads. The ephemeral private key and
    // raw id_token are NOT persisted (nothing else consumes them).
    const sessionData = {
      suiAddress,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      createdAt: Date.now()
    };

    await saveSession(sessionId, sessionData);

    reply.setCookie('aria_session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV !== 'development',
      sameSite: process.env.NODE_ENV !== 'development' ? 'none' : 'lax',
      maxAge: 86400,
      path: '/'
    });

    // Cross-domain frontends read this and store it for the x-session-id header.
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    return reply.redirect(`${frontendUrl}?auth=success&sid=${sessionId}`);

  } catch (err) {
    console.error('zkLogin callback error:', err.message);
    // Generic message to the client — no internal details leaked.
    return reply.code(401).send({ error: 'Authentication failed' });
  }
}
