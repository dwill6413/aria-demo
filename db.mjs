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

  console.log('Database initialized');
}

export { pool };
