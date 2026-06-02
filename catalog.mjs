// ─── ARIA shared catalog ──────────────────────────────────────────────────────
// Single source of truth for property prices and jurisdiction tax rates.
// Imported by server.mjs and ai_route.mjs so the server NEVER trusts a
// client-supplied price. (The Next.js frontend keeps its own display copy in
// pages/index.jsx — keep these in sync, or have the frontend fetch them.)

// Authoritative nightly prices. These match the values shown in the frontend,
// so legitimate booking totals are unchanged; only tampered prices are rejected.
export const PROPERTIES = {
  1: { title: 'Oceanfront Villa',    price: 285 },
  2: { title: 'Downtown Loft',       price: 145 },
  3: { title: 'Mountain Cabin',      price: 195 },
  4: { title: 'Desert Retreat',      price: 225 },
  5: { title: 'Lake House',          price: 320 },
  6: { title: 'Historic Brownstone', price: 175 },
};

export const JURISDICTION_TAX_RATES = {
  1: { rate: 0.13,   name: 'Miami-Dade County, FL',  breakdown: '6% FL sales tax + 7% Miami-Dade tourist tax' },
  2: { rate: 0.17,   name: 'City of Austin, TX',      breakdown: '6% TX state HOT + 11% City of Austin HOT' },
  3: { rate: 0.13,   name: 'Buncombe County, NC',     breakdown: '6.75% NC sales tax + 6% Buncombe County occupancy tax' },
  4: { rate: 0.0805, name: 'City of Scottsdale, AZ',  breakdown: 'AZ state + city Transaction Privilege Tax combined' },
  5: { rate: 0.10,   name: 'Placer County, CA',       breakdown: '10% Transient Occupancy Tax (Tahoe area)' },
  6: { rate: 0.1475, name: 'New York City, NY',        breakdown: '4% NY state + 4.5% local sales tax + 5.875% NYC hotel occupancy tax' },
};
