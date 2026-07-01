// Extracted verbatim from server.mjs (R1 route-module split, July 1 2026).
import { getAllProperties } from '../catalog.mjs';

export default async function coreRoutes(fastify) {
// Health
fastify.get('/health', async () => {
  return { status: 'ok', app: 'ARIA Demo', network: process.env.SUI_NETWORK };
});

// Properties — authoritative price/tax data from catalog.mjs (Phase 2a fix).
// Public/read-only: this is the same price/tax info already hardcoded into
// the frontend bundles today, so exposing it isn't a new disclosure. The
// frontend pages (index.jsx, host.jsx) fetch this at load and merge it into
// their local display-only arrays (images, ratings, location, beds/baths,
// tags) so price/title/tax-rate have one source of truth instead of three.
// Phase 3a: now backed by catalog.mjs's getAllProperties(), which merges the
// 6 fixed demo properties with any active host-created rows from the
// `properties` table (imported via Airbnb/VRBO or entered manually — see
// POST /host/properties below). Dynamic rows additionally carry the cosmetic
// fields (location/beds/baths/images/tag) that the fixed 6 keep client-side
// in PROPERTY_DISPLAY, since there's no local fallback for an id the frontend
// doesn't already know about — pages/index.jsx and host.jsx read these to
// render a card for a property they've never seen before.
fastify.get('/properties', async () => {
  const all = await getAllProperties();
  const properties = all.map(p => ({
    id: p.id,
    title: p.title,
    price: p.price,
    taxRate: p.taxRate,
    taxName: p.taxName,
    // source lets the frontend tell a fixed demo property (catalog.mjs, ids
    // 1-6) apart from a host-created DB row, even when their ids collide —
    // the `properties` table's SERIAL starts at 1 too, so the first listing
    // a host ever creates gets id=1, same as the Oceanfront Villa demo
    // property. Without this flag the frontend's PROPERTY_DISPLAY merge
    // (host.jsx/index.jsx) matches by id alone and overlays the wrong
    // catalog's location/beds/baths/tag/image onto the new listing's
    // title/price. See ARIA_ROADMAP.md tech debt backlog.
    source: p.source,
    // maxGuests is now set for both the fixed catalog (catalog.mjs PROPERTIES)
    // and host-created DB rows, so it's surfaced unconditionally — the guest
    // count stepper in the booking modal needs the cap for every property,
    // not just imported listings.
    maxGuests: p.maxGuests,
    // hostAddress: surfaced so pages/host.jsx can filter "my listings" down
    // to properties the logged-in host actually owns, instead of showing
    // every property on the platform to every approved host. Sui addresses
    // are pseudonymous by design (already shown in booking receipts and the
    // wallet send UI), so exposing this on the public catalog isn't a new
    // disclosure.
    hostAddress: p.hostAddress,
    ...(p.source === 'db' ? {
      location: p.location, beds: p.beds, baths: p.baths,
      tag: p.tag, images: p.images, description: p.description,
    } : {}),
  }));
  return { properties };
});
}
