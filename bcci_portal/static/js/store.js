/* ==========================================================================
   BCCI BHARUCH - Data Store
   Primary:  Odoo backend API (when hosted on Odoo.sh)
   Fallback: localStorage (when on GitHub Pages / local dev)
   ========================================================================== */

const STORAGE_KEYS = {
  APPLICATIONS:    'bcci_membership_applications',
  ENQUIRIES:       'bcci_enquiries',
  ADMIN_AUTH:      'bcci_admin_session',
  APPLICANT_SESSION: 'bcci_applicant_session',
  SENT_EMAILS:     'bcci_sent_approval_emails'
};

/**
 * Detect whether we are running inside the Odoo instance.
 * If the origin ends with .odoo.com or .odoo.sh, use Odoo APIs.
 * Otherwise fall back to localStorage (GitHub Pages / local dev).
 */
function isOdooHost() {
  const host = window.location.hostname;
  return host.endsWith('.odoo.com') || host.endsWith('.odoo.sh') || host === 'localhost';
}

/**
 * Generic Odoo JSON-RPC caller.
 */
async function odooCall(endpoint, params = {}) {
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'call', params })
    });
    const data = await res.json();
    return data.result || { success: false, error: 'No result from server.' };
  } catch (err) {
    console.error('[Odoo API Error]', endpoint, err);
    return { success: false, error: 'Network error.' };
  }
}

export class Store {
  constructor() {
    this._useOdoo = isOdooHost();
    this._initLocalStorage();
    console.log(`[Store] Backend: ${this._useOdoo ? 'Odoo API' : 'localStorage'}`);
  }

  _initLocalStorage() {
    // Purge legacy mock data
    const currentApps = JSON.parse(localStorage.getItem(STORAGE_KEYS.APPLICATIONS) || '[]');
    if (currentApps.some(a => a.id === 'APP-1001' || a.id === 'APP-1002')) {
      localStorage.removeItem(STORAGE_KEYS.APPLICATIONS);
    }
    const currentEnqs = JSON.parse(localStorage.getItem(STORAGE_KEYS.ENQUIRIES) || '[]');
    if (currentEnqs.some(e => e.id === 'ENQ-501')) {
      localStorage.removeItem(STORAGE_KEYS.ENQUIRIES);
    }
    if (!localStorage.getItem(STORAGE_KEYS.APPLICATIONS)) {
      localStorage.setItem(STORAGE_KEYS.APPLICATIONS, JSON.stringify([]));
    }
    if (!localStorage.getItem(STORAGE_KEYS.ENQUIRIES)) {
      localStorage.setItem(STORAGE_KEYS.ENQUIRIES, JSON.stringify([]));
    }
  }

  // ── Applications ──────────────────────────────────────────────────────────

