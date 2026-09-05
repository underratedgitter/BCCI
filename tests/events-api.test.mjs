import { startMockRedis } from './mock-redis.mjs';
const mock = await startMockRedis();
process.env.UPSTASH_REDIS_REST_URL = mock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 't';

let pass = 0, fail = 0;
const ck = (n, c, d = '') => {
  c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (d ? ' — ' + d : '')));
};

console.log('\nTask 2: Events REST API Endpoints');
console.log('─────────────────────────────────');

// Helper to simulate request/response against api/events handler
const eventsHandler = (await import(new URL('../api', import.meta.url).pathname + '/events.js')).default;
const { redis, KEYS } = await import(new URL('../api', import.meta.url).pathname + '/_lib/redis.js');

// Seed an admin session
const adminToken = 'test-admin-token-123';
await redis.set(KEYS.adminSession(adminToken), 'admin@bccibharuch.in', { ex: 3600 });

function mockReqRes({ method = 'GET', query = {}, body = {}, headers = {} }) {
  const req = {
    method,
    query,
    body,
    headers: { ...headers },
  };
  let statusCode = 200;
  let jsonResponse = null;
  const res = {
    status(c) { statusCode = c; return this; },
    json(d) { jsonResponse = d; return this; },
    setHeader() { return this; },
    end() { return this; },
  };
  return { req, res, getStatus: () => statusCode, getJson: () => jsonResponse };
}

// 1. GET /api/events initially returns empty list
{
  const { req, res, getStatus, getJson } = mockReqRes({ method: 'GET' });
  await eventsHandler(req, res);
  ck('GET /api/events returns 200', getStatus() === 200);
  ck('GET /api/events returns array', Array.isArray(getJson()?.events));
}

// 2. POST /api/events without admin auth returns 401
{
  const { req, res, getStatus, getJson } = mockReqRes({
    method: 'POST',
    body: { title: 'Unauthorized Event', date: '2026-12-01', capacity: 50 },
  });
  await eventsHandler(req, res);
  ck('POST /api/events without auth returns 401', getStatus() === 401);
}

// 3. POST /api/events with admin auth and validation
let createdEventId = null;
{
  const { req, res, getStatus, getJson } = mockReqRes({
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` },
    body: {
      title: 'BCCI Tech & Export Summit 2026',
      date: '2026-11-25',
      time: '11:00 AM - 04:00 PM',
      capacity: 2, // capacity 2
      pricingType: 'paid',
      fee: 500,
      mode: 'offline',
      venue: 'BCCI Convention Center, Bharuch',
      description: 'Exclusive trade & export summit for chemical & manufacturing industries.',
    },
  });
  await eventsHandler(req, res);
  ck('POST /api/events with admin auth returns 201', getStatus() === 201);
  ck('Created event has ID and title', getJson()?.event?.title === 'BCCI Tech & Export Summit 2026');
  createdEventId = getJson()?.event?.id;
}

// 4. GET /api/events now lists the created event with seatsLeft
{
  const { req, res, getStatus, getJson } = mockReqRes({ method: 'GET' });
  await eventsHandler(req, res);
  const ev = getJson()?.events?.find(e => e.id === createdEventId);
  ck('Event present in listing', !!ev);
  ck('Initial seatsLeft equals capacity', ev?.seatsLeft === 2 && ev?.registeredCount === 0);
}

// 5. POST /api/events?action=register on paid event requires paymentRef
{
  const { req, res, getStatus, getJson } = mockReqRes({
    method: 'POST',
    query: { action: 'register' },
    body: {
      eventId: createdEventId,
      name: 'Ramesh Patel',
      email: 'ramesh@example.com',
      phone: '9825123456',
      company: 'Patel Exporters Ltd',
    },
  });
  await eventsHandler(req, res);
  ck('Paid event registration without paymentRef returns 400', getStatus() === 400);
  ck('Error mentions payment reference', getJson()?.error?.toLowerCase().includes('payment'));
}

// 5b. POST /api/events?action=register with paymentRef registers an attendee and generates ticket
let firstTicketId = null;
{
  const { req, res, getStatus, getJson } = mockReqRes({
    method: 'POST',
    query: { action: 'register' },
    body: {
      eventId: createdEventId,
      name: 'Ramesh Patel',
      email: 'ramesh@example.com',
      phone: '9825123456',
      company: 'Patel Exporters Ltd',
      paymentRef: 'UPI/982512345678',
    },
  });
  await eventsHandler(req, res);
  ck('Attendee registration returns 200', getStatus() === 200);
  ck('Registration confirms success', getJson()?.success === true);
  ck('Registration returns ticketId', !!getJson()?.ticketId);
  ck('Attendee record contains paymentRef', getJson()?.attendee?.paymentRef === 'UPI/982512345678');
  firstTicketId = getJson()?.ticketId;
}

// 6. Second registration succeeds with paymentRef (reaching capacity 2 of 2)
{
  const { req, res, getStatus } = mockReqRes({
    method: 'POST',
    query: { action: 'register' },
    body: {
      eventId: createdEventId,
      name: 'Deepak Shah',
      email: 'deepak@example.com',
      phone: '9825654321',
      company: 'Shah Chemicals',
      paymentRef: 'UPI/888777666555',
    },
  });
  await eventsHandler(req, res);
  ck('Second attendee registration returns 200', getStatus() === 200);
}

// 7. Third registration rejected with 409 (Capacity reached)
{
  const { req, res, getStatus, getJson } = mockReqRes({
    method: 'POST',
    query: { action: 'register' },
    body: {
      eventId: createdEventId,
      name: 'Third Person',
      email: 'third@example.com',
      phone: '9825999888',
      company: 'Third Corp',
      paymentRef: 'UPI/999888777666',
    },
  });
  await eventsHandler(req, res);
  ck('Registration beyond capacity returns 409', getStatus() === 409);
  ck('Error explains capacity reached', getJson()?.error?.includes('capacity'));
}

// 8. Admin DELETE /api/events deletes the event
{
  const { req, res, getStatus, getJson } = mockReqRes({
    method: 'DELETE',
    query: { id: createdEventId },
    headers: { authorization: `Bearer ${adminToken}` },
  });
  await eventsHandler(req, res);
  ck('DELETE /api/events returns 200', getStatus() === 200);
}

// 9. After deletion, event is gone
{
  const { req, res, getJson } = mockReqRes({ method: 'GET' });
  await eventsHandler(req, res);
  const ev = getJson()?.events?.find(e => e.id === createdEventId);
  ck('Deleted event no longer in list', !ev);
}

console.log(`\n${'═'.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(52)}`);
mock.server.close();
process.exit(fail ? 1 : 0);
