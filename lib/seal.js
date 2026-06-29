// ─── Client-side Seal (guest PII) helper ───────────────────────────────────
//
// Phase 2: guests encrypt their PII in the browser with Seal (threshold IBE),
// store the ciphertext on Walrus, and the booking's host decrypts it client-side
// after Seal's key servers dry-run escrow.move's seal_approve. ARIA's backend
// NEVER sees plaintext PII or decryption keys — it only ever holds the Walrus
// blob pointer (see /guest/profile and /host/guest-identity in server.mjs).
//
// Requires the `@mysten/seal` dependency (not yet installed — run
// `pnpm add @mysten/seal`). The whole flow needs an in-browser smoke test; it
// can't be exercised headless (Seal key servers + zkLogin SessionKey signing).

import { SealClient, SessionKey } from '@mysten/seal';
import { Transaction } from '@mysten/sui/transactions';
import { fromHex } from '@mysten/sui/utils';

// Seal's identity namespace is anchored to a package's ORIGINAL (first-published)
// id forever — so encryption always uses this, regardless of upgrades.
// Seal anchors everything to a package's ORIGINAL (first-published) id and
// REJECTS upgraded ids ("Package ID used in PTB is invalid" if you pass v4).
// So encryption, the SessionKey, AND the seal_approve PTB all use THIS id. Even
// though seal_approve was only added in the v4 upgrade, the key servers resolve
// this original id to the latest on-chain version (v4) when they dry-run the
// call, so the function is reachable. All three must use the same id or Seal
// rejects the decrypt as a package-id mismatch.
export const SEAL_PACKAGE_ID =
  '0x538262ffc948c814e0de066d8a8ecd93a195a4b4f0643b3758d37962d4f7fdbe';

// Kept for reference / docs only — NOT used by Seal (see above).
export const CURRENT_PACKAGE_ID =
  process.env.NEXT_PUBLIC_ESCROW_PACKAGE_ID || SEAL_PACKAGE_ID;

const COIN_TYPE = process.env.NEXT_PUBLIC_PAYMENT_COIN_TYPE || '0x2::sui::SUI';
const MODULE = 'escrow';

// Testnet Mysten-run key servers (Phase 2b). Threshold 2-of-2 = the secret is
// split across both and both must approve; drop SEAL_THRESHOLD to 1 to trade
// some security for availability. Mainnet has no free Mysten Open server — pick
// a paid/third-party provider (Ruby Nodes, NodeInfra, Enoki, …) before launch.
const KEY_SERVER_IDS = [
  '0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75', // mysten-testnet-1
  '0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8', // mysten-testnet-2
];
const SEAL_THRESHOLD = 2;

// Keep in sync with walrus.mjs's WALRUS_PUBLISHER_URL — 183 epochs is the
// testnet max (~1 year per epoch); the previous epochs=3 (~3-6 days) meant
// encrypted guest-identity blobs would 404 on Walrus almost as soon as a
// host needed to look them up.
const WALRUS_PUBLISHER = 'https://publisher.walrus-testnet.walrus.space/v1/blobs?epochs=183';
const WALRUS_AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space/v1/blobs';

function sealClient(suiClient) {
  return new SealClient({
    suiClient,
    serverConfigs: KEY_SERVER_IDS.map((objectId) => ({ objectId, weight: 1 })),
    verifyKeyServers: false,
  });
}

// The Seal identity is the guest's Sui address (its 32 bytes), so seal_approve
// can gate on `id == address::to_bytes(escrow.guest)`. Seal wants the id as a
// hex string with no 0x prefix.
function identityHex(guestAddress) {
  return guestAddress.toLowerCase().replace(/^0x/, '');
}

// ── Guest: encrypt PII + store on Walrus ────────────────────────────────────
export async function encryptAndStorePII(suiClient, guestAddress, piiObject) {
  const data = new TextEncoder().encode(JSON.stringify(piiObject));
  const { encryptedObject } = await sealClient(suiClient).encrypt({
    threshold: SEAL_THRESHOLD,
    packageId: SEAL_PACKAGE_ID, // original/first-published id (Seal rejects upgraded ids)
    id: identityHex(guestAddress),
    data,
  });

  const res = await fetch(WALRUS_PUBLISHER, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: encryptedObject,
  });
  if (!res.ok) throw new Error(`Walrus store failed (${res.status})`);
  const json = await res.json();
  const blobId = json?.newlyCreated?.blobObject?.blobId ?? json?.alreadyCertified?.blobId;
  if (!blobId) throw new Error('Walrus did not return a blob id');
  return blobId;
}

// ── Host: fetch + decrypt a guest's PII ─────────────────────────────────────
// signPersonalMessage(messageBytes) -> Promise<serialized signature>; for ARIA
// pass signPersonalMessageWithZkLogin from lib/zklogin.js.
export async function fetchAndDecryptPII({
  suiClient, blobId, guestAddress, escrowObjectId, hostAddress, signPersonalMessage,
}) {
  // 1. Pull the ciphertext back from Walrus.
  const res = await fetch(`${WALRUS_AGGREGATOR}/${blobId}`);
  if (!res.ok) {
    // A 404 here almost always means the blob's paid epochs ran out (testnet
    // epochs are short — see WALRUS_PUBLISHER comment above) and Walrus
    // garbage-collected it. The underlying PII is gone for good; retrying the
    // same blobId will never succeed. The fix is for the guest to resubmit on
    // /profile, which stores a fresh blob and overwrites guest_verifications'
    // walrus_blob_id — not for the host to keep hitting Retry.
    if (res.status === 404) {
      throw new Error("This guest's identity record has expired on Walrus and can't be recovered. Ask them to resubmit verification on their Profile page — Retry won't help until they do.");
    }
    throw new Error(`Walrus fetch failed (${res.status})`);
  }
  const ciphertext = new Uint8Array(await res.arrayBuffer());

  // 2. Create a SessionKey and have the host sign its personal message once
  //    (a TTL window of decrypts then needs no further signing).
  const sessionKey = await SessionKey.create({
    address: hostAddress,
    packageId: SEAL_PACKAGE_ID,
    ttlMin: 10,
    suiClient,
  });
  const signature = await signPersonalMessage(sessionKey.getPersonalMessage());
  sessionKey.setPersonalMessageSignature(signature);

  // 3. Build the seal_approve dry-run PTB (transaction-kind only — never
  //    executed). The key servers run it against current on-chain state; if the
  //    escrow object is gone (booking settled) it can't pass and access is gone.
  // The seal_approve CALL must target the package version that actually has the
  // function (v4) so the move call resolves and dry-runs. encrypt + SessionKey
  // use the ORIGINAL id (Seal requires a first-published id and rejects upgraded
  // ones); Seal reconciles the two by resolving the call's package to its first
  // version. So: SEAL_PACKAGE_ID for encrypt/SessionKey, CURRENT (v4) for the call.
  const tx = new Transaction();
  tx.moveCall({
    target: `${CURRENT_PACKAGE_ID}::${MODULE}::seal_approve`,
    typeArguments: [COIN_TYPE],
    arguments: [
      tx.pure.vector('u8', Array.from(fromHex(identityHex(guestAddress)))),
      tx.object(escrowObjectId),
    ],
  });
  const txBytes = await tx.build({ client: suiClient, onlyTransactionKind: true });

  // 4. Decrypt client-side.
  const decrypted = await sealClient(suiClient).decrypt({ data: ciphertext, sessionKey, txBytes });
  return JSON.parse(new TextDecoder().decode(decrypted));
}
