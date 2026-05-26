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
  `);
  console.log('Database initialized');
}

export { pool };
