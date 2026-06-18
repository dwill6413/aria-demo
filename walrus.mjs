// ─── Shared Walrus receipt helper (R3) ────────────────────────────────────────
// Single implementation of "push a JSON receipt to Walrus testnet and return the
// blobId" — previously duplicated three times (pushBookingReceiptToWalrus in
// bookings.mjs, and pushToWalrus local functions in both server.mjs and
// ai_route.mjs). Consolidated here so the publisher URL, epoch count, and
// response-shape parsing live in exactly one place.
//
// Non-blocking by contract: a failed push returns null (logged) rather than
// throwing — a booking/cancellation/release is still valid without its
// permanent off-chain audit copy.

const WALRUS_PUBLISHER_URL = 'https://publisher.walrus-testnet.walrus.space/v1/blobs?epochs=3';

export async function pushToWalrus(data, logger = console) {
  try {
    const res = await fetch(WALRUS_PUBLISHER_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: Buffer.from(JSON.stringify(data)),
    });
    const json = await res.json();
    return json?.newlyCreated?.blobObject?.blobId ?? json?.alreadyCertified?.blobId ?? null;
  } catch (err) {
    logger?.warn?.({ err: err.message }, 'Walrus push failed');
    return null;
  }
}
