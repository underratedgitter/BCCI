/* ==========================================================================
   BCCI BHARUCH - Data Store & API Client
   All server operations go through Vercel API routes (Redis-backed).
   localStorage is ONLY used for client-side session caching.
   ========================================================================== */

const API_BASE = ''; // Same origin in production

const STORAGE_KEYS = {
  ADMIN_SESSION: 'bcci_admin_session',
  APPLICANT_SESSION: 'bcci_applicant_session',
};

export class Store {
  constructor() {
    // No localStorage initialization needed for server-backed data
  }

  /* ── API Helper ──────────────────────────────────────────────────── */
  async apiCall(endpoint, options = {}) {
    const { method = 'GET', body, adminAuth = false } = options;
    const headers = { 'Content-Type': 'application/json' };

    if (adminAuth) {
      const session = this.getAdminSession();
      if (session && session.token) {
        headers['Authorization'] = `Bearer ${session.token}`;
      }
    }

    const fetchOptions = { method, headers };
    if (body && method !== 'GET') {
      fetchOptions.body = JSON.stringify(body);
    }

    const res = await fetch(`${API_BASE}${endpoint}`, fetchOptions);
    const data = await res.json();

    if (!res.ok) {
      const error = new Error(data.error || `API error: ${res.status}`);
      error.status = res.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  /* ════════════════════════════════════════════════════════════════════
     APPLICATIONS — Server-backed CRUD
     ════════════════════════════════════════════════════════════════════ */

  async getApplications() {
    try {
      const result = await this.apiCall('/api/applications', { adminAuth: true });
      return result.applications || [];
    } catch (err) {
      console.error('[Store] Failed to fetch applications:', err.message);
      return [];
    }
  }

  async getApplicationById(id) {
    const apps = await this.getApplications();
    return apps.find(app => app.id === id) || null;
  }

  async addApplication(appData) {
    try {
      const result = await this.apiCall('/api/applications', {
        method: 'POST',
        body: appData
      });
      return result.application;
    } catch (err) {
      console.error('[Store] Failed to add application:', err.message);
      throw err;
    }
  }

  async getApplicationByEmail(email) {
    if (!email) return null;
    try {
      // Try to get application by email (works for both admin and applicant)
      const result = await this.apiCall(`/api/applications?email=${encodeURIComponent(email)}`);
      return result.application || null;
    } catch (err) {
      // Fallback: try admin auth
      try {
        const apps = await this.getApplications();
        return apps.find(app => (app.email || '').toLowerCase().trim() === email.toLowerCase().trim()) || null;
      } catch {
        return null;
      }
    }
  }

  async updateApplicationStatus(id, newStatus) {
    try {
      const result = await this.apiCall('/api/applications', {
        method: 'PATCH',
        body: { id, status: newStatus },
        adminAuth: true
      });
      return result.application;
    } catch (err) {
      console.error('[Store] Failed to update application:', err.message);
      throw err;
    }
  }

  async renewMembership(appId, utrRef = '') {
    // Renewal extends the membership by 1 year client-side
    // (server stores renewalYears as part of the application)
    try {
      const apps = await this.getApplications();
      const app = apps.find(a => a.id === appId);
      if (!app) return null;

      // Update via PATCH with renewal data
      const result = await this.apiCall('/api/applications', {
        method: 'PATCH',
        body: {
          id: appId,
          status: 'Approved',
          renewalYears: (app.renewalYears || 1) + 1,
          lastRenewedAt: new Date().toISOString(),
          paymentRef: utrRef || app.paymentRef,
        },
        adminAuth: true
      });
      return result.application;
    } catch (err) {
      console.error('[Store] Failed to renew membership:', err.message);
      throw err;
    }
  }

  getMembershipValidity(app) {
    if (!app || app.status !== 'Approved') return null;

    const approvedDate = app.approvedAt ? new Date(app.approvedAt) : new Date(app.submittedAt || Date.now());
    const validUntil = new Date(approvedDate);
    const yearsToAdd = app.renewalYears || 1;
    validUntil.setFullYear(validUntil.getFullYear() + yearsToAdd);

    const now = new Date();
    const diffMs = validUntil.getTime() - now.getTime();
    const daysRemaining = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    let state = 'ACTIVE';
    if (daysRemaining <= 0) {
      state = 'EXPIRED';
    } else if (daysRemaining <= 30) {
      state = 'RENEWAL_DUE';
    }

    return {
      approvedDate: approvedDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
      validUntilDate: validUntil.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
      validUntilISO: validUntil.toISOString(),
      daysRemaining: Math.max(0, daysRemaining),
      yearsTenure: yearsToAdd,
      state: state,
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     ENQUIRIES — Server-backed CRUD
     ════════════════════════════════════════════════════════════════════ */

  async getEnquiries() {
    try {
      const result = await this.apiCall('/api/enquiries');
      return result.enquiries || [];
    } catch (err) {
      console.error('[Store] Failed to fetch enquiries:', err.message);
      return [];
    }
  }

  async addEnquiry(enquiryData) {
    try {
      const result = await this.apiCall('/api/enquiries', {
        method: 'POST',
        body: enquiryData
      });
      return result.enquiry;
    } catch (err) {
      console.error('[Store] Failed to add enquiry:', err.message);
      throw err;
    }
  }

  /* ════════════════════════════════════════════════════════════════════
     ADMIN AUTHENTICATION — Server-backed with session tokens
     ════════════════════════════════════════════════════════════════════ */

  getAdminSession() {
    const data = localStorage.getItem(STORAGE_KEYS.ADMIN_SESSION);
    if (!data) return null;
    try {
      const session = JSON.parse(data);
      // Check if client-side session is expired
      if (session.expiresAt && Date.now() > session.expiresAt) {
        localStorage.removeItem(STORAGE_KEYS.ADMIN_SESSION);
        return null;
      }
      return session;
    } catch {
      localStorage.removeItem(STORAGE_KEYS.ADMIN_SESSION);
      return null;
    }
  }

  isAdminAuthed() {
    return this.getAdminSession() !== null;
  }

  async setAdminAuth(username, password) {
    try {
      const result = await this.apiCall('/api/admin-auth', {
        method: 'POST',
        body: { username, password }
      });

      if (result.success && result.session) {
        const clientSession = {
          token: result.session.token,
          username: result.session.username,
          createdAt: result.session.createdAt,
          expiresAt: Date.now() + result.session.expiresIn,
        };
        localStorage.setItem(STORAGE_KEYS.ADMIN_SESSION, JSON.stringify(clientSession));
        return { success: true };
      }

      return { success: false, error: result.error };
    } catch (err) {
      return { success: false, error: err.message || 'Login failed.' };
    }
  }

  async clearAdminSession() {
    const session = this.getAdminSession();
    if (session && session.token) {
      try {
        await this.apiCall('/api/admin-auth', {
          method: 'DELETE',
          adminAuth: true
        });
      } catch (err) {
        console.warn('[Store] Failed to invalidate server session:', err.message);
      }
    }
    localStorage.removeItem(STORAGE_KEYS.ADMIN_SESSION);
  }

  /* ════════════════════════════════════════════════════════════════════
     APPLICANT SESSION — Client-side only (OTP verified)
     ════════════════════════════════════════════════════════════════════ */

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

  /* ════════════════════════════════════════════════════════════════════
     EMAIL NOTIFICATION HELPERS (Client-side generation, sent via API)
     ════════════════════════════════════════════════════════════════════ */

  generateApprovalEmailData(application) {
    const repName = application.repName || 'Member Representative';
    return {
      recipientName: repName,
      recipientEmail: application.email,
      subject: `Official Membership Approval - Bharuch Chamber of Commerce & Industry (${application.id})`,
      body: `Dear ${repName},

We are pleased to inform you that your application for BCCI Membership (${application.id}) for "${application.company}" has been formally REVIEWED and APPROVED by the BCCI Secretariat Board.

Your institutional membership is now ACTIVE. You are entitled to all member privileges, trade facilitation services, and policy representation under the Bharuch Chamber of Commerce & Industry.

Official Membership Record:
- Application ID: ${application.id}
- Enterprise: ${application.company}
- Approved On: ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
- Status: ACTIVATED & APPROVED

Welcome to Asia's Largest Industrial Corridor Network.

Warm Regards,
BCCI Secretariat & Membership Board
Bharuch Chamber of Commerce & Industry
admin@bccibharuch.in | +91 7861906384`
    };
  }

  generateAdminNotificationData(application) {
    const repName = application.repName || 'Applicant';
    return {
      subject: `[ADMIN ALERT] New BCCI Membership Application: ${application.company} (${application.id})`,
      body: `ATTN: BCCI Secretariat & Admin Board,

A new membership application has been submitted on the BCCI Official Portal and is pending your review & approval.

Application Summary:
- Application ID: ${application.id}
- Company Name: ${application.company}
- Representative: ${repName} (${application.repDesignation || 'Delegate'})
- Sector: ${application.businessServices || 'N/A'}
- Scale: ${application.enterpriseType || 'N/A'} • ${application.legalStatus || 'N/A'}
- Email: ${application.email}
- Phone: ${application.phone}
- GSTIN: ${application.gstNo || 'N/A'}
- UTR Ref: ${application.paymentRef || 'N/A'}
- Date Submitted: ${new Date().toLocaleString('en-IN')}

Please sign in to the BCCI Admin Portal to inspect details and approve or reject this membership.`
    };
  }

  generateApplicantReceivedEmailData(application) {
    const repName = application.repName || 'Valued Applicant';
    return {
      recipientName: repName,
      recipientEmail: application.email,
      subject: `BCCI Membership Application Received (${application.id}) - Pending Admin Verification`,
      body: `Dear ${repName},

Thank you for applying for Institutional Membership with the Bharuch Chamber of Commerce & Industry (BCCI).

We have successfully received your membership application for "${application.company}".

Application Record Details:
- Application Reference ID: ${application.id}
- Enterprise / Firm: ${application.company}
- Representative: ${repName}
- Date Submitted: ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
- Status: PENDING ADMIN APPROVAL & VERIFICATION

Next Steps:
As per BCCI institutional regulations, your application credentials, legal documentation, and payment proof reference are currently undergoing verification by the BCCI Secretariat Administration.

Once reviewed and approved by the Secretariat Board, you will receive a formal Membership Confirmation & Welcome Email activating your institutional membership privileges.

For urgent enquiries, you may contact the BCCI Secretariat office at admin@bccibharuch.in or +91 7861906384.

Warm Regards,
BCCI Secretariat & Membership Board
Bharuch Chamber of Commerce & Industry
Station Road, Bharuch - 392001`
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     EMAIL DISPATCH — Sends via /api/send-email (Resend + SMTP fallback)
     ════════════════════════════════════════════════════════════════════ */

  async sendEmail(type, to, data) {
    try {
      const result = await this.apiCall('/api/send-email', {
        method: 'POST',
        body: { type, to, data }
      });
      return result;
    } catch (err) {
      console.error(`[Store] Failed to send ${type} email:`, err.message);
      return { success: false, error: err.message };
    }
  }

  /* ════════════════════════════════════════════════════════════════════
     STATIC DATA — Remains client-side (no server needed)
     ════════════════════════════════════════════════════════════════════ */

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
