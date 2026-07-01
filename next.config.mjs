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
//     wildcard since Mysten hosts the testnet key servers there
//
// Shipping in Report-Only mode first per the original plan below: this lets
// us watch the browser console / a report endpoint for violations against
// real traffic before it can ever block the live booking/Seal flow. Flip
// Content-Security-Policy-Report-Only to Content-Security-Policy once a
// production session has run clean for a few days.
// Still open: Stripe.js isn't loaded by the frontend yet (payment/create-intent
// is a stub — see roadmap item 4, Stripe webhook completion), so js.stripe.com/
// api.stripe.com aren't allowlisted yet. Add them when that lands.
const API_ORIGIN = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

const CSP_DIRECTIVES = [
  `default-src 'self'`,
  // Next.js/React need inline style attributes (style={{}} is used throughout)
  // and this app's inline <style> blocks; no inline <script> execution is used.
  `script-src 'self'`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data: blob: https:`,
  `font-src 'self' data:`,
  `connect-src 'self' ${API_ORIGIN} https://fullnode.testnet.sui.io https://*.mystenlabs.com https://publisher.walrus-testnet.walrus.space https://aggregator.walrus-testnet.walrus.space`,
  `frame-src 'self' https://accounts.google.com`,
  `frame-ancestors 'self'`,
  `object-src 'none'`,
  `base-uri 'self'`,
  `form-action 'self' https://accounts.google.com`,
  `upgrade-insecure-requests`,
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Content-Security-Policy-Report-Only', value: CSP_DIRECTIVES },
        ],
      },
    ];
  },
}

export default nextConfig;
