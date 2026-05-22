import { CoreClient as SuiClient } from '@mysten/sui/client';
import { generateNonce, generateRandomness, jwtToAddress } from '@mysten/sui/zklogin';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { dotenvConfig } from './config.mjs';

dotenvConfig();

const suiClient = new SuiClient({ url: 'https://fullnode.testnet.sui.io:443' });

// In-memory session store (fine for demo)
const sessions = new Map();
const pendingNonces = new Map();

export function getSession(sessionId) {
  return sessions.get(sessionId) || null;
}

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

  const nonceId = Math.random().toString(36).slice(2);
  pendingNonces.set(nonceId, {
 ephemeralKeypair: { privateKey: ephemeralKeypair.getSecretKey() },
    maxEpoch, randomness, nonce, createdAt: Date.now()
  });

  for (const [key, val] of pendingNonces) {
    if (Date.now() - val.createdAt > 600000) pendingNonces.delete(key);
  }

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    response_type: 'id_token',
    redirect_uri: 'http://localhost:3000/auth/zklogin/callback',
    scope: 'openid email profile',
    nonce,
    state: nonceId
  });

  const googleUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  return { url: googleUrl, nonceId };
}

export async function handleZkLoginCallback(request, reply) {
  const { state, id_token } = request.query;

  if (!state || !id_token) {
    return reply.code(400).send({ error: 'Missing state or id_token' });
  }

  const pending = pendingNonces.get(state);
  if (!pending) {
    return reply.code(400).send({ error: 'Invalid or expired nonce' });
  }

  try {
    const [, payloadB64] = id_token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    const sub = payload.sub;
const salt = '0';
const suiAddress = jwtToAddress(id_token, salt, true);
    const sessionId = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    sessions.set(sessionId, {
      suiAddress, email: payload.email, name: payload.name,
      picture: payload.picture, ephemeralKeypair: pending.ephemeralKeypair,
      maxEpoch: pending.maxEpoch, randomness: pending.randomness,
      idToken: id_token, createdAt: Date.now()
    });

    pendingNonces.delete(state);

    reply.setCookie('aria_session', sessionId, {
      httpOnly: true, secure: false, sameSite: 'lax', maxAge: 86400, path: '/'
    });

    return reply.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}?auth=success`);

  } catch (err) {
    console.error('zkLogin callback error:', err);
    return reply.code(500).send({ error: 'Authentication failed', details: err.message });
  }
}