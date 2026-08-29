import { createClient } from 'redis';
import crypto from 'crypto';

const client = createClient({ url: process.env.REDIS_URL });
client.on('error', () => {});
if (!client.isOpen) client.connect().catch(() => {});

const MAX_BODY_SIZE = 100 * 1024; // 100KB limit

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const authHeader = req.headers.authorization;
  const token = authHeader?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const email = await client.get(`admin:${token}`);
  if (!email) return res.status(401).json({ error: 'Invalid session' });

  if (req.method === 'GET') {
    try {
      const keys = await client.keys('application:*');
      const apps = [];
      for (const key of keys.slice(0, 100)) {
        const data = await client.get(key);
        if (data) apps.push(JSON.parse(data));
      }
      apps.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
      return res.status(200).json({ applications: apps, total: apps.length });
    } catch (e) {
      return res.status(500).json({ error: 'Failed to fetch applications' });
    }
  }

  if (req.method === 'POST') {
    const body = JSON.stringify(req.body || {});
    if (body.length > MAX_BODY_SIZE) {
      return res.status(413).json({ error: 'Request body too large (max 100KB)' });
    }

    const { applicantName, email: applicantEmail, phone, address, state, city, pincode, gstin, pan, membershipType, paymentProof, paymentAmount, paymentRef } = req.body || {};

    if (!applicantName || !applicantEmail || !phone || !membershipType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(applicantEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    if (!/^\d{10}$/.test(phone)) {
      return res.status(400).json({ error: 'Phone must be 10 digits' });
    }

    const appId = `BCCI-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const application = {
      id: appId, applicantName, email: applicantEmail, phone, address, state, city, pincode,
      gstin, pan, membershipType, paymentProof, paymentAmount, paymentRef,
      status: 'pending', submittedAt: new Date().toISOString(), reviewedAt: null, reviewedBy: null
    };

    try {
      await client.setEx(`application:${appId}`, 86400 * 30, JSON.stringify(application));
      res.status(201).json({ success: true, applicationId: appId, message: 'Application submitted successfully' });
    } catch (e) {
      res.status(500).json({ error: 'Failed to submit application' });
    }
  }
}
