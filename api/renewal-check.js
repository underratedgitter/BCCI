// api/renewal-check.js
// Vercel Serverless Function — BCCI Bharuch Membership Renewal Checker
// Runs daily via Vercel Cron (cron: "0 9 * * *")
// Checks all approved memberships expiring within 3 days
// Sends renewal reminder emails via /api/send-email

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const APPLICATIONS_KEY = 'bcci:applications';
const REMINDERS_KEY = 'bcci:renewal_reminders';
const CRON_SECRET = process.env.CRON_SECRET || '';

function getMembershipExpiry(app) {
  if (!app || app.status !== 'Approved') return null;
  const approvedDate = app.approvedAt ? new Date(app.approvedAt) : new Date(app.submittedAt || Date.now());
  const validUntil = new Date(approvedDate);
  validUntil.setFullYear(validUntil.getFullYear() + (app.renewalYears || 1));
  return validUntil;
}

export default async function handler(req, res) {
  // Verify cron secret for security (Vercel Cron sends this header)
  const authHeader = req.headers.authorization || '';
  const isVercelCron = authHeader === `Bearer ${CRON_SECRET}`;

  // Also allow manual trigger for testing (with query param)
  const isManualTest = req.query?.secret === CRON_SECRET;

  if (!isVercelCron && !isManualTest && req.method !== 'GET') {
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
  }

  try {
    const applications = (await redis.get(APPLICATIONS_KEY)) || [];
    const reminders = (await redis.get(REMINDERS_KEY)) || {};

    const now = new Date();
    const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
    const ONE_DAY_MS = 1 * 24 * 60 * 60 * 1000;

    let emailsSent = 0;
    let emailsFailed = 0;
    let membersChecked = 0;
    const results = [];

    for (const app of applications) {
      if (app.status !== 'Approved') continue;

      const expiryDate = getMembershipExpiry(app);
      if (!expiryDate) continue;

      membersChecked++;
      const daysUntilExpiry = Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

      // Send reminder if expiring in 1-3 days
      if (daysUntilExpiry > 0 && daysUntilExpiry <= 3) {
        // Check if already reminded for this expiry cycle
        const reminderKey = `${app.id}_${expiryDate.toISOString().split('T')[0]}`;

        if (reminders[reminderKey]) {
          // Already reminded for this expiry date
          continue;
        }

        // Send renewal reminder email
        try {
          const emailPayload = {
            type: 'renewal_reminder',
            to: app.email,
            data: {
              appId: app.id,
              company: app.company,
              repName: app.repName || 'Member',
              validUntil: expiryDate.toLocaleDateString('en-IN', {
                day: 'numeric', month: 'long', year: 'numeric'
              }),
              daysLeft: daysUntilExpiry,
            },
          };

          const emailRes = await fetch(
            `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host || 'bccibharuch.vercel.app'}/api/send-email`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(emailPayload),
            }
          );

          const emailResult = await emailRes.json();

          if (emailResult.success) {
            // Mark as reminded
            reminders[reminderKey] = {
              sentAt: now.toISOString(),
              daysUntilExpiry,
            };
            emailsSent++;
            results.push({
              appId: app.id,
              company: app.company,
              email: app.email,
              daysUntilExpiry,
              status: 'sent',
            });
            console.log(`[Renewal] Reminder sent to ${app.email} for ${app.id} (${daysUntilExpiry} days left)`);
          } else {
            emailsFailed++;
            results.push({
              appId: app.id,
              company: app.company,
              email: app.email,
              status: 'failed',
              error: emailResult.error,
            });
          }
        } catch (err) {
          emailsFailed++;
          results.push({
            appId: app.id,
            status: 'error',
            error: err.message,
          });
          console.error(`[Renewal] Failed to send reminder for ${app.id}:`, err.message);
        }
      }

      // Also send reminder on the day of expiry
      if (daysUntilExpiry === 0) {
        const todayKey = `${app.id}_expiry_day`;
        if (!reminders[todayKey]) {
          try {
            await fetch(
              `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host || 'bccibharuch.vercel.app'}/api/send-email`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  type: 'renewal_reminder',
                  to: app.email,
                  data: {
                    appId: app.id,
                    company: app.company,
                    repName: app.repName || 'Member',
                    validUntil: expiryDate.toLocaleDateString('en-IN', {
                      day: 'numeric', month: 'long', year: 'numeric'
                    }),
                    daysLeft: 0,
                  },
                }),
              }
            );
            reminders[todayKey] = { sentAt: now.toISOString() };
            emailsSent++;
          } catch (err) {
            emailsFailed++;
          }
        }
      }
    }

    // Save updated reminders
    await redis.set(REMINDERS_KEY, reminders);

    const summary = {
      timestamp: now.toISOString(),
      membersChecked,
      emailsSent,
      emailsFailed,
      results,
    };

    console.log(`[Renewal Check Complete] Checked: ${membersChecked}, Sent: ${emailsSent}, Failed: ${emailsFailed}`);

    return res.status(200).json({
      success: true,
      message: `Renewal check complete. ${emailsSent} reminders sent.`,
      summary,
    });

  } catch (err) {
    console.error('[Renewal Check Error]', err.message);
    return res.status(500).json({
      success: false,
      error: 'Internal server error.',
    });
  }
}
