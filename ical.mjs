import ical from 'ical-generator';
import icalParser from 'ical.js';
import { pool } from './db.mjs';
import dns from 'node:dns/promises';
import net from 'node:net';

// ── SSRF guard for external iCal feeds (review finding #2) ──────────────────
// /ical/import lets a host store an arbitrary feed URL that the server later
// fetches (fetchExternalBookings, reachable via the public /availability route).
// Without these guards that's a server-side request forgery vector — point it
// at 169.254.169.254 (cloud metadata) or an internal service and the server
// fetches it. So: https only, and the hostname must NOT resolve to any
// private/loopback/link-local/unique-local address.
const ICAL_FETCH_TIMEOUT_MS = 5000;
const ICAL_MAX_BYTES = 2 * 1024 * 1024; // 2 MB cap

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127
      || (p[0] === 169 && p[1] === 254)            // link-local / cloud metadata
      || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) // private
      || (p[0] === 192 && p[1] === 168)             // private
      || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) // CGNAT
      || ip === '255.255.255.255';
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true; // link-local / unique-local
  if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7));                          // IPv4-mapped
  return false;
}

// Validates a feed URL is https and resolves only to public addresses. Throws
// on rejection; returns the normalized URL string on success. Exported so the
// /ical/import route can reject bad URLs at store time, and re-checked at fetch
// time (DNS can change between store and fetch).
export async function assertPublicHttpsUrl(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('Invalid iCal URL'); }
  if (u.protocol !== 'https:') throw new Error('Only https:// iCal URLs are allowed');
  let addrs;
  try { addrs = await dns.lookup(u.hostname, { all: true }); }
  catch { throw new Error('Could not resolve iCal host'); }
  if (!addrs.length) throw new Error('Could not resolve iCal host');
  for (const { address } of addrs) {
    if (isPrivateIp(address)) throw new Error('iCal host resolves to a non-public address');
  }
  return u.toString();
}

/**
 * Generate iCal export for a property — reads bookings from Postgres
 * Hosts paste this URL into Airbnb/VRBO to sync ARIA bookings
 */
export async function generateICal(propertyId, propertyTitle) {
  const calendar = ical({ name: `ARIA — ${propertyTitle}` });

  try {
    const result = await pool.query(
      `SELECT booking_ref, check_in, check_out, guest_name
       FROM bookings
       WHERE property_id = $1 AND payment_status != 'cancelled'
       ORDER BY check_in ASC`,
      [propertyId]
    );

    for (const booking of result.rows) {
      calendar.createEvent({
        start: new Date(booking.check_in),
        end:   new Date(booking.check_out),
        summary:     `ARIA Booking — ${booking.booking_ref}`,
        description: `Booked via ARIA. Ref: ${booking.booking_ref}`,
        id:          booking.booking_ref
      });
    }
  } catch (err) {
    console.warn('generateICal DB error:', err.message);
  }

  return calendar.toString();
}

/**
 * Save external iCal URL for a property (Airbnb/VRBO feed) — stored in Postgres
 */
export async function saveExternalCalendar(propertyId, platform, icalUrl) {
  await pool.query(
    `INSERT INTO property_ical_feeds (property_id, platform, ical_url, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (property_id, platform)
     DO UPDATE SET ical_url = $3, updated_at = NOW()`,
    [propertyId, platform, icalUrl]
  );

  const result = await pool.query(
    'SELECT platform, ical_url FROM property_ical_feeds WHERE property_id = $1',
    [propertyId]
  );

  return Object.fromEntries(result.rows.map(r => [r.platform, r.ical_url]));
}

/**
 * Get saved external calendars for a property
 */
export async function getExternalCalendars(propertyId) {
  const result = await pool.query(
    'SELECT platform, ical_url FROM property_ical_feeds WHERE property_id = $1',
    [propertyId]
  );
  return Object.fromEntries(result.rows.map(r => [r.platform, r.ical_url]));
}

/**
 * Fetch and parse external iCal feed (Airbnb/VRBO)
 */
async function fetchExternalBookings(icalUrl) {
  try {
    // Re-validate at fetch time (DNS rebinding / store-time TOCTOU).
    await assertPublicHttpsUrl(icalUrl);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ICAL_FETCH_TIMEOUT_MS);
    let res, text;
    try {
      // redirect:'error' so a public URL can't 30x-redirect to an internal one.
      res = await fetch(icalUrl, { signal: ctrl.signal, redirect: 'error', headers: { Accept: 'text/calendar' } });
      const len = Number(res.headers.get('content-length') || 0);
      if (len && len > ICAL_MAX_BYTES) throw new Error('iCal feed too large');
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
    if (text.length > ICAL_MAX_BYTES) throw new Error('iCal feed too large');
    const parsed = icalParser.parse(text);
    const comp   = new icalParser.Component(parsed);
    const events = comp.getAllSubcomponents('vevent');

    return events.map(event => ({
      start:   new Date(event.getFirstPropertyValue('dtstart')),
      end:     new Date(event.getFirstPropertyValue('dtend')),
      summary: event.getFirstPropertyValue('summary') || 'Blocked'
    }));
  } catch (err) {
    console.warn(`Failed to fetch iCal from ${icalUrl}:`, err.message);
    return [];
  }
}

/**
 * Check if dates are available across all external calendars
 * Returns { available: boolean, conflicts: [] }
 */
export async function checkAvailability(propertyId, checkIn, checkOut) {
  let externalCalendars = {};
  try {
    externalCalendars = await getExternalCalendars(propertyId);
  } catch {
    return { available: true, conflicts: [] };
  }

  if (Object.keys(externalCalendars).length === 0) {
    return { available: true, conflicts: [] };
  }

  const requestedCheckIn  = new Date(checkIn);
  const requestedCheckOut = new Date(checkOut);
  const conflicts = [];

  for (const [platform, url] of Object.entries(externalCalendars)) {
    const bookings = await fetchExternalBookings(url);
    for (const booking of bookings) {
      if (requestedCheckIn < booking.end && requestedCheckOut > booking.start) {
        conflicts.push({
          platform,
          conflictStart: booking.start,
          conflictEnd:   booking.end,
          summary:       booking.summary
        });
      }
    }
  }

  return { available: conflicts.length === 0, conflicts };
}