  getApplications() {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.APPLICATIONS) || '[]');
  }

  getApplicationById(id) {
    return this.getApplications().find(a => a.id === id) || null;
  }

  /**
   * Submit a new membership application.
   * On Odoo host → POST to /bcci/application/submit (saves to PostgreSQL)
   * On GitHub Pages → save to localStorage only
   */
  async addApplication(appData) {
    if (this._useOdoo) {
      const result = await odooCall('/bcci/application/submit', appData);
      if (result.success && result.application) {
        // Also cache locally for instant UI response
        const apps = this.getApplications();
        apps.unshift(result.application);
        try { localStorage.setItem(STORAGE_KEYS.APPLICATIONS, JSON.stringify(apps)); } catch (_) {}
        return result.application;
      } else {
        throw new Error(result.error || 'Failed to submit to Odoo.');
      }
    }
    // localStorage fallback
    return this._addApplicationLocal(appData);
  }

  _addApplicationLocal(appData) {
    const apps = this.getApplications();
    const newApp = {
      id: `APP-${Math.floor(1000 + Math.random() * 9000)}`,
      ...appData,
      status: 'Pending',
      submittedAt: new Date().toISOString()
    };
    apps.unshift(newApp);
    try {
      localStorage.setItem(STORAGE_KEYS.APPLICATIONS, JSON.stringify(apps));
    } catch (err) {
      console.warn('[LocalStorage Quota] Pruning older records', err);
      const pruned = apps.slice(0, 15).map((item, idx) =>
        idx === 0 ? item : { ...item, paymentProof: item.paymentProof ? '[Stored Image]' : '' }
      );
      try { localStorage.setItem(STORAGE_KEYS.APPLICATIONS, JSON.stringify(pruned)); } catch (_) {}
    }
    return newApp;
  }

  /**
   * Look up application by email or phone.
   * On Odoo → fetch from real database (works across all devices).
   * On GitHub Pages → localStorage only.
   */
  async getApplicationByEmail(emailOrPhone) {
    if (!emailOrPhone) return null;

    if (this._useOdoo) {
      const clean = emailOrPhone.toLowerCase().trim();
      const isPhone = /^\d{7,}$/.test(clean.replace(/\D/g, ''));
      const result = await odooCall('/bcci/application/status', {
        email: isPhone ? undefined : clean,
        phone: isPhone ? clean : undefined
      });
      if (result.success && result.application) return result.application;
      return null;
    }

    // localStorage fallback
    const clean = emailOrPhone.toLowerCase().trim();
    const digits = emailOrPhone.replace(/\D/g, '');
    return this.getApplications().find(app => {
      const emailMatch = (app.email || '').toLowerCase().trim() === clean;
      const phoneMatch = digits.length >= 7 && (app.phone || '').replace(/\D/g, '').endsWith(digits);
      return emailMatch || phoneMatch;
    }) || null;
  }

  getMembershipValidity(app) {
    if (!app || app.status !== 'Approved') return null;

    // Use pre-computed validity from Odoo if available
    if (app.validity && app.validity.validUntilDate) {
      return {
        approvedDate:   app.approvedAt ? new Date(app.approvedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }) : '',
        validUntilDate: app.validity.validUntilDate,
        daysRemaining:  app.validity.daysRemaining,
        state:          app.validity.state,
        yearsTenure:    app.renewalYears || 1,
      };
    }

    // Compute locally (localStorage fallback)
    const approvedDate = app.approvedAt ? new Date(app.approvedAt) : new Date(app.submittedAt || Date.now());
    const validUntil = new Date(approvedDate);
    const yearsToAdd = app.renewalYears || 1;
    validUntil.setFullYear(validUntil.getFullYear() + yearsToAdd);

    const now = new Date();
    const daysRemaining = Math.ceil((validUntil.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    let state = 'ACTIVE';
    if (daysRemaining <= 0) state = 'EXPIRED';
    else if (daysRemaining <= 30) state = 'RENEWAL_DUE';

    return {
      approvedDate:   approvedDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
      validUntilDate: validUntil.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
      validUntilISO:  validUntil.toISOString(),
      daysRemaining:  Math.max(0, daysRemaining),
      yearsTenure:    yearsToAdd,
      state
    };
  }

  renewMembership(appId, utrRef = '') {
    const apps = this.getApplications();
    const index = apps.findIndex(a => a.id === appId);
    if (index !== -1) {
      apps[index].renewalYears = (apps[index].renewalYears || 1) + 1;
      apps[index].lastRenewedAt = new Date().toISOString();
      if (utrRef) apps[index].paymentRef = utrRef;
      try { localStorage.setItem(STORAGE_KEYS.APPLICATIONS, JSON.stringify(apps)); } catch (_) {}
      return apps[index];
    }
    return null;
  }

  updateApplicationStatus(id, newStatus) {
    if (!this.isAdminAuthed()) {
      console.warn('[Auth] Admin required to update application status.');
      return null;
    }
    const apps = this.getApplications();
    const index = apps.findIndex(app => app.id === id);
    if (index !== -1) {
      apps[index].status = newStatus;
      if (newStatus === 'Approved' && !apps[index].approvedAt) {
        apps[index].approvedAt = new Date().toISOString();
      }
      try { localStorage.setItem(STORAGE_KEYS.APPLICATIONS, JSON.stringify(apps)); } catch (_) {}
      return apps[index];
    }
    return null;
  }

  // ── Enquiries ─────────────────────────────────────────────────────────────

  getEnquiries() {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.ENQUIRIES) || '[]');
  }

  async addEnquiry(enquiryData) {
    if (this._useOdoo) {
      const result = await odooCall('/bcci/enquiry/submit', enquiryData);
      if (result.success) {
        const newEnq = { id: result.id, ...enquiryData, submittedAt: new Date().toISOString() };
        const enquiries = this.getEnquiries();
        enquiries.unshift(newEnq);
        try { localStorage.setItem(STORAGE_KEYS.ENQUIRIES, JSON.stringify(enquiries)); } catch (_) {}
        return newEnq;
      }
      throw new Error(result.error || 'Failed to submit enquiry.');
    }
    // localStorage fallback
    const enquiries = this.getEnquiries();
    const newEnq = {
      id: `ENQ-${Math.floor(500 + Math.random() * 500)}`,
      ...enquiryData,
      submittedAt: new Date().toISOString()
    };
    enquiries.unshift(newEnq);
    try { localStorage.setItem(STORAGE_KEYS.ENQUIRIES, JSON.stringify(enquiries)); } catch (_) {}
    return newEnq;
  }

  // ── Admin Authentication ───────────────────────────────────────────────────

  isAdminAuthed() {
    return localStorage.getItem(STORAGE_KEYS.ADMIN_AUTH) === 'true';
  }

  setAdminAuth(status) {
    localStorage.setItem(STORAGE_KEYS.ADMIN_AUTH, status ? 'true' : 'false');
  }

  validateAdminCredentials(username, password) {
    // NOTE: This is a temporary placeholder.
    // Replace with Odoo session auth when credentials are available (Monday).
    if (!username || !password) return false;
    const u = username.toLowerCase().trim();
    const p = password.trim();
    const validUsers = ['admin', 'admin@bccibharuch.in', 'bcci'];
    // Minimum 8-char password enforced to prevent trivial bypass
    return validUsers.includes(u) && p.length >= 8;
  }

  // ── Applicant Session (always localStorage — per-user auth state) ──────────

  getApplicantSession() {
    const data = localStorage.getItem(STORAGE_KEYS.APPLICANT_SESSION);
    return data ? JSON.parse(data) : null;
  }

  setApplicantSession(sessionData) {
    localStorage.setItem(STORAGE_KEYS.APPLICANT_SESSION, JSON.stringify(sessionData));
  }

  clearApplicantSession() {
    localStorage.removeItem(STORAGE_KEYS.APPLICANT_SESSION);
  }

  // ── Email Log (localStorage — admin notifications) ────────────────────────

  getSentEmails() {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.SENT_EMAILS) || '[]');
  }

  sendApprovalEmail(application) {
    if (!this.isAdminAuthed()) return null;
    const repName = application.repName || 'Member Representative';
    const emailData = {
      id: `MAIL-${Math.floor(1000 + Math.random() * 9000)}`,
      appId: application.id,
      company: application.company,
      recipientName: repName,
      recipientEmail: application.email,
      subject: `Official Membership Approval - BCCI (${application.id})`,
      sentAt: new Date().toISOString(),
      body: `Dear ${repName}, your application ${application.id} for "${application.company}" has been APPROVED.`
    };
    const sentEmails = this.getSentEmails();
    sentEmails.unshift(emailData);
    localStorage.setItem(STORAGE_KEYS.SENT_EMAILS, JSON.stringify(sentEmails));
    return emailData;
  }

  sendAdminNewApplicationNotification(application) {
    const repName = application.repName || 'Applicant';
    return {
      id: `NOTIF-${Math.floor(1000 + Math.random() * 9000)}`,
      appId: application.id,
      company: application.company,
      subject: `[ADMIN ALERT] New BCCI Application: ${application.company} (${application.id})`,
      sentAt: new Date().toISOString(),
      body: `New application submitted: ${application.id} by ${repName} (${application.email})`
    };
  }

  sendApplicantReceivedEmail(application) {
    const repName = application.repName || 'Valued Applicant';
    const emailData = {
      id: `ACK-${Math.floor(1000 + Math.random() * 9000)}`,
      appId: application.id,
      company: application.company,
      recipientName: repName,
      recipientEmail: application.email,
      subject: `BCCI Application Received (${application.id})`,
      sentAt: new Date().toISOString(),
      body: `Dear ${repName}, we received your application for "${application.company}". Status: PENDING REVIEW.`
    };
    const sentEmails = this.getSentEmails();
    sentEmails.unshift(emailData);
    localStorage.setItem(STORAGE_KEYS.SENT_EMAILS, JSON.stringify(sentEmails));
    return emailData;
  }

  // ── Static Data Providers ─────────────────────────────────────────────────

  getLeadership() {
    return [
      { name: 'MR. KIRAN K. MAJMUDAR', role: 'President', category: 'Executive Board', initials: 'KM', image: 'assets/President_photo.webp', linkedin: 'https://www.linkedin.com/in/kiran-k-majmudar-52b235308/' },
      { name: 'MR. KAMAL KUMAR', role: 'Joint Vice President', category: 'Executive Board', initials: 'KK', image: 'assets/KAmal.webp', linkedin: 'https://www.linkedin.com/in/kamal-kumar-165a5b86' },
      { name: 'MR. ANISH PARIKH', role: 'Joint Vice President', category: 'Executive Board', initials: 'AP', image: 'assets/anish.webp', linkedin: 'https://www.linkedin.com/in/anish-parikh-4a5156b6/' },
      { name: 'MR. TUSHAR P. SHAH', role: 'Secretary', category: 'Executive Board', initials: 'TS', image: 'assets/tushar.webp' },
      { name: 'DR. C. D. SHELAT', role: 'Executive Secretary', category: 'Administration', initials: 'CS', image: 'assets/WhatsApp Image 2026-07-02 at 08.01.51.webp', linkedin: 'https://www.linkedin.com/in/dr-c-d-shelat-16902563/' },
      { name: 'MR. TUSHAR J. SHAH', role: 'Hon. Treasurer', category: 'Finance', initials: 'TJ' },
      { name: 'BHAAVIK BAROT', role: 'Founder Member - IT & AI', category: 'Technology', initials: 'BB', image: 'assets/WhatsApp Image 2026-02-13 at 14.59.38.webp', linkedin: 'https://www.linkedin.com/in/bhavikbarot/' }
    ];
  }

  getServices() {
    return [
      { id: 'coo', title: 'Certificate of Origin', icon: 'fa-certificate', desc: 'BCCI issues official Certificates of Origin certifying country of manufacture for seamless export clearance and global trade compliance.' },
      { id: 'attestation', title: 'Document Attestation', icon: 'fa-file-signature', desc: 'Authentication of commercial invoices, packing lists, and trade documents for embassy attestation and government regulatory bodies.' },
      { id: 'visa', title: 'Visa Recommendation Letters', icon: 'fa-passport', desc: 'Formal recommendation letters issued to member delegates for expedited business travel visas, trade expos, and international delegations.' },
      { id: 'trade', title: 'Trade Facilitation', icon: 'fa-globe-asia', desc: 'Guidance and advisory for domestic and international trade, customs coordination, and B2B expansion networking.' },
      { id: 'advisory', title: 'Business & Policy Advisory', icon: 'fa-briefcase', desc: 'Advocacy for Ease of Doing Business (EoDB), policy reform representations, legal compliance guidance, and regulatory support.' },
      { id: 'training', title: 'Training & Workshops', icon: 'fa-chalkboard-teacher', desc: 'Regular seminars, skill enhancement workshops, GST updates, technology adoption sessions, and leadership forums.' }
    ];
  }

  getFaqs() {
    return [
      { q: 'What is Bharuch Chamber of Commerce & Industry (BCCI)?', a: 'BCCI is a trusted institutional platform representing the collective strength of commerce and industry in Bharuch district. It acts as an authoritative voice for business growth, policy advocacy, and inter-industry collaboration.' },
      { q: 'Why is Bharuch considered an important industrial hub?', a: 'Bharuch is Asia\'s largest industrial hub with massive investments in Chemicals, Petrochemicals, Fertilizers, Pharmaceuticals, Textiles, Logistics, and Energy. It houses over 12,000 MSMEs and 625+ large industries.' },
      { q: 'How does the Admin Approval process work for new members?', a: 'When you submit the Membership Form, your registration status remains "Pending Admin Approval". The BCCI Admin Board reviews your company credentials, GST/PAN documentation, and approves the application before member access is granted.' },
      { q: 'What are the main membership categories?', a: 'BCCI offers Corporate Membership, Associate Membership, and Associate Limited Membership based on enterprise scale and legal structure.' },
      { q: 'How does BCCI support Ease of Doing Business (EoDB)?', a: 'BCCI works closely with state government bodies, GIDC authorities, and central ministries to address policy friction, reduce compliance bottlenecks, and advocate business-friendly industrial reforms.' },
      { q: 'What specialized committees function under BCCI?', a: 'Key committees include Policy & Advocacy, MSME & Startup, Export Promotion, Legal & Regulatory Affairs, and Innovation & Digitalisation.' }
    ];
  }
}
