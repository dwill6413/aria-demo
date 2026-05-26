import { generateNonce, generateRandomness, jwtToAddress } from '@mysten/sui/zklogin';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { dotenvConfig } from './config.mjs';

dotenvConfig();


// In-memory session store (fine for demo)
const sessions = new Map();

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
  const privateKey = ephemeralKeypair.getSecretKey();

  // Encode all state into the state param — no server memory needed
  const stateData = Buffer.from(JSON.stringify({
    privateKey,
    maxEpoch,
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
    sessions.set(sessionId, {
      suiAddress,
      email: payload.email,
      name: payload.name,
      picture: payload.picture,
      ephemeralKeypair: { privateKey: pending.privateKey },
      maxEpoch: pending.maxEpoch,
      randomness: pending.randomness,
      idToken: id_token,
      createdAt: Date.now()
    });

    reply.setCookie('aria_session', sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: 'none',
      maxAge: 86400,
      path: '/'
    });

    return reply.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}?auth=success`);

  } catch (err) {
    console.error('zkLogin callback error:', err);
    return reply.code(500).send({ error: 'Authentication failed', details: err.message });
  }
}
