// Extracted verbatim from server.mjs (R1 route-module split, July 1 2026).
import { pool } from '../db.mjs';
import { getProperty, getAllProperties } from '../catalog.mjs';
import { extractListingFields } from '../listing_import.mjs';
import { normalizeAddr } from '../escrow.mjs';
import { getResaleSettings } from '../bookings.mjs';
import { pushImageToWalrus } from '../walrus.mjs';
import { escapeHtml } from '../emails.mjs';
import { hostApplySchema, validateBody, resaleSettingsSchema, propertyCreateSchema, listingExtractSchema, listingBulkExtractSchema, listingPhotoSchema } from '../validation.mjs';
import { HOST_ADDRESSES, isHost, checkDbHost, canManageProperty, getAuthedSession, isSafeImageUrl } from '../authz.mjs';
import { resend } from '../services.mjs';
import { BPS_DENOM } from './resale.mjs';

export default async function hostRoutes(fastify) {
// ── Host resale settings (Rail 1 opt-in + Rail 2 cap) ───────────────────────
// GET returns the host's per-listing settings; POST upserts them. Stored in
// property_resale_settings keyed by catalog property_id (the demo listings have
// no `properties` row). Read at booking time by getResaleSettings.
fastify.get('/host/resale-settings', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  try {
    const r = await pool.query('SELECT property_id, transfer_allowed, max_resale_premium_bps FROM property_resale_settings');
    const settings = {};
    for (const row of r.rows) settings[row.property_id] = { transferAllowed: row.transfer_allowed === true, maxPremiumBps: Number(row.max_resale_premium_bps) || 0 };
    return { settings, resaleEnabled: process.env.RESALE_ENABLED === 'true' };
  } catch (err) {
    fastify.log.error({ err }, '/host/resale-settings query failed');
    return reply.code(500).send({ error: 'Could not load resale settings' });
  }
});

