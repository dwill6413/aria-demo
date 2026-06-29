// ─── Request validation schemas (Phase 5 / Finding #8) ────────────────────────
// zod sat in package.json unused since Phase 0 (decision deferred). Adopted
// here per the user's explicit choice: validate the shape of the three
// request bodies the remediation plan called out. This is defense-in-depth,
// not a replacement for the business-logic checks already in bookings.mjs /
// server.mjs (e.g. propertyId range, date ordering, nights 1-90) — those
// stay exactly as they are. Zod's job is just to reject obviously-malformed
// bodies (wrong types, missing fields) with a clean 400 before they reach
// that logic, hardening the same endpoints Phase 1 made server-authoritative
// on price/auth.

import { z } from 'zod';

// propertyId arrives as either a number or a numeric string depending on
// caller (REST JSON body vs. AI tool-call args) — accept both, business
// logic does Number(propertyId) itself.
const propertyIdField = z.union([z.string(), z.number()]);

export const bookingCreateSchema = z.object({
  propertyId: propertyIdField,
  checkIn: z.string().min(1, 'checkIn is required'),
  checkOut: z.string().min(1, 'checkOut is required'),
  // Optional — createBooking() defaults to 1 and independently clamps/rejects
  // against the property's maxGuests, so this schema only rejects malformed shapes.
  guests: z.union([z.string(), z.number()]).optional()
});

export const paymentCreateIntentSchema = z.object({
  propertyId: propertyIdField,
  nights: z.union([z.string(), z.number()])
});

export const hostApplySchema = z.object({
  name: z.string().min(1, 'name is required'),
  email: z.string().email('email must be a valid email address'),
  phone: z.string().optional().nullable(),
  propertyAddress: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  zip: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  jurisdiction: z.string().optional().nullable(),
  strPermit: z.string().optional().nullable(),
  // Enforce the Sui address format server-side (0x + 64 hex) when provided —
  // previously accepted any string. Still optional/nullable so applicants who
  // haven't set a payout wallet yet aren't blocked.
  payoutSuiAddress: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'payoutSuiAddress must be a 0x-prefixed 64-character hex Sui address').optional().nullable(),
  payoutNotes: z.string().optional().nullable(),
  termsAgreed: z.boolean(),
  complianceConfirmed: z.boolean()
});

// P2 / Phase 1j: claim/dispute/resolution request bodies. bookingRef format
// (ARIA-<property>-...) is still checked in the route itself, matching the
// existing pattern for /booking/cancel and /booking/release-deposit.
export const claimDamageSchema = z.object({
  bookingRef: z.string().min(1, 'bookingRef is required'),
  claimAmount: z.union([z.string(), z.number()]),
  reason: z.string().min(1, 'reason is required')
});

export const claimDamageConfirmSchema = z.object({
  bookingRef: z.string().min(1, 'bookingRef is required'),
  digest: z.string().min(1, 'digest is required'),
  // reason is an optional human note shown to the guest. The claim AMOUNT is NOT
  // accepted here — it is decoded from the on-chain claim_damage tx (P1-2).
  reason: z.string().max(1000).optional().nullable()
});

export const disputeClaimSchema = z.object({
  bookingRef: z.string().min(1, 'bookingRef is required'),
  reason: z.string().min(1, 'reason is required')
});

export const disputeClaimConfirmSchema = z.object({
  bookingRef: z.string().min(1, 'bookingRef is required'),
  digest: z.string().min(1, 'digest is required')
});

export const resolveDisputeSchema = z.object({
  bookingRef: z.string().min(1, 'bookingRef is required'),
  guestAmount: z.union([z.string(), z.number()]),
  hostAmount: z.union([z.string(), z.number()])
});

// Phase 1h.5: the guest reports the combined booking PTB digest (one tx that
// created both the payment and deposit escrows) to the confirm route. No amounts
// are accepted here — every leg/destination is decoded from the on-chain tx and
// checked against server-authoritative values (verifyBookingPaymentTransaction).
export const bookingPaymentConfirmSchema = z.object({
  bookingRef: z.string().min(1, 'bookingRef is required'),
  digest: z.string().min(1, 'digest is required')
});

// Phase 2: the guest reports the Walrus blob id of their Seal-encrypted PII
// after encrypting + storing it client-side. No PII is accepted by the backend
// — only the pointer. phoneVerified is an optional demo flag.
export const guestProfileSchema = z.object({
  walrusBlobId: z.string().min(1, 'walrusBlobId is required'),
  phoneVerified: z.boolean().optional()
});

