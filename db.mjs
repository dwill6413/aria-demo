import pg from 'pg';
const { Pool } = pg;

if (!process.env.DATABASE_URL) console.warn('WARNING: DATABASE_URL not set');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
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

  console.log('Database initialized');
}

export { pool };
