import { startMockRedis } from './mock-redis.mjs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(exec);   // async — the mock server lives in THIS process,
                               // so blocking the event loop would deadlock it.
const mock = await startMockRedis();
process.env.UPSTASH_REDIS_REST_URL = mock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = 't';
const { redis, putApplication, putEnquiry, listApplications, listEnquiries } =
  await import(new URL('../api/_lib/redis.js', import.meta.url).href);

for (let i=0;i<4;i++) await putApplication({ id:`BCCI-${i}`, company:`Co ${i}`, email:`m${i}@x.com`, repName:'R', status:'Pending', submittedAt:new Date(Date.now()+i).toISOString() });
for (let i=0;i<3;i++) await putEnquiry({ id:`ENQ-${i}`, name:`N${i}`, email:`e${i}@x.com`, submittedAt:new Date().toISOString() });
await redis.set('admin:tok1','admin@x.com');
await redis.set('applicant:tok2','m1@x.com');
await redis.set('bcci:otp:m1@x.com','123456');
await redis.set('bcci:email_log',[{id:'E1'}]);

const purge = (args='') => run(`node scripts/purge-data.mjs ${args}`,
  { cwd: new URL('..', import.meta.url).pathname, env: process.env });

let pass=0, fail=0;
const ck=(n,c,d='')=>{c?(pass++,console.log('  PASS  '+n)):(fail++,console.log('  FAIL  '+n+(d?' — '+d:'')));};

console.log(`\nSeeded: ${(await listApplications()).length} applications, ${(await listEnquiries()).length} enquiries\n`);

console.log('Dry run is the default'); console.log('──────────────────────');
let out = (await purge()).stdout;
ck('says DRY RUN', out.includes('DRY RUN'));
ck('lists the applications', /applications/.test(out));
ck('tells you how to proceed', out.includes('--confirm'));
ck('deleted NOTHING', (await listApplications()).length === 4, `${(await listApplications()).length} left`);

console.log('\nLive purge, member data only'); console.log('────────────────────────────');
out = (await purge('--confirm')).stdout;
ck('applications gone', (await listApplications()).length === 0);
ck('enquiries gone', (await listEnquiries()).length === 0);
ck('email index gone', (await redis.get('bcci:app_email:m1@x.com')) === null);
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
