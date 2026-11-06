/* ==========================================================================
   BCCI BHARUCH — Data Store & API Client
   All server operations go through the Vercel API routes (Redis-backed).
   localStorage holds session tokens only; it is never the source of truth.
   ========================================================================== */

import { LEADERSHIP } from './leadership.js?v=1.0.3';

const API_BASE = ''; // same origin

const STORAGE_KEYS = {
  ADMIN_SESSION: 'bcci_admin_session',
  APPLICANT_SESSION: 'bcci_applicant_session',
  BOARD_SESSION: 'bcci_board_session',
};

const REQUEST_TIMEOUT_MS = 20000;

export class Store {
  /* ── API helper ───────────────────────────────────────────────────── */

  /**
   * @param {string} endpoint
   * @param {{method?: string, body?: any, auth?: 'admin'|'applicant'|'board'|null, retries?: number}} options
   */
  async apiCall(endpoint, options = {}) {
    const { method = 'GET', body, auth = null, retries = method === 'GET' ? 2 : 0 } = options;

    const headers = { 'Content-Type': 'application/json' };
    const token = this._sessionFor(auth)?.token;
    if (token) headers['Authorization'] = `Bearer ${token}`;

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
        let bodyErr = null;
        try {
          data = await res.json();
        } catch (err) {
          // Non-JSON response (a proxy error page, say). Remembered rather
          // than thrown here so the status below still reaches the error.
          bodyErr = err;
        }

        if (!res.ok) {
          // An expired or revoked session should clear itself rather than
          // leaving the UI in a signed-in state that no longer works.
          if (res.status === 401) this._forgetSession(auth);
          const error = new Error((data && data.error)
            || (bodyErr ? `Server returned ${res.status}.` : `Request failed (${res.status}).`));
          error.status = res.status;
          error.data = data;
          if (bodyErr) error.cause = bodyErr;
          throw error;
        }

        if (bodyErr) {
          // A 2xx whose body we cannot read is a failure, not an empty
          // success: resolving `{}` would look like "no records" to callers.
          const error = new Error(`Server returned ${res.status} with a response that could not be read.`);
          error.status = res.status;
          error.data = {};
          error.cause = bodyErr;
          throw error;
        }

        if (auth === 'board') this._syncBoardExpiry(res);
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

  /** The stored session an `auth` option names, or null. */
  _sessionFor(auth) {
    if (auth === 'admin') return this.getAdminSession();
    if (auth === 'applicant') return this.getApplicantSession();
    if (auth === 'board') return this.getBoardSession();
    return null;
  }

  /** Forgets the session an `auth` option names (a no-op for null). */
  _forgetSession(auth) {
    if (auth === 'admin') this.forgetAdminSession();
    else if (auth === 'applicant') this.forgetApplicantSession();
    else if (auth === 'board') this.forgetBoardSession();
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
    const found = apps.find((app) => app.id === id) || null;
    // The list omits document scans for size; refetch the single full
    // record (documents included) for dossiers and review actions.
    if (!found?.email) return found;
    try {
      const full = await this.apiCall(`/api/applications?email=${encodeURIComponent(found.email)}`, {
        auth: this.isAdminAuthed() ? 'admin' : 'applicant',
      });
      return full.application || found;
    } catch {
      return found;
    }
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
      // Signed out reads the same as "no record" for this form; anything else
      // (a dead network, a 5xx) has to reach the caller, which can tell
      // "try again" apart from "you have no application".
      if (err.status === 401) return null;
      console.error('[Store] Failed to fetch application:', err.message);
      throw err;
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

  /** Requests or executes membership renewal with payment reference. */
  async renewMembership(appId, utrRef = '', amount = null) {
    const body = { id: appId, action: 'renew', paymentRef: utrRef };
    // The fee the member was shown; the server refuses it if its price differs.
    if (Number.isFinite(amount) && amount > 0) body.paymentAmount = String(amount);
    const result = await this.apiCall('/api/applications', {
      method: 'PATCH',
      body,
      auth: this.isAdminAuthed() ? 'admin' : 'applicant',
    });
    return result.application;
  }

  /** Secretariat approval of a pending renewal (Admin Only). */
  async approveRenewal(appId, utrRef = '') {
    const body = { id: appId, action: 'approve-renewal' };
    if (utrRef) body.paymentRef = utrRef;
    const result = await this.apiCall('/api/applications', {
      method: 'PATCH',
      body,
      auth: 'admin',
    });
    return result.application;
  }

  /** Secretariat rejection of a pending renewal (Admin Only). */
  async rejectRenewal(appId, reason = '') {
    const result = await this.apiCall('/api/applications', {
      method: 'PATCH',
      body: { id: appId, action: 'reject-renewal', reason },
      auth: 'admin',
    });
    return result.application;
  }

  getMembershipValidity(app) {
    if (!app || app.status !== 'Approved') return null;

    // One corrupt date in one record must not throw the whole list down
    // (Date#toISOString raises RangeError on an invalid date).
    const asDate = (value) => {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d;
    };

    // validFrom (set for members imported from the Secretariat register) is the
    // date their membership year started; otherwise the year runs from approval.
    const startRaw = app.validFrom || app.approvedAt || app.submittedAt;
    const approvedDate = startRaw ? asDate(startRaw) : new Date();
    const yearsToAdd = Number(app.renewalYears) || 1;
    // Mirrors validUntil() in api/applications.js: a renewal stores expiresAt.
    let validUntil = asDate(app.expiresAt);
    if (!validUntil && approvedDate) {
      validUntil = new Date(approvedDate);
      validUntil.setFullYear(validUntil.getFullYear() + yearsToAdd);
      // An absurd renewalYears lands outside the range a Date can hold.
      if (Number.isNaN(validUntil.getTime())) validUntil = null;
    }
    const valid = Boolean(validUntil);

    const daysRemaining = valid ? Math.ceil((validUntil.getTime() - Date.now()) / 86400000) : null;

    let state = 'UNKNOWN';
    if (valid) {
      state = 'ACTIVE';
      if (daysRemaining <= 0) state = 'EXPIRED';
      else if (daysRemaining <= 30) state = 'RENEWAL_DUE';
    }

    const fmt = { day: 'numeric', month: 'long', year: 'numeric' };
    return {
      approvedDate: approvedDate ? approvedDate.toLocaleDateString('en-IN', fmt) : 'Unknown',
      validUntilDate: valid ? validUntil.toLocaleDateString('en-IN', fmt) : 'Unknown',
      validUntilISO: valid ? validUntil.toISOString() : null,
      daysRemaining: valid ? Math.max(0, daysRemaining) : null,
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
     MEMBERSHIP PLANS
     ════════════════════════════════════════════════════════════════════ */

  /** Every membership type on offer: built-ins plus admin-added ones. */
  async getMembershipPlans() {
    const result = await this.apiCall('/api/membership-plans');
    return Array.isArray(result.plans) ? result.plans : [];
  }

  async addMembershipPlan(name, fee) {
    const result = await this.apiCall('/api/membership-plans', {
      method: 'POST',
      body: { name, fee },
      auth: 'admin',
    });
    return result.plan;
  }

  async deleteMembershipPlan(id) {
    return this.apiCall(`/api/membership-plans?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      auth: 'admin',
    });
  }

  /* ════════════════════════════════════════════════════════════════════
     EVENTS
     ════════════════════════════════════════════════════════════════════ */

  async getEvents() {
    try {
      const result = await this.apiCall('/api/events');
      return result.events || [];
    } catch (err) {
      console.error('[Store] Failed to fetch events:', err.message);
      throw err;
    }
  }

  async getEventWithAttendees(id) {
    try {
      const result = await this.apiCall(`/api/events?id=${encodeURIComponent(id)}&includeAttendees=true`, {
        auth: 'admin',
      });
      return result.event || null;
    } catch (err) {
      console.error('[Store] Failed to fetch event attendees:', err.message);
      throw err;
    }
  }

  async broadcastEvent(eventData) {
    const result = await this.apiCall('/api/events', {
      method: 'POST',
      body: eventData,
      auth: 'admin',
    });
    return result.event;
  }

  async deleteEvent(id) {
    const result = await this.apiCall(`/api/events?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      auth: 'admin',
    });
    return result;
  }

  async registerForEvent(id, attendeeData) {
    const result = await this.apiCall('/api/events?action=register', {
      method: 'POST',
      body: { eventId: id, ...attendeeData },
    });
    return result;
  }

  async confirmEventPayment(eventId, ticketId) {
    const result = await this.apiCall('/api/events?action=confirm-payment', {
      method: 'POST',
      body: { eventId, ticketId },
      auth: 'admin',
    });
    return result;
  }

  // Idempotent on the server, so one retry after a dropped connection
  // cannot check anyone in twice.
  async checkInAttendee(eventId, ticketId, { method = 'scan', undo = false } = {}) {
    return this.apiCall('/api/events?action=check-in', {
      method: 'POST',
      body: { eventId, ticketId, method, undo },
      auth: 'admin',
      retries: 1,
    });
  }

  async removeEventAttendee(eventId, ticketId) {
    return this.apiCall('/api/events?action=remove-attendee', {
      method: 'POST',
      body: { eventId, ticketId },
      auth: 'admin',
    });
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
     APPLICANT SESSION & AUTHENTICATION
     ════════════════════════════════════════════════════════════════════ */

  async applicantLogin(email, password) {
    try {
      const result = await this.apiCall('/api/applicant-auth', {
        method: 'POST',
        body: { action: 'login', email, password },
      });

      if (result.success && result.session) {
        this.setApplicantSession(result.session);
        return { success: true, session: result.session };
      }
      return {
        success: false,
        code: result.code,
        error: result.error || 'Sign-in failed.',
      };
    } catch (err) {
      return {
        success: false,
        status: err.status,
        code: err.data?.code,
        error: err.data?.error || err.message || 'Sign-in failed.',
      };
    }
  }

  async applicantRegister(email, code, password) {
    try {
      const result = await this.apiCall('/api/applicant-auth', {
        method: 'POST',
        body: { action: 'register', email, code, password },
      });

      if (result.success && result.session) {
        this.setApplicantSession(result.session);
        return { success: true, session: result.session };
      }
      return {
        success: false,
        error: result.error || 'Registration failed.',
      };
    } catch (err) {
      return {
        success: false,
        error: err.data?.error || err.message || 'Registration failed.',
      };
    }
  }

  async applicantForgotPasswordRequest(email) {
    try {
      const result = await this.apiCall('/api/applicant-auth', {
        method: 'POST',
        body: { action: 'forgot-password-request', email },
      });

      if (result.success) {
        return {
          success: true,
          message: result.message || 'Password reset code sent to your email.',
        };
      }
      return {
        success: false,
        error: result.error || 'Failed to send reset code.',
      };
    } catch (err) {
      return {
        success: false,
        error: err.data?.error || err.message || 'Failed to send reset code.',
      };
    }
  }

  async applicantResetPassword(email, code, newPassword) {
    try {
      const result = await this.apiCall('/api/applicant-auth', {
        method: 'POST',
        body: { action: 'reset-password', email, code, newPassword },
      });

      if (result.success && result.session) {
        this.setApplicantSession(result.session);
        return { success: true, session: result.session };
      }
      return {
        success: false,
        error: result.error || 'Password reset failed.',
      };
    } catch (err) {
      return {
        success: false,
        error: err.data?.error || err.message || 'Password reset failed.',
      };
    }
  }

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

  /* ── Board portal session ─────────────────────────────────────────── */

  getBoardSession() {
    return this._readSession(STORAGE_KEYS.BOARD_SESSION);
  }

  setBoardSession(session, member) {
    this._writeSession(STORAGE_KEYS.BOARD_SESSION, { ...session, member });
  }

  async clearBoardSession() {
    if (this.getBoardSession()) {
      try {
        await this.apiCall('/api/board?action=sign-out', { method: 'POST', auth: 'board' });
      } catch (err) {
        console.warn('[Store] Could not end the board session server-side:', err.message);
      }
    }
    this.forgetBoardSession();
  }

  forgetBoardSession() {
    try { localStorage.removeItem(STORAGE_KEYS.BOARD_SESSION); } catch {}
  }

  /**
   * Board sessions renew on use, and each signed-in reply says how long the
   * session now has left. Without this the stored copy would still lapse 30
   * days after sign-in and sign out a member who never stopped using it.
   */
  _syncBoardExpiry(res) {
    const left = Number(res.headers?.get?.('X-Session-Expires-In'));
    if (!Number.isFinite(left) || left <= 0) return;
    const session = this.getBoardSession();
    if (session) this._writeSession(STORAGE_KEYS.BOARD_SESSION, { ...session, expiresIn: left });
  }

  /**
   * Downloads a file the API returns (not JSON), e.g. the attendance
   * register. Saves it under the server's filename.
   */
  async downloadFile(endpoint, { auth = 'admin', fallbackName = 'download' } = {}) {
    const headers = {};
    // The same Authorization rules as apiCall: 'admin' is the default because
    // the attendance register is an admin endpoint, but 'board'/'applicant'
    // work too rather than silently sending no token.
    const token = this._sessionFor(auth)?.token;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(`${API_BASE}${endpoint}`, { headers, signal: controller.signal });
    } catch (err) {
      throw new Error('Could not reach the server. Check your connection and try again.', { cause: err });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      let message = `Download failed (${res.status}).`;
      try { message = (await res.json()).error || message; } catch {}
      if (res.status === 401) this._forgetSession(auth);
      throw Object.assign(new Error(message), { status: res.status });
    }
    const disposition = res.headers.get('Content-Disposition') || '';
    const name = /filename="([^"]+)"/.exec(disposition)?.[1] || fallbackName;
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return name;
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

  /** Leadership shown on the About page, in display order. */
  getLeadership() {
    return LEADERSHIP;
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
