import { Redis } from '@upstash/redis';
import crypto from 'crypto';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const MAX_BODY_SIZE = 100 * 1024; // 100KB limit
const APPLICATIONS_KEY = 'bcci:applications';

async function getApplications() {
  return (await redis.get(APPLICATIONS_KEY)) || [];
}

async function saveApplications(apps) {
  await redis.set(APPLICATIONS_KEY, apps);
}

export default async function handler(req, res) {
  const origin = process.env.ALLOWED_ORIGIN || 'https://bccibharuch.in';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth check for PATCH (admin only)
  if (req.method === 'PATCH') {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const email = await redis.get(`admin:${token}`);
    if (!email) return res.status(401).json({ error: 'Invalid session' });
  }

  if (req.method === 'GET') {
    try {
      const { email } = req.query || {};
      const apps = await getApplications();
      
      // If email query param provided, return only that applicant's application
      if (email) {
        const userApp = apps.find(a => (a.email || '').toLowerCase() === email.toLowerCase());
        return res.status(200).json({ application: userApp || null });
      }
      
      // Otherwise return all (admin view)
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

    const { repName, repDesignation, company, legalStatus, enterpriseType, businessServices, annualTurnover, employees, cin, email: applicantEmail, phone, address, district, pincode, gstNo, panNo, paymentRef, paymentProof } = req.body || {};

    // Map form fields to application fields
    const applicantName = repName;
    const gstin = gstNo;
    const pan = panNo;
    const state = district;
    const city = district;
    const membershipType = businessServices;

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
      id: appId,
      applicantName,
      repName: applicantName,
      repDesignation: repDesignation || '',
      company: company || '',
      email: applicantEmail,
      phone,
      address: address || '',
      state: state || '',
      city: city || '',
      pincode: pincode || '',
      gstin: gstin || '',
      pan: pan || '',
      legalStatus: legalStatus || '',
      enterpriseType: enterpriseType || '',
      businessServices: businessServices || '',
      annualTurnover: annualTurnover || '',
      employees: employees || '',
      cin: cin || '',
      membershipType,
      paymentProof: paymentProof || '',
      paymentAmount: '',
      paymentRef: paymentRef || '',
      status: 'pending',
      submittedAt: new Date().toISOString(),
      reviewedAt: null,
      reviewedBy: null
    };

    try {
      const apps = await getApplications();
      apps.unshift(application);
      await saveApplications(apps);
      res.status(201).json({ success: true, applicationId: appId, message: 'Application submitted successfully' });
    } catch (e) {
      console.error('[Applications POST Error]', e.message);
      res.status(500).json({ error: 'Failed to submit application' });
    }
  }

  if (req.method === 'PATCH') {
    const { id, status, renewalYears, lastRenewedAt, paymentRef } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Application ID required' });

    try {
      const apps = await getApplications();
      const idx = apps.findIndex(a => a.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Application not found' });

      // Update fields
      if (status) apps[idx].status = status;
      if (status === 'Approved') apps[idx].approvedAt = new Date().toISOString();
      if (status) apps[idx].reviewedAt = new Date().toISOString();
      if (renewalYears !== undefined) apps[idx].renewalYears = renewalYears;
      if (lastRenewedAt) apps[idx].lastRenewedAt = lastRenewedAt;
      if (paymentRef) apps[idx].paymentRef = paymentRef;

      await saveApplications(apps);
      return res.status(200).json({ success: true, application: apps[idx] });
    } catch (e) {
      console.error('[Applications PATCH Error]', e.message);
      return res.status(500).json({ error: 'Failed to update application' });
    }
  }
}
