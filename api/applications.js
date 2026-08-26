// api/applications.js
// Vercel Serverless Function — BCCI Bharuch Membership Applications CRUD
// GET: List all applications (admin only for full data, public for limited) 
// POST: Create new application
// PATCH: Update application status (admin only)
// Uses Upstash Redis for persistent storage

import { Redis } from '@upstash/redis';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const APPLICATIONS_KEY = 'bcci:applications';
const ADMIN_SESSIONS_KEY = 'bcci:admin_sessions';
const RATE_LIMIT_KEY_PREFIX = 'bcci:ratelimit:application:';

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function generateAppId() {
  const num = Math.floor(1000 + Math.random() * 9000);
  return `APP-${num}`;
}

async function verifyAdminSession(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '').trim();
  if (!token) return false;

  const sessions = (await redis.get(ADMIN_SESSIONS_KEY)) || {};
  const session = sessions[token];
  if (!session) return false;

  // Check if session expired (8 hours)
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

  try {
    if (req.method === 'GET') {
      // ── List All Applications ──────────────────────────────────────
      const isAdmin = await verifyAdminSession(req);
      const applications = (await redis.get(APPLICATIONS_KEY)) || [];

      if (isAdmin) {
        // Admin gets full data including payment proofs
        return res.status(200).json({ success: true, applications });
      }

      // Public gets limited data (no payment proofs, no sensitive info)
      const publicApps = applications.map(app => ({
        id: app.id,
        company: app.company,
        status: app.status,
        submittedAt: app.submittedAt,
        approvedAt: app.approvedAt,
        enterpriseType: app.enterpriseType,
        businessServices: app.businessServices,
        repName: app.repName,
      }));

      return res.status(200).json({ success: true, applications: publicApps });
    }

    if (req.method === 'POST') {
      // ── Create New Application ─────────────────────────────────────
      const data = req.body || {};

      // Validate required fields
      const requiredFields = [
        { field: 'company', label: 'Company name', minLen: 2 },
        { field: 'repName', label: 'Representative name', minLen: 2 },
        { field: 'repDesignation', label: 'Designation', minLen: 2 },
        { field: 'email', label: 'Email address' },
        { field: 'phone', label: 'Phone number' },
        { field: 'gstNo', label: 'GSTIN number' },
        { field: 'panNo', label: 'PAN number' },
        { field: 'address', label: 'Office address', minLen: 5 },
        { field: 'pincode', label: 'Pincode' },
        { field: 'district', label: 'District' },
      ];

      for (const { field, label, minLen } of requiredFields) {
        const val = (data[field] || '').toString().trim();
        if (!val) {
          return res.status(400).json({ success: false, error: `${label} is required.` });
        }
        if (minLen && val.length < minLen) {
          return res.status(400).json({ success: false, error: `${label} must be at least ${minLen} characters.` });
        }
      }

      // Validate email format
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(data.email.trim().toLowerCase())) {
        return res.status(400).json({ success: false, error: 'Invalid email address format.' });
      }

      // Validate phone
      const cleanPhone = data.phone.replace(/\D/g, '');
      if (cleanPhone.length !== 10 || !/^[6-9]/.test(cleanPhone)) {
        return res.status(400).json({ success: false, error: 'Invalid 10-digit Indian mobile number.' });
      }

      // Validate GSTIN
      const gstClean = (data.gstNo || '').toUpperCase().trim();
      if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}[Zz][0-9A-Z]{1}$/.test(gstClean)) {
        return res.status(400).json({ success: false, error: 'Invalid GSTIN format (15 characters).' });
      }

      // Validate PAN
      const panClean = (data.panNo || '').toUpperCase().trim();
      if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(panClean)) {
        return res.status(400).json({ success: false, error: 'Invalid PAN format (10 characters).' });
      }

      // Validate pincode
      if (!/^[1-9][0-9]{5}$/.test((data.pincode || '').trim())) {
        return res.status(400).json({ success: false, error: 'Invalid 6-digit pincode.' });
      }

      // Rate limiting: 1 application per email per 5 minutes
      const normalizedEmail = data.email.trim().toLowerCase();
      const rateLimitKey = `${RATE_LIMIT_KEY_PREFIX}${normalizedEmail}`;
      const lastSubmitted = await redis.get(rateLimitKey);
      if (lastSubmitted) {
        return res.status(429).json({
          success: false,
          error: 'Please wait 5 minutes before submitting another application.'
        });
      }

      // Check if email already has a pending or approved application
      const applications = (await redis.get(APPLICATIONS_KEY)) || [];
      const existingApp = applications.find(
        app => app.email === normalizedEmail && (app.status === 'Pending' || app.status === 'Approved')
      );
      if (existingApp) {
        return res.status(409).json({
          success: false,
          error: existingApp.status === 'Approved'
            ? 'This email already has an active membership. Please sign in to manage your account.'
            : 'You already have a pending application under this email. Please wait for admin review.'
        });
      }

      // Compress payment proof if present (limit size in Redis)
      let paymentProof = data.paymentProof || '';
      if (paymentProof && paymentProof.length > 500000) {
        // Truncate very large base64 images to avoid Redis payload issues
        paymentProof = paymentProof.substring(0, 500000);
      }

      const newApp = {
        id: generateAppId(),
        company: data.company.trim(),
        legalStatus: data.legalStatus || 'Pvt. Ltd.',
        enterpriseType: data.enterpriseType || 'Small',
        businessServices: data.businessServices || 'Chemical & Petrochemicals',
        annualTurnover: (data.annualTurnover || '').trim(),
        employees: data.employees || '',
        gstNo: gstClean,
        panNo: panClean,
        cin: (data.cin || '').toUpperCase().trim(),
        address: data.address.trim(),
        district: data.district || 'Bharuch',
        pincode: data.pincode.trim(),
        repName: data.repName.trim(),
        repDesignation: data.repDesignation.trim(),
        email: normalizedEmail,
        phone: cleanPhone,
        paymentRef: (data.paymentRef || '').trim(),
        paymentProof: paymentProof,
        status: 'Pending',
        submittedAt: new Date().toISOString(),
        approvedAt: null,
        renewalYears: 1,
      };

      // Prepend to applications list in Redis
      applications.unshift(newApp);

      // Keep max 1000 applications
      const trimmed = applications.slice(0, 1000);
      await redis.set(APPLICATIONS_KEY, trimmed);

      // Set rate limit (5 minutes TTL)
      await redis.set(rateLimitKey, '1', { ex: 300 });

      console.log(`[BCCI Application] Created ${newApp.id} from ${newApp.email} (${newApp.company})`);

      // Return without payment proof in response
      const { paymentProof: _, ...appResponse } = newApp;
      return res.status(201).json({
        success: true,
        message: 'Application submitted successfully. Pending admin approval.',
        application: appResponse
      });
    }

    if (req.method === 'PATCH') {
      // ── Update Application Status (Admin Only) ─────────────────────
      const isAdmin = await verifyAdminSession(req);
      if (!isAdmin) {
        return res.status(401).json({ success: false, error: 'Admin authentication required.' });
      }

      const { id, status } = req.body || {};
      if (!id || !status) {
        return res.status(400).json({ success: false, error: 'Application ID and status are required.' });
      }

      if (!['Approved', 'Rejected'].includes(status)) {
        return res.status(400).json({ success: false, error: 'Status must be Approved or Rejected.' });
      }

      const applications = (await redis.get(APPLICATIONS_KEY)) || [];
      const index = applications.findIndex(app => app.id === id);

      if (index === -1) {
        return res.status(404).json({ success: false, error: 'Application not found.' });
      }

      applications[index].status = status;
      if (status === 'Approved') {
        applications[index].approvedAt = new Date().toISOString();
      }

      await redis.set(APPLICATIONS_KEY, applications);

      console.log(`[BCCI Application] ${status} ${id}`);

      const { paymentProof: _, ...appResponse } = applications[index];
      return res.status(200).json({
        success: true,
        message: `Application ${id} has been ${status.toLowerCase()}.`,
        application: appResponse
      });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed.' });

  } catch (err) {
    console.error('[BCCI Applications API Error]', err.message);
    return res.status(500).json({
      success: false,
      error: 'Internal server error. Please try again later.'
    });
  }
}
