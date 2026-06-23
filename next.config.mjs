/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  // §5f: security headers on the frontend. CSP is intentionally NOT set here yet:
  // a correct policy must allowlist Google OAuth, the Sui fullnode, the zkLogin
  // prover, Walrus publisher/aggregator, the Seal key servers, the Railway API,
  // and 'unsafe-inline' styles (the app uses inline style={} everywhere) — a wrong
  // CSP would break the live Seal/booking flow, so it's a deliberate follow-up
  // (validate against the running app, ideally Report-Only first). See roadmap §5f.
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
        ],
      },
    ];
  },
}

export default nextConfig;
