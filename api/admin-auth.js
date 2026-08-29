import { createClient } from 'redis';
import crypto from 'crypto';

const client = createClient({ url: process.env.REDIS_URL });
client.on('error', () => {});
if (!client.isOpen) client.connect().catch(() => {});

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a || '');
  const bufB = Buffer.from(b || '');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password } = req.body || {};
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
    await client.setEx(`admin:${token}`, 3600, email.toLowerCase());
    res.status(200).json({ success: true, token, expiresIn: 3600 });
  } catch (e) {
    res.status(500).json({ error: 'Failed to create session' });
  }
}
