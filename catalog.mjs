// ─── ARIA shared catalog ──────────────────────────────────────────────────────
// Single source of truth for property prices and jurisdiction tax rates.
// Imported by server.mjs and ai_route.mjs so the server NEVER trusts a
// client-supplied price. This is the single place prices/tax rates are defined:
// the frontend fetches them at runtime via GET /properties, and the AI prompts
// are generated from this module (see ai_route.mjs catalogPromptSections). The
// pages/*.jsx files keep only cosmetic display fields (images/ratings/location)
// as PROPERTY_DISPLAY fallbacks — no authoritative pricing lives there. (R15)

// Authoritative nightly prices. These match the values shown in the frontend,
// so legitimate booking totals are unchanged; only tampered prices are rejected.
//
// hostAddress (P2 / Phase 1i): the Sui address that owns each of these 6 demo
// properties. This is the missing link the "Testnet placeholder" comment in
// bookings.mjs referred to — the `properties` DB table was scaffolded for a
// future "hosts add their own listings" feature but is still empty (see
// ARIA_ROADMAP.md tech debt backlog), so for these fixed demo properties the
// host mapping lives here instead of a DB join. Now wired to
// OFFICIAL_HOST_ADDRESS below (was null while no real host had been approved
// yet) — bookings.mjs's getPropertyHostAddress() prefers that host's
// host_profiles.payout_sui_address when one exists, falling back to
// OFFICIAL_HOST_ADDRESS itself otherwise; only an unset (null) hostAddress
// falls back further to the auto-release key placeholder.
// maxGuests mirrors each property's bed count × 2 (matches PROPERTY_DISPLAY's
// beds in pages/*.jsx) — the authoritative occupancy cap createBooking()
// enforces server-side, since the cosmetic beds/baths fields themselves only
// ever lived client-side for these 6 fixed demo properties.
// The 6 fixed demo properties all belong to the official operator account
// (cwilliams36092@gmail.com's zkLogin wallet) — set once here so
// canManageProperty/getPropertyHostAddress attribute them correctly instead
// of falling back to the auto-release key placeholder, and so a second
// (test) account approved as a host via /host/apply never appears to own
// them (see pages/host.jsx's refreshProperties ownership filter).
// Confirmed directly from each account's live wallet display on July 1, 2026
// (not re-derived from old screenshots/transactions — the zkLogin salt has
// changed since this app was first built, per ARIA_ROADMAP.md's "Deliberately
// Deferred" section, which re-derives every Google account's Sui address and
// silently orphans old ones). cwilliams36092@gmail.com (official) currently
// resolves to 0xbdb2e801... — NOT 0x528819eb..., which is the TEST account
// (ariasuidemo@gmail.com) as of the same check. If addresses look wrong again
// after any future salt change, re-verify from each account's live wallet
// display rather than trusting a prior value here or in git history.
const OFFICIAL_HOST_ADDRESS = '0xbdb2e801f9bccc29edc587c1651984c10a82c1a63c88fc406ca231bea6757fdf';

export const PROPERTIES = {
  1: { title: 'Oceanfront Villa',    price: 285, hostAddress: OFFICIAL_HOST_ADDRESS, maxGuests: 8 },
  2: { title: 'Downtown Loft',       price: 145, hostAddress: OFFICIAL_HOST_ADDRESS, maxGuests: 4 },
  3: { title: 'Mountain Cabin',      price: 195, hostAddress: OFFICIAL_HOST_ADDRESS, maxGuests: 6 },
  4: { title: 'Desert Retreat',      price: 225, hostAddress: OFFICIAL_HOST_ADDRESS, maxGuests: 6 },
  5: { title: 'Lake House',          price: 320, hostAddress: OFFICIAL_HOST_ADDRESS, maxGuests: 10 },
  6: { title: 'Historic Brownstone', price: 175, hostAddress: OFFICIAL_HOST_ADDRESS, maxGuests: 4 },
};

export const JURISDICTION_TAX_RATES = {
  1: { rate: 0.13,   name: 'Miami-Dade County, FL',  breakdown: '6% FL sales tax + 7% Miami-Dade tourist tax' },
  2: { rate: 0.17,   name: 'City of Austin, TX',      breakdown: '6% TX state HOT + 11% City of Austin HOT' },
  3: { rate: 0.13,   name: 'Buncombe County, NC',     breakdown: '6.75% NC sales tax + 6% Buncombe County occupancy tax' },
  4: { rate: 0.0805, name: 'City of Scottsdale, AZ',  breakdown: 'AZ state + city Transaction Privilege Tax combined' },
  5: { rate: 0.10,   name: 'Placer County, CA',       breakdown: '10% Transient Occupancy Tax (Tahoe area)' },
  6: { rate: 0.1475, name: 'New York City, NY',        breakdown: '4% NY state + 4.5% local sales tax + 5.875% NYC hotel occupancy tax' },
};