fastify.post('/host/property/:propertyId/resale-settings', {
  config: { rateLimit: { max: 30, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many settings updates.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  if (validateBody(resaleSettingsSchema, request, reply)) return;

  const propertyId = Number(request.params.propertyId);
  if (!Number.isInteger(propertyId) || !(await getProperty(propertyId)))
    return reply.code(400).send({ error: 'Unknown propertyId' });
  // Property-scoped: a non-superadmin host may only set their own listings.
  if (!(await canManageProperty(session, propertyId)) && !HOST_ADDRESSES.includes((session.email || '').toLowerCase()))
    return reply.code(403).send({ error: 'You do not manage this property' });

  const transferAllowed = request.body.transferAllowed === true;
  let maxPremiumBps = Math.round(Number(request.body.maxPremiumBps ?? 0));
  if (!Number.isFinite(maxPremiumBps) || maxPremiumBps < 0) maxPremiumBps = 0;
  if (maxPremiumBps > BPS_DENOM) maxPremiumBps = BPS_DENOM; // cap at 100%

  try {
    await pool.query(
      `INSERT INTO property_resale_settings (property_id, host_address, transfer_allowed, max_resale_premium_bps, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (property_id) DO UPDATE
         SET host_address=EXCLUDED.host_address, transfer_allowed=EXCLUDED.transfer_allowed,
             max_resale_premium_bps=EXCLUDED.max_resale_premium_bps, updated_at=NOW()`,
      [propertyId, session.suiAddress, transferAllowed, maxPremiumBps]
    );
  } catch (err) {
    fastify.log.error({ err, propertyId }, '/host/property/resale-settings upsert failed');
    return reply.code(500).send({ error: 'Could not save resale settings' });
  }
  return { success: true, propertyId, transferAllowed, maxPremiumBps };
});

// Walrus push helper now lives in walrus.mjs (R3) and is imported above.

// ── Phase 3a: host-created listings ───────────────────────────────────────────
// Three routes, in the order a host actually uses them:
//   1. POST /host/listings/extract       — paste one listing's text -> AI draft (no DB write)
//   2. POST /host/listings/bulk-extract  — paste many at once -> array of drafts (no DB write)
//   3. POST /host/properties             — host reviews/edits a draft (or types one from
//                                           scratch) and this is what actually persists it.
// Extraction never touches the DB; only #3 does, and #3 doesn't care whether
// its input came from extraction or a blank form — same validation either way.
// This keeps "AI-paste" a thin convenience layer over manual entry rather than
// a separate trust path.

fastify.post('/host/listings/extract', {
  config: { rateLimit: { max: 30, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many import attempts. Try again later.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  if (validateBody(listingExtractSchema, request, reply)) return;

  const { text, url } = request.body;
  const draft = await extractListingFields(text, url, fastify.log);
  if (draft.error) return reply.code(422).send({ error: draft.error });
  return { draft };
});

fastify.post('/host/listings/bulk-extract', {
  config: { rateLimit: { max: 5, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many bulk import attempts. Try again later.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  if (validateBody(listingBulkExtractSchema, request, reply)) return;

  const { listings } = request.body;
  // Sequential, not Promise.all — a host's "dozens or hundreds" of pasted
  // listings should not fan out into dozens of simultaneous Grok calls from
  // one request; this trades a bit of latency for not hammering the xAI rate
  // limit (and for clearer per-item error attribution if one block is junk).
  const results = [];
  for (const { text, url } of listings) {
    const draft = await extractListingFields(text, url, fastify.log);
    results.push(draft.error ? { error: draft.error } : { draft });
  }
  return { results, succeeded: results.filter(r => !r.error).length, failed: results.filter(r => r.error).length };
});

fastify.post('/host/listings/photo', {
  config: { rateLimit: { max: 100, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many photo uploads. Try again later.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  if (validateBody(listingPhotoSchema, request, reply)) return;

  const match = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(request.body.dataUrl);
  if (!match) return reply.code(400).send({ error: 'dataUrl must be a base64-encoded PNG, JPEG, WEBP, or GIF image' });

  let buffer;
  try { buffer = Buffer.from(match[2], 'base64'); }
  catch { return reply.code(400).send({ error: 'Could not decode image data' }); }
  if (buffer.length > 6 * 1024 * 1024) return reply.code(400).send({ error: 'Image is too large (max 6MB)' });

  const url = await pushImageToWalrus(buffer, fastify.log);
  if (!url) return reply.code(502).send({ error: 'Could not upload image — try again' });
  return { url };
});

fastify.post('/host/properties', {
  config: { rateLimit: { max: 50, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many listings created. Try again later.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  if (validateBody(propertyCreateSchema, request, reply)) return;

  const {
    title, description, location, price, beds, baths, maxGuests, tag, images,
    taxRate, taxJurisdiction, taxBreakdown, sourceUrl, importSource
  } = request.body;

  // Never trust a host-declared number as-is, even though this is a draft the
  // host themselves typed/edited — same principle as catalog.mjs's fixed
  // prices: server clamps, server is authoritative, always. taxRate is capped
  // to [0, 0.20] per db.mjs's Phase 3a comment so a typo (or a bad-faith host)
  // can't inflate every future booking's tax line for this listing.
  const cleanPrice = Math.max(0, Math.round(Number(price) || 0));
  const cleanBeds = Math.min(50, Math.max(1, Math.round(Number(beds) || 1)));
  const cleanBaths = Math.min(50, Math.max(1, Math.round(Number(baths) || 1)));
  const cleanMaxGuests = Math.min(100, Math.max(1, Math.round(Number(maxGuests) || cleanBeds * 2)));
  let cleanTaxRate = Number(taxRate);
  if (!Number.isFinite(cleanTaxRate)) cleanTaxRate = 0.08;
  cleanTaxRate = Math.min(0.20, Math.max(0, cleanTaxRate));
  const cleanImages = Array.isArray(images) ? images.slice(0, 20).filter(isSafeImageUrl) : [];

  if (cleanPrice <= 0) return reply.code(400).send({ error: 'price must be greater than 0' });

  try {
    const r = await pool.query(
      `INSERT INTO properties
         (host_address, title, description, location, price, beds, baths, tag, images,
          tax_rate, tax_jurisdiction, tax_breakdown, max_guests, source_url, import_source, host_email, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true)
       RETURNING *`,
      [
        session.suiAddress, title.trim(), (description || '').trim(), location.trim(), cleanPrice,
        cleanBeds, cleanBaths, (tag || 'New Listing').trim(), cleanImages,
        cleanTaxRate, (taxJurisdiction || 'Unknown').trim(), (taxBreakdown || `${(cleanTaxRate * 100).toFixed(2)}% occupancy tax (host-declared)`).trim(),
        cleanMaxGuests, (sourceUrl || null), (importSource || 'manual'), (session.email || null)
      ]
    );
    const row = r.rows[0];
    fastify.log.info({ propertyId: row.id, host: session.suiAddress, importSource: row.import_source }, 'New host listing created');
    return reply.code(201).send({
      success: true,
      property: {
        id: row.id, title: row.title, description: row.description, location: row.location,
        price: row.price, beds: row.beds, baths: row.baths, maxGuests: row.max_guests,
        tag: row.tag, images: row.images || [], taxRate: Number(row.tax_rate), taxName: row.tax_jurisdiction,
        sourceUrl: row.source_url, importSource: row.import_source
      }
    });
  } catch (err) {
    fastify.log.error({ err }, '/host/properties insert failed');
    return reply.code(500).send({ error: 'Could not create listing' });
  }
});

// PATCH /host/properties/:id — edit a host-created listing. Same schema and
// clamping as create (propertyCreateSchema), since a bad-faith edit is just
// as dangerous as a bad-faith create. Scoped to rows in the `properties`
// table only — there is no DB row to edit for the 6 fixed catalog
// properties (catalog.mjs, ids 1-6, code-only), so an id that doesn't match
// an active row owned by this host 404s rather than silently no-opping.
fastify.patch('/host/properties/:id', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  if (validateBody(propertyCreateSchema, request, reply)) return;

  const propertyId = Number(request.params.id);
  if (!Number.isInteger(propertyId)) return reply.code(400).send({ error: 'Invalid property id' });

  const {
    title, description, location, price, beds, baths, maxGuests, tag, images,
    taxRate, taxJurisdiction, taxBreakdown, sourceUrl
  } = request.body;

  const cleanPrice = Math.max(0, Math.round(Number(price) || 0));
  const cleanBeds = Math.min(50, Math.max(1, Math.round(Number(beds) || 1)));
  const cleanBaths = Math.min(50, Math.max(1, Math.round(Number(baths) || 1)));
  const cleanMaxGuests = Math.min(100, Math.max(1, Math.round(Number(maxGuests) || cleanBeds * 2)));
  let cleanTaxRate = Number(taxRate);
  if (!Number.isFinite(cleanTaxRate)) cleanTaxRate = 0.08;
  cleanTaxRate = Math.min(0.20, Math.max(0, cleanTaxRate));
  const cleanImages = Array.isArray(images) ? images.slice(0, 20).filter(isSafeImageUrl) : [];

  if (cleanPrice <= 0) return reply.code(400).send({ error: 'price must be greater than 0' });

  try {
    const existing = await pool.query('SELECT host_address FROM properties WHERE id = $1 AND active = true', [propertyId]);
    if (!existing.rows.length) return reply.code(404).send({ error: 'Listing not found' });
    if (normalizeAddr(existing.rows[0].host_address) !== normalizeAddr(session.suiAddress)) {
      return reply.code(403).send({ error: 'You do not own this listing' });
    }

    const r = await pool.query(
      `UPDATE properties SET
         title = $1, description = $2, location = $3, price = $4, beds = $5, baths = $6,
         tag = $7, images = $8, tax_rate = $9, tax_jurisdiction = $10, tax_breakdown = $11,
         max_guests = $12, source_url = $13
       WHERE id = $14
       RETURNING *`,
      [
        title.trim(), (description || '').trim(), location.trim(), cleanPrice,
        cleanBeds, cleanBaths, (tag || 'New Listing').trim(), cleanImages,
        cleanTaxRate, (taxJurisdiction || 'Unknown').trim(), (taxBreakdown || `${(cleanTaxRate * 100).toFixed(2)}% occupancy tax (host-declared)`).trim(),
        cleanMaxGuests, (sourceUrl || null), propertyId
      ]
    );
    const row = r.rows[0];
    fastify.log.info({ propertyId: row.id, host: session.suiAddress }, 'Host listing edited');
    return reply.send({
      success: true,
      property: {
        id: row.id, title: row.title, description: row.description, location: row.location,
        price: row.price, beds: row.beds, baths: row.baths, maxGuests: row.max_guests,
        tag: row.tag, images: row.images || [], taxRate: Number(row.tax_rate), taxName: row.tax_jurisdiction,
        sourceUrl: row.source_url, importSource: row.import_source
      }
    });
  } catch (err) {
    fastify.log.error({ err }, '/host/properties/:id update failed');
    return reply.code(500).send({ error: 'Could not update listing' });
  }
});

// PATCH /host/properties/:id/deactivate — soft-delete. Sets active=false
// rather than actually deleting the row, since getProperty()/getAllProperties
// (catalog.mjs) already filter on active=true everywhere — this is the same
// mechanism that's been there since Phase 3a, just newly exposed to hosts.
// Reversible in principle (no UI for that yet) and safe even if the listing
// has existing bookings, since bookings store a denormalized property_title
// at booking time and don't depend on the property row continuing to exist.
fastify.patch('/host/properties/:id/deactivate', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });

  const propertyId = Number(request.params.id);
  if (!Number.isInteger(propertyId)) return reply.code(400).send({ error: 'Invalid property id' });

  try {
    const existing = await pool.query('SELECT host_address FROM properties WHERE id = $1 AND active = true', [propertyId]);
    if (!existing.rows.length) return reply.code(404).send({ error: 'Listing not found' });
    if (normalizeAddr(existing.rows[0].host_address) !== normalizeAddr(session.suiAddress)) {
      return reply.code(403).send({ error: 'You do not own this listing' });
    }
    await pool.query('UPDATE properties SET active = false WHERE id = $1', [propertyId]);
    fastify.log.info({ propertyId, host: session.suiAddress }, 'Host listing deactivated');
    return reply.send({ success: true });
  } catch (err) {
    fastify.log.error({ err }, '/host/properties/:id/deactivate failed');
    return reply.code(500).send({ error: 'Could not deactivate listing' });
  }
});

// ─── Host Onboarding Routes ───────────────────────────────────────────────────

fastify.get('/host/profile', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  try {
    const result = await pool.query('SELECT * FROM host_profiles WHERE sui_address = $1', [session.suiAddress]);
    if (result.rows.length === 0) return { profile: null };
    const p = result.rows[0];
    return { profile: {
      name: p.name, email: p.email, phone: p.phone,
      propertyAddress: p.property_address, city: p.city, state: p.state,
      zip: p.zip, country: p.country, jurisdiction: p.jurisdiction,
      strPermit: p.str_permit, payoutSuiAddress: p.payout_sui_address,
      payoutNotes: p.payout_notes, status: p.status,
      termsAgreed: p.terms_agreed, complianceConfirmed: p.compliance_confirmed,
      createdAt: p.created_at, updatedAt: p.updated_at
    }};
  } catch (err) { return reply.code(500).send({ error: 'Failed to fetch host profile' }); }
});

fastify.post('/host/apply', {
  config: { rateLimit: { max: 3, timeWindow: '1 hour', errorResponseBuilder: () => ({ error: 'Too many applications. Please wait and try again.' }) } }
}, async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (validateBody(hostApplySchema, request, reply)) return;

  const { name, email, phone, propertyAddress, city, state, zip, country,
          jurisdiction, strPermit, payoutNotes, termsAgreed, complianceConfirmed } = request.body;
  // payout_sui_address is always session.suiAddress — never accepted from the
  // client — so a host can never end up with a payout destination that isn't
  // their own signing wallet (see validation.mjs comment for why).

  if (!termsAgreed || !complianceConfirmed)
    return reply.code(400).send({ error: 'Terms agreement and compliance confirmation are required' });

  try {
    const existing = await pool.query('SELECT id, status FROM host_profiles WHERE sui_address = $1', [session.suiAddress]);
    if (existing.rows.length > 0) {
      const status = existing.rows[0].status;
      if (status === 'approved') return reply.code(400).send({ error: 'You are already an approved host' });
      if (status === 'pending') return reply.code(400).send({ error: 'Your application is already under review' });
    }

    await pool.query(
      `INSERT INTO host_profiles
        (sui_address, email, name, phone, property_address, city, state, zip, country,
         jurisdiction, str_permit, payout_sui_address, payout_notes,
         status, terms_agreed, terms_agreed_at, compliance_confirmed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending',true,NOW(),true)
       ON CONFLICT (sui_address) DO UPDATE SET
         email=$2, name=$3, phone=$4, property_address=$5, city=$6, state=$7, zip=$8,
         country=$9, jurisdiction=$10, str_permit=$11, payout_sui_address=$12,
         payout_notes=$13, status='pending', terms_agreed=true, terms_agreed_at=NOW(),
         compliance_confirmed=true, updated_at=NOW()`,
      [session.suiAddress, email.toLowerCase(), name, phone || null,
       propertyAddress || null, city || null, state || null, zip || null, country || 'US',
       jurisdiction || null, strPermit || null,
       session.suiAddress, payoutNotes || null]
    );

    try {
      await resend.emails.send({
        from: 'ARIA <onboarding@resend.dev>',
        to: HOST_ADDRESSES[0] || 'cwilliams36092@gmail.com',
        subject: `New Host Application — ${name}`,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#ffaa00;font-size:22px;margin:0 0 8px">🏡 New Host Application</h1><p style="color:#888;margin:0 0 20px">Someone wants to become an ARIA host.</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:20px;font-size:13px"><table style="width:100%;border-collapse:collapse"><tr><td style="color:#888;padding:5px 0">Name</td><td style="text-align:right">${escapeHtml(name)}</td></tr><tr><td style="color:#888;padding:5px 0">Email</td><td style="text-align:right">${escapeHtml(email)}</td></tr><tr><td style="color:#888;padding:5px 0">Sui Address</td><td style="text-align:right;font-family:monospace;font-size:11px">${session.suiAddress}</td></tr>${city ? `<tr><td style="color:#888;padding:5px 0">Location</td><td style="text-align:right">${escapeHtml(city)}${state ? ', ' + escapeHtml(state) : ''}</td></tr>` : ''}${strPermit ? `<tr><td style="color:#888;padding:5px 0">STR Permit</td><td style="text-align:right">${escapeHtml(strPermit)}</td></tr>` : ''}</table></div><p style="color:#888;font-size:12px;margin:0">To approve, use the ARIA admin API with their Sui address.</p></div>`
      });
    } catch (err) { fastify.log.warn({ err }, 'Admin notification email failed'); }

    try {
      await resend.emails.send({
        from: 'ARIA <onboarding@resend.dev>',
        to: email,
        subject: 'ARIA Host Application Received',
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#00ff44;font-size:24px;margin:0 0 8px">🏠 Host Application Received</h1><p style="color:#888;margin:0 0 24px">Thanks for applying to host on ARIA, ${escapeHtml(name)}.</p><div style="background:#111;border:1px solid #222;border-radius:8px;padding:20px;margin-bottom:20px"><p style="margin:0 0 12px;font-size:14px;color:#ccc">Your application is under review. Here's what happens next:</p><ul style="color:#888;font-size:13px;line-height:1.8;padding-left:16px"><li>We'll review your application within 1–2 business days</li><li>You'll receive an email when your account is approved</li><li>Once approved, you can list properties and receive bookings</li></ul></div><p style="color:#555;font-size:12px;text-align:center;margin:0">Powered by ARIA — Built on Sui</p></div>`
      });
    } catch (err) { fastify.log.warn({ err }, 'Host application email failed'); }

    return { success: true, status: 'pending', message: 'Host application submitted. You will receive an email when approved.' };
  } catch (err) {
    fastify.log.error(err);
    return reply.code(500).send({ error: 'Failed to submit host application' });
  }
});

fastify.post('/host/approve', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!HOST_ADDRESSES.includes(session.email.toLowerCase()))
    return reply.code(403).send({ error: 'Superadmin access required' });

  const { suiAddress } = request.body;
  if (!suiAddress) return reply.code(400).send({ error: 'suiAddress is required' });

  try {
    const result = await pool.query(
      `UPDATE host_profiles SET status='approved', approved_at=NOW(), approved_by=$1, updated_at=NOW() WHERE sui_address=$2 RETURNING *`,
      [session.email, suiAddress]
    );
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Host profile not found' });
    const host = result.rows[0];

    try {
      await resend.emails.send({
        from: 'ARIA <onboarding@resend.dev>',
        to: host.email,
        subject: '🎉 Your ARIA Host Account is Approved!',
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;background:#0a0a0a;color:#fff;padding:32px;border-radius:12px"><h1 style="color:#00ff44;font-size:24px;margin:0 0 8px">🎉 You're an ARIA Host!</h1><p style="color:#888;margin:0 0 24px">Congratulations ${escapeHtml(host.name)} — your host account has been approved.</p><div style="background:#0a1a0a;border:1px solid #1a3a1a;border-radius:8px;padding:20px;margin-bottom:20px"><p style="color:#00ff44;font-size:14px;font-weight:600;margin:0 0 8px">You can now:</p><ul style="color:#888;font-size:13px;line-height:1.8;padding-left:16px"><li>Access your Host Dashboard</li><li>Receive bookings from guests</li><li>Manage deposits and payouts</li><li>Track occupancy tax compliance</li></ul></div><a href="${process.env.FRONTEND_URL || 'http://localhost:3000'}" style="display:block;background:#00ff44;color:#000;text-align:center;padding:14px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none;margin-bottom:20px">Go to ARIA →</a><p style="color:#555;font-size:12px;text-align:center;margin:0">Powered by ARIA — Built on Sui</p></div>`
      });
    } catch (err) { fastify.log.warn({ err }, 'Host approval email failed'); }

    return { success: true, message: `Host ${host.name} approved`, email: host.email };
  } catch (err) {
    return reply.code(500).send({ error: 'Failed to approve host' });
  }
});

// POST /host/revoke — superadmin-only counterpart to /host/approve. Sets an
// approved (or pending) host_profiles row back to 'revoked' so checkDbHost()
// (and therefore isHost()) stops passing for that sui_address — used e.g. to
// undo a test/demo account that was approved for testing but should never
// have counted as a real host. Distinct status value (not 'rejected', which
// this codebase doesn't otherwise use) so it's clear in the applications list
// this was a deliberate after-the-fact revocation, not a rejected application.
fastify.post('/host/revoke', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!HOST_ADDRESSES.includes(session.email.toLowerCase()))
    return reply.code(403).send({ error: 'Superadmin access required' });

  const { suiAddress } = request.body;
  if (!suiAddress) return reply.code(400).send({ error: 'suiAddress is required' });

  try {
    const result = await pool.query(
      `UPDATE host_profiles SET status='revoked', updated_at=NOW() WHERE sui_address=$1 RETURNING id, name, email`,
      [suiAddress]
    );
    if (result.rows.length === 0) return reply.code(404).send({ error: 'Host profile not found' });
    return { success: true, message: `Host access revoked for ${result.rows[0].email}` };
  } catch (err) {
    return reply.code(500).send({ error: 'Failed to revoke host' });
  }
});

fastify.get('/host/applications', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  if (!HOST_ADDRESSES.includes(session.email.toLowerCase()))
    return reply.code(403).send({ error: 'Superadmin access required' });

  try {
    const result = await pool.query(
      `SELECT id, sui_address, name, email, phone, city, state, jurisdiction, str_permit, status, created_at, approved_at
       FROM host_profiles ORDER BY created_at DESC`
    );
    return { applications: result.rows };
  } catch (err) {
    return reply.code(500).send({ error: 'Failed to fetch applications' });
  }
});
}
