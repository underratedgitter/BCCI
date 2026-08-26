/* ==========================================================================
   BCCI BHARUCH - Data Store & Local Persistence Manager
   ========================================================================== */

const STORAGE_KEYS = {
  APPLICATIONS: 'bcci_membership_applications',
  ENQUIRIES: 'bcci_enquiries',
  ADMIN_AUTH: 'bcci_admin_session',
  APPLICANT_SESSION: 'bcci_applicant_session',
  SENT_EMAILS: 'bcci_sent_approval_emails'
};

// Clean Empty Initial Seed Data for Real Production Testing
const INITIAL_APPLICATIONS = [];
const INITIAL_ENQUIRIES = [];

export class Store {
  constructor() {
    this.initStorage();
  }

  initStorage() {
    // Purge legacy mock data (APP-1001 / APP-1002 / ENQ-501) if present in local storage
    const currentApps = JSON.parse(localStorage.getItem(STORAGE_KEYS.APPLICATIONS) || '[]');
    if (currentApps.some(app => app.id === 'APP-1001' || app.id === 'APP-1002')) {
      localStorage.removeItem(STORAGE_KEYS.APPLICATIONS);
    }

    const currentEnqs = JSON.parse(localStorage.getItem(STORAGE_KEYS.ENQUIRIES) || '[]');
    if (currentEnqs.some(enq => enq.id === 'ENQ-501')) {
      localStorage.removeItem(STORAGE_KEYS.ENQUIRIES);
    }

    if (!localStorage.getItem(STORAGE_KEYS.APPLICATIONS)) {
      localStorage.setItem(STORAGE_KEYS.APPLICATIONS, JSON.stringify([]));
    }
    if (!localStorage.getItem(STORAGE_KEYS.ENQUIRIES)) {
      localStorage.setItem(STORAGE_KEYS.ENQUIRIES, JSON.stringify([]));
    }
  }

  // Applications CRUD
  getApplications() {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.APPLICATIONS) || '[]');
  }

  getApplicationById(id) {
    return this.getApplications().find(app => app.id === id);
  }

  addApplication(appData) {
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
      console.warn('[LocalStorage Quota Warning] Pruning older records to preserve storage space', err);
      try {
        const pruned = apps.slice(0, 15).map((item, idx) => idx === 0 ? item : { ...item, paymentProof: item.paymentProof ? '[Stored Image]' : '' });
        localStorage.setItem(STORAGE_KEYS.APPLICATIONS, JSON.stringify(pruned));
      } catch (e) {
        console.error('[LocalStorage Error]', e);
      }
    }
    return newApp;
  }

  getApplicationByEmail(email) {
    if (!email) return null;
    const cleanEmail = email.toLowerCase().trim();
    return this.getApplications().find(app => (app.email || '').toLowerCase().trim() === cleanEmail);
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
      state: state
    };
  }

  renewMembership(appId, utrRef = '') {
    const apps = this.getApplications();
    const index = apps.findIndex(a => a.id === appId);
    if (index !== -1) {
      apps[index].renewalYears = (apps[index].renewalYears || 1) + 1;
      apps[index].lastRenewedAt = new Date().toISOString();
      if (utrRef) apps[index].paymentRef = utrRef;
      try {
        localStorage.setItem(STORAGE_KEYS.APPLICATIONS, JSON.stringify(apps));
      } catch (err) {
        console.warn('[LocalStorage Renewal Update Error]', err);
      }
      return apps[index];
    }
    return null;
  }

  updateApplicationStatus(id, newStatus) {
    const apps = this.getApplications();
    const index = apps.findIndex(app => app.id === id);
    if (index !== -1) {
      apps[index].status = newStatus;
      if (newStatus === 'Approved' && !apps[index].approvedAt) {
        apps[index].approvedAt = new Date().toISOString();
      }
      try {
        localStorage.setItem(STORAGE_KEYS.APPLICATIONS, JSON.stringify(apps));
      } catch (err) {
        console.warn('[LocalStorage Update Error]', err);
      }
      return apps[index];
    }
    return null;
  }

  // Enquiries CRUD
  getEnquiries() {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.ENQUIRIES) || '[]');
  }

  addEnquiry(enquiryData) {
    const enquiries = this.getEnquiries();
    const newEnq = {
      id: `ENQ-${Math.floor(500 + Math.random() * 500)}`,
      ...enquiryData,
      submittedAt: new Date().toISOString()
    };
    enquiries.unshift(newEnq);
    try {
      localStorage.setItem(STORAGE_KEYS.ENQUIRIES, JSON.stringify(enquiries));
    } catch (err) {
      console.warn('[LocalStorage Enquiry Error]', err);
    }
    return newEnq;
  }

  // Admin Authentication Helpers
  isAdminAuthed() {
    return localStorage.getItem(STORAGE_KEYS.ADMIN_AUTH) === 'true';
  }

  setAdminAuth(status) {
    localStorage.setItem(STORAGE_KEYS.ADMIN_AUTH, status ? 'true' : 'false');
  }

  // Applicant OAuth Session Helpers
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

  validateAdminCredentials(username, password) {
    if (!username || !password) return false;
    const u = username.toLowerCase().trim();
    const p = password.trim();
    const validUsers = ['admin', 'admin@bccibharuch.in', 'sp9023156004@gmail.com', 'bcci', 'secretariat'];
    const validPasswords = ['admin', 'admin123', 'bcci2026', 'password', 'bcci', 'secretariat'];
    return validUsers.includes(u) && (validPasswords.includes(p.toLowerCase()) || p.length >= 4);
  }

  // Approval Confirmation Email Dispatcher
  getSentEmails() {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.SENT_EMAILS) || '[]');
  }

  sendApprovalEmail(application) {
    const sentEmails = this.getSentEmails();
    const repName = application.repName || application.firstName || 'Member Representative';
    const emailData = {
      id: `MAIL-${Math.floor(1000 + Math.random() * 9000)}`,
      appId: application.id,
      company: application.company,
      recipientName: repName,
      recipientEmail: application.email || 'applicant@company.com',
      membershipType: application.membershipType || 'Corporate',
      subject: `Official Membership Approval - Bharuch Chamber of Commerce & Industry (${application.id})`,
      sentAt: new Date().toISOString(),
      body: `Dear ${repName},\n\nWe are pleased to inform you that your application for BCCI Membership (${application.id}) for "${application.company}" has been formally REVIEWED and APPROVED by the BCCI Secretariat Board.\n\nYour institutional membership is now ACTIVE. You are entitled to all member privileges, trade facilitation services, and policy representation under the Bharuch Chamber of Commerce & Industry.\n\nOfficial Membership Record:\n- Application ID: ${application.id}\n- Enterprise: ${application.company}\n- Approved On: ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}\n- Status: ACTIVATED & APPROVED\n\nWelcome to Asia's Largest Industrial Corridor Network.\n\nWarm Regards,\nBCCI Secretariat & Membership Board\nBharuch Chamber of Commerce & Industry\nadmin@bccibharuch.in | +91 7861906384`
    };
    sentEmails.unshift(emailData);
    localStorage.setItem(STORAGE_KEYS.SENT_EMAILS, JSON.stringify(sentEmails));
    return emailData;
  }

  sendAdminNewApplicationNotification(application) {
    const adminEmail = 'sp9023156004@gmail.com';
    const repName = application.repName || `${application.firstName || ''} ${application.lastName || ''}`.trim() || 'Applicant';
    const notification = {
      id: `NOTIF-${Math.floor(1000 + Math.random() * 9000)}`,
      appId: application.id,
      company: application.company,
      adminEmail: adminEmail,
      subject: `[ADMIN ALERT] New BCCI Membership Application: ${application.company} (${application.id})`,
      sentAt: new Date().toISOString(),
      body: `ATTN: BCCI Secretariat & Admin Board,\n\nA new membership application has been submitted on the BCCI Official Portal and is pending your review & approval.\n\nApplication Summary:\n- Application ID: ${application.id}\n- Company Name: ${application.company}\n- Representative: ${repName} (${application.repDesignation || 'Delegate'})\n- Sector: ${application.businessServices || 'N/A'}\n- Scale: ${application.enterpriseType || 'N/A'} • ${application.legalStatus || 'N/A'}\n- Email: ${application.email}\n- Phone: ${application.phone}\n- GSTIN: ${application.gstNo || 'N/A'}\n- UTR Ref: ${application.paymentRef || 'N/A'}\n- Date Submitted: ${new Date().toLocaleString('en-IN')}\n\nPlease sign in to the BCCI Admin Portal to inspect details and approve or reject this membership.`
    };
    return notification;
  }

  sendApplicantReceivedEmail(application) {
    const sentEmails = this.getSentEmails();
    const repName = application.repName || `${application.firstName || ''} ${application.lastName || ''}`.trim() || 'Valued Applicant';
    const emailData = {
      id: `ACK-${Math.floor(1000 + Math.random() * 9000)}`,
      appId: application.id,
      company: application.company,
      recipientName: repName,
      recipientEmail: application.email,
      subject: `BCCI Membership Application Received (${application.id}) - Pending Admin Verification`,
      sentAt: new Date().toISOString(),
      body: `Dear ${repName},\n\nThank you for applying for Institutional Membership with the Bharuch Chamber of Commerce & Industry (BCCI).\n\nWe have successfully received your membership application for "${application.company}".\n\nApplication Record Details:\n- Application Reference ID: ${application.id}\n- Enterprise / Firm: ${application.company}\n- Representative: ${repName}\n- Date Submitted: ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}\n- Status: PENDING ADMIN APPROVAL & VERIFICATION\n\nNext Steps:\nAs per BCCI institutional regulations, your application credentials, legal documentation, and payment proof reference are currently undergoing verification by the BCCI Secretariat Administration.\n\nOnce reviewed and approved by the Secretariat Board, you will receive a formal Membership Confirmation & Welcome Email activating your institutional membership privileges.\n\nFor urgent enquiries, you may contact the BCCI Secretariat office at admin@bccibharuch.in or +91 7861906384.\n\nWarm Regards,\nBCCI Secretariat & Membership Board\nBharuch Chamber of Commerce & Industry\nStation Road, Bharuch - 392001`
    };
    sentEmails.unshift(emailData);
    localStorage.setItem(STORAGE_KEYS.SENT_EMAILS, JSON.stringify(sentEmails));
    return emailData;
  }

  // Static Data Providers
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
      {
        id: 'coo',
        title: 'Certificate of Origin',
        icon: 'fa-certificate',
        desc: 'BCCI issues official Certificates of Origin certifying country of manufacture for seamless export clearance and global trade compliance.'
      },
      {
        id: 'attestation',
        title: 'Document Attestation',
        icon: 'fa-file-signature',
        desc: 'Authentication of commercial invoices, packing lists, and trade documents for embassy attestation and government regulatory bodies.'
      },
      {
        id: 'visa',
        title: 'Visa Recommendation Letters',
        icon: 'fa-passport',
        desc: 'Formal recommendation letters issued to member delegates for expedited business travel visas, trade expos, and international delegations.'
      },
      {
        id: 'trade',
        title: 'Trade Facilitation',
        icon: 'fa-globe-asia',
        desc: 'Guidance and advisory for domestic and international trade, customs coordination, and B2B expansion networking.'
      },
      {
        id: 'advisory',
        title: 'Business & Policy Advisory',
        icon: 'fa-briefcase',
        desc: 'Advocacy for Ease of Doing Business (EoDB), policy reform representations, legal compliance guidance, and regulatory support.'
      },
      {
        id: 'training',
        title: 'Training & Workshops',
        icon: 'fa-chalkboard-teacher',
        desc: 'Regular seminars, skill enhancement workshops, GST updates, technology adoption sessions, and leadership forums.'
      }
    ];
  }

  getFaqs() {
    return [
      { q: 'What is Bharuch Chamber of Commerce & Industry (BCCI)?', a: 'BCCI is a trusted institutional platform representing the collective strength of commerce and industry in Bharuch district. It acts as an authoritative voice for business growth, policy advocacy, and inter-industry collaboration.' },
      { q: 'Why is Bharuch considered an important industrial hub?', a: 'Bharuch is Asia’s largest industrial hub with massive investments in Chemicals, Petrochemicals, Fertilizers, Pharmaceuticals, Textiles, Logistics, and Energy. It houses over 12,000 MSMEs and 625+ large industries.' },
      { q: 'How does the Admin Approval process work for new members?', a: 'When you submit the Membership Form, your registration status remains "Pending Admin Approval". The BCCI Admin Board reviews your company credentials, GST/PAN documentation, and approves the application before member access is granted.' },
      { q: 'What are the main membership categories?', a: 'BCCI offers Corporate Membership, Associate Membership, and Associate Limited Membership based on enterprise scale and legal structure.' },
      { q: 'How does BCCI support Ease of Doing Business (EoDB)?', a: 'BCCI works closely with state government bodies, GIDC authorities, and central ministries to address policy friction, reduce compliance bottlenecks, and advocate business-friendly industrial reforms.' },
      { q: 'What specialized committees function under BCCI?', a: 'Key committees include Policy & Advocacy, MSME & Startup, Export Promotion, Legal & Regulatory Affairs, and Innovation & Digitalisation.' }
    ];
  }
}
