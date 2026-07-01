import pg from 'pg';
const { Pool } = pg;

if (!process.env.DATABASE_URL) console.warn('WARNING: DATABASE_URL not set');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // DATABASE_URL uses Railway's private internal network (postgres.railway.internal)
  // — traffic never leaves Railway's network so SSL is unnecessary.
  // Falls back to strict SSL for any non-internal connection string (e.g. mainnet external DB).
  ssl: process.env.DATABASE_URL?.includes('.railway.internal') ? false : { rejectUnauthorized: true }
});

export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS properties (
      id SERIAL PRIMARY KEY,
      host_address TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT NOT NULL,
      price INTEGER NOT NULL,
      beds INTEGER NOT NULL,
      baths INTEGER NOT NULL,
      tag TEXT,
      images TEXT[],
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      booking_ref TEXT UNIQUE NOT NULL,
      property_id INTEGER,
      property_title TEXT,
      wallet_address TEXT NOT NULL,
      guest_name TEXT,
      guest_email TEXT,
      check_in DATE NOT NULL,
      check_out DATE NOT NULL,
      nights INTEGER NOT NULL,
      price_per_night INTEGER,
      subtotal INTEGER,
      aria_fee INTEGER,
      taxes INTEGER,
      total_amount INTEGER,
      deposit_amount INTEGER,
      deposit_status TEXT DEFAULT 'held',
      payment_status TEXT DEFAULT 'confirmed',
      payment_method TEXT DEFAULT 'SuiUSD',
      walrus_blob_id TEXT,
      cancellation_walrus_blob_id TEXT,
      escrow_object_id TEXT,
      cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL,
      booking_ref TEXT NOT NULL,
      guest_name TEXT,
      guest_email TEXT,
      rating INTEGER NOT NULL,
      review TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      booking_ref TEXT NOT NULL,
      from_name TEXT,
      from_email TEXT,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS hosts (
      id SERIAL PRIMARY KEY,
      sui_address TEXT UNIQUE NOT NULL,
      email TEXT,
      name TEXT,
      approved BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tax_remittances (
      id SERIAL PRIMARY KEY,
      booking_ref TEXT UNIQUE NOT NULL,
      property_id INTEGER,
      property_title TEXT,
      tax_amount INTEGER NOT NULL,
      jurisdiction TEXT,
      remitted_at TIMESTAMPTZ NOT NULL,
      remitted_by TEXT NOT NULL,
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- M3 (per-user zkLogin salt): each Google account's sub claim maps to its
    -- own persisted salt, instead of every user sharing one ZKLOGIN_SALT env
    -- var. Once a row exists, that user's Sui address derivation never moves
    -- again regardless of what the global env var does later. See
    -- getOrCreateUserSalt() in auth.mjs — new rows are seeded with the
    -- CURRENT global salt value (not a fresh random one) so existing users'
    -- addresses are preserved at rollout; only a value change to an
    -- already-frozen row would move an address, and nothing in the app does
    -- that after creation.
    CREATE TABLE IF NOT EXISTS user_salts (
      sub TEXT PRIMARY KEY,
      salt TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS property_ical_feeds (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      ical_url TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (property_id, platform)
    );
    CREATE TABLE IF NOT EXISTS host_profiles (
      id SERIAL PRIMARY KEY,
      sui_address TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      name TEXT NOT NULL,
      phone TEXT,
      property_address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      country TEXT DEFAULT 'US',
      jurisdiction TEXT,
      str_permit TEXT,
      payout_sui_address TEXT,
      payout_notes TEXT,
      status TEXT DEFAULT 'pending',
      approved_at TIMESTAMPTZ,
      approved_by TEXT,
      terms_agreed BOOLEAN DEFAULT false,
      terms_agreed_at TIMESTAMPTZ,
      compliance_confirmed BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // Idempotent column additions for existing deployments
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS escrow_object_id TEXT`);
  // Guest-declared party size at booking time (June 29, 2026) — previously
  // never collected; createBooking() clamps/validates this against the
  // property's maxGuests before writing it here.
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guests INTEGER DEFAULT 1`);

  // P2 / Phase 1i + 1j: host address actually baked into this booking's
  // on-chain escrow (see bookings.mjs getPropertyHostAddress), and the
  // claim/dispute/resolution lifecycle fields. deposit_status is plain TEXT
  // (no CHECK constraint, matching payment_status elsewhere in this schema)
  // and now takes on 'claimed' | 'disputed' | 'forfeited' in addition to the
  // existing 'pending' | 'held' | 'released'.
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS host_sui_address TEXT`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS claim_amount INTEGER`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS claim_reason TEXT`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS dispute_reason TEXT`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS resolved_guest_amount INTEGER`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS resolved_host_amount INTEGER`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`);
  // Walrus receipt for an AI-path deposit release (ai_route.mjs writes this on
  // release). Was previously written but never created — a clean DB would throw
  // "column does not exist" on release. Idempotent for existing deployments.
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_release_walrus_blob_id TEXT`);

  // ── Phase 1h.5: payment escrow (rental + ARIA fee + tax) ──────────────────
  // The payment escrow is SEPARATE from the deposit escrow (escrow_object_id).
  // Its lifecycle: pending -> held (verified on-chain at booking) -> released
  // (3-way split at check-in) | refunded (full guest refund on pre-check-in
  // cancel). payment_release_ms is the check-in timestamp baked into the
  // on-chain object, used by the check-in sweep and by the confirm route's
  // authoritative comparison. settlement_digest is the booking PTB digest;
  // a partial-unique index (below) enforces one booking per on-chain tx so a
  // digest can't be replayed to confirm a second booking.
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_escrow_object_id TEXT`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_escrow_status TEXT DEFAULT 'pending'`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_release_ms BIGINT`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS settlement_digest TEXT`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_released_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_refunded_at TIMESTAMPTZ`);
  // BookingPass Phase 2a — the owned, soulbound pass NFT minted to the guest in
  // the booking PTB (only when BOOKING_PASS_ENABLED + a v5 package that has
  // mint_booking_pass). Stores the object id so the UI can link to it.
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_pass_object_id TEXT`);

  // M6 (Stripe Checkout, July 2026): the card-payment fallback path. A
  // stripe-paid booking is inserted with payment_status='pending' (holding
  // the dates, same idea as the SuiUSD path's deposit_status='pending' window)
  // and only flips to 'confirmed' when POST /webhooks/stripe verifies a
  // checkout.session.completed event — never on the frontend's say-so. These
  // columns let the webhook find the right row and record what Stripe says
  // actually happened. Deliberately no deposit for this path (deposit_amount/
  // deposit_status stay NULL, which the existing CHECK constraint below
  // already allows since NULL always satisfies a CHECK) — a refundable
  // security deposit is a Sui-escrow-native concept (release, check-in pass,
  // resale all key off it) that a card charge has no equivalent for yet.
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_payment_intent_id TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bookings_stripe_session ON bookings(stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL`);

  // M6 follow-up (Seal/Stripe parity, July 2026): Stripe bookings have no
  // guest-signed escrow_object_id (no guest wallet signature ever happens in
  // the card flow), so host.jsx's "View Guest Identity" — gated on-chain by
  // escrow.move's seal_approve, which requires a REAL &BookingEscrow<T>
  // object — had no object to check against for card guests. Rather than
  // building any off-chain authorization fallback (which would mean ARIA's
  // backend deciding PII access instead of Seal's key servers dry-running
  // on-chain state — genuine custody, rejected), ARIA's own auto-release key
  // now creates a normal BookingEscrow<T> object for these bookings via the
  // EXISTING create_escrow entry function, funded with a trivial testnet
  // amount, with guest/host set to the booking's real addresses. Its ONLY
  // purpose is satisfying seal_approve's on-chain check — it is NOT a payment
  // or deposit escrow and must never be read by autoReleaseEscrow, the
  // deposit sweep, refund logic, resale, or the check-in-pass flow, which is
  // why it lives in its own dedicated column, never escrow_object_id.
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS identity_attestation_object_id TEXT`);

  // ── Phase 2: guest PII verification (Walrus + Seal) ───────────────────────
  // Holds only a POINTER to the guest's Seal-encrypted PII blob on Walrus — no
  // PII columns ever live in Postgres. The blob is encrypted client-side under
  // the guest's Sui address as the Seal identity; only the host of an active
  // booking can decrypt it (gated on-chain by escrow.move's seal_approve), and
  // access disappears automatically when the booking's escrow object is deleted.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guest_verifications (
      sui_address    TEXT PRIMARY KEY,
      walrus_blob_id TEXT NOT NULL,
      phone_verified BOOLEAN DEFAULT false,
      created_at     TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // ── Indexes (Phase 3 / Finding #13) ───────────────────────────────────────
  // bookings.booking_ref already has an implicit unique index from its UNIQUE
  // NOT NULL column constraint above — no separate index needed there.
  // wallet_address and property_id are looked up on nearly every request
  // (guest's own bookings, availability checks, revenue summaries) and had
  // no index backing those lookups; messages.booking_ref is looked up the
  // same way for every message-thread read.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bookings_wallet_address ON bookings(wallet_address)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bookings_property_id ON bookings(property_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_messages_booking_ref ON messages(booking_ref)`);
  // Replay/idempotency: one booking per on-chain settlement tx. Partial unique
  // so the many rows with a NULL digest (pre-confirm) don't collide.
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_settlement_digest ON bookings(settlement_digest) WHERE settlement_digest IS NOT NULL`);
  // Check-in sweep scans for held payment escrows past their release time.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bookings_payment_escrow ON bookings(payment_escrow_status, payment_release_ms)`);
  // Abandoned-booking sweep (June 30, 2026) scans for never-signed bookings
  // past the TTL — partial index keeps it tiny since 'pending' rows are a
  // small, fast-churning slice of the table (most bookings move to 'held'
  // within seconds of being created).
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bookings_abandoned_sweep ON bookings(created_at) WHERE payment_status = 'confirmed' AND deposit_status = 'pending'`);

  // ── §5f: DB integrity (June 24, 2026) ─────────────────────────────────────
  // One review per booking — previously only enforced in app code. Guarded so a
  // pre-existing duplicate (shouldn't exist) logs a notice instead of crashing
  // startup. Plus an index for the /reviews/:propertyId lookup.
  await pool.query(`DO $$ BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_booking_ref ON reviews(booking_ref);
  EXCEPTION WHEN others THEN
    RAISE NOTICE 'idx_reviews_booking_ref skipped (existing duplicate reviews?): %', SQLERRM;
  END $$;`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_reviews_property_id ON reviews(property_id)`);

  // Verifiable reviews (June 24, 2026): a review is only accepted for the guest's
  // own, non-cancelled, on-chain-escrow-backed booking, and is itself written to
  // Walrus as an immutable attestation. These columns hold the proof.
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS verified BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS settlement_ref TEXT`);
  await pool.query(`ALTER TABLE reviews ADD COLUMN IF NOT EXISTS review_walrus_blob_id TEXT`);

  // Status enums as CHECK constraints (catch app bugs at the DB layer). NOT VALID
  // so existing rows aren't re-checked (no startup failure); enforced on new
  // writes. Idempotent via pg_constraint lookup.
  await pool.query(`DO $$ BEGIN
    -- M6: widened to add 'pending' (a Stripe Checkout Session awaiting the
    -- webhook) and 'failed' (Stripe reported the charge itself failed, as
    -- opposed to 'cancelled' which covers guest/host cancellation and
    -- Checkout Session expiry). Drop-and-recreate since Postgres has no
    -- ALTER CONSTRAINT for CHECK clauses; NOT VALID again so this is a no-op
    -- against existing rows on every boot.
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_bookings_payment_status') THEN
      ALTER TABLE bookings DROP CONSTRAINT chk_bookings_payment_status;
    END IF;
    ALTER TABLE bookings ADD CONSTRAINT chk_bookings_payment_status
      CHECK (payment_status IN ('pending','confirmed','cancelled','failed')) NOT VALID;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_bookings_deposit_status') THEN
      ALTER TABLE bookings ADD CONSTRAINT chk_bookings_deposit_status
        CHECK (deposit_status IN ('pending','held','released','claimed','disputed','forfeited')) NOT VALID;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='chk_bookings_payment_escrow_status') THEN
      ALTER TABLE bookings ADD CONSTRAINT chk_bookings_payment_escrow_status
        CHECK (payment_escrow_status IN ('pending','held','released','refunded')) NOT VALID;
    END IF;
  END $$;`);

  // ── §5f: Seal PII access audit log (June 24, 2026) ────────────────────────
  // The actual decrypt happens client-side (lib/seal.js), which the backend
  // can't observe — so we log every ACCESS REQUEST to /host/guest-identity (who
  // asked for whose identity, for which booking). Required before real PII on
  // mainnet (Seal isn't scoped for regulated PII without an audit trail).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pii_access_log (
      id            SERIAL PRIMARY KEY,
      booking_ref   TEXT NOT NULL,
      host_address  TEXT NOT NULL,
      guest_address TEXT NOT NULL,
      accessed_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_pii_access_log_booking_ref ON pii_access_log(booking_ref)`);

  // ── Phase 2c: guardrailed resale market ───────────────────────────────────
  // Host opt-in lives per-listing (Rail 1). transfer_allowed defaults OFF; the
  // premium cap (Rail 2) is in basis points, 0 = face-value-only. These are read
  // at booking time and baked into the booking's on-chain ResalePolicy object;
  // later changes only affect future bookings.
  //
  // NOTE: this used to also ALTER TABLE properties ADD COLUMN transfer_allowed/
  // max_resale_premium_bps directly on the `properties` table, with a comment
  // saying they "remain for any real DB-backed listing." That was never true —
  // every read/write path (GET/POST /host/.../resale-settings below, and
  // getResaleSettings() in bookings.mjs) only ever touches property_resale_settings,
  // keyed generically by property_id for BOTH catalog and DB-backed listings. The
  // properties.* columns were pure dead schema (catalog/db parity audit, item #4)
  // and have been removed here. Already-migrated databases may still have the
  // orphan columns sitting unused — harmless, but a manual
  // `ALTER TABLE properties DROP COLUMN IF EXISTS transfer_allowed, DROP COLUMN IF EXISTS max_resale_premium_bps`
  // can clean those up if desired.
  //
  // The 6 demo listings live in catalog.mjs, not the `properties` table (which
  // has NOT NULL location/beds/baths a catalog entry can't satisfy), so resale
  // opt-in for them is stored here, keyed by the catalog property_id. This is the
  // single source getResaleSettings() reads and the host settings route upserts —
  // and it's also where any real DB-backed listing's resale settings live.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS property_resale_settings (
      property_id            INTEGER PRIMARY KEY,
      host_address           TEXT,
      transfer_allowed       BOOLEAN DEFAULT false,
      max_resale_premium_bps INTEGER DEFAULT 0,
      updated_at             TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Per-booking resale state. resale_policy_object_id points at the on-chain
  // ResalePolicy; resale_count mirrors its hop counter (Rail 5, max 1);
  // original_wallet_address preserves provenance across a resale (wallet_address
  // is reassigned to the buyer on sale). resale_listed / resale_ask_price let the
  // UI show a listing without reading chain. resale_walrus_blob_id is the
  // immutable resale receipt.
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS resale_policy_object_id TEXT`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS resale_count INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS original_wallet_address TEXT`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS resale_listed BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS resale_ask_price INTEGER`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS resale_walrus_blob_id TEXT`);

  // One row per completed resale (provenance + the on-chain split breakdown).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS resales (
      id              SERIAL PRIMARY KEY,
      booking_ref     TEXT NOT NULL,
      seller_address  TEXT NOT NULL,
      buyer_address   TEXT NOT NULL,
      face_amount     INTEGER NOT NULL,
      sale_price      INTEGER NOT NULL,
      aria_cut        INTEGER NOT NULL,
      host_cut        INTEGER NOT NULL,
      seller_cut      INTEGER NOT NULL,
      tx_digest       TEXT,
      walrus_blob_id  TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_resales_booking_ref ON resales(booking_ref)`);
  // Replay guard: one resale row per on-chain tx (partial — NULLs don't collide).
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_resales_tx_digest ON resales(tx_digest) WHERE tx_digest IS NOT NULL`);
  // Browse the open resale market: listed bookings only.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bookings_resale_listed ON bookings(resale_listed) WHERE resale_listed = true`);

  // ── Plain wallet sends (P3) ──────────────────────────────────────────────
  // Audit trail for "send funds out of your ARIA wallet" — there's no booking
  // or escrow object backing this, so unlike every other money-moving table
  // here this one isn't read back to drive app state. It exists purely so
  // support can answer "I sent X and it's not showing up" by looking up the
  // digest, the same way pii_access_log exists for access (not state) audit.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallet_sends (
      id              SERIAL PRIMARY KEY,
      from_address    TEXT NOT NULL,
      to_address      TEXT NOT NULL,
      amount_mist     TEXT NOT NULL,
      tx_digest       TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_wallet_sends_from_address ON wallet_sends(from_address)`);
  // Replay guard: one row per on-chain tx (partial — NULLs don't collide).
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_sends_tx_digest ON wallet_sends(tx_digest) WHERE tx_digest IS NOT NULL`);

  // ── Self check-in (P4) ──────────────────────────────────────────────────────
  // property_checkin_settings: dedicated table for check-in type + encrypted
  // access instructions. Covers BOTH catalog (ids 1-6) and host-imported DB
  // properties without creating shadow rows in the properties table.
  // The columns on `properties` (check_in_type, access_instructions_encrypted)
  // are kept for backward compatibility but are no longer written by new code.
  await pool.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS check_in_type TEXT DEFAULT 'front_desk'`);
  await pool.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS access_instructions_encrypted TEXT`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS property_checkin_settings (
      property_id INTEGER PRIMARY KEY,
      check_in_type TEXT NOT NULL DEFAULT 'front_desk',
      access_instructions_encrypted TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // checked_in: flipped to true the first time the guest calls /booking/:ref/checkin
  // successfully. checked_in_at records the timestamp for support/audit.
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in BOOLEAN DEFAULT false`);
  await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMPTZ`);

  // ── Phase 3a: host-created listings (the `properties` table goes live) ───
  // Until now this table was scaffolded but never written to — the 6 demo
  // properties live in catalog.mjs instead (see its header comment). This is
  // the schema fill-in for "hosts add their own listings," including the
  // Airbnb/VRBO import flow (listing_import.mjs): tax fields are denormalized
  // onto the row itself (no JURISDICTION_TAX_RATES-style lookup table for
  // dynamic listings) because the host self-declares their jurisdiction at
  // creation time and catalog.mjs's getProperty()/getAllProperties() read them
  // straight off the row. tax_rate is clamped server-side to [0, 0.20] at write
  // time (see server.mjs POST /host/properties) — same trust model terms.jsx
  // already discloses: ARIA collects the declared tax but hosts are solely
  // responsible for the rate being correct and for remitting it.
  await pool.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS tax_rate NUMERIC DEFAULT 0.08`);
  await pool.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS tax_jurisdiction TEXT DEFAULT 'Unknown'`);
  await pool.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS tax_breakdown TEXT DEFAULT '8% occupancy tax (default — host has not set a jurisdiction)'`);
  await pool.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS max_guests INTEGER DEFAULT 2`);
  await pool.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS source_url TEXT`);
  await pool.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS import_source TEXT DEFAULT 'manual'`);
  await pool.query(`ALTER TABLE properties ADD COLUMN IF NOT EXISTS host_email TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_properties_host_address ON properties(host_address)`);

  // Guard against id collisions with the 6 fixed catalog properties
  // (catalog.mjs ids 1-6, code-only — not rows in this table). properties.id
  // is a plain SERIAL, so the first-ever host-created listing got id=1, same
  // as the Oceanfront Villa demo property. That collision corrupted more
  // than display fields: bookings.property_id is also a bare, source-unaware
  // INTEGER, so host.jsx's per-listing BOOKINGS/REVENUE cards (which filter
  // bookings by propertyId === p.id) attributed the demo property's real
  // booking/revenue onto the new listing's card. Bumping the sequence well
  // past the fixed range stops any *future* collision; it does not fix rows
  // already inserted at ids 1-6 (see ARIA_ROADMAP.md — needs a one-off data
  // fix for any of those that already exist). Idempotent: setval only moves
  // the counter forward, never back, so this is safe to run on every boot.
  await pool.query(`SELECT setval('properties_id_seq', GREATEST(1000, (SELECT COALESCE(MAX(id), 0) FROM properties)))`);

  // One-off fix for rows ALREADY inserted at ids 1-6 before the sequence bump
  // above existed (e.g. a host's first listing landing on id=1, same as the
  // Oceanfront Villa). catalog.mjs's getProperty()/getAllProperties() check
  // the fixed catalog FIRST and unconditionally for ids 1-6, so a DB row stuck
  // in that range is permanently unreachable: booking, editing, or viewing
  // "that id" silently resolves to the fixed demo property instead, using ITS
  // price/tax/title — this is why booking a colliding new listing silently
  // booked (and charged for) the demo property instead. Re-id any survivor
  // out of the collision range, on every boot (idempotent: a clean DB has no
  // rows in 1-6, so this is a no-op there). Past bookings made against a
  // since-relocated row keep the property_id they were created with (no FK —
  // see comment above) and can't be retroactively reattributed, since they
  // were recorded identically to a genuine demo-property booking at write time.
  const { rows: colliding } = await pool.query('SELECT id, title FROM properties WHERE id <= 6');
  for (const row of colliding) {
    const { rows: [{ nextval }] } = await pool.query(`SELECT nextval('properties_id_seq') AS nextval`);
    await pool.query('UPDATE properties SET id = $1 WHERE id = $2', [nextval, row.id]);
    console.log(`Re-id'd colliding property "${row.title}" from id=${row.id} to id=${nextval} (was colliding with fixed catalog ids 1-6)`);
  }

  console.log('Database initialized');
}

export { pool };
