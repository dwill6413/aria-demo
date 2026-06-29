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

// Testnet epoch duration is 1 day, and Walrus deletes a blob once its paid
// epochs run out. `epochs=3` (an earlier value) only bought ~3 days of
// storage — far short of the "RECEIPT STORED PERMANENTLY ON WALRUS" claim
// shown in the UI (pages/index.jsx, bookings.jsx, host.jsx). 53 is the actual
// current testnet max_epochs_ahead (confirmed on docs.wal.app/docs/network-
// reference — a prior value of 183 here was based on stale info and was past
// the protocol's real limit, which made the publisher reject the request
// outright with a 500). 53 days still isn't literally permanent; revisit when
// porting to mainnet (epochs are 2 weeks there, same 53-epoch max).
const WALRUS_PUBLISHER_URL = 'https://publisher.walrus-testnet.walrus.space/v1/blobs?epochs=53';

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

// ── Phase 3a: host listing photos ─────────────────────────────────────────────
// Sibling to pushToWalrus above, but for raw binary image bytes instead of a
// JSON receipt — used by POST /host/listings/photos so host-uploaded listing
// photos get a public URL without standing up separate file-storage
// infrastructure (S3, etc.) for what's still a testnet demo. Same publisher/
// epoch tradeoffs as pushToWalrus apply (53-day expiry, not literally
// permanent). Returns the public aggregator URL directly (not just the
// blobId) since that's what the `properties.images` column stores and what
// <img src> needs — same aggregator pattern already used by lib/seal.js,
// pages/index.jsx, pages/host.jsx, and pages/bookings.jsx for other blobs.
const WALRUS_AGGREGATOR_URL = 'https://aggregator.walrus-testnet.walrus.space/v1/blobs';

export async function pushImageToWalrus(buffer, logger = console) {
  try {
    const res = await fetch(WALRUS_PUBLISHER_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: buffer,
    });
    const json = await res.json();
    const blobId = json?.newlyCreated?.blobObject?.blobId ?? json?.alreadyCertified?.blobId ?? null;
    if (!blobId) {
      logger?.warn?.({ json }, 'Walrus image push: no blobId in response');
      return null;
    }
    return `${WALRUS_AGGREGATOR_URL}/${blobId}`;
  } catch (err) {
    logger?.warn?.({ err: err.message }, 'Walrus image push failed');
    return null;
  }
}
