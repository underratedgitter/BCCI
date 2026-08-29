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
  withErrorHandling,
} from './_lib/http.js';

async function handler(req, res) {
  applyCors(req, res, 'POST, OPTIONS');
  if (handlePreflight(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }

  const token = bearerToken(req);
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const isInternal = Boolean(internalSecret) && safeEqual(token, internalSecret);
  const isAdmin = isInternal ? true : Boolean(await getAdminSession(req));

  if (!isInternal && !isAdmin) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { type, to, data } = req.body || {};

  if (!type || !TEMPLATES[type]) {
    return res.status(400).json({
      success: false,
      error: `Invalid email type. Valid types: ${Object.keys(TEMPLATES).join(', ')}`,
    });
  }
  if (!to) return res.status(400).json({ success: false, error: 'Recipient email is required.' });
  if (!data) return res.status(400).json({ success: false, error: 'Email data is required.' });

  const result = await sendEmail({ type, to, data });

  if (!result.success) {
    return res.status(502).json({
      success: false,
      error: result.error || 'Failed to send email.',
    });
  }
  return res.status(200).json({ success: true, message: 'Email sent.' });
}

export default withErrorHandling('SendEmail', handler);
