// PROPERTY_DISPLAY holds cosmetic/display-only fields (images, location,
// rating, beds/baths, tag) that have no backend equivalent. price/title/
// taxRate/taxName here are fallback defaults only — the authoritative values
// are fetched at runtime from GET /properties (backed by catalog.mjs) and
// merged in via mergeProperty() below, so there's a single source of truth
// for anything that affects money.
//
// Shared between pages/index.jsx (the homepage grid) and
// pages/listing/[id].jsx (the dedicated property page) so both stay in sync
// instead of keeping two copies of the same fixture data.
export const PROPERTY_DISPLAY = [
  {
    id: 1, title: 'Oceanfront Villa', location: 'Miami Beach, FL', price: 285, rating: 4.97, reviews: 124,
    image: 'https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1499793983690-e29da59ef1c2?w=800&q=80','https://images.unsplash.com/photo-1502005229762-cf1b2da7c5d6?w=800&q=80','https://images.unsplash.com/photo-1615571022219-eb45cf7faa9d?w=800&q=80','https://images.unsplash.com/photo-1571003123894-1f0594d2b5d9?w=800&q=80','https://images.unsplash.com/photo-1584132967334-10e028bd69f7?w=800&q=80'],
    beds: 4, baths: 3, maxGuests: 8, tag: 'Beachfront'
  },
  {
    id: 2, title: 'Downtown Loft', location: 'Austin, TX', price: 145, rating: 4.89, reviews: 87,
    image: 'https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?w=800&q=80','https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=800&q=80','https://images.unsplash.com/photo-1484154218962-a197022b5858?w=800&q=80','https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=800&q=80','https://images.unsplash.com/photo-1507089947368-19c1da9775ae?w=800&q=80'],
    beds: 2, baths: 1, maxGuests: 4, tag: 'City View'
  },
  {
    id: 3, title: 'Mountain Cabin', location: 'Asheville, NC', price: 195, rating: 4.95, reviews: 203,
    image: 'https://images.unsplash.com/photo-1542718610-a1d656d1884c?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1542718610-a1d656d1884c?w=800&q=80','https://images.unsplash.com/photo-1518780664697-55e3ad937233?w=800&q=80','https://images.unsplash.com/photo-1510798831971-661eb04b3739?w=800&q=80','https://images.unsplash.com/photo-1506974210756-8e1b8985d348?w=800&q=80','https://images.unsplash.com/photo-1449158743715-0a90ebb6d2d8?w=800&q=80'],
    beds: 3, baths: 2, maxGuests: 6, tag: 'Nature'
  },
  {
    id: 4, title: 'Desert Retreat', location: 'Scottsdale, AZ', price: 225, rating: 4.92, reviews: 156,
    image: 'https://images.unsplash.com/photo-1613977257363-707ba9348227?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1613977257363-707ba9348227?w=800&q=80','https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800&q=80','https://images.unsplash.com/photo-1571055107559-3e67626fa8be?w=800&q=80','https://images.unsplash.com/photo-1596394516093-501ba68a0ba6?w=800&q=80','https://images.unsplash.com/photo-1600607687920-4e2a09cf159d?w=800&q=80'],
    beds: 3, baths: 2, maxGuests: 6, tag: 'Pool'
  },
  {
    id: 5, title: 'Lake House', location: 'Lake Tahoe, CA', price: 320, rating: 4.98, reviews: 91,
    image: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=800&q=80','https://images.unsplash.com/photo-1601918774946-25832a4be0d6?w=800&q=80','https://images.unsplash.com/photo-1505916349660-8d91a99f56e0?w=800&q=80','https://images.unsplash.com/photo-1571492913491-50e0083303f4?w=800&q=80','https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=800&q=80'],
    beds: 5, baths: 4, maxGuests: 10, tag: 'Waterfront'
  },
  {
    id: 6, title: 'Historic Brownstone', location: 'Brooklyn, NY', price: 175, rating: 4.85, reviews: 312,
    image: 'https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=600&q=80',
    images: ['https://images.unsplash.com/photo-1570129477492-45c003edd2be?w=800&q=80','https://images.unsplash.com/photo-1555636222-cae831e670b3?w=800&q=80','https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=800&q=80','https://images.unsplash.com/photo-1600047509807-ba8f99d2cdde?w=800&q=80','https://images.unsplash.com/photo-1586023492125-27b2c045efd7?w=800&q=80'],
    beds: 2, baths: 2, maxGuests: 4, tag: 'Historic'
  },
];

// Fallback image for host-created listings that have no photos yet.
export const PLACEHOLDER_IMAGE = 'https://images.unsplash.com/photo-1560448204-603b3fc33ddc?w=600&q=80';

// Merges one row from GET /properties (the authoritative price/title/tax
// fields from catalog.mjs) with its cosmetic PROPERTY_DISPLAY fallback. Used
// identically by pages/index.jsx (mapping the whole list) and
// pages/listing/[id].jsx (picking out a single property) — keeping this in
// one place means the two pages can never silently drift apart on what a
// "merged" property object looks like.
//
// Matches fixed demo properties on source==='catalog' AND id, not just id —
// a host-created listing's DB-assigned SERIAL id can collide with one of the
// 6 fixed demo ids (the `properties` table also starts counting at 1), which
// would otherwise overlay the wrong demo property's display fields here.
export function mergeProperty(p, displayList = PROPERTY_DISPLAY) {
  const fixed = p.source === 'catalog' ? displayList.find(f => f.id === p.id) : null;
  if (fixed) {
    return { ...fixed, title: p.title, price: p.price, taxRate: p.taxRate, taxName: p.taxName, maxGuests: p.maxGuests ?? fixed.maxGuests, description: p.description || '' };
  }
  return {
    id: p.id, title: p.title, price: p.price, taxRate: p.taxRate, taxName: p.taxName, description: p.description || '',
    location: p.location || 'Location not set', rating: 0, reviews: 0,
    image: (p.images && p.images[0]) || PLACEHOLDER_IMAGE,
    images: (p.images && p.images.length ? p.images : [PLACEHOLDER_IMAGE]),
    beds: p.beds ?? 1, baths: p.baths ?? 1, maxGuests: p.maxGuests ?? 2, tag: p.tag || 'New Listing',
  };
}
