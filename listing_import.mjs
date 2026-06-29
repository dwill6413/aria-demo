// ─── ARIA Listing Import (Phase 3a) ───────────────────────────────────────────
// Host onboarding friction reducer: instead of hosts with dozens/hundreds of
// properties typing every field into a form, they paste the URL of their
// existing Airbnb/VRBO listing plus the listing text they copy off that page,
// and we use the same LLM infra already powering ai_route.mjs (xAI's Grok) to
// turn unstructured text into the structured fields the `properties` table
// needs (see db.mjs).
//
// Deliberately NOT scraping: we never fetch the Airbnb/VRBO URL ourselves —
// Airbnb's API Terms of Service prohibit unauthorized automated data
// collection, and reusing scraped photos/descriptions to populate a directly
// competing booking platform is a materially more aggressive use than the
// personal-analytics use most third-party "Airbnb scraper" vendors market
// toward. The URL is stored only as a reference (source_url) and is never
// fetched server-side. All actual listing content comes from text the host
// pastes themselves (which they already have rights to, since it's their own
// listing) and photos they upload themselves.
//
// The host ALWAYS reviews/edits the extracted draft before anything is
// written to the database — see server.mjs's POST /host/properties, which is
// the only route that actually persists a listing. This module only ever
// produces a draft; it has no DB access at all.

const GROK_MODEL   = 'grok-3-latest';
const XAI_BASE_URL = 'https://api.x.ai/v1/chat/completions';

const MAX_INPUT_CHARS = 12000; // generous for a full listing description + amenities list

const EXTRACT_TOOL = {
  type: 'function',
  function: {
    name: 'extract_listing',
    description: 'Extract structured vacation-rental listing fields from raw pasted text.',
    parameters: {
      type: 'object',
      properties: {
        title:       { type: 'string', description: 'A concise listing title, e.g. "Oceanfront Villa with Private Pool". If the text has no clear title, write one from the description.' },
        description: { type: 'string', description: 'A cleaned-up 1-3 paragraph description of the property, written in plain prose (no markdown, no bullet lists).' },
        location:    { type: 'string', description: 'City and state/region, e.g. "Asheville, NC". Best guess from the text; empty string if truly not mentioned.' },
        price:       { type: 'number', description: 'Nightly price in whole US dollars, as a plain number with no currency symbol. 0 if not mentioned.' },
        beds:        { type: 'number', description: 'Number of bedrooms. 1 if not mentioned.' },
        baths:       { type: 'number', description: 'Number of bathrooms. 1 if not mentioned.' },
        maxGuests:   { type: 'number', description: 'Maximum occupancy. Estimate from beds if not explicitly stated (beds * 2).' },
        tag:         { type: 'string', description: 'A short 1-3 word vibe/category tag, e.g. "Beachfront", "Mountain View", "City Loft".' },
      },
      required: ['title', 'description', 'location', 'price', 'beds', 'baths', 'maxGuests', 'tag']
    }
  }
};

function clampNumber(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

// Takes raw pasted listing text (and the source URL, kept only for display/
// audit — never fetched) and returns a normalized draft object matching the
// `properties` table's shape, ready for the host to review/edit before
// publishing. Never throws — returns { error } on failure so callers (single
// or bulk) can keep going.
export async function extractListingFields(rawText, sourceUrl = '', logger = console) {
  const text = (rawText || '').trim();
  if (!text) return { error: 'No listing text provided' };
  if (text.length > MAX_INPUT_CHARS) {
    return { error: `Listing text is too long (max ${MAX_INPUT_CHARS} characters) — paste just the title/description/amenities, not the whole page.` };
  }
  if (!process.env.XAI_API_KEY) {
    return { error: 'Listing import is not configured on this server (missing XAI_API_KEY)' };
  }

  try {
    const res = await fetch(XAI_BASE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.XAI_API_KEY}`
      },
      body: JSON.stringify({
        model: GROK_MODEL,
        messages: [
          { role: 'system', content: 'You extract structured vacation-rental listing data from raw pasted text (usually copied from an Airbnb or VRBO listing page by the host who owns it). Always call extract_listing exactly once with your best-effort values — never ask clarifying questions, never refuse, just make reasonable inferences for anything missing.' },
          { role: 'user', content: text }
        ],
        tools: [EXTRACT_TOOL],
        tool_choice: { type: 'function', function: { name: 'extract_listing' } },
        max_tokens: 1200
      })
    });

    if (!res.ok) {
      const err = await res.text();
      logger?.warn?.({ status: res.status, err }, 'extractListingFields: Grok API error');
      return { error: 'Could not parse this listing right now — try again, or fill the form in manually.' };
    }

    const json = await res.json();
    const call = json?.choices?.[0]?.message?.tool_calls?.[0];
    if (!call?.function?.arguments) {
      return { error: 'Could not extract listing fields from that text — try pasting more of the description, or fill the form in manually.' };
    }

    let parsed;
    try { parsed = JSON.parse(call.function.arguments); }
    catch { return { error: 'Could not parse the extraction result — try again.' }; }

    // Clamp/sanitize everything — this is host-supplied text run through an
    // LLM, not a trusted internal source, even though it never touches money
    // directly (price here is a DRAFT the host still reviews and the actual
    // POST /host/properties write re-validates independently).
    return {
      title:       String(parsed.title || 'Untitled Listing').slice(0, 200),
      description: String(parsed.description || '').slice(0, 4000),
      location:    String(parsed.location || '').slice(0, 200),
      price:       clampNumber(parsed.price, 0, 100000, 0),
      beds:        clampNumber(parsed.beds, 1, 50, 1),
      baths:       clampNumber(parsed.baths, 1, 50, 1),
      maxGuests:   clampNumber(parsed.maxGuests, 1, 100, 2),
      tag:         String(parsed.tag || 'New Listing').slice(0, 50),
      sourceUrl:   String(sourceUrl || '').slice(0, 500),
    };
  } catch (err) {
    logger?.warn?.({ err: err.message }, 'extractListingFields: request failed');
    return { error: 'Could not reach the listing import service — try again, or fill the form in manually.' };
  }
}
