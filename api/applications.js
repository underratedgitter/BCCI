// api/applications.js
// Membership applications — list (admin), read own (applicant), create, update.

import crypto from 'crypto';
import {
  listApplicationSummaries,
  countApplications,
  getApplication,
  getApplicationByEmail,
  putApplication,
  updateApplication,
  acquireLock,
  releaseLock,
  STATUS,
  normalizeStatus,
} from './_lib/records.js';
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
import { UPLOADED_CERTIFICATES } from './_lib/record-fields.js';
import { sendEmailWithin, adminRecipients } from './_lib/email.js';
import { validateFileSignature } from './_lib/validation.js';
import adminStatsHandler from './_lib/admin-stats.js';
import { getMembershipFee } from './_lib/membership-plans.js';
import { deliverEmailIntent } from './_lib/email-outbox.js';

function decisionIntent(next, previous) {
  if (!next.decisionEmailId || next.decisionEmailId === previous.decisionEmailId) return null;
  return {
    id: next.decisionEmailId,
    message: {
      type: next.status === STATUS.REJECTED ? 'application_declined' : 'application_approved',
      to: next.email,
      context: { applicationId: next.id, field: 'decisionEmailId', status: next.status },
      data: { appId: next.id, company: next.company, repName: next.repName,
        reason: next.rejectionReason || '',
        validUntil: validUntil(next).toLocaleDateString('en-IN', INDIAN_DATE) },
    },
  };
}

function renewalIntent(next, previous) {
  if (!next.renewalEmailId || next.renewalEmailId === previous.renewalEmailId) return null;
  return {
    id: next.renewalEmailId,
    message: {
      type: next.renewalStatus === 'Rejected' ? 'application_declined' : 'application_approved',
      to: next.email,
      context: { applicationId: next.id, field: 'renewalEmailId', renewalStatus: next.renewalStatus },
      data: { appId: next.id, company: next.company, repName: next.repName,
        reason: next.renewalRejectionReason || '',
        validUntil: validUntil(next).toLocaleDateString('en-IN', INDIAN_DATE) },
    },
  };
}

/**
 * True when this application's renewal already completed: either for the
 * payment reference the caller sent, or — when a retry no longer carries one,
 * which is what the admin UI sends — at all. A retry of a completed approval
 * must read as the same success, not as "no pending renewal".
 */
function renewalAlreadyApproved(app, paymentRef) {
  if (app?.renewalStatus !== 'Approved') return false;
  const renewals = Array.isArray(app.renewals) ? app.renewals : [];
  if (paymentRef && (renewals.some((r) => r.paymentRef === paymentRef) || app.paymentRef === paymentRef)) {
    return true;
  }
  return renewals.length > 0 || Boolean(app.lastRenewedAt);
}

/**
 * The idempotent answer to a repeated approve-renewal. The confirmation is
 * re-delivered only if it never went out: the outbox leases the intent, so a
 * retry can never send it twice.
 */
async function renewalAlreadyApprovedResponse(res, app) {
  const delivery = await deliverEmailIntent(app?.renewalEmailId);
  return res.status(200).json({
    success: true,
    application: app,
    idempotent: true,
    alreadyApproved: true,
    emailSent: Boolean(delivery?.success),
    message: 'Membership renewal was already approved.',
  });
}

// A receipt is base64 in the JSON body, so the cap has to leave room for it.
const MAX_BODY_SIZE = 3.5 * 1024 * 1024;
// The transport (server.js MAX_BODY, and Vercel's own limit) refuses anything
// over 5 MB, so a larger declared body cannot be a real submission. Checked
// before parsing so a multi-megabyte upload never costs a JSON.parse.
const MAX_CONTENT_LENGTH = 5 * 1024 * 1024;
// Invalid forms are refused before the strict submission limit below, but a
// script that only ever sends invalid forms must still be capped.
const ATTEMPT_LIMIT = { max: 60, windowSec: 3600 };

