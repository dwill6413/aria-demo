import ical from 'ical-generator';
import icalParser from 'ical.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

// Directory to store property calendars and external iCal links
const CALENDARS_DIR = join(process.cwd(), 'calendars');
if (!existsSync(CALENDARS_DIR)) mkdirSync(CALENDARS_DIR);

/**
 * Get all local bookings for a property from receipts folder
 */
function getLocalBookings(propertyId) {
  const receiptsDir = join(process.cwd(), 'receipts');
  if (!existsSync(receiptsDir)) return [];

  const bookings = [];
  try {
    const files = readdirSync(receiptsDir).filter(f => f.includes(`ARIA-${propertyId}-`));
    for (const file of files) {
      try {
        const receipt = JSON.parse(readFileSync(join(receiptsDir, file), 'utf8'));
        if (receipt.checkIn && receipt.checkOut) {
          bookings.push({
            ref: receipt.bookingRef,
            checkIn: new Date(receipt.checkIn),
            checkOut: new Date(receipt.checkOut),
            guestName: receipt.guestName || 'ARIA Guest'
          });
        }
      } catch (e) {}
    }
  } catch (e) {}
  return bookings;
}

/**
 * Generate iCal export for a property
 * Hosts paste this URL into Airbnb/VRBO to sync ARIA bookings
 */
export function generateICal(propertyId, propertyTitle) {
  const calendar = ical({ name: `ARIA — ${propertyTitle}` });
  const bookings = getLocalBookings(propertyId);

  for (const booking of bookings) {
    calendar.createEvent({
      start: booking.checkIn,
      end: booking.checkOut,
      summary: `ARIA Booking — ${booking.ref}`,
      description: `Booked via ARIA. Ref: ${booking.ref}`,
      id: booking.ref
    });
  }

  return calendar.toString();
}

/**
 * Save external iCal URL for a property (Airbnb/VRBO feed)
 */
export function saveExternalCalendar(propertyId, platform, icalUrl) {
  const file = join(CALENDARS_DIR, `property-${propertyId}-external.json`);
  let existing = {};
  if (existsSync(file)) {
    existing = JSON.parse(readFileSync(file, 'utf8'));
  }
  existing[platform] = icalUrl;
  writeFileSync(file, JSON.stringify(existing, null, 2));
  return existing;
}

/**
 * Fetch and parse external iCal feed (Airbnb/VRBO)
 */
async function fetchExternalBookings(icalUrl) {
  try {
    const res = await fetch(icalUrl);
    const text = await res.text();
    const parsed = icalParser.parse(text);
    const comp = new icalParser.Component(parsed);
    const events = comp.getAllSubcomponents('vevent');

    return events.map(event => ({
      start: new Date(event.getFirstPropertyValue('dtstart')),
      end: new Date(event.getFirstPropertyValue('dtend')),
      summary: event.getFirstPropertyValue('summary') || 'Blocked'
    }));
  } catch (err) {
    console.warn(`Failed to fetch iCal from ${icalUrl}:`, err.message);
    return [];
  }
}

/**
 * Check if dates are available across all external calendars
 * Returns true if available, false if blocked
 */
export async function checkAvailability(propertyId, checkIn, checkOut) {
  const file = join(CALENDARS_DIR, `property-${propertyId}-external.json`);
  if (!existsSync(file)) return { available: true, conflicts: [] };

  const externalCalendars = JSON.parse(readFileSync(file, 'utf8'));
  const requestedCheckIn = new Date(checkIn);
  const requestedCheckOut = new Date(checkOut);
  const conflicts = [];

  for (const [platform, url] of Object.entries(externalCalendars)) {
    const bookings = await fetchExternalBookings(url);
    for (const booking of bookings) {
      if (requestedCheckIn < booking.end && requestedCheckOut > booking.start) {
        conflicts.push({
          platform,
          conflictStart: booking.start,
          conflictEnd: booking.end,
          summary: booking.summary
        });
      }
    }
  }

  return {
    available: conflicts.length === 0,
    conflicts
  };
}