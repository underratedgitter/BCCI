// api/enquiries.js
// Contact enquiries — public create, admin-only list.

import crypto from 'crypto';
import { listEnquiries, putEnquiry, trimEnquiries } from './_lib/redis.js';
import {
  applyCors,
  handlePreflight,
  requireAdmin,
  rateLimit,
  tooManyRequests,
  clientIp,
  str,
  isEmail,
  withErrorHandling,
} from './_lib/http.js';

function newEnquiryId() {
  // The old scheme drew from 500 possible values with no uniqueness check —
  // a 50% chance of a collision after 27 enquiries.
  return `ENQ-${Date.now().toString(36).toUpperCase()}-${crypto
    .randomBytes(3)
    .toString('hex')
    .toUpperCase()}`;
}

async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS');
  if (handlePreflight(req, res)) return;

  // ── List — admin only ────────────────────────────────────────────
  if (req.method === 'GET') {
    // This returns names, emails, phone numbers and message bodies; it was
    // previously readable by anyone.
    if (!(await requireAdmin(req, res))) return;
    const enquiries = await listEnquiries();
    return res.status(200).json({ success: true, enquiries });
  }

  // ── Create — public ──────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};
    const name = str(body.name, 120);
    const email = str(body.email, 254).toLowerCase();
    const phone = str(body.phone, 20).replace(/\D/g, '');
    const subject = str(body.subject, 200);
    const message = str(body.message, 4000);

    if (name.length < 2) {
      return res.status(400).json({ success: false, error: 'Full name is required (min 2 characters).' });
    }
    if (!isEmail(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email address format.' });
    }
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ success: false, error: 'Invalid 10-digit Indian mobile number.' });
    }
    if (!subject) {
      return res.status(400).json({ success: false, error: 'Subject is required.' });
    }
    if (message.length < 2) {
      return res.status(400).json({ success: false, error: 'Message is required (min 2 characters).' });
    }

    // Limit by email and by network, so rotating the email address alone is
    // not enough to flood the inbox.
    const byEmail = await rateLimit(`enquiry:email:${email}`, { max: 1, windowSec: 60 });
    if (!byEmail.ok) {
      return tooManyRequests(res, byEmail.retryAfter, 'Please wait a minute before submitting another enquiry.');
    }
    const byIp = await rateLimit(`enquiry:ip:${clientIp(req)}`, { max: 10, windowSec: 3600 });
    if (!byIp.ok) {
      return tooManyRequests(res, byIp.retryAfter, 'Too many enquiries from this network. Please try again later.');
    }

    const enquiry = {
      id: newEnquiryId(),
      name,
      email,
      phone,
      company: str(body.company, 200) || 'N/A',
      subject,
      message,
      membershipType: str(body.membershipType, 120) || 'None',
      submittedAt: new Date().toISOString(),
    };

    await putEnquiry(enquiry);
    trimEnquiries(1000).catch((err) =>
      console.warn('[Enquiries] trim failed:', err.message)
    );

    console.log(`[BCCI Enquiry] Created ${enquiry.id}`);
    return res.status(201).json({
      success: true,
      message: 'Enquiry submitted successfully.',
      enquiry,
    });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed.' });
}

export default withErrorHandling('Enquiries', handler);
