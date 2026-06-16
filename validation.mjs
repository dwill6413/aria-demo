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
  checkOut: z.string().min(1, 'checkOut is required')
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
  payoutSuiAddress: z.string().optional().nullable(),
  payoutNotes: z.string().optional().nullable(),
  termsAgreed: z.boolean(),
  complianceConfirmed: z.boolean()
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
