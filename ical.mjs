import ical from 'ical-generator';
import icalParser from 'ical.js';
import { pool } from './db.mjs';

/**
 * Generate iCal export for a property — reads bookings from Postgres
 * Hosts paste this URL into Airbnb/VRBO to sync ARIA bookings
 */
export async function generateICal(propertyId, propertyTitle) {
  const calendar = ical({ name: `ARIA — ${propertyTitle}` });

  try {
    const result = await pool.query(
      `SELECT booking_ref, check_in, check_out, guest_name
       FROM bookings
       WHERE property_id = $1 AND payment_status != 'cancelled'
       ORDER BY check_in ASC`,
      [propertyId]
    );

    for (const booking of result.rows) {
      calendar.createEvent({
        start: new Date(booking.check_in),
        end:   new Date(booking.check_out),
        summary:     `ARIA Booking — ${booking.booking_ref}`,
        description: `Booked via ARIA. Ref: ${booking.booking_ref}`,
        id:          booking.booking_ref
      });
    }
  } catch (err) {
    console.warn('generateICal DB error:', err.message);
  }

  return calendar.toString();
}

/**
 * Save external iCal URL for a property (Airbnb/VRBO feed) — stored in Postgres
 */
export async function saveExternalCalendar(propertyId, platform, icalUrl) {
  await pool.query(
    `INSERT INTO property_ical_feeds (property_id, platform, ical_url, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (property_id, platform)
     DO UPDATE SET ical_url = $3, updated_at = NOW()`,
    [propertyId, platform, icalUrl]
  );

  const result = await pool.query(
    'SELECT platform, ical_url FROM property_ical_feeds WHERE property_id = $1',
    [propertyId]
  );

  return Object.fromEntries(result.rows.map(r => [r.platform, r.ical_url]));
}

/**
 * Get saved external calendars for a property
 */
export async function getExternalCalendars(propertyId) {
  const result = await pool.query(
    'SELECT platform, ical_url FROM property_ical_feeds WHERE property_id = $1',
    [propertyId]
  );
  return Object.fromEntries(result.rows.map(r => [r.platform, r.ical_url]));
}

/**
 * Fetch and parse external iCal feed (Airbnb/VRBO)
 */
async function fetchExternalBookings(icalUrl) {
  try {
    const res    = await fetch(icalUrl);
    const text   = await res.text();
    const parsed = icalParser.parse(text);
    const comp   = new icalParser.Component(parsed);
    const events = comp.getAllSubcomponents('vevent');

    return events.map(event => ({
      start:   new Date(event.getFirstPropertyValue('dtstart')),
      end:     new Date(event.getFirstPropertyValue('dtend')),
      summary: event.getFirstPropertyValue('summary') || 'Blocked'
    }));
  } catch (err) {
    console.warn(`Failed to fetch iCal from ${icalUrl}:`, err.message);
    return [];
  }
}

/**
 * Check if dates are available across all external calendars
 * Returns { available: boolean, conflicts: [] }
 */
export async function checkAvailability(propertyId, checkIn, checkOut) {
  let externalCalendars = {};
  try {
    externalCalendars = await getExternalCalendars(propertyId);
  } catch {
    return { available: true, conflicts: [] };
  }

  if (Object.keys(externalCalendars).length === 0) {
    return { available: true, conflicts: [] };
  }

  const requestedCheckIn  = new Date(checkIn);
  const requestedCheckOut = new Date(checkOut);
  const conflicts = [];

  for (const [platform, url] of Object.entries(externalCalendars)) {
    const bookings = await fetchExternalBookings(url);
    for (const booking of bookings) {
      if (requestedCheckIn < booking.end && requestedCheckOut > booking.start) {
        conflicts.push({
          platform,
          conflictStart: booking.start,
          conflictEnd:   booking.end,
          summary:       booking.summary
        });
      }
    }
  }

  return { available: conflicts.length === 0, conflicts };
}
