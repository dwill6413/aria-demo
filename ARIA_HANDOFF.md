# ARIA — Technical Handoff Document
**Version:** 2.1 | **Updated:** June 02, 2026

This document provides deeper technical details for developers or AI assistants continuing work on ARIA.

## Architecture Overview

- **Frontend**: Next.js (Pages Router) + Tailwind + react-datepicker
- **Backend**: Fastify (ESM) + PostgreSQL (node-postgres)
- **Auth**: Google OAuth → zkLogin (Sui wallet address)
- **Database**: PostgreSQL with 7 tables (properties, bookings, host_profiles, etc.)
- **Payments**: SuiUSD primary + Stripe fallback
- **Storage**: Walrus for immutable receipts
- **Sessions**: Now stored in PostgreSQL (major upgrade June 2026)

## Key Technical Decisions

### Cross-Domain Auth Solution
- Backend (Railway) and Frontend (Vercel) on different domains
- Session ID passed via URL param (`?sid=`) → stored in localStorage
- All authenticated requests use `x-session-id` header fallback
- `authFetch()` helper in frontend

### Session Management (Updated)
- Previously in-memory → now persisted in `sessions` table
- Survives Railway restarts
- See `auth.mjs` for `createSession()`, `getSession()`, `destroySession()`

### Recent Security Hardening (June 2026)
- Google JWT verification on callback
- Server-side price validation in `/booking/create`
- Improved rate limiting
- XSS protection on user inputs
- Better input sanitization

### Tax System
- Now uses jurisdiction-based rates (stored per property or lookup)
- Previously flat 8%
- Duplication exists across frontend, booking route, and AI route (TODO: centralize)

## Important Files

| File | Purpose | Notes |
|------|--------|-------|
| `server.mjs` | Main Fastify server | All routes, middleware, RBAC |
| `db.mjs` | Database pool + initDB() | Creates tables + indexes |
| `auth.mjs` | OAuth + session logic | Postgres sessions now |
| `deepbook.mjs` | Sui payout calculations | |
| `ai_route.mjs` | Grok AI agent endpoint | Real actions possible |

## Current Technical Debt

1. **Properties**: Still frontend-hardcoded. `properties` table empty.
2. **Tax rates duplication** — needs extraction to shared utility or DB.
3. **Stripe**: Partial implementation (create-intent only). Webhooks missing.
4. **Error handling**: Inconsistent in some routes.
5. **Testing**: No automated tests.

## Best Practices for Changes

- Always use `authFetch()` in frontend
- Check `isHost(session)` for host-only routes
- Update ARIA_Context.md when making major changes
- Prefer server-side validation

**Last major updates**: Postgres sessions, security hardening, jurisdiction taxes, date fixes.

---
*Technical Handoff v2.1 — June 02, 2026*