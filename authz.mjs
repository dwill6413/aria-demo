// Shared auth / RBAC helpers, extracted verbatim from server.mjs (R1 split,
// July 1 2026). The only edits vs. the original: export keywords, and
// fastify.log -> the injected `log` (set via setAuthzLogger at boot).
import { dotenvConfig } from './config.mjs';
import { pool } from './db.mjs';
import { getSession } from './auth.mjs';
import { getProperty, getAllProperties } from './catalog.mjs';
import { normalizeAddr } from './escrow.mjs';

dotenvConfig();

let log = console;
export function setAuthzLogger(l) { log = l; }

// ─── Role-Based Access Control ────────────────────────────────────────────────
export const HOST_ADDRESSES = (process.env.HOST_ADDRESSES || '').split(',').map(e => e.trim().toLowerCase());

// B1 fix: isHost() used to read session.dbHostApproved, a flag that was only
// ever set transiently inside /auth/me and never persisted via saveSession —
// so on every other REST route it was undefined, and a host approved via
// host_profiles (but not in the HOST_ADDRESSES superadmin env list) failed
// isHost() on all REST host routes while still passing ai_route.mjs's
// resolveIsHost() (which is DB-backed). isHost() is now DB-backed too, so
// both paths agree. Callers must now `await isHost(session)`.
export async function isHost(session) {
  if (!session?.email) return false;
  if (HOST_ADDRESSES.includes(session.email.toLowerCase())) return true;
  return checkDbHost(session.email);
}

// S4 fix: listing images[] was only length-checked (<2000 chars) before being
// stored and later rendered in <img src> — a host could store a data:/
// javascript:/arbitrary-scheme URL there. Restrict to https: URLs only.
export function isSafeImageUrl(u) {
  if (typeof u !== 'string' || u.length === 0 || u.length >= 2000) return false;
  try {
    return new URL(u).protocol === 'https:';
  } catch {
    return false;
  }
}

export async function checkDbHost(email) {
  try {
    const result = await pool.query(
      `SELECT id FROM host_profiles WHERE email = $1 AND status = 'approved'`,
      [email.toLowerCase()]
    );
    return result.rows.length > 0;
  } catch { return false; }
}

// Property-scoped authorization for actions that mutate a specific booking
// (release deposit, tax remit/unremit, etc). Superadmins (HOST_ADDRESSES) may
// act on any property; an approved host may only act on properties they own
// — either a host-imported row in the `properties` table, OR one of the 6
// fixed catalog demo properties whose hostAddress has been configured in
// catalog.mjs (PROPERTIES[id].hostAddress). Previously this only checked the
// `properties` table, so a real host configured for a fixed catalog
// property could never manage their own listing (Gap #2 of the catalog/db
// parity audit — the inverse of "imported listings missing functionality").
// Mirrors ai_route.mjs's release_deposit pattern (Finding #4 / Phase 1b) so
// the two booking-mutation paths can't diverge.
export async function canManageProperty(session, propertyId) {
  if (HOST_ADDRESSES.includes((session?.email || '').toLowerCase())) return true;
  if (!session?.suiAddress) return false;
  try {
    // getProperty() already resolves hostAddress for BOTH sources — the
    // fixed catalog's PROPERTIES[id].hostAddress and a host-imported row's
    // host_address column — so a single check covers both cases.
    const prop = await getProperty(propertyId, log);
    return !!(prop?.hostAddress && normalizeAddr(prop.hostAddress) === normalizeAddr(session.suiAddress));
  } catch { return false; }
}

// R6: bulk version of canManageProperty — the set of property ids this
// session actually owns, or `null` to mean "superadmin, no scoping needed."
// Used to scope host-facing READ routes (/bookings/all, /tax/summary,
// /reviews/all) so an approved host only ever sees data for properties they
// manage, not every guest on the platform. Previously these routes gated on
// isHost() alone — any approved host, including a second test/demo account,
// could read every other host's bookings, taxes, and reviews. Mirrors
// canManageProperty's per-property check but computes it once across the
// whole catalog instead of one id at a time.
export async function getOwnedPropertyIds(session) {
  if (HOST_ADDRESSES.includes((session?.email || '').toLowerCase())) return null;
  if (!session?.suiAddress) return new Set();
  try {
    const all = await getAllProperties(log);
    const mine = all.filter(
      (p) => p.hostAddress && normalizeAddr(p.hostAddress) === normalizeAddr(session.suiAddress)
    );
    return new Set(mine.map((p) => Number(p.id)));
  } catch { return new Set(); }
}

// P2 / Phase 1j: claim_damage asserts on-chain that the signer IS escrow.host
// — not just "manages the property" in the loose canManageProperty sense —
// so the booking's own host_sui_address (the address actually baked into its
// on-chain escrow object, recorded by createBooking) is the authoritative
// check. Superadmins (HOST_ADDRESSES) and canManageProperty are kept as
// fallbacks for forward-compatibility once the `properties` table is
// populated, but neither bypasses the on-chain assertion itself — if the
// caller isn't really escrow.host, the signed transaction simply fails
// on-chain with ENotHost when they try to submit it.
export async function canClaimAsHost(session, booking) {
  if (HOST_ADDRESSES.includes((session?.email || '').toLowerCase())) return true;
  if (booking.host_sui_address && session?.suiAddress === booking.host_sui_address) return true;
  return canManageProperty(session, booking.property_id);
}

// R1: single source of the session-lookup boilerplate that was copy-pasted into
// ~28 routes. Returns the session, or sends the 401 and returns null (caller
// does `if (!session) return;`).
//
// CSRF hardening (July 2026 security review): the aria_session cookie is
// sameSite:'none' in production (required since the Vercel frontend and
// Railway API are different origins), which means browsers attach it
// automatically to cross-site requests — including ones a malicious page
// forges via an auto-submitting form or a "simple" (non-preflighted) fetch.
// CORS alone doesn't stop this: it only blocks the attacker's JS from
// *reading* our response, not the browser from *sending* the request and
// triggering whatever side effect it causes.
//
// The fix: for any state-changing request (anything but GET/HEAD), require
// the explicit x-session-id header rather than trusting the ambient cookie.
// A cross-site page cannot attach a custom header without the browser first
// sending a CORS preflight, and our CORS config only allows FRONTEND_URL —
// so a forged request from any other origin is rejected before it reaches
// the handler. Every legitimate mutating call in this app already goes
// through authFetch() (lib/authFetch.js), which always sets this header, so
// this closes the hole with no change needed on the frontend.
export async function getAuthedSession(request, reply) {
  const isMutating = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  const headerSid = request.headers['x-session-id'];
  const cookieSid = request.cookies.aria_session;
  const sessionId = isMutating ? headerSid : (cookieSid || headerSid);
  if (!sessionId) {
    reply.code(401).send({ error: isMutating ? 'Missing session header — please refresh and try again.' : 'Not authenticated' });
    return null;
  }
  const session = await getSession(sessionId);
  if (!session) { reply.code(401).send({ error: 'Session expired' }); return null; }
  return session;
}

// R5: a booking's message thread is visible only to its participants — the guest
// who booked, a host who manages the property, or a superadmin. Without this,
// any logged-in user could read/post to an arbitrary thread by bookingRef.
export async function canAccessBookingThread(session, booking) {
  if (!booking) return false;
  if (booking.wallet_address === session?.suiAddress) return true;                 // guest
  if (HOST_ADDRESSES.includes((session?.email || '').toLowerCase())) return true;  // superadmin
  if (booking.host_sui_address && session?.suiAddress === booking.host_sui_address) return true; // demo host
  return canManageProperty(session, booking.property_id);                          // DB-mapped host
}
