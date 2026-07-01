// Extracted verbatim from server.mjs (R1 route-module split, July 1 2026).
import { getSuiUSDLiquidity, calculateHostPayout } from '../deepbook.mjs';
import { generateICal, saveExternalCalendar, checkAvailability, assertPublicHttpsUrl } from '../ical.mjs';
import { getProperty } from '../catalog.mjs';
import { isHost, canManageProperty, getAuthedSession } from '../authz.mjs';

export default async function miscRoutes(fastify) {
// DeepBook
fastify.get('/deepbook/payout/:amount', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  const amount = parseFloat(request.params.amount);
  if (!amount || amount <= 0) return reply.code(400).send({ error: 'Invalid amount' });
  const liquidity = await getSuiUSDLiquidity(amount);
  const payout    = calculateHostPayout(amount);
  return { ...payout, liquidity, timestamp: new Date().toISOString() };
});

// iCal
fastify.get('/ical/:propertyId', async (request, reply) => {
  const { propertyId } = request.params;
  // Previously a hardcoded map of only the 6 fixed catalog titles, so any
  // host-imported listing's exported .ics feed showed "Property {id}"
  // instead of its real title. getProperty() resolves both sources.
  const prop = await getProperty(propertyId, fastify.log);
  const icalData = await generateICal(propertyId, prop?.title || 'Property ' + propertyId);
  reply.header('Content-Type', 'text/calendar; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="aria-property-${propertyId}.ics"`);
  return reply.send(icalData);
});

fastify.post('/ical/import', async (request, reply) => {
  const session = await getAuthedSession(request, reply);
  if (!session) return;
  const { propertyId, platform, icalUrl } = request.body;
  if (!propertyId || !platform || !icalUrl) return reply.code(400).send({ error: 'propertyId, platform and icalUrl required' });
  // Review finding #2 (SSRF + authz): only a host who manages this property may
  // register a feed URL the server will later fetch, and the URL must be a public
  // https endpoint (assertPublicHttpsUrl blocks internal/metadata addresses).
  if (!(await isHost(session))) return reply.code(403).send({ error: 'Host access required' });
  if (!(await canManageProperty(session, propertyId))) return reply.code(403).send({ error: 'You do not manage this property' });
  try {
    await assertPublicHttpsUrl(icalUrl);
  } catch (err) {
    return reply.code(400).send({ error: `Invalid iCal URL: ${err.message}` });
  }
  const saved = await saveExternalCalendar(propertyId, platform, icalUrl);
  return { success: true, message: `${platform} calendar synced for property ${propertyId}`, calendars: saved };
});

fastify.get('/availability/:propertyId', async (request, reply) => {
  const { propertyId } = request.params;
  const { checkIn, checkOut } = request.query;
  if (!checkIn || !checkOut) return reply.code(400).send({ error: 'checkIn and checkOut required' });
  const availability = await checkAvailability(propertyId, checkIn, checkOut);
  return { propertyId, checkIn, checkOut, ...availability };
});
}
