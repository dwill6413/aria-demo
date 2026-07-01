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

// ─── Per-user zkLogin salt (M3) ────────────────────────────────────────────
// Replaces the single shared ZKLOGIN_SALT env var as the actual derivation
// input: each Google account's `sub` claim gets its own persisted salt in
// user_salts, looked up/created here. Once a row exists it never changes, so
// changing the ZKLOGIN_SALT env var again can no longer reshuffle anyone's
// address — it only ever seeds a row that doesn't exist yet. See db.mjs's
// user_salts comment and ARIA_KEY_INVENTORY.md §8 for the incident that made
// this necessary (June 30 → July 1, 2026: changing the old shared salt
// silently swapped which Sui address two accounts resolved to).
export async function getOrCreateUserSalt(sub) {
  const existing = await pool.query('SELECT salt FROM user_salts WHERE sub = $1', [sub]);
  if (existing.rows.length > 0) return existing.rows[0].salt;

  // First time we've ever seen this sub. Seed with the CURRENT global salt
  // value — not a fresh random one — so an existing user's address is
  // preserved at rollout (their historical address was already derived from
  // this value). ON CONFLICT DO NOTHING + re-SELECT handles the race where
  // two logins for the same brand-new sub land at the same instant.
  const seedSalt = process.env.ZKLOGIN_SALT || '0';
  await pool.query(
    `INSERT INTO user_salts (sub, salt) VALUES ($1, $2) ON CONFLICT (sub) DO NOTHING`,
    [sub, seedSalt]
  );
  const result = await pool.query('SELECT salt FROM user_salts WHERE sub = $1', [sub]);
  return result.rows[0].salt;
}

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
      throw new E