/* ==========================================================================
   BCCI BHARUCH — Data Store & API Client
   All server operations go through the Vercel API routes (Redis-backed).
   localStorage holds session tokens only; it is never the source of truth.
   ========================================================================== */

const API_BASE = ''; // same origin

const STORAGE_KEYS = {
  ADMIN_SESSION: 'bcci_admin_session',
  APPLICANT_SESSION: 'bcci_applicant_session',
};

const REQUEST_TIMEOUT_MS = 20000;

export class Store {
  /* ── API helper ───────────────────────────────────────────────────── */

  /**
   * @param {string} endpoint
   * @param {{method?: string, body?: any, auth?: 'admin'|'applicant'|null, retries?: number}} options
   */
  async apiCall(endpoint, options = {}) {
    const { method = 'GET', body, auth = null, retries = method === 'GET' ? 2 : 0 } = options;

    const headers = { 'Content-Type': 'application/json' };
    if (auth === 'admin') {
      const session = this.getAdminSession();
      if (session?.token) headers['Authorization'] = `Bearer ${session.token}`;
    } else if (auth === 'applicant') {
      const session = this.getApplicantSession();
      if (session?.token) headers['Authorization'] = `Bearer ${session.token}`;
    }

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const res = await fetch(`${API_BASE}${endpoint}`, {
          method,
          headers,
          signal: controller.signal,
          ...(body && method !== 'GET' ? { body: JSON.stringify(body) } : {}),
        });

        let data = {};
        try {
          data = await res.json();
        } catch {
          // Non-JSON response (a proxy error page, say).
          if (!res.ok) throw new Error(`Server returned ${res.status}.`);
        }

        if (!res.ok) {
          // An expired or revoked session should clear itself rather than
          // leaving the UI in a signed-in state that no longer works.
          if (res.status === 401) {
            if (auth === 'admin') this.forgetAdminSession();
            if (auth === 'applicant') this.forgetApplicantSession();
          }
          const error = new Error(data.error || `Request failed (${res.status}).`);
          error.status = res.status;
          error.data = data;
          throw error;
        }

        return data;
      } catch (err) {
        lastErr = err;
        // Only retry transient network/timeout failures, never a real
        // HTTP error — re-sending a POST would duplicate the record.
        const transient = !err.status && attempt < retries;
        if (!transient) break;
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      } finally {
        clearTimeout(timer);
      }
    }

    if (lastErr && !lastErr.status) {
      const netErr = new Error('Could not reach the server. Check your connection and try again.');
      netErr.cause = lastErr;
      throw netErr;
    }
    throw lastErr;
  }

  /* ════════════════════════════════════════════════════════════════════
     APPLICATIONS
     ════════════════════════════════════════════════════════════════════ */

  /** Admin-only: every application, newest first. */
  async getApplications() {
    try {
      const result = await this.apiCall('/api/applications', { auth: 'admin' });
      return result.applications || [];
    } catch (err) {
      console.error('[Store] Failed to fetch applications:', err.message);
      throw err;
    }
  }

  async getApplicationById(id) {
    const apps = await this.getApplications();
    return apps.find((app) => app.id === id) || null;
  }

  async addApplication(appData) {
    const result = await this.apiCall('/api/applications', {
      method: 'POST',
      body: appData,
      auth: 'applicant',
    });
    return result.application;
  }

  /** The signed-in applicant's own application (or any, for an admin). */
  async getApplicationByEmail(email) {
    if (!email) return null;
    try {
      const result = await this.apiCall(
        `/api/applications?email=${encodeURIComponent(email)}`,
        { auth: this.isAdminAuthed() ? 'admin' : 'applicant' }
      );
      return result.application || null;
    } catch (err) {
      if (err.status === 401) return null;
      console.error('[Store] Failed to fetch application:', err.message);
      return null;
    }
  }

  async updateApplicationStatus(id, newStatus, reason = '') {
    const result = await this.apiCall('/api/applications', {
      method: 'PATCH',
      body: { id, status: newStatus, reason },
      auth: 'admin',
    });
    return result.application;
  }

  /** Extends the member's own membership by one year. */
  async renewMembership(appId, utrRef = '') {
    const result = await this.apiCall('/api/applications', {
      method: 'PATCH',
      body: { id: appId, action: 'renew', paymentRef: utrRef },
      auth: this.isAdminAuthed() ? 'admin' : 'applicant',
    });
    return result.application;
  }

  getMembershipValidity(app) {
    if (!app || app.status !== 'Approved') return null;

    const approvedDate = app.approvedAt
      ? new Date(app.approvedAt)
      : new Date(app.submittedAt || Date.now());
    const validUntil = new Date(approvedDate);
    const yearsToAdd = Number(app.renewalYears) || 1;
    validUntil.setFullYear(validUntil.getFullYear() + yearsToAdd);

    const daysRemaining = Math.ceil((validUntil.getTime() - Date.now()) / 86400000);

    let state = 'ACTIVE';
    if (daysRemaining <= 0) state = 'EXPIRED';
    else if (daysRemaining <= 30) state = 'RENEWAL_DUE';

    const fmt = { day: 'numeric', month: 'long', year: 'numeric' };
    return {
      approvedDate: approvedDate.toLocaleDateString('en-IN', fmt),
      validUntilDate: validUntil.toLocaleDateString('en-IN', fmt),
      validUntilISO: validUntil.toISOString(),
      daysRemaining: Math.max(0, daysRemaining),
      yearsTenure: yearsToAdd,
      state,
    };
  }

  /* ════════════════════════════════════════════════════════════════════
     ENQUIRIES
     ════════════════════════════════════════════════════════════════════ */

  /** Admin-only. */
  async getEnquiries() {
    try {
      const result = await this.apiCall('/api/enquiries', { auth: 'admin' });
      return result.enquiries || [];
    } catch (err) {
      console.error('[Store] Failed to fetch enquiries:', err.message);
      throw err;
    }
  }

  async addEnquiry(enquiryData) {
    const result = await this.apiCall('/api/enquiries', {
      method: 'POST',
      body: enquiryData,
    });
    return result.enquiry;
  }

  /* ════════════════════════════════════════════════════════════════════
     ADMIN SESSION
     ════════════════════════════════════════════════════════════════════ */

  getAdminSession() {
    return this._readSession(STORAGE_KEYS.ADMIN_SESSION);
  }

  isAdminAuthed() {
    return this.getAdminSession() !== null;
  }

  async setAdminAuth(username, password) {
    try {
      const result = await this.apiCall('/api/admin-auth', {
        method: 'POST',
        body: { username, password },
      });

      if (result.success && result.session) {
        this._writeSession(STORAGE_KEYS.ADMIN_SESSION, result.session);
        return { success: true };
      }
      return { success: false, error: result.error || 'Sign-in failed.' };
    } catch (err) {
      return { success: false, error: err.message || 'Sign-in failed.' };
    }
  }

  async clearAdminSession() {
    if (this.getAdminSession()) {
      try {
        await this.apiCall('/api/admin-auth', { method: 'DELETE', auth: 'admin' });
      } catch (err) {
        console.warn('[Store] Could not invalidate admin session server-side:', err.message);
      }
    }
    this.forgetAdminSession();
  }

  forgetAdminSession() {
    try { localStorage.removeItem(STORAGE_KEYS.ADMIN_SESSION); } catch {}
  }

  /* ════════════════════════════════════════════════════════════════════
     APPLICANT SESSION — token issued by /api/verify-otp
     ════════════════════════════════════════════════════════════════════ */

  getApplicantSession() {
    return this._readSession(STORAGE_KEYS.APPLICANT_SESSION);
  }

  setApplicantSession(sessionData) {
    this._writeSession(STORAGE_KEYS.APPLICANT_SESSION, sessionData);
  }

  async clearApplicantSession() {
    if (this.getApplicantSession()) {
      try {
        await this.apiCall('/api/verify-otp', { method: 'DELETE', auth: 'applicant' });
      } catch (err) {
        console.warn('[Store] Could not invalidate applicant session server-side:', err.message);
      }
    }
    this.forgetApplicantSession();
  }

  forgetApplicantSession() {
    try { localStorage.removeItem(STORAGE_KEYS.APPLICANT_SESSION); } catch {}
  }

  /* ── Session storage plumbing ─────────────────────────────────────── */

  _writeSession(key, session) {
    // expiresIn arrives in SECONDS; Date.now() is in milliseconds. Forgetting
    // to convert made admin sessions expire 3.6 seconds after sign-in.
    const ttlMs = (Number(session.expiresIn) || 3600) * 1000;
    const stored = { ...session, expiresAt: Date.now() + ttlMs };
    try {
      localStorage.setItem(key, JSON.stringify(stored));
    } catch (err) {
      console.warn('[Store] Could not persist session:', err.message);
    }
  }

  _readSession(key) {
    let raw;
    try {
      raw = localStorage.getItem(key);
    } catch {
      return null;
    }
    if (!raw) return null;

    try {
      const session = JSON.parse(raw);
      if (!session?.token) throw new Error('missing token');
      if (session.expiresAt && Date.now() > session.expiresAt) {
        try { localStorage.removeItem(key); } catch {}
        return null;
      }
      return session;
    } catch {
      try { localStorage.removeItem(key); } catch {}
      return null;
    }
  }

  /* ════════════════════════════════════════════════════════════════════
     STATIC CONTENT
     ════════════════════════════════════════════════════════════════════ */

  getLeadership() {
    return [
      { name: 'MR. KIRAN K. MAJMUDAR', role: 'President', category: 'Executive Board', initials: 'KM', image: 'assets/President_photo.webp', linkedin: 'https://www.linkedin.com/in/kiran-k-majmudar-52b235308/' },
      { name: 'MR. KAMAL KUMAR', role: 'Joint Vice President', category: 'Executive Board', initials: 'KK', image: 'assets/KAmal.webp', linkedin: 'https://www.linkedin.com/in/kamal-kumar-165a5b86' },
      { name: 'MR. ANISH PARIKH', role: 'Joint Vice President', category: 'Executive Board', initials: 'AP', image: 'assets/anish.webp', linkedin: 'https://www.linkedin.com/in/anish-parikh-4a5156b6/' },
      { name: 'MR. TUSHAR P. SHAH', role: 'Secretary', category: 'Executive Board', initials: 'TS', image: 'assets/tushar.webp' },
      { name: 'DR. C. D. SHELAT', role: 'Executive Secretary', category: 'Administration', initials: 'CS', image: 'assets/cd-shelat.webp', linkedin: 'https://www.linkedin.com/in/dr-c-d-shelat-16902563/' },
      { name: 'MR. TUSHAR J. SHAH', role: 'Hon. Treasurer', category: 'Finance', initials: 'TJ' },
      { name: 'BHAAVIK BAROT', role: 'Founder Member - IT & AI', category: 'Technology', initials: 'BB', image: 'assets/bhavik-barot.webp', linkedin: 'https://www.linkedin.com/in/bhavikbarot/' }
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
