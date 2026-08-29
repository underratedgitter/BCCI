import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a || '');
  const bufB = Buffer.from(b || '');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://bccibharuch.in';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Handle DELETE (sign out)
  if (req.method === 'DELETE') {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');
    if (token) {
      await redis.del(`admin:${token}`).catch(() => {});
    }
    return res.status(200).json({ success: true, message: 'Signed out' });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, password } = req.body || {};
  const email = username; // store.js sends username field
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminEmails.includes(email.toLowerCase()) || !timingSafeEqual(password, adminPassword)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  try {
    const token = crypto.randomUUID();
    const expiresIn = 3600;
    await redis.set(`admin:${token}`, email.toLowerCase(), { ex: expiresIn });
    
    // Return in format store.js expects: result.session.token
    res.status(200).json({
      success: true,
      session: {
        token,
        username: email.toLowerCase(),
        createdAt: new Date().toISOString(),
        expiresIn
      }
    });
  } catch (e) {
    console.error('[Admin Auth Error]', e.message);
    res.status(500).json({ error: 'Failed to create session' });
  }
}