// ── Phase 2c: resale market request bodies ───────────────────────────────────
// Dollar amounts arrive as number|string (same convention as claim/dispute);
// the route converts to on-chain units and re-validates face/cap against the
// booking before building. The on-chain contract enforces all guardrails
// authoritatively — these schemas only reject malformed bodies early.
export const resaleListSchema = z.object({
  askPrice: z.union([z.string(), z.number()])
});

// bookingRef for these routes is a URL path param (/pass/:bookingRef/…), NOT a
// body field — the route reads request.params.bookingRef. So the body schema
// validates only the digest. (Extra body keys like askPrice are ignored by zod's
// default strip behavior and still readable from request.body in the route.)
export const resaleTransferConfirmSchema = z.object({
  digest: z.string().min(1, 'digest is required')
});

// Host sets per-listing transfer opt-in (Rail 1) + premium cap in bps (Rail 2).
// maxPremiumBps 0 = face-value-only resale. Cap at 100% (10000 bps) so a typo
// can't open an unbounded markup.
export const resaleSettingsSchema = z.object({
  transferAllowed: z.boolean(),
  maxPremiumBps: z.union([z.string(), z.number()]).optional()
});

// ── Phase 3a: host-created listings ───────────────────────────────────────────
// The host always reviews/edits AI-extracted fields before this schema is hit
// (extraction itself never writes to the DB — see listing_import.mjs). This is
// the actual write path's gate: numbers arrive as string|number like the
// resale schemas above, and the route still clamps price >= 0 and taxRate to
// [0, 0.20] independently (defense in depth — a passed schema doesn't mean the
// value is sane, just that it's the right shape).
export const propertyCreateSchema = z.object({
  title: z.string().min(1, 'title is required').max(200),
  description: z.string().max(4000).optional().nullable(),
  location: z.string().min(1, 'location is required').max(200),
  price: z.union([z.string(), z.number()]),
  beds: z.union([z.string(), z.number()]).optional(),
  baths: z.union([z.string(), z.number()]).optional(),
  maxGuests: z.union([z.string(), z.number()]).optional(),
  tag: z.string().max(50).optional().nullable(),
  images: z.array(z.string()).max(20).optional(),
  taxRate: z.union([z.string(), z.number()]).optional(),
  taxJurisdiction: z.string().max(200).optional().nullable(),
  taxBreakdown: z.string().max(500).optional().nullable(),
  sourceUrl: z.string().max(500).optional().nullable(),
  importSource: z.enum(['manual', 'ai-paste']).optional()
});

// Single-listing extraction: host pastes the URL (reference only, never
// fetched server-side) plus the listing text/description they copied
// themselves. text is the only required field — a host can paste just the
// description with no URL for a listing that was never on Airbnb/VRBO.
export const listingExtractSchema = z.object({
  text: z.string().min(1, 'text is required').max(12000),
  url: z.string().max(500).optional().nullable()
});

// Bulk variant for hosts with dozens/hundreds of properties: an array of the
// same {text, url} shape, capped so one request can't trigger hundreds of LLM
// calls server-side.
export const listingBulkExtractSchema = z.object({
  listings: z.array(z.object({
    text: z.string().min(1).max(12000),
    url: z.string().max(500).optional().nullable()
  })).min(1, 'At least one listing is required').max(50, 'Bulk import is limited to 50 listings per request')
});

// Listing photo upload: base64 data URL in the JSON body rather than a
// multipart form — the codebase has no multipart plugin registered anywhere
// else (client-side encryption blobs like guest PII already go through Walrus
// the same JSON-body way, see guestProfileSchema's sibling routes), so this
// stays consistent with that pattern instead of adding a new dependency.
// ~8M base64 chars caps the decoded image around ~6MB, generous for a listing
// photo while keeping one upload from ballooning a request.
export const listingPhotoSchema = z.object({
  dataUrl: z.string().min(1, 'dataUrl is required').max(8_000_000, 'Image is too large')
});

// Runs a zod schema against request.body and sends a 400 with a readable
// message if it fails. Returns true if validation failed (caller should
// `return` immediately after calling this), false if the body is valid.
export function validateBody(schema, request, reply) {
  const result = schema.safeParse(request.body);
  if (!result.success) {
    const message = result.error.issues.map(i => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    reply.code(400).send({ error: `Invalid request: ${message}` });
    return true;
  }
  return false;
}
