// api/applications.js
// Membership applications — list (admin), read own (applicant), create, update.

import crypto from 'crypto';
import {
  redis,
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
  cleanPhone,
  withErrorHandling,
} from './_lib/http.js';
import { sendEmail, adminRecipients } from './_lib/email.js';
import { validateFileSignature } from './_lib/validation.js';

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
    // Public QR Verification: ?verifyId=... or ?verify=...
    const verifyId = str(req.query?.verifyId || req.query?.verify, 64);
    if (verifyId) {
      const ip = clientIp(req);
      const rl = await rateLimit(`verify:${ip}`, { max: 45, windowSec: 60 });
      if (!rl.ok) {
        return tooManyRequests(res, rl.retryAfter, 'Too many verification attempts. Please try again shortly.');
      }
      const app = await getApplication(verifyId);
      if (!app) {
        return res.status(404).json({ success: false, error: 'Member not found or invalid membership ID.' });
      }
      const expiry = validUntil(app);
      const isExpired = Date.now() > expiry.getTime();
      const isApproved = app.status === STATUS.APPROVED;
      const isActive = isApproved && !isExpired;

      return res.status(200).json({
        success: true,
        verified: isActive,
        member: {
          id: app.id,
          company: app.company,
          repName: app.repName,
          membershipType: app.membershipType,
          status: app.status,
          isActive,
          isExpired,
          validUntil: expiry.toISOString(),
          approvedAt: app.approvedAt || null,
        },
      });
    }

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
    const repDesignation = str(body.repDesignation, 120);
    const company = str(body.company, 200);
    const phone = cleanPhone(body.phone);
    const membershipType = str(body.businessServices, 120);
    const applicantAddress = str(body.address, 500);
    const district = str(body.district, 120);
    const pincode = str(body.pincode, 10);
    const legalStatus = str(body.legalStatus, 80);
    const enterpriseType = str(body.enterpriseType, 80);
    const annualTurnover = str(body.annualTurnover, 60);
    const employees = str(body.employees, 30);
    const paymentRef = str(body.paymentRef, 80);
    const paymentProofRaw = typeof body.paymentProof === 'string' ? body.paymentProof.trim() : '';

    if (!repName || repName.length < 2) {
      return res.status(400).json({ error: 'Representative name is required (minimum 2 characters).' });
    }
    if (!repDesignation || repDesignation.length < 2) {
      return res.status(400).json({ error: 'Representative designation is required (minimum 2 characters).' });
    }
    if (!company || company.length < 2) {
      return res.status(400).json({ error: 'Company or organization name is required (minimum 2 characters).' });
    }
    if (!phone || !/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: 'Enter a valid 10-digit Indian mobile number.' });
    }
    if (!isEmail(applicantEmail)) {
      return res.status(400).json({ error: 'Invalid email format.' });
    }
    if (!membershipType || membershipType.length < 2) {
      return res.status(400).json({ error: 'Primary business sector / service is required.' });
    }
    if (!legalStatus || legalStatus.length < 2) {
      return res.status(400).json({ error: 'Legal status is required.' });
    }
    if (!enterpriseType || enterpriseType.length < 2) {
      return res.status(400).json({ error: 'Enterprise category is required.' });
    }
    if (!applicantAddress || applicantAddress.length < 5) {
      return res.status(400).json({ error: 'Registered office address is required (minimum 5 characters).' });
    }
    if (!district || district.length < 2) {
      return res.status(400).json({ error: 'District is required.' });
    }
    if (!pincode || !/^[1-9][0-9]{5}$/.test(pincode)) {
      return res.status(400).json({ error: 'Valid 6-digit postal pincode is required.' });
    }

    const turnoverNum = Number(annualTurnover);
    if (!annualTurnover || annualTurnover.length < 2 || !/^\d+$/.test(annualTurnover) || isNaN(turnoverNum) || turnoverNum <= 0) {
      return res.status(400).json({ error: 'Annual turnover must contain numbers only (e.g. 50000000).' });
    }

    const empCount = parseInt(employees, 10);
    if (!employees || isNaN(empCount) || empCount < 1 || !/^\d+$/.test(employees)) {
      return res.status(400).json({ error: 'Employee count must be a number greater than or equal to 1.' });
    }

    const gstNo = str(body.gstNo, 20).toUpperCase();
    if (gstNo && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}[Zz][0-9A-Z]{1}$/.test(gstNo)) {
      return res.status(400).json({ error: 'Invalid GSTIN format (15 characters).' });
    }

    const panNo = str(body.panNo, 15).toUpperCase();
    if (panNo && !/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(panNo)) {
      return res.status(400).json({ error: 'Invalid PAN format (10 characters).' });
    }

    const cin = str(body.cin, 30).toUpperCase();
    if (cin && !/^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/.test(cin)) {
      return res.status(400).json({ error: 'Invalid 21-character CIN format.' });
    }

    if (!paymentProofRaw && (!paymentRef || paymentRef.length < 6)) {
      return res.status(400).json({ error: 'Payment receipt document or valid transaction reference (UTR) is required.' });
    }

    let paymentProof = '';
    if (paymentProofRaw) {
      const sigCheck = validateFileSignature(paymentProofRaw, ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf']);
      if (!sigCheck.ok) {
        return res.status(400).json({ error: `Payment receipt validation failed: ${sigCheck.error}` });
      }
      paymentProof = paymentProofRaw;
    }

    if (paymentRef && (paymentRef.length < 6 || !/^[A-Za-z0-9_\-\/]{6,80}$/.test(paymentRef))) {
      return res.status(400).json({ error: 'Payment reference / UTR must be at least 6 alphanumeric characters.' });
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
      paymentProof,
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

    // SEC-03: Renewal workflow.
    // When requested by a member, the request enters 'Pending Verification'
    // and requires Secretariat approval to extend validity.
    // Direct admin renewal immediately extends validity.
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
      if (!paymentRef || paymentRef.length < 6 || !/^[A-Za-z0-9_\-\/]{6,80}$/.test(paymentRef)) {
        return res.status(400).json({ error: 'A valid payment UTR / transaction reference is required (min 6 alphanumeric characters).' });
      }

      const existingRenewals = Array.isArray(target.renewals) ? target.renewals : [];
      const alreadyProcessed = existingRenewals.find(r => r.paymentRef === paymentRef) || (target.paymentRef === paymentRef && target.lastRenewedAt);
      if (alreadyProcessed) {
        return res.status(200).json({
          success: true,
          application: target,
          idempotent: true,
          message: 'This renewal payment reference was already processed.',
        });
      }

      if (target.pendingRenewal && target.pendingRenewal.paymentRef === paymentRef) {
        return res.status(200).json({
          success: true,
          application: target,
          idempotent: true,
          message: 'This renewal payment reference is already pending Secretariat verification.',
        });
      }

      // Member self-service renewal request: requires Secretariat approval
      if (!adminEmail) {
        const updated = await updateApplication(id, (app) => {
          return {
            ...app,
            renewalStatus: 'Pending Verification',
            pendingRenewal: {
              paymentRef,
              requestedAt: new Date().toISOString(),
            },
          };
        });
        return res.status(200).json({
          success: true,
          application: updated,
          message: 'Renewal request submitted successfully and is pending Secretariat verification.',
        });
      }

      // Admin direct renewal: immediately approves and extends term
      const updated = await updateApplication(id, (app) => {
        const renewals = Array.isArray(app.renewals) ? [...app.renewals] : [];
        if (renewals.some(r => r.paymentRef === paymentRef)) return app;
        const renewalRecord = {
          paymentRef,
          renewedAt: new Date().toISOString(),
          renewalYear: (Number(app.renewalYears) || 1) + 1,
          approvedBy: adminEmail,
        };
        renewals.push(renewalRecord);
        return {
          ...app,
          renewalYears: (Number(app.renewalYears) || 1) + 1,
          lastRenewedAt: renewalRecord.renewedAt,
          renewalStatus: 'Approved',
          pendingRenewal: null,
          paymentRef,
          renewals,
        };
      });
      return res.status(200).json({ success: true, application: updated });
    }

    // Secretariat approval for a pending renewal (Admin Only)
    if (action === 'approve-renewal') {
      if (!adminEmail) return res.status(401).json({ error: 'Admin authentication required.' });
      const target = await getApplication(id);
      if (!target) return res.status(404).json({ error: 'Application not found' });
      if (target.status !== STATUS.APPROVED) {
        return res.status(409).json({ error: 'Only an approved membership can be renewed.' });
      }

      const paymentRef = str(req.body.paymentRef || target.pendingRenewal?.paymentRef, 80);

      // Idempotency: if this renewal was already approved with this paymentRef, return idempotent 200
      if (target.renewalStatus !== 'Pending Verification' || !target.pendingRenewal) {
        const alreadyApproved = target.renewalStatus === 'Approved' && (
          target.renewals?.some(r => r.paymentRef === paymentRef) || target.paymentRef === paymentRef
        );
        if (alreadyApproved) {
          return res.status(200).json({
            success: true,
            application: target,
            idempotent: true,
            alreadyApproved: true,
            message: 'Membership renewal was already approved.',
          });
        }
        return res.status(409).json({ error: 'There is no pending renewal request to approve.' });
      }

      if (!paymentRef || paymentRef.length < 6 || !/^[A-Za-z0-9_\-\/]{6,80}$/.test(paymentRef)) {
        return res.status(400).json({ error: 'A valid payment UTR reference is required to approve renewal.' });
      }

      const lockKey = `bcci:lock:renewal:${id}`;
      let lockAcquired = false;
      for (let attempt = 0; attempt < 25; attempt++) {
        const res = await redis.set(lockKey, '1', { nx: true, ex: 5 });
        if (res) {
          lockAcquired = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      if (!lockAcquired) {
        return res.status(409).json({ error: 'Renewal approval in progress. Please retry.' });
      }

      try {
        // Re-read under lock
        const fresh = await getApplication(id);
        if (fresh.renewalStatus !== 'Pending Verification' || !fresh.pendingRenewal) {
          const alreadyApproved = fresh.renewalStatus === 'Approved' && (
            fresh.renewals?.some(r => r.paymentRef === paymentRef) || fresh.paymentRef === paymentRef
          );
          if (alreadyApproved) {
            return res.status(200).json({
              success: true,
              application: fresh,
              idempotent: true,
              alreadyApproved: true,
              message: 'Membership renewal was already approved.',
            });
          }
          return res.status(409).json({ error: 'There is no pending renewal request to approve.' });
        }

        const updated = await updateApplication(id, (app) => {
          if (app.renewalStatus !== 'Pending Verification' || !app.pendingRenewal) {
            return app;
          }
          const renewals = Array.isArray(app.renewals) ? [...app.renewals] : [];
          if (renewals.some(r => r.paymentRef === paymentRef)) return app;
          const renewalRecord = {
            paymentRef,
            renewedAt: new Date().toISOString(),
            renewalYear: (Number(app.renewalYears) || 1) + 1,
            approvedBy: adminEmail,
          };
          renewals.push(renewalRecord);
          return {
            ...app,
            renewalYears: (Number(app.renewalYears) || 1) + 1,
            lastRenewedAt: renewalRecord.renewedAt,
            renewalStatus: 'Approved',
            pendingRenewal: null,
            paymentRef,
            renewals,
          };
        });

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

        return res.status(200).json({
          success: true,
          application: updated,
          message: 'Membership renewal approved and tenure extended by +1 year.',
        });
      } finally {
        await redis.del(lockKey).catch(() => {});
      }
    }

    // Secretariat rejection of a renewal (Admin Only)
    if (action === 'reject-renewal') {
      if (!adminEmail) return res.status(401).json({ error: 'Admin authentication required.' });
      const target = await getApplication(id);
      if (!target) return res.status(404).json({ error: 'Application not found' });
      if (target.status !== STATUS.APPROVED) {
        return res.status(409).json({ error: 'Only an approved membership renewal can be rejected.' });
      }
      if (target.renewalStatus !== 'Pending Verification' || !target.pendingRenewal) {
        return res.status(409).json({ error: 'There is no pending renewal request to reject.' });
      }

      const reason = str(req.body.reason, 1000) || 'Payment verification could not be completed.';
      const updated = await updateApplication(id, (app) => {
        if (app.renewalStatus !== 'Pending Verification') {
          return app;
        }
        return {
          ...app,
          renewalStatus: 'Rejected',
          pendingRenewal: null,
          renewalRejectionReason: reason,
        };
      });

      await sendEmail({
        type: 'application_declined',
        to: updated.email,
        data: {
          appId: updated.id,
          company: updated.company,
          repName: updated.repName,
          reason,
        },
      });

      return res.status(200).json({
        success: true,
        application: updated,
        message: 'Membership renewal rejected.',
      });
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