// ─── Phase 3a: dynamic, host-created listings ────────────────────────────────
// Everything above this point is the original fixed 6-property catalog and
// stays untouched — it's still the cheapest, zero-DB-round-trip path for the
// demo properties. getProperty()/getAllProperties() are the NEW single source
// of truth every money-critical call site should use going forward: they
// check the fixed catalog first (id 1-6) and fall back to the `properties`
// Postgres table for anything a host has actually created (via the
// Airbnb/VRBO import flow or manual entry — see server.mjs POST
// /host/properties). This is what finally makes the long-scaffolded
// `properties` table real (see its header comment in db.mjs).
//
// Dynamic rows carry their OWN tax fields (tax_rate/tax_jurisdiction/
// tax_breakdown) instead of a JURISDICTION_TAX_RATES lookup, because the host
// self-declares their jurisdiction at creation time — there's no fixed list
// of every jurisdiction a host might be in. The rate is clamped server-side
// to [0, 0.20] at write time, so even a self-declared value can't blow out a
// booking total.
import { pool } from './db.mjs';

function normalizeDbRow(row) {
  return {
    id: row.id,
    title: row.title,
    price: row.price,
    hostAddress: row.host_address,
    description: row.description || '',
    location: row.location || '',
    beds: row.beds ?? 1,
    baths: row.baths ?? 1,
    maxGuests: row.max_guests ?? 2,
    tag: row.tag || 'New Listing',
    images: Array.isArray(row.images) && row.images.length ? row.images : [],
    taxRate: row.tax_rate != null ? Number(row.tax_rate) : 0.08,
    taxName: row.tax_jurisdiction || 'Unknown',
    taxBreakdown: row.tax_breakdown || '8% occupancy tax (default)',
    sourceUrl: row.source_url || null,
    importSource: row.import_source || 'manual',
    active: row.active !== false,
    source: 'db',
  };
}

// Returns a normalized property shape regardless of whether it's one of the
// 6 fixed demo properties or a host-created row, or null if propertyId
// doesn't resolve to anything. Async because the dynamic path needs a DB
// round-trip; every call site (bookings.mjs, server.mjs, ai_route.mjs) is
// already inside an async function, so this composes cleanly.
export async function getProperty(propertyId, logger = console) {
  const id = Number(propertyId);
  const fixed = PROPERTIES[id];
  if (fixed) {
    const j = JURISDICTION_TAX_RATES[id] || { rate: 0.08, name: 'Unknown', breakdown: '8% occupancy tax (default)' };
    return {
      id, title: fixed.title, price: fixed.price, hostAddress: fixed.hostAddress,
      maxGuests: fixed.maxGuests ?? 2,
      taxRate: j.rate, taxName: j.name, taxBreakdown: j.breakdown,
      active: true, source: 'catalog',
    };
  }
  try {
    const r = await pool.query('SELECT * FROM properties WHERE id = $1 AND active = true', [id]);
    if (!r.rows.length) return null;
    return normalizeDbRow(r.rows[0]);
  } catch (err) {
    logger?.warn?.({ err, propertyId }, 'catalog.getProperty: DB lookup failed');
    return null;
  }
}

// All bookable properties — the 6 fixed demo ones plus every active
// host-created row. Used by GET /properties and the AI catalog prompt so
// guests/the AI assistant can see (and book) imported listings, not just the
// original demo set.
export async function getAllProperties(logger = console) {
  const fixed = Object.entries(PROPERTIES).map(([id, p]) => {
    const j = JURISDICTION_TAX_RATES[Number(id)] || { rate: 0.08, name: 'Unknown', breakdown: '8% occupancy tax (default)' };
    return { id: Number(id), title: p.title, price: p.price, hostAddress: p.hostAddress, maxGuests: p.maxGuests ?? 2, taxRate: j.rate, taxName: j.name, taxBreakdown: j.breakdown, active: true, source: 'catalog' };
  });
  try {
    const r = await pool.query('SELECT * FROM properties WHERE active = true ORDER BY id');
    return [...fixed, ...r.rows.map(normalizeDbRow)];
  } catch (err) {
    logger?.warn?.({ err }, 'catalog.getAllProperties: DB lookup failed, returning fixed catalog only');
    return fixed;
  }
}
