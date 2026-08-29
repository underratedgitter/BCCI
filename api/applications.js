// api/applications.js
// Membership applications — list (admin), read own (applicant), create, update.

import crypto from 'crypto';
import {
  listApplications,
  getApplication,
  getApplicationByEmail,
  putApplication,
  updateApplication,
  STATUS,
  normalizeStatus,
} from './_lib/redis.js';
import {
  applyCors,
  handlePreflight,
  getAdminSession,
  getApplicantSession,
  rateLimit,
  tooManyRequests,
  clientIp,
  str,
  isEmail,
  withErrorHandling,
} from './_lib/http.js';
import { sendEmail, adminRecipients } from './_lib/email.js';

// A receipt is base64 in the JSON body, so the cap has to leave room for it.
const MAX_BODY_SIZE = 900 * 1024;

function newApplicationId() {
  return `BCCI-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

const INDIAN_DATE = { day: 'numeric', month: 'long', year: 'numeric' };

/** Membership expiry, mirroring the client's getMembershipValidity(). */
function validUntil(app) {
  const from = app.approvedAt ? new Date(app.approvedAt) : new Date(app.submittedAt || Date.now());
  const until = new Date(from);
  until.setFullYear(until.getFullYear() + (Number(app.renewalYears) || 1));
  return until;
}

async function handler(req, res) {
  applyCors(req, res, 'GET, POST, PATCH, OPTIONS');
  if (handlePreflight(req, res)) return;

  // ── GET ──────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const requested = str(req.query?.email, 254).toLowerCase();
    const adminEmail = await getAdminSession(req);

    // Full list is admin-only. Previously this was wide open and returned
    // every applicant's PAN, GSTIN, address and payment receipt.
    if (!requested) {
      if (!adminEmail) {
        return res.status(401).json({ error: 'Admin authentication required.' });
      }
      const applications = await listApplications();
      return res.status(200).json({ applications, total: applications.length });
    }

    // Single record: the owner, or an admin.
    const applicantEmail = await getApplicantSession(req);
    const isOwner = applicantEmail && applicantEmail === requested;
    if (!adminEmail && !isOwner) {
      return res.status(401).json({
        error: 'Sign in with this email address to view its application.',
      });
    }

    const application = await getApplicationByEmail(requested);
    return res.status(200).json({ application: application || null });
  }

  // ── POST — submit a new application ──────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};
    const raw = JSON.stringify(body);
    if (raw.length > MAX_BODY_SIZE) {
      return res.status(413).json({
        error: 'Your payment receipt is too large. Please attach a smaller image.',
      });
    }

    // Submitting requires a verified email, and the application must be filed
    // under the address that was actually verified.
    const applicantEmail = await getApplicantSession(req);
    if (!applicantEmail) {
      return res.status(401).json({
        error: 'Please verify your email address before submitting.',
      });
    }

    const ip = clientIp(req);
    const limit = await rateLimit(`apply:${ip}`, { max: 5, windowSec: 3600 });
    if (!limit.ok) {
      return tooManyRequests(res, limit.retryAfter, 'Too many submissions from this network. Please try again later.');
    }

    const repName = str(body.repName, 120);
    const company = str(body.company, 200);
    const phone = str(body.phone, 20).replace(/\D/g, '');
    const membershipType = str(body.businessServices, 120);
    const applicantAddress = str(body.address, 500);

    if (!repName || !company || !phone || !membershipType) {
      return res.status(400).json({
        error: 'Representative name, company, phone and business sector are all required.',
      });
    }
    if (!isEmail(applicantEmail)) {
      return res.status(400).json({ error: 'Invalid email format.' });
    }
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number.' });
    }

    // One application per verified email.
    const existing = await getApplicationByEmail(applicantEmail);
    if (existing) {
      return res.status(409).json({
        error: `An application for this email already exists (${existing.id}).`,
        applicationId: existing.id,
        application: existing,
      });
    }

    const district = str(body.district, 120);
    const application = {
      id: newApplicationId(),
      applicantName: repName,
      repName,
      repDesignation: str(body.repDesignation, 120),
      company,
      email: applicantEmail,
      phone,
      address: applicantAddress,
      state: district,
      city: district,
      district,
      pincode: str(body.pincode, 10),
      gstin: str(body.gstNo, 20),
      gstNo: str(body.gstNo, 20),
      pan: str(body.panNo, 15),
      panNo: str(body.panNo, 15),
      legalStatus: str(body.legalStatus, 80),
      enterpriseType: str(body.enterpriseType, 80),
      businessServices: membershipType,
      annualTurnover: str(body.annualTurnover, 60),
      employees: str(body.employees, 30),
      cin: str(body.cin, 30),
      membershipType,
      paymentProof: typeof body.paymentProof === 'string' ? body.paymentProof : '',
      paymentAmount: '',
      paymentRef: str(body.paymentRef, 80),
      status: STATUS.PENDING,
      submittedAt: new Date().toISOString(),
      reviewedAt: null,
      reviewedBy: null,
      renewalYears: 1,
    };

    const saved = await putApplication(application);

    // Notifications are sent here rather than by the browser, so they still go
    // out if the applicant closes the tab, and so the recipient list cannot be
    // chosen by the client.
    const date = new Date().toLocaleDateString('en-IN', INDIAN_DATE);
    const shared = {
      appId: saved.id,
      company: saved.company,
      repName: saved.repName,
      sector: saved.businessServices,
      date,
    };

    await Promise.allSettled([
      sendEmail({ type: 'application_submitted', to: saved.email, data: shared }),
      sendEmail({
        type: 'admin_new_application',
        to: adminRecipients(),
        data: {
          ...shared,
          repDesignation: saved.repDesignation,
          email: saved.email,
          phone: saved.phone,
          enterpriseType: saved.enterpriseType,
          legalStatus: saved.legalStatus,
          gstNo: saved.gstNo,
          panNo: saved.panNo,
          paymentRef: saved.paymentRef,
        },
      }),
    ]);

    return res.status(201).json({
      success: true,
      applicationId: saved.id,
      application: saved,
      message: 'Application submitted successfully',
    });
  }

  // ── PATCH — review decision, or a renewal ────────────────────────
  if (req.method === 'PATCH') {
    const { id, action } = req.body || {};
    if (!id) return res.status(400).json({ error: 'Application ID required' });

    const adminEmail = await getAdminSession(req);

    // Renewal: allowed for an admin, or the member renewing their own
    // membership. Deliberately cannot change status.
    if (action === 'renew') {
      const applicantEmail = await getApplicantSession(req);
      const target = await getApplication(id);
      if (!target) return res.status(404).json({ error: 'Application not found' });

      const isOwner = applicantEmail && applicantEmail === String(target.email || '').toLowerCase();
      if (!adminEmail && !isOwner) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      if (target.status !== STATUS.APPROVED) {
        return res.status(409).json({ error: 'Only an approved membership can be renewed.' });
      }

      const paymentRef = str(req.body.paymentRef, 80);
      if (!paymentRef) {
        return res.status(400).json({ error: 'Payment UTR / transaction reference is required.' });
      }

      const updated = await updateApplication(id, (app) => ({
        ...app,
        renewalYears: (Number(app.renewalYears) || 1) + 1,
        lastRenewedAt: new Date().toISOString(),
        paymentRef,
      }));
      return res.status(200).json({ success: true, application: updated });
    }

    // Everything else is an admin review action.
    if (!adminEmail) return res.status(401).json({ error: 'Admin authentication required.' });

    const { status } = req.body || {};
    if (!status) return res.status(400).json({ error: 'No changes supplied.' });

    const nextStatus = normalizeStatus(status);
    const updated = await updateApplication(id, (app) => {
      const next = { ...app, status: nextStatus, reviewedAt: new Date().toISOString(), reviewedBy: adminEmail };
      if (nextStatus === STATUS.APPROVED && !app.approvedAt) {
        next.approvedAt = new Date().toISOString();
      }
      return next;
    });

    if (!updated) return res.status(404).json({ error: 'Application not found' });

    // Tell the applicant what was decided.
    if (nextStatus === STATUS.APPROVED) {
      await sendEmail({
        type: 'application_approved',
        to: updated.email,
        data: {
          appId: updated.id,
          company: updated.company,
          repName: updated.repName,
          validUntil: validUntil(updated).toLocaleDateString('en-IN', INDIAN_DATE),
        },
      });
    } else if (nextStatus === STATUS.REJECTED) {
      await sendEmail({
        type: 'application_declined',
        to: updated.email,
        data: {
          appId: updated.id,
          company: updated.company,
          repName: updated.repName,
          reason: str(req.body.reason, 1000),
        },
      });
    }

    return res.status(200).json({ success: true, application: updated });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

export default withErrorHandling('Applications', handler);
