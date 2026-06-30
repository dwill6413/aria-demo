import crypto from 'node:crypto';
import { jwtToAddress } from '@mysten/sui/zklogin';
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

export async function deleteSession(sessionId) {
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

// ─── zkLogin Callback ─────────────────────────────────────────────────────────
//
// P0b prerequisite change: the ephemeral keypair, nonce, and randomness used
// to be generated HERE (server-side), round-tripped through the OAuth
// `state` param, and discarded after this function ran — meaning nothing,
// frontend or backend, retained the material needed to produce a zkLogin
// signature after login. That made "guest signs the escrow transaction"
// impossible regardless of what the backend did with the PTB.
//
// The ephemeral keypair + nonce are now generated client-side (see
// lib/zklogin.js: beginZkLogin) and never leave the browser. This endpoint's
// job shrinks to what it should always have been: verify the Google id_token,
// confirm it was minted for the nonce this browser generated, derive the Sui
// address, and create the app session. The nonce arrives as a plain request
// field instead of inside a server-issued state blob.

export async function handleZkLoginCallback(request, reply) {
  const { id_token, nonce } = request.body || {};

  if (!id_token || !nonce) {
    return reply.code(400).send({ error: 'Missing id_token or nonce' });
  }

  try {
    // Verify signature + claims against Google BEFORE trusting anything.
    const payload = await verifyGoogleIdToken(id_token);

    // Bind the token to this login attempt — the nonce must match the one
    // embedded in the Google OAuth URL the browser was redirected to
    // (generated client-side in lib/zklogin.js: beginZkLogin).
    if (String(payload.nonce) !== String(nonce)) {
      throw new Error('Nonce mismatch');
    }

    // Must match NEXT_PUBLIC_ZKLOGIN_SALT in lib/zklogin.js (Vercel).
    // Set ZKLOGIN_SALT in Railway env vars. Defaults to '0' for local dev only.
    const salt = process.env.ZKLOGIN_SALT || '0';
    const suiAddress = jwtToAddress(id_token, salt, true);

    // Cryptographically strong, opaque session id (was Math.random()).
    const sessionId = crypto.randomBytes(32).toString('base64url');

    // Store only what the app actually reads. The raw id_token is NOT
    // persisted server-side — the frontend retains it just long enough to
    // fetch its ZK proof (see lib/zklogin.js: completeZkLogin), then drops it.
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

    // Cross-domain frontends can't read the httpOnly cookie directly, so we
    // also return the session id in the body for the x-session-id header path.
    return {
      sid: sessionId,
      address: suiAddress,
      email: payload.email,
      name: payload.name,
      picture: payload.picture
    };

  } catch (err) {
    console.error('zkLogin callback error:', err.message);
    // Generic message to the client — no internal details leaked.
    return reply.code(401).send({ error: 'Authentication failed' });
  }
}
