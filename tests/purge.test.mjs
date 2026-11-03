import { startMockRedis } from './mock-redis.mjs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(exec);   // async — the mock server lives in THIS process,
                               // so blocking the event loop would deadlock it.
const mock = await startMockRedis();
process.env.UPSTASH_REDIS_REST_URL = mock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 't';
const { redis, putApplication, putEnquiry, putEvent, listApplications, listEnquiries, listEvents } =
  await import(new URL('../api/_lib/redis.js', import.meta.url).href);

for (let i=0;i<4;i++) await putApplication({ id:`BCCI-${i}`, company:`Co ${i}`, email:`m${i}@x.com`, repName:'R', status:'Pending', submittedAt:new Date(Date.now()+i).toISOString() });
for (let i=0;i<3;i++) await putEnquiry({ id:`ENQ-${i}`, name:`N${i}`, email:`e${i}@x.com`, submittedAt:new Date().toISOString() });
await putEvent({ id: 'evt-1', title: 'Tech Expo', date: '2026-10-01' });
await redis.set('bcci:account:m1@x.com', { email: 'm1@x.com' });
await redis.set('admin:tok1','admin@x.com');
await redis.set('applicant:tok2','m1@x.com');
await redis.set('bcci:otp:m1@x.com','123456');
await redis.set('bcci:email_log',[{id:'E1'}]);
await redis.set('bcci:plan:gold', { id: 'gold', fee: 5000 });
await redis.zadd('bcci:plan_index', { score: 1, member: 'gold' });
await redis.set('bcci:board:seq:member', 1);
await redis.set('bcci:board:member:BM-1', { id: 'BM-1', email: 'b@x.com' });
await redis.set('bcci:board:member_email:b@x.com', 'BM-1');
await redis.set('bcci:board:seq:meeting', 1);
await redis.set('bcci:board:meeting:MTG-1', { id: 'MTG-1' });
await redis.set('bcci:board:open_meeting', 'MTG-1');
await redis.set('bcci:board:open_meeting_indexed', '1');
await redis.set('bcci:board:att:MTG-1:BM-1', { status: 'present' });
await redis.set('bcci:board:pin:MTG-1', '1234');
await redis.set('bcci:board:pin_version:MTG-1', 'test-generation');
await redis.set('bcci:board:pin_fails:MTG-1', 2);
await redis.set('bcci:board:name_pass:tok-1', { meetingId: 'MTG-1', device: 'abc' });
await redis.set('bcci:board:device:MTG-1:abc', 'BM-1');

const purge = (args='') => run(`node scripts/purge-data.mjs ${args}`,
  { cwd: new URL('..', import.meta.url).pathname, env: process.env });

let pass=0, fail=0;
const ck=(n,c,d='')=>{c?(pass++,console.log('  PASS  '+n)):(fail++,console.log('  FAIL  '+n+(d?' — '+d:'')));};

console.log(`\nSeeded: ${(await listApplications()).length} applications, ${(await listEnquiries()).length} enquiries, ${(await listEvents()).length} events\n`);

console.log('Dry run is the default'); console.log('──────────────────────');
let out = (await purge()).stdout;
ck('says DRY RUN', out.includes('DRY RUN'));
ck('lists the applications', /applications/.test(out));
ck('lists the events', /events/.test(out));
ck('lists applicant accounts', /applicant accounts/.test(out));
ck('tells you how to proceed', out.includes('--confirm'));
ck('deleted NOTHING', (await listApplications()).length === 4, `${(await listApplications()).length} left`);
ck('dry run preserves the board PIN, pass and open-meeting pointer',
  String(await redis.get('bcci:board:pin:MTG-1')) === '1234' &&
  (await redis.get('bcci:board:name_pass:tok-1')) !== null &&
  (await redis.get('bcci:board:open_meeting')) === 'MTG-1');

console.log('\nLive purge, member data only'); console.log('────────────────────────────');
out = (await purge('--confirm')).stdout;
ck('applications gone', (await listApplications()).length === 0);
ck('enquiries gone', (await listEnquiries()).length === 0);
ck('events gone', (await listEvents()).length === 0);
ck('account gone', (await redis.get('bcci:account:m1@x.com')) === null);
ck('email index gone', (await redis.get('bcci:app_email:m1@x.com')) === null);
ck('custom membership types gone', (await redis.get('bcci:plan:gold')) === null && (await redis.zcard('bcci:plan_index')) === 0);
const boardLeft = await Promise.all(['bcci:board:seq:member', 'bcci:board:member:BM-1', 'bcci:board:member_email:b@x.com',
  'bcci:board:seq:meeting', 'bcci:board:meeting:MTG-1', 'bcci:board:open_meeting', 'bcci:board:open_meeting_indexed',
  'bcci:board:att:MTG-1:BM-1', 'bcci:board:pin:MTG-1', 'bcci:board:pin_version:MTG-1', 'bcci:board:pin_fails:MTG-1',
  'bcci:board:name_pass:tok-1', 'bcci:board:device:MTG-1:abc'].map((k) => redis.get(k)));
ck('board profiles, meetings, PINs, passes, marks and counters gone', boardLeft.every((v) => v === null), JSON.stringify(boardLeft));
ck('admin session PRESERVED', (await redis.get('admin:tok1')) === 'admin@x.com', 'should not touch sessions');
ck('email log PRESERVED', (await redis.get('bcci:email_log')) !== null);
ck('mentions what it left alone', out.includes('--all'));

console.log('\nPurge --all'); console.log('───────────');
out = (await purge('--confirm --all')).stdout;
ck('admin session cleared', (await redis.get('admin:tok1')) === null);
ck('applicant session cleared', (await redis.get('applicant:tok2')) === null);
ck('otp cleared', (await redis.get('bcci:otp:m1@x.com')) === null);
ck('email log cleared', (await redis.get('bcci:email_log')) === null);

console.log('\nIdempotent'); console.log('──────────');
out = (await purge('--confirm --all')).stdout;
ck('second run reports a clean database', out.includes('already clean'), out.trim().split('\n').pop());

console.log(`\n${'═'.repeat(50)}\n  ${pass} passed, ${fail} failed\n${'═'.repeat(50)}`);
mock.server.close();
process.exit(fail?1:0);
