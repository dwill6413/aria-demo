import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import { dotenvConfig } from './config.mjs';
import { registerAIRoute } from './ai_route.mjs';
import { initDB } from './db.mjs';
import { setAuthzLogger } from './authz.mjs';
import { startSweeps } from './sweeps.mjs';
import coreRoutes from './routes/core.mjs';
import authRoutes from './routes/auth.mjs';
import identityRoutes from './routes/identity.mjs';
import paymentsRoutes from './routes/payments.mjs';
import bookingsRoutes from './routes/bookings.mjs';
import resaleRoutes from './routes/resale.mjs';
import walletRoutes from './routes/wallet.mjs';
import checkinRoutes from './routes/checkin.mjs';
import hostRoutes from './routes/host.mjs';
import miscRoutes from './routes/misc.mjs';
import messagesRoutes from './routes/messages.mjs';
import reviewsRoutes from './routes/reviews.mjs';
import taxRoutes from './routes/tax.mjs';

dotenvConfig();

// R1 route-module split (July 1, 2026): server.mjs is now bootstrap only.
// - HTTP routes:            routes/*.mjs (Fastify plugins, registered below
//                           in the original definition order)
// - Auth/RBAC helpers:      authz.mjs (getAuthedSession, isHost,
//                           canManageProperty, ... — logger injected below)
// - Stripe/Resend clients:  services.mjs
// - Background sweeps:      sweeps.mjs (startSweeps(fastify), called after
//                           routes so boot ordering matches the old file)
// The Sui escrow client + PTB build/verify helpers live in escrow.mjs
// (Phase 2b) — see its header comment and bookings.mjs's createBooking().

try { await initDB(); } catch (err) { console.error('DB init failed:', err.message); }

const fastify = Fastify({ logger: true });
setAuthzLogger(fastify.log);

await fastify.register(cors, {
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']
});

await fastify.register(cookie, {
  secret: process.env.SESSION_SECRET
});

await fastify.register(rateLimit, {
  global: true,
  max: 100,
  timeWindow: '1 minute',
  errorResponseBuilder: () => ({
    error: 'Too many requests. Please slow down and try again in a minute.'
  })
});

// §5f: security headers. This is a JSON API (the HTML/CSP live on the Next
// frontend — see next.config.mjs), so we disable CSP here and, crucially, keep
// the cross-origin resource policy OPEN: the Vercel frontend is a different
// origin and must be able to read API responses. The valuable headers helmet
// still sets: HSTS, X-Content-Type-Options (nosniff), X-Frame-Options,
// Referrer-Policy, X-DNS-Prefetch-Control, etc.
await fastify.register(helmet, {
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
});

await registerAIRoute(fastify);

await fastify.register(coreRoutes);
await fastify.register(authRoutes);
await fastify.register(identityRoutes);
await fastify.register(paymentsRoutes);
await fastify.register(bookingsRoutes);
await fastify.register(resaleRoutes);
await fastify.register(walletRoutes);
await fastify.register(checkinRoutes);
await fastify.register(hostRoutes);
await fastify.register(miscRoutes);
await fastify.register(messagesRoutes);
await fastify.register(reviewsRoutes);
await fastify.register(taxRoutes);

startSweeps(fastify);

// ─── Start ────────────────────────────────────────────────────────────────────
const port = parseInt(process.env.PORT || '3001');
await fastify.listen({ port, host: '0.0.0.0' });
console.log('ARIA API running on port ' + port);
