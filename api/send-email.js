// api/send-email.js
// Internal-only email dispatcher, kept for operational testing.
//
// The application flow no longer calls this route — applications.js sends
// through api/_lib/email.js directly. This endpoint used
// to be public and unauthenticated, which let anyone send arbitrary HTML to
// any address from BCCI's own mailbox.

import { TEMPLATES, sendEmail } from './_lib/email.js';
import {
  applyCors,
  handlePreflight,
  bearerToken,
  safeEqual,
  getAdminSession,
  rateLimit,
  tooManyRequests,
  isEmail,
  withErrorHandling,
} from './_lib/http.js';

// One call is one operational email, not a mail-merge: cap the recipients and
// the rate so a compromised admin session cannot be turned into a bulk mailer.
const MAX_RECIPIENTS = 10;
const SEND_LIMIT = { max: 30, windowSec: 3600 };

/** Every address in the request, split out and trimmed, in submission order. */
function parseRecipients(raw) {
  return (Array.isArray(raw) ? raw : [raw])
    .filter((value) => typeof value === 'string')
    .flatMap((value) => value.split(/[,;]/))
    .map((value) => value.trim())
    .filter(Boolean);
}

async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');
  if (handlePreflight(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }

  const token = bearerToken(req);
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const isInternal = Boolean(internalSecret) && safeEqual(token, internalSecret);
  const adminEmail = isInternal ? null : await getAdminSession(req);

  if (!isInternal && !adminEmail) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  // Per caller: the internal secret is one caller of its own, so it keeps
  // working without sharing an administrator's allowance.
  const limit = await rateLimit(`send-email:${adminEmail || 'internal'}`, SEND_LIMIT);
  if (!limit.ok) {
    return tooManyRequests(res, limit.retryAfter, 'Too many emails sent from this account. Please try again later.');
  }

  const { type, to, data } = req.body || {};

  if (typeof type !== 'string' || !Object.hasOwn(TEMPLATES, type)) {
    return res.status(400).json({
      success: false,
      error: `Invalid email type. Valid types: ${Object.keys(TEMPLATES).join(', ')}`,
    });
  }

  const recipients = parseRecipients(to);
  if (!recipients.length) {
    return res.status(400).json({ success: false, error: 'Recipient email is required.' });
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return res.status(400).json({
      success: false,
      error: `At most ${MAX_RECIPIENTS} recipients may be given per email.`,
    });
  }
  // The transport would happily take a malformed recipient; check every one
  // with the same validator the public forms use.
  if (recipients.some((address) => !isEmail(address))) {
    return res.status(400).json({ success: false, error: 'Every recipient must be a valid email address.' });
  }
  if (!data) return res.status(400).json({ success: false, error: 'Email data is required.' });

  const result = await sendEmail({ type, to: recipients.length === 1 ? recipients[0] : recipients, data });

  if (!result.success) {
    // The SMTP reason can name an internal host, port or credential. Keep it
    // in the log and hand the caller a generic failure.
    console.error(`[SendEmail] ${type} to ${recipients.join(', ')} failed:`, result.error);
    return res.status(502).json({ success: false, error: 'The email could not be sent.' });
  }
  return res.status(200).json({ success: true, message: 'Email sent.' });
}

export default withErrorHandling('SendEmail', handler);
