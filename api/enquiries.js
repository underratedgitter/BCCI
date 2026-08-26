// api/enquiries.js
// Vercel Serverless Function — BCCI Bharuch Enquiries CRUD
// GET: List all enquiries | POST: Create new enquiry
// Uses Upstash Redis for persistent storage

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const ENQUIRIES_KEY = 'bcci:enquiries';
const RATE_LIMIT_KEY_PREFIX = 'bcci:ratelimit:enquiry:';

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function generateEnquiryId() {
  const num = Math.floor(500 + Math.random() * 500);
  return `ENQ-${num}`;
}

export default async function handler(req, res) {
  corsHeaders(res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      // ── List All Enquiries ─────────────────────────────────────────
      const enquiries = (await redis.get(ENQUIRIES_KEY)) || [];
      return res.status(200).json({ success: true, enquiries });
    }

    if (req.method === 'POST') {
      // ── Create New Enquiry ─────────────────────────────────────────
      const { name, email, phone, company, subject, message, membershipType } = req.body || {};

      // Validate required fields
      if (!name || typeof name !== 'string' || name.trim().length < 2) {
        return res.status(400).json({ success: false, error: 'Full name is required (min 2 characters).' });
      }
      if (!email || typeof email !== 'string') {
        return res.status(400).json({ success: false, error: 'Email address is required.' });
      }
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.trim().toLowerCase())) {
        return res.status(400).json({ success: false, error: 'Invalid email address format.' });
      }
      if (!phone || typeof phone !== 'string') {
        return res.status(400).json({ success: false, error: 'Phone number is required.' });
      }
      const cleanPhone = phone.replace(/\D/g, '');
      if (cleanPhone.length !== 10 || !/^[6-9]/.test(cleanPhone)) {
        return res.status(400).json({ success: false, error: 'Invalid 10-digit Indian mobile number.' });
      }
      if (!subject || typeof subject !== 'string') {
        return res.status(400).json({ success: false, error: 'Subject is required.' });
      }
      if (!message || typeof message !== 'string' || message.trim().length < 2) {
        return res.status(400).json({ success: false, error: 'Message is required (min 2 characters).' });
      }

      // Rate limiting: 1 enquiry per email per 60 seconds
      const rateLimitKey = `${RATE_LIMIT_KEY_PREFIX}${email.trim().toLowerCase()}`;
      const lastSubmitted = await redis.get(rateLimitKey);
      if (lastSubmitted) {
        return res.status(429).json({
          success: false,
          error: 'Please wait 60 seconds before submitting another enquiry.'
        });
      }

      const newEnquiry = {
        id: generateEnquiryId(),
        name: name.trim(),
        email: email.trim().toLowerCase(),
        phone: cleanPhone,
        company: (company || '').trim() || 'N/A',
        subject: subject.trim(),
        message: message.trim(),
        membershipType: membershipType || 'None',
        submittedAt: new Date().toISOString(),
      };

      // Prepend to enquiries list in Redis
      const enquiries = (await redis.get(ENQUIRIES_KEY)) || [];
      enquiries.unshift(newEnquiry);

      // Keep max 500 enquiries to avoid large payloads
      const trimmed = enquiries.slice(0, 500);
      await redis.set(ENQUIRIES_KEY, trimmed);

      // Set rate limit (60 seconds TTL)
      await redis.set(rateLimitKey, '1', { ex: 60 });

      console.log(`[BCCI Enquiry] Created ${newEnquiry.id} from ${newEnquiry.email}`);

      return res.status(201).json({
        success: true,
        message: 'Enquiry submitted successfully.',
        enquiry: newEnquiry
      });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed.' });

  } catch (err) {
    console.error('[BCCI Enquiries API Error]', err.message);
    return res.status(500).json({
      success: false,
      error: 'Internal server error. Please try again later.'
    });
  }
}
