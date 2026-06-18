// ─── Client-side zkLogin helper ────────────────────────────────────────────
//
// Owns the ephemeral keypair, nonce, and ZK proof needed for the guest's
// browser to sign transactions as their own zkLogin Sui address — without
// ARIA's backend ever holding signing material. This is the prerequisite
// for P0b (guest-funded escrow): before this module existed, the ephemeral
// key was generated server-side and discarded after the OAuth callback, so
// no one (frontend or backend) could produce a zkLogin signature after login.
//
// Lifecycle:
//   1. beginZkLogin()    — call before redirecting to Google. Generates the
//                           ephemeral keypair + nonce, stashes pending state
//                           in sessionStorage, returns the nonce to embed in
//                           the OAuth URL.
//   2. completeZkLogin() — call from the OAuth callback page once Google
//                           hands back an id_token. Fetches the ZK proof
//                           from the prover service and caches everything
//                           needed to sign, keyed for the maxEpoch window.
//   3. signTransactionWithZkLogin() — used later (P0b escrow signing) to
//                           produce a submittable zkLogin signature for a
//                           given transaction's bytes.
//
// sessionStorage (not localStorage) is intentional: this material should
// not outlive the browser tab.

import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { fromBase64 } from '@mysten/sui/utils';
import {
  generateNonce,
  generateRandomness,
  getExtendedEphemeralPublicKey,
  getZkLoginSignature,
  genAddressSeed,
  decodeJwt,
} from '@mysten/sui/zklogin';

const PENDING_KEY = 'aria_zklogin_pending';
const SESSION_KEY = 'aria_zklogin_session';
const FULLNODE_URL = 'https://fullnode.testnet.sui.io:443';
const PROVER_URL = process.env.NEXT_PUBLIC_PROVER_URL || 'https://prover-dev.mystenlabs.com/v1';

// Sui's JSON-RPC interface is being deactivated network-wide (July 31, 2026).
// The backend already migrated to the gRPC client in P0a; this is the matching
// migration for the browser-side guest signing path (Finding #2) — both the
// epoch read (beginZkLogin) and the signed-transaction submit
// (submitSignedTransaction) now go through SuiGrpcClient instead of raw
// sui_*/suix_* JSON-RPC calls, so guest-funded escrow keeps working past the
// sunset. Same testnet fullnode endpoint, which serves gRPC-web to browsers.
const suiClient = new SuiGrpcClient({ network: 'testnet', baseUrl: FULLNODE_URL });

// Must match the salt used server-side in auth.mjs (jwtToAddress(id_token, salt, true)).
// Kept at '0' to preserve existing derived addresses — see auth.mjs note.
const SALT = '0';
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes — long enough for the Google redirect round trip

function getStorage() {
  if (typeof window === 'undefined') return null;
  try {
    window.sessionStorage.setItem('__aria_probe', '1');
    window.sessionStorage.removeItem('__aria_probe');
    return window.sessionStorage;
  } catch {
    return null;
  }
}

async function fetchCurrentEpoch() {
  // gRPC replacement for the old suix_getLatestSuiSystemState JSON-RPC call.
  const state = await suiClient.core.getCurrentSystemState();
  const epoch = parseInt(state?.systemState?.epoch, 10);
  if (Number.isNaN(epoch)) throw new Error('Could not read current Sui epoch');
  return epoch;
}

// Step 1 — call before redirecting to Google. Returns the nonce to put in the
// Google OAuth URL (response_type=id_token&nonce=...).
export async function beginZkLogin() {
  const storage = getStorage();
  if (!storage) throw new Error('sessionStorage unavailable — zkLogin requires a browser');

  const ephemeralKeypair = new Ed25519Keypair();
  const maxEpoch = (await fetchCurrentEpoch()) + 10; // ~10 epochs validity window, matches prior server-side value
  const randomness = generateRandomness();
  const nonce = generateNonce(ephemeralKeypair.getPublicKey(), maxEpoch, randomness);

  storage.setItem(PENDING_KEY, JSON.stringify({
    ephemeralPrivateKey: ephemeralKeypair.getSecretKey(),
    maxEpoch,
    randomness: randomness.toString(),
    nonce,
    createdAt: Date.now(),
  }));

  return nonce;
}

