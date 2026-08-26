// api/admin-stats.js
// Vercel Serverless Function — BCCI Bharuch Admin Dashboard Statistics
// GET: Returns application counts and basic metrics
// Requires admin session authentication

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const APPLICATIONS_KEY = 'bcci:applications';
const ENQUIRIES_KEY = 'bcci:enquiries';
const ADMIN_SESSIONS_KEY = 'bcci:admin_sessions';

function corsHeaders(res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://bccibharuch.in';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

async function verifyAdminSession(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return false;

  const sessions = (await redis.get(ADMIN_SESSIONS_KEY)) || {};
  const session = sessions[token];
  if (!session) return false;

  const createdAt = new Date(session.createdAt).getTime();
  const now = Date.now();
  if (now - createdAt > 8 * 60 * 60 * 1000) {
    delete sessions[token];
    await redis.set(ADMIN_SESSIONS_KEY, sessions);
    return false;
  }

  return true;
}

export default async function handler(req, res) {
  corsHeaders(res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }

  try {
    const isAdmin = await verifyAdminSession(req);
    if (!isAdmin) {
      return res.status(401).json({ success: false, error: 'Admin authentication required.' });
    }

    const applications = (await redis.get(APPLICATIONS_KEY)) || [];
    const enquiries = (await redis.get(ENQUIRIES_KEY)) || [];

    const stats = {
      total: applications.length,
      pending: applications.filter(a => a.status === 'Pending').length,
      approved: applications.filter(a => a.status === 'Approved').length,
      rejected: applications.filter(a => a.status === 'Rejected').length,
      totalEnquiries: enquiries.length,
      recentApplications: applications.slice(0, 5).map(a => ({
        id: a.id,
        company: a.company,
        status: a.status,
        submittedAt: a.submittedAt,
      })),
    };

    return res.status(200).json({ success: true, stats });

  } catch (err) {
    console.error('[BCCI Admin Stats API Error]', err.message);
    return res.status(500).json({
      success: false,
      error: 'Internal server error.'
    });
  }
}
