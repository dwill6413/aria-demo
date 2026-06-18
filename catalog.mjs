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
// host mapping lives here instead of a DB join. null means "no real host
// configured yet for this demo property" — bookings.mjs's
// getPropertyHostAddress() falls back to the auto-release key's address in
// that case, same placeholder behavior as before this field existed. Once a
// real host applies via /host/apply and is approved, set their sui_address
// here so createBooking looks up their host_profiles.payout_sui_address.
export const PROPERTIES = {
  1: { title: 'Oceanfront Villa',    price: 285, hostAddress: null },
  2: { title: 'Downtown Loft',       price: 145, hostAddress: null },
  3: { title: 'Mountain Cabin',      price: 195, hostAddress: null },
  4: { title: 'Desert Retreat',      price: 225, hostAddress: null },
  5: { title: 'Lake House',          price: 320, hostAddress: null },
  6: { title: 'Historic Brownstone', price: 175, hostAddress: null },
};

export const JURISDICTION_TAX_RATES = {
  1: { rate: 0.13,   name: 'Miami-Dade County, FL',  breakdown: '6% FL sales tax + 7% Miami-Dade tourist tax' },
  2: { rate: 0.17,   name: 'City of Austin, TX',      breakdown: '6% TX state HOT + 11% City of Austin HOT' },
  3: { rate: 0.13,   name: 'Buncombe County, NC',     breakdown: '6.75% NC sales tax + 6% Buncombe County occupancy tax' },
  4: { rate: 0.0805, name: 'City of Scottsdale, AZ',  breakdown: 'AZ state + city Transaction Privilege Tax combined' },
  5: { rate: 0.10,   name: 'Placer County, CA',       breakdown: '10% Transient Occupancy Tax (Tahoe area)' },
  6: { rate: 0.1475, name: 'New York City, NY',        breakdown: '4% NY state + 4.5% local sales tax + 5.875% NYC hotel occupancy tax' },
};
