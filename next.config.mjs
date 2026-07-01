// §5f (July 2026 hardening pass): CSP, built from an actual audit of every
// external domain the frontend talks to (grepped across pages/ and lib/):
//   - accounts.google.com  → zkLogin sign-in redirect (top-level navigation,
//     not a fetch, but harmless to allowlist for form-action/frame use)
//   - fullnode.testnet.sui.io → Sui gRPC-web fullnode, called directly from
//     the guest's browser (lib/zklogin.js) to sign/submit transactions
//   - prover-dev.mystenlabs.com → zkLogin proof generation
//   - publisher/aggregator.walrus-testnet.walrus.space → Walrus blob
//     read/write (receipts, Seal-encrypted identity docs)
//   - the Railway API itself (NEXT_PUBLIC_API_URL)
//   - images.unsplash.com → the 6 demo properties' stock photos; host-
//     imported listings (Airbnb/VRBO) can carry photos from arbitrary CDNs,
//     so img-src stays open to any https origin rather than an allowlist
//     that would silently break host onboarding
//   - Seal's key-server URLs are resolved dynamically from on-chain data
//     (@mysten/seal), not hardcoded here — covered by the mystenlabs.com
//     wildcard since Mysten hosts the testnet