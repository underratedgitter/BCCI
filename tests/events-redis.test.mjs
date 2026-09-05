import { startMockRedis } from './mock-redis.mjs';
const mock = await startMockRedis();
process.env.UPSTASH_REDIS_REST_URL = mock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 't';

const lib = await import(new URL('../api', import.meta.url).pathname + '/_lib/redis.js');
const {
  listEvents,
  getEvent,
  putEvent,
  deleteEvent,
  getEventAttendees,
  registerForEvent,
} = lib;

let pass = 0, fail = 0;
const ck = (n, c, d = '') => {
  c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (d ? ' — ' + d : '')));
};

console.log('\nTask 1: Redis Event Model & Capacity Tracking');
console.log('─────────────────────────────────────────────');

// 1. Put and List Events
const event1 = {
  id: 'EVT-TEST-1',
  title: 'BCCI Industrial Summit 2026',
  date: '2026-11-20',
  time: '10:00 AM - 01:00 PM',
  mode: 'offline',
  venue: 'BCCI Auditorium, Bharuch',
  pricingType: 'free',
  fee: 0,
  capacity: 2, // small capacity for test
  description: 'Annual industrial gathering in Bharuch.',
  status: 'published',
  createdAt: '2026-09-05T10:00:00.000Z',
};

await putEvent(event1);
const fetched = await getEvent('EVT-TEST-1');
ck('getEvent returns saved event', fetched?.title === event1.title, `got ${fetched?.title}`);

const list = await listEvents();
ck('listEvents returns event', list.some(e => e.id === 'EVT-TEST-1'));

// 2. Register for Event (First attendee)
const reg1 = await registerForEvent('EVT-TEST-1', {
  name: 'Anil Sharma',
  email: 'anil@example.com',
  phone: '9825012345',
  company: 'Sharma Industries',
});
ck('first registration succeeds', reg1.success === true && reg1.event?.registeredCount === 1);

// 3. Duplicate email registration rejected
const dup = await registerForEvent('EVT-TEST-1', {
  name: 'Anil Sharma',
  email: 'anil@example.com',
  phone: '9825012345',
  company: 'Sharma Industries',
});
ck('duplicate email registration rejected', dup.success === false && dup.error?.includes('already registered'));

// 4. Second attendee reaches capacity
const reg2 = await registerForEvent('EVT-TEST-1', {
  name: 'Bhavik Patel',
  email: 'bhavik@example.com',
  phone: '9825054321',
  company: 'Patel Chemicals',
});
ck('second registration reaches capacity', reg2.success === true && reg2.event?.registeredCount === 2);

// 5. Third attendee rejected due to capacity limit
const reg3 = await registerForEvent('EVT-TEST-1', {
  name: 'Chetan Desai',
  email: 'chetan@example.com',
  phone: '9825098765',
  company: 'Desai Synthetics',
});
ck('over-capacity registration rejected', reg3.success === false && reg3.error?.includes('capacity'));

// 6. Verify attendees list
const attendees = await getEventAttendees('EVT-TEST-1');
ck('getEventAttendees returns 2 attendees', attendees.length === 2, `got ${attendees.length}`);
ck('attendees include Anil and Bhavik', attendees.some(a => a.email === 'anil@example.com') && attendees.some(a => a.email === 'bhavik@example.com'));

// 7. Delete event
const deleted = await deleteEvent('EVT-TEST-1');
ck('deleteEvent succeeds', deleted === true);
const afterDelete = await getEvent('EVT-TEST-1');
ck('deleted event is gone', afterDelete === null);

console.log(`\n${'═'.repeat(52)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(52)}`);
mock.server.close();
process.exit(fail ? 1 : 0);
