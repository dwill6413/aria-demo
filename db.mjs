import pg from 'pg';
const { Pool } = pg;

if (!process.env.DATABASE_URL) console.warn('WARNING: DATABASE_URL not set');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // NOTE: rejectUnauthorized:false is kept because Railway's managed Postgres
  // presents a cert that won't validate against the default CA bundle.
  // To harden later, provide the Railway CA via `ssl: { ca: ... }` and set
  // rejectUnauthorized:true. Changing this now can break the DB connection.
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
      deposit_release_walrus_blob_id TEXT,
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

    -- Auth sessions (was previously assumed to exist; now created explicitly).
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );

    -- External calendar feeds per property (ical sync).
    -- UNIQUE(property_id, platform) is required by the ON CONFLICT upsert.
    CREATE TABLE IF NOT EXISTS property_ical_feeds (
      id SERIAL PRIMARY KEY,
      property_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      ical_url TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (property_id, platform)
    );

    -- Backfill the new receipt column on pre-existing bookings tables.
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS deposit_release_walrus_blob_id TEXT;

    -- Indexes for the actual query filters (no-ops if they already exist).
    CREATE INDEX IF NOT EXISTS idx_bookings_wallet      ON bookings (wallet_address);
    CREATE INDEX IF NOT EXISTS idx_bookings_property    ON bookings (property_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_avail       ON bookings (property_id, check_in, check_out);
    CREATE INDEX IF NOT EXISTS idx_messages_ref         ON messages (booking_ref);
    CREATE INDEX IF NOT EXISTS idx_reviews_property     ON reviews (property_id);
    CREATE INDEX IF NOT EXISTS idx_host_profiles_email  ON host_profiles (email);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires     ON sessions (expires_at);
  `);
  console.log('Database initialized');
}

export { pool };
