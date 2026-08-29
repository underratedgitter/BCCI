// api/renewal-check.js
// Daily job (Vercel Cron, 09:00) that emails members whose membership is
// about to expire. Scheduled by the "crons" entry in vercel.json.

import { redis, listApplications, STATUS } from './_lib/redis.js';
import { sendEmail } from './_lib/email.js';
import { safeEqual, bearerToken, str, withErrorHandling } from './_lib/http.js';

const REMINDERS_KEY = 'bcci:renewal_reminders';
const REMIND_WITHIN_DAYS = 3;

function membershipExpiry(app) {
  if (!app || app.status !== STATUS.APPROVED) return null;
  const from = app.approvedAt ? new Date(app.approvedAt) : new Date(app.submittedAt || Date.now());
  const until = new Date(from);
  until.setFullYear(until.getFullYear() + (Number(app.renewalYears) || 1));
  return Number.isNaN(until.getTime()) ? null : until;
}

async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[Renewal] CRON_SECRET is not configured');
    return res.status(503).json({ success: false, error: 'Renewal job is not configured.' });
  }

  // The previous guard read:
  //   if (!isVercelCron && !isManualTest && req.method !== 'GET')
  // which let any anonymous GET through, because the last clause was false.
  const isCron = safeEqual(bearerToken(req), secret);
  const isManual = safeEqual(str(req.query?.secret, 200), secret);
  if (!isCron && !isManual) {
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }

  const applications = await listApplications();
  const reminders = (await redis.get(REMINDERS_KEY)) || {};
  const now = new Date();

  let membersChecked = 0;
  let emailsSent = 0;
  let emailsFailed = 0;
  const results = [];

  for (const app of applications) {
    if (app.status !== STATUS.APPROVED) continue;

    const expiry = membershipExpiry(app);
    if (!expiry || !app.email) continue;

    membersChecked++;
    const daysLeft = Math.ceil((expiry.getTime() - now.getTime()) / 86400000);
    if (daysLeft < 0 || daysLeft > REMIND_WITHIN_DAYS) continue;

    // One reminder per member per expiry date, including the expiry day
    // itself. Previously the day-0 reminder used a key with no date in it,
    // so it fired only once for the life of the membership.
    const reminderKey = `${app.id}_${expiry.toISOString().slice(0, 10)}_${daysLeft}`;
    if (reminders[reminderKey]) continue;

    // Sending through the shared library avoids the old self-fetch back into
    // /api/send-email, which guessed its own hostname from request headers.
    const result = await sendEmail({
      type: 'renewal_reminder',
      to: app.email,
      data: {
        appId: app.id,
        company: app.company,
        repName: app.repName || 'Member',
        validUntil: expiry.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
        daysLeft,
      },
    });

    if (result.success) {
      reminders[reminderKey] = { sentAt: now.toISOString(), daysLeft };
      emailsSent++;
      results.push({ appId: app.id, company: app.company, daysLeft, status: 'sent' });
    } else {
      emailsFailed++;
      results.push({ appId: app.id, company: app.company, daysLeft, status: 'failed', error: result.error });
    }
  }

  // Drop ledger entries older than a year so this key cannot grow forever.
  const cutoff = Date.now() - 365 * 86400000;
  for (const [key, value] of Object.entries(reminders)) {
    const sentAt = Date.parse(value?.sentAt || '');
    if (Number.isFinite(sentAt) && sentAt < cutoff) delete reminders[key];
  }
  await redis.set(REMINDERS_KEY, reminders);

  console.log(`[Renewal] checked=${membersChecked} sent=${emailsSent} failed=${emailsFailed}`);

  return res.status(200).json({
    success: true,
    message: `Renewal check complete. ${emailsSent} reminder${emailsSent === 1 ? '' : 's'} sent.`,
    summary: { timestamp: now.toISOString(), membersChecked, emailsSent, emailsFailed, results },
  });
}

export default withErrorHandling('RenewalCheck', handler);
