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
  ck('Paid event venue redacted on public GET', ev?.venue?.includes('Meeting details will be sent to registered attendees'));

  // Admin GET should reveal the real venue
  const adminGet = mockReqRes({ method: 'GET', headers: { authorization: `Bearer ${adminToken}` } });
  await eventsHandler(adminGet.req, adminGet.res);
  const adminEv = adminGet.getJson()?.events?.find(e => e.id === createdEventId);
  ck('Admin GET reveals real venue for paid event', adminEv?.venue === 'BCCI Convention Center, Bharuch');
}

// 4b. SEC-05: Virtual/Online event meeting URL is redacted on public GET
let onlineEventId = '';
{
  const { req, res, getStatus, getJson } = mockReqRes({
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` },
    body: {
      title: 'BCCI Virtual Webinar on GST Updates',
      date: '2026-12-01',
      time: '03:00 PM - 05:00 PM',
      capacity: 100,
      pricingType: 'free',
      fee: 0,
      mode: 'online',
      venue: 'https://meet.google.com/audit-secret-room',
      description: 'Online GST awareness session for BCCI members.',
    },
  });
  await eventsHandler(req, res);
  ck('Admin can create online virtual event', getStatus() === 201);
  onlineEventId = getJson()?.event?.id;
}
{
  const { req, res, getStatus, getJson } = mockReqRes({ method: 'GET' });
  await eventsHandler(req, res);
  const ev = getJson()?.events?.find(e => e.id === onlineEventId);
  ck('SEC-05: Public GET redacts online meeting URL', !ev?.venue?.includes('meet.google.com') && ev?.venue?.includes('Meeting details will be sent to registered attendees'));

  // Admin GET should reveal the real URL
  const adminGet = mockReqRes({ method: 'GET', headers: { authorization: `Bearer ${adminToken}` } });
  await eventsHandler(adminGet.req, adminGet.res);
  const adminEv = adminGet.getJson()?.events?.find(e => e.id === onlineEventId);
  ck('SEC-05: Admin GET reveals real virtual meeting URL', adminEv?.venue === 'https://meet.google.com/audit-secret-room');
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
  ck('SEC-04: Paid registration response does NOT expose ticketId', getJson()?.ticketId === undefined);
  ck('SEC-04: Paid attendee record does NOT expose ticketId', getJson()?.attendee?.ticketId === undefined);
  ck('Attendee record contains paymentRef', getJson()?.attendee?.paymentRef === 'UPI/982512345678');
  ck('SEC-04: Paid attendee is pending payment verification', getJson()?.attendee?.status === 'pending' && getJson()?.attendee?.paymentStatus === 'pending_verification');
  ck('SEC-04: Response message informs verification pending', getJson()?.message?.toLowerCase().includes('pending'));
  ck('VULN-P4-01: Paid event registration redacts venue in response body', getJson()?.event?.venue?.includes('Meeting details will be sent to registered attendees'));
  ck('VULN-P4-01: Response does NOT leak secret venue before payment verification', !getJson()?.event?.venue?.includes('BCCI Convention Center, Bharuch'));

  // Admin retrieves attendees to verify ticketId is only accessible with admin authorization
  const adminAttendees = mockReqRes({
    method: 'GET',
    headers: { authorization: `Bearer ${adminToken}` },
    query: { id: createdEventId, includeAttendees: 'true' },
  });
  await eventsHandler(adminAttendees.req, adminAttendees.res);
  firstTicketId = adminAttendees.getJson()?.event?.attendees?.[0]?.ticketId;
  ck('SEC-04: Admin can retrieve attendee ticket ID for verification', !!firstTicketId);
}

// 5c. SEC-04: Secretariat payment confirmation workflow
{
  // Non-admin rejected
  const unauth = mockReqRes({
    method: 'POST',
    body: { action: 'confirm-payment', eventId: createdEventId, ticketId: firstTicketId },
  });
  await eventsHandler(unauth.req, unauth.res);
  ck('SEC-04: Non-admin cannot confirm payment → 401', unauth.getStatus() === 401);

  // Missing fields rejected
  const missing = mockReqRes({
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` },
    body: { action: 'confirm-payment', eventId: createdEventId },
  });
  await eventsHandler(missing.req, missing.res);
  ck('SEC-04: Missing ticket ID rejected → 400', missing.getStatus() === 400);

  // Admin confirms payment
  const confirm = mockReqRes({
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` },
    body: { action: 'confirm-payment', eventId: createdEventId, ticketId: firstTicketId },
  });
  await eventsHandler(confirm.req, confirm.res);
  ck('SEC-04: Admin confirms attendee payment → 200', confirm.getStatus() === 200);
  ck('SEC-04: Attendee status becomes confirmed', confirm.getJson()?.attendee?.status === 'confirmed');
  ck('SEC-04: Attendee paymentStatus becomes confirmed', confirm.getJson()?.attendee?.paymentStatus === 'confirmed');

  // VULN-P4-04: Replay confirmation is idempotent and marks alreadyConfirmed
  const replayConfirm = mockReqRes({
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}` },
    body: { action: 'confirm-payment', eventId: createdEventId, ticketId: firstTicketId },
  });
  await eventsHandler(replayConfirm.req, replayConfirm.res);
  ck('VULN-P4-04: Replay confirmation succeeds idempotently → 200', replayConfirm.getStatus() === 200);
  ck('VULN-P4-04: Replay confirmation flags alreadyConfirmed: true', replayConfirm.getJson()?.alreadyConfirmed === true);
  ck('VULN-P4-04: Message indicates already verified', replayConfirm.getJson()?.message?.includes('already verified'));
}

// 5d. SEC-04: Free event registration is instantly confirmed
{
  const freeReg = mockReqRes({
    method: 'POST',
    query: { action: 'register' },
    body: {
      eventId: onlineEventId,
      name: 'Free Attendee',
      email: 'freeattendee@example.com',
      phone: '9825111222',
      company: 'Free Corp',
    },
  });
  await eventsHandler(freeReg.req, freeReg.res);
  ck('Free event registration returns 200', freeReg.getStatus() === 200);
  ck('Free attendee status is confirmed immediately', freeReg.getJson()?.attendee?.status === 'confirmed');
  ck('Free attendee paymentStatus is confirmed immediately', freeReg.getJson()?.attendee?.paymentStatus === 'confirmed');
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