// Step 2 — call from the OAuth callback page with the id_token Google returned.
// Fetches the ZK proof and caches a ready-to-sign session. Returns the nonce
// so the caller can send it to the backend for the matching session-creation check.
export async function completeZkLogin(idToken) {
  const storage = getStorage();
  if (!storage) throw new Error('sessionStorage unavailable — zkLogin requires a browser');

  const raw = storage.getItem(PENDING_KEY);
  if (!raw) throw new Error('No pending zkLogin attempt found — please sign in again.');

  const pending = JSON.parse(raw);
  storage.removeItem(PENDING_KEY);

  if (!pending.createdAt || Date.now() - pending.createdAt > PENDING_TTL_MS) {
    throw new Error('Sign-in took too long — please try again.');
  }

  const ephemeralKeypair = Ed25519Keypair.fromSecretKey(pending.ephemeralPrivateKey);
  const extendedEphemeralPublicKey = getExtendedEphemeralPublicKey(ephemeralKeypair.getPublicKey());

  const proverRes = await fetch(PROVER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jwt: idToken,
      extendedEphemeralPublicKey,
      maxEpoch: pending.maxEpoch,
      jwtRandomness: pending.randomness,
      salt: SALT,
      keyClaimName: 'sub',
    }),
  });
  if (!proverRes.ok) {
    const detail = await proverRes.text().catch(() => '');
    throw new Error(`ZK proof request failed (${proverRes.status}): ${detail.slice(0, 200)}`);
  }
  const zkProof = await proverRes.json();

  const decoded = decodeJwt(idToken);
  const addressSeed = genAddressSeed(SALT, 'sub', decoded.sub, decoded.aud).toString();

  storage.setItem(SESSION_KEY, JSON.stringify({
    ephemeralPrivateKey: pending.ephemeralPrivateKey,
    maxEpoch: pending.maxEpoch,
    zkProof,
    addressSeed,
    createdAt: Date.now(),
  }));

  return { nonce: pending.nonce };
}

// Step 3 — used by the booking flow (P0b) to sign a transaction's bytes as
// the guest's zkLogin address. Returns a serialized signature ready to
// submit alongside the transaction bytes via SuiClient.executeTransactionBlock.
export async function signTransactionWithZkLogin(transactionBytes) {
  const storage = getStorage();
  const raw = storage?.getItem(SESSION_KEY);
  if (!raw) throw new Error('Not signed in with zkLogin — please sign in again.');

  const session = JSON.parse(raw);
  const ephemeralKeypair = Ed25519Keypair.fromSecretKey(session.ephemeralPrivateKey);
  const { signature: userSignature } = await ephemeralKeypair.signTransaction(transactionBytes);

  return getZkLoginSignature({
    inputs: { ...session.zkProof, addressSeed: session.addressSeed },
    maxEpoch: session.maxEpoch,
    userSignature,
  });
}

// Step 4 — submit a zkLogin-signed transaction directly to Sui testnet from
// the browser. ARIA's backend never sees or relays this call: it goes
// straight from the guest's browser to a public Sui fullnode, the same way
// fetchCurrentEpoch already talks to Sui above. This is the non-custodial
// completion of P0b — funds move directly between the guest's own address
// and the chain. Returns the transaction digest, which the caller reports to
// /booking/:bookingRef/escrow/confirm so the backend can independently
// re-verify the result on-chain before writing anything to Postgres (it
// never trusts this digest at face value).
export async function submitSignedTransaction(transactionBytesBase64, signature) {
  // gRPC replacement for the old sui_executeTransactionBlock JSON-RPC call.
  // executeTransaction wants the raw transaction bytes (Uint8Array), so decode
  // the base64 the caller already holds. The result is the same discriminated
  // union the backend's escrow.mjs unwraps: $kind 'Transaction' on success
  // (digest under .Transaction) or 'FailedTransaction' on failure.
  const transaction = fromBase64(transactionBytesBase64);
  const result = await suiClient.core.executeTransaction({
    transaction,
    signatures: [signature],
    include: { effects: true },
  });

  if (result?.$kind === 'FailedTransaction') {
    const msg = result.FailedTransaction?.effects?.status?.error?.message
      || result.FailedTransaction?.status?.error?.message;
    throw new Error(msg || 'Transaction failed on-chain');
  }

  const digest = result?.Transaction?.digest;
  if (!digest) throw new Error('Sui did not return a transaction digest');
  return digest;
}

export function hasActiveZkLoginSession() {
  const storage = getStorage();
  return !!storage?.getItem(SESSION_KEY);
}

export function clearZkLoginSession() {
  const storage = getStorage();
  storage?.removeItem(SESSION_KEY);
  storage?.removeItem(PENDING_KEY);
}