function newApplicationId() {
  return `BCCI-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

const INDIAN_DATE = { day: 'numeric', month: 'long', year: 'numeric' };

/**
 * Membership expiry, mirroring the client's getMembershipValidity().
 * A renewal stores expiresAt. Records never renewed since that field was
 * added run one term from validFrom when set (members imported from the
 * Secretariat register, whose year starts on the date they paid), otherwise
 * from approval.
 */
function validUntil(app) {
  if (app.expiresAt && Number.isFinite(Date.parse(app.expiresAt))) return new Date(app.expiresAt);
  const from = new Date(app.validFrom || app.approvedAt || app.submittedAt || Date.now());
  const until = new Date(from);
  until.setFullYear(until.getFullYear() + (Number(app.renewalYears) || 1));
  return until;
}

/**
 * Expiry after one more year: from the current expiry while the membership
 * is still running, from today once it has lapsed, so a member who renews
 * late is not left expired after paying.
 */
function renewedExpiry(app, now = new Date()) {
  const current = validUntil(app);
  const next = new Date(Math.max(current.getTime(), now.getTime()));
  next.setFullYear(next.getFullYear() + 1);
  return next.toISOString();
}

/**
 * What one more year costs this member: the plan's current listed fee, or
 * what they paid on joining when the plan has since been taken off the form.
 * Null when neither is known (e.g. an imported member with no plan on file).
 */
async function renewalFeeFor(app) {
  const listed = await getMembershipFee(app.membershipPlan);
  if (listed !== undefined) return listed;
  const paid = Number(app.totalFee ?? app.paymentAmount);
  return Number.isFinite(paid) && paid > 0 ? paid : null;
}

/** A client-supplied amount that disagrees with the fee, as an error message; else null. */
function renewalAmountMismatch(body, fee) {
  const claimed = str(body?.paymentAmount, 20).replace(/[^0-9]/g, '');
  if (!claimed || fee === null || Number(claimed) === fee) return null;
  return `Renewal amount mismatch for this membership type (expected ₹${fee.toLocaleString('en-IN')}/-).`;
}

async function handler(req, res) {
  // Admin dashboard stats route dispatch (via /api/admin-stats rewrite or ?stats=true)
  if (req.query?.stats === 'true' || req.query?.stats === '1') {
    return await adminStatsHandler(req, res);
  }

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
      // Cards are only issued on approval. A pending or rejected application
      // gets the same answer as an unknown ID, so the endpoint does not reveal
      // who applied, who was turned down, or their representative's name.
      if (!app || app.status !== STATUS.APPROVED) {
        return res.status(404).json({ success: false, error: 'Member not found or invalid membership ID.' });
      }
      const expiry = validUntil(app);
      const isExpired = Date.now() > expiry.getTime();
      const isActive = !isExpired;

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
      // The list defaults to a 500-row page; fetch the real total first so
      // the admin list never silently drops applications once the org
      // passes 500. Document scans (hundreds of KB each) are never loaded
      // here; the dossier and CSV fetch single records that include them.
      const totalApps = await countApplications();
      const slim = totalApps > 0 ? await listApplicationSummaries({ limit: totalApps }) : [];
      return res.status(200).json({ applications: slim, total: slim.length });
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
    // Refuse an oversized body on its declared length, before anything reads
    // it. A legitimate multi-document submission stays under the 5 MB the
    // transport accepts; the per-record cap is still applied after parsing.
    const declaredLength = Number(req.headers?.['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_CONTENT_LENGTH) {
      return res.status(413).json({
        error: 'Your payment receipt is too large. Please attach a smaller image.',
      });
    }

    // A cheap per-network ceiling before the body is serialised and validated,
    // so a script sending only invalid forms is still rate limited. It is a
    // separate, looser key: the stricter submission limit below counts only
    // forms that actually pass validation.
    const attempts = await rateLimit(`apply:attempt:${clientIp(req)}`, ATTEMPT_LIMIT);
    if (!attempts.ok) {
      return tooManyRequests(res, attempts.retryAfter, 'Too many submission attempts from this network. Please try again later.');
    }

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

    const repName = str(body.repName, 120);
    const repDesignation = str(body.repDesignation, 120);
    const repMobile = cleanPhone(body.repMobile);
    const repEmail = str(body.repEmail, 254).toLowerCase();
    // The form's "Official Email" may be a company address distinct from the
    // verified sign-in email; the record is still filed under the latter.
    const officialEmail = str(body.email, 254).toLowerCase() || applicantEmail;
    const company = str(body.company, 200);
    const phone = cleanPhone(body.phone);
    const membershipType = str(body.businessServices, 120);
    const applicantAddress = str(body.address, 500);
    const city = str(body.city, 120);
    const district = str(body.district, 120);
    const state = str(body.state, 120) || 'Gujarat';
    const pincode = str(body.pincode, 10);
    const legalStatus = str(body.legalStatus, 80);
    const enterpriseType = str(body.enterpriseType, 80);
    const annualTurnover = str(body.annualTurnover, 60);
    const employees = str(body.employees, 30);
    const paymentRef = str(body.paymentRef, 80);
    const paymentProofRaw = typeof body.paymentProof === 'string' ? body.paymentProof.trim() : '';
    const fullName = str(body.fullName, 120);
    const subject = str(body.subject, 200);
    const website = str(body.website, 200);
    const primaryBusiness = str(body.primaryBusiness, 200);
    const businessDescription = str(body.businessDescription, 4000);
    const internationalOps = str(body.internationalOps, 2000);
    const regNumber = str(body.regNumber, 60);
    const regDate = str(body.regDate, 10);
    const regPlace = str(body.regPlace, 120);
    const otherAssociations = str(body.otherAssociations, 300);
    const feedback = str(body.feedback, 4000);
    const membershipPlan = str(body.membershipPlan, 80);
    const paymentMode = str(body.paymentMode, 40);

    if (!fullName || fullName.length < 2) {
      return res.status(400).json({ error: 'Full name is required (minimum 2 characters).' });
    }
    if (!subject || subject.length < 2) {
      return res.status(400).json({ error: 'Subject is required (minimum 2 characters).' });
    }
    if (!city || city.length < 2) {
      return res.status(400).json({ error: 'City is required (minimum 2 characters).' });
    }

    if (!repName || repName.length < 2) {
      return res.status(400).json({ error: 'Representative name is required (minimum 2 characters).' });
    }
    if (!repDesignation || repDesignation.length < 2) {
      return res.status(400).json({ error: 'Representative designation is required (minimum 2 characters).' });
    }
    if (!repMobile || !/^[6-9]\d{9}$/.test(repMobile)) {
      return res.status(400).json({ error: 'Enter a valid 10-digit representative mobile number.' });
    }
    if (!repEmail || !isEmail(repEmail)) {
      return res.status(400).json({ error: 'Enter a valid representative email address.' });
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
    if (!isEmail(officialEmail)) {
      return res.status(400).json({ error: 'Enter a valid official email address.' });
    }
    if (!membershipType || membershipType.length < 2) {
      return res.status(400).json({ error: 'Primary business sector / service is required.' });
    }
    if (!primaryBusiness || primaryBusiness.length < 2) {
      return res.status(400).json({ error: 'Primary business name is required (minimum 2 characters).' });
    }
    if (!businessDescription || businessDescription.length < 10) {
      return res.status(400).json({ error: 'Brief description of operations is required (minimum 10 characters).' });
    }
    if (website && !/^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(website)) {
      return res.status(400).json({ error: 'Enter a valid website URL (e.g. example.com).' });
    }
    if (!feedback || feedback.length < 5) {
      return res.status(400).json({ error: 'Feedback or questions are required (minimum 5 characters).' });
    }
    // The total fee is derived server-side from the tier — a client-supplied
    // amount is cross-checked, never trusted.
    const expectedFee = await getMembershipFee(membershipPlan);
    if (expectedFee === undefined) {
      return res.status(400).json({ error: 'Select a valid membership type.' });
    }
    const claimedAmountRaw = str(body.paymentAmount ?? body.totalFee, 20).replace(/[^0-9]/g, '');
    if (claimedAmountRaw && Number(claimedAmountRaw) !== expectedFee) {
      return res.status(400).json({ error: `Total fee mismatch for the selected membership type (expected ₹${expectedFee.toLocaleString('en-IN')}/-).` });
    }
    const paymentAmount = String(expectedFee);
    const PAYMENT_MODES = ['Cash', 'UPI', 'RTGS', 'NEFT', 'Bank Transfer'];
    if (!PAYMENT_MODES.includes(paymentMode)) {
      return res.status(400).json({ error: 'Select a valid payment mode (Cash, UPI, RTGS, NEFT or Bank Transfer).' });
    }
    if (regDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(regDate)) {
        return res.status(400).json({ error: 'Date of registration must be YYYY-MM-DD.' });
      }
      const [ry, rm, rd] = regDate.split('-').map(Number);
      const d = new Date(Date.UTC(ry, rm - 1, rd));
      if (d.getUTCFullYear() !== ry || d.getUTCMonth() !== rm - 1 || d.getUTCDate() !== rd) {
        return res.status(400).json({ error: 'Date of registration is not a valid calendar date.' });
      }
      // Compare calendar days in India (UTC+5:30): a UTC midnight made today's
      // date count as the future until 05:30 IST.
      const todayIst = new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
      if (regDate > todayIst) {
        return res.status(400).json({ error: 'Date of registration cannot be in the future.' });
      }
    }
    if (!legalStatus || legalStatus.length < 2 || legalStatus.toLowerCase() === 'none') {
      return res.status(400).json({ error: 'Legal status is required.' });
    }
    if (!enterpriseType || enterpriseType.length < 2 || enterpriseType.toLowerCase() === 'none') {
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

    // Supporting documents: GST + PAN certificates required, registration
    // certificate and representative attachment optional. Images and PDFs.
    const DOC_MIMES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf'];
    const readDoc = (key, label, required) => {
      const raw = typeof body[key] === 'string' ? body[key].trim() : '';
      if (!raw) {
        if (required) return { error: `${label} is required. Please attach the document.` };
        return { value: '' };
      }
      const sigCheck = validateFileSignature(raw, DOC_MIMES);
      if (!sigCheck.ok) {
        return { error: `${label} validation failed: ${sigCheck.error}` };
      }
      return { value: raw };
    };
    const docs = {};
    for (const { key, label, required } of UPLOADED_CERTIFICATES) {
      const checked = readDoc(key, label, required);
      if (checked.error) {
        return res.status(400).json({ error: checked.error });
      }
      docs[key] = checked.value;
    }

    if (paymentRef && (paymentRef.length < 6 || !/^[A-Za-z0-9_\-\/]{6,80}$/.test(paymentRef))) {
      return res.status(400).json({ error: 'Payment reference / UTR must be at least 6 alphanumeric characters.' });
    }

    // Counted only once the form is valid, so typos never use up the
    // allowance of everyone behind the same office NAT.
    const limit = await rateLimit(`apply:${clientIp(req)}`, { max: 5, windowSec: 3600 });
    if (!limit.ok) {
      return tooManyRequests(res, limit.retryAfter, 'Too many submissions from this network. Please try again later.');
    }

    // One application per verified email. The check and the save hold one
    // lock, so a double-clicked submit cannot file two applications.
    const applyLock = `apply:${applicantEmail}`;
    const applyLockToken = await acquireLock(applyLock, 15);
    if (!applyLockToken) {
      return res.status(409).json({ error: 'Your application is already being submitted. Please wait a moment.' });
    }
    let saved;
    try {
      const existing = await getApplicationByEmail(applicantEmail);
      // A rejected applicant may file again; the new submission replaces the
      // rejected one under the same id, so the one-per-email rule still holds.
      if (existing && existing.status !== STATUS.REJECTED) {
        return res.status(409).json({
          error: `An application for this email already exists (${existing.id}).`,
          applicationId: existing.id,
          application: existing,
        });
      }
      const application = {
        id: newApplicationId(),
        applicantName: repName,
        fullName,
        subject,
        repName,
        repDesignation,
        repMobile,
        repEmail,
        company,
        email: applicantEmail,
        officialEmail,
        phone,
        address: applicantAddress,
        city,
        state,
        district,
        pincode,
        website,
        primaryBusiness,
        businessDescription,
        internationalOps,
        regNumber,
        regDate,
        regPlace,
        otherAssociations,
        feedback,
        membershipPlan,
        paymentMode,
        // Saved as validated (upper case), so registers and searches match.
        gstin: gstNo,
        gstNo,
        pan: panNo,
        panNo,
        legalStatus,
        enterpriseType,
        businessServices: membershipType,
        annualTurnover,
        employees,
        cin,
        membershipType,
        paymentProof,
        gstCertProof: docs.gstCertProof,
        panCertProof: docs.panCertProof,
        regCertProof: docs.regCertProof,
        repAttachment: docs.repAttachment,
        paymentAmount,
        totalFee: expectedFee,
        paymentRef,
        status: STATUS.PENDING,
        submittedAt: new Date().toISOString(),
        reviewedAt: null,
        reviewedBy: null,
        renewalYears: 1,
      };

      if (existing) {
        saved = await updateApplication(existing.id, (prev) => {
          // An admin may have changed the decision since the read above.
          if (prev.status !== STATUS.REJECTED) return prev;
          const previousSubmissions = Array.isArray(prev.previousSubmissions) ? prev.previousSubmissions : [];
          return {
            ...application,
            id: prev.id,
            previousSubmissions: [...previousSubmissions, {
              submittedAt: prev.submittedAt || null,
              reviewedAt: prev.reviewedAt || null,
              reviewedBy: prev.reviewedBy || null,
              rejectionReason: prev.rejectionReason || '',
            }],
          };
        });
        if (!saved || saved.submittedAt !== application.submittedAt) {
          return res.status(409).json({
            error: 'Your earlier application was reviewed again just now. Please refresh to see its status.',
            applicationId: existing.id,
          });
        }
      } else {
        saved = await putApplication(application);
      }
    } finally {
      await releaseLock(applyLock, applyLockToken);
    }

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
      sendEmailWithin({ type: 'application_submitted', to: saved.email, data: shared }),
      sendEmailWithin({
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
      const amount = await renewalFeeFor(target);
      const mismatch = renewalAmountMismatch(req.body, amount);
      if (mismatch) return res.status(400).json({ error: mismatch });

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

      // One payment is awaiting verification already. Accepting a second,
      // different reference would silently drop the first one — and with it
      // the payment it documents — so the pending request must be closed first.
      if (target.renewalStatus === 'Pending Verification' && target.pendingRenewal) {
        return res.status(409).json({
          error: 'A renewal payment is already awaiting Secretariat verification. The Secretariat must reject that request before a different payment reference can be submitted.',
          code: 'renewal_pending',
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
              amount,
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
          amount,
          renewedAt: new Date().toISOString(),
          renewalYear: (Number(app.renewalYears) || 1) + 1,
          approvedBy: adminEmail,
        };
        renewals.push(renewalRecord);
        return {
          ...app,
          renewalYears: (Number(app.renewalYears) || 1) + 1,
          expiresAt: renewedExpiry(app),
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

      // Idempotency: a retry of an approval that already went through — with
      // the same paymentRef, or with none at all — returns the same success.
      // Only a record that was never renewed is a genuine "no pending" 409.
      if (target.renewalStatus !== 'Pending Verification' || !target.pendingRenewal) {
        if (renewalAlreadyApproved(target, paymentRef)) {
          return await renewalAlreadyApprovedResponse(res, target);
        }
        return res.status(409).json({ error: 'There is no pending renewal request to approve.' });
      }

      if (!paymentRef || paymentRef.length < 6 || !/^[A-Za-z0-9_\-\/]{6,80}$/.test(paymentRef)) {
        return res.status(400).json({ error: 'A valid payment UTR reference is required to approve renewal.' });
      }

      const lockKey = `renewal:${id}`;
      const lockToken = await acquireLock(lockKey, 5, 25, 40);
      if (!lockToken) {
        return res.status(409).json({ error: 'Renewal approval in progress. Please retry.' });
      }

      try {
        // Re-read under lock
        const fresh = await getApplication(id);
        if (fresh.renewalStatus !== 'Pending Verification' || !fresh.pendingRenewal) {
          // A concurrent request may have completed the same approval first.
          if (renewalAlreadyApproved(fresh, paymentRef)) {
            return await renewalAlreadyApprovedResponse(res, fresh);
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
            // Priced when the member asked; older requests predate that.
            amount: app.pendingRenewal.amount ?? null,
            renewedAt: new Date().toISOString(),
            renewalYear: (Number(app.renewalYears) || 1) + 1,
            approvedBy: adminEmail,
          };
          renewals.push(renewalRecord);
          return {
            ...app,
            renewalYears: (Number(app.renewalYears) || 1) + 1,
            expiresAt: renewedExpiry(app),
            lastRenewedAt: renewalRecord.renewedAt,
            renewalStatus: 'Approved',
            renewalEmailId: `renewal-${crypto.randomUUID()}`,
            pendingRenewal: null,
            paymentRef,
            renewals,
          };
        }, renewalIntent);

        // Reported, not enforced: a failed notification never undoes the
        // approval the Secretariat just made.
        const delivery = await deliverEmailIntent(updated.renewalEmailId);

        return res.status(200).json({
          success: true,
          application: updated,
          emailSent: Boolean(delivery?.success),
          message: 'Membership renewal approved and tenure extended by +1 year.',
        });
      } finally {
        await releaseLock(lockKey, lockToken);
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
          renewalEmailId: `renewal-${crypto.randomUUID()}`,
          pendingRenewal: null,
          renewalRejectionReason: reason,
        };
      }, renewalIntent);

      const delivery = await deliverEmailIntent(updated.renewalEmailId);

      return res.status(200).json({
        success: true,
        application: updated,
        emailSent: Boolean(delivery?.success),
        message: 'Membership renewal rejected.',
      });
    }

    // Everything else is an admin review action.
    if (!adminEmail) return res.status(401).json({ error: 'Admin authentication required.' });

    const { status } = req.body || {};
    if (!status) return res.status(400).json({ error: 'No changes supplied.' });

    // normalizeStatus maps anything unrecognised to Pending (right for old
    // stored data), so a typo like "Approve" would silently un-approve a member.
    if (!['pending', 'approved', 'rejected', 'declined'].includes(String(status).trim().toLowerCase())) {
      return res.status(400).json({ error: 'Status must be Pending, Approved or Rejected.' });
    }
    const nextStatus = normalizeStatus(status);
    const reason = str(req.body.reason, 1000);
    // Read under the record's lock, so of two simultaneous identical clicks
    // exactly one sees the change and sends the email.
    const updated = await updateApplication(id, (app) => {
      const next = { ...app, status: nextStatus, reviewedAt: new Date().toISOString(), reviewedBy: adminEmail };
      if (app.status !== nextStatus && [STATUS.APPROVED, STATUS.REJECTED].includes(nextStatus)) {
        next.decisionEmailId = `decision-${crypto.randomUUID()}`;
      }
      if (nextStatus === STATUS.APPROVED && !app.approvedAt) {
        next.approvedAt = new Date().toISOString();
      }
      if (nextStatus === STATUS.REJECTED) {
        if (reason) next.rejectionReason = reason;
      } else {
        delete next.rejectionReason;
      }
      return next;
    }, decisionIntent);

    if (!updated) return res.status(404).json({ error: 'Application not found' });

    // Identical decisions reuse the intent: failed sends can retry after
    // backoff, while a completed send is never repeated. Whether it went out
    // is reported to the caller — the decision itself already stands.
    let emailSent = false;
    if ([STATUS.APPROVED, STATUS.REJECTED].includes(nextStatus)) {
      const delivery = await deliverEmailIntent(updated.decisionEmailId);
      emailSent = Boolean(delivery?.success);
    }

    return res.status(200).json({ success: true, application: updated, emailSent });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

export default withErrorHandling('Applications', handler);
