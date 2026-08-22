/* ==========================================================================
   BCCI BHARUCH - Data Store & Local Persistence Manager
   ========================================================================== */

const STORAGE_KEYS = {
  APPLICATIONS: 'bcci_membership_applications',
  ENQUIRIES: 'bcci_enquiries',
  ADMIN_AUTH: 'bcci_admin_session',
  SENT_EMAILS: 'bcci_sent_approval_emails'
};

// Initial Seed Data for Pending & Approved Applications
const INITIAL_APPLICATIONS = [
  {
    id: 'APP-1001',
    company: 'Gujarat Petrochem Synthetics Ltd.',
    salutation: 'Mr.',
    firstName: 'Rajesh',
    lastName: 'Shah',
    email: 'r.shah@petrochem-gujarat.com',
    phone: '+91 98250 12345',
    membershipType: 'Corporate',
    enterpriseType: 'Large',
    legalStatus: 'Public Ltd.',
    district: 'Bharuch',
    state: 'Gujarat',
    address: 'Plot 402, GIDC Phase II, Ankleshwar',
    pincode: '393002',
    cin: 'L24110GJ1998PLC034120',
    gstNo: '24AAACG1234F1Z5',
    panNo: 'AAACG1234F',
    annualTurnover: '150 Crore',
    employees: '450',
    businessServices: 'Chemical & Petrochemicals',
    primaryBusiness: 'Specialty Polymers & Solvents Manufacturing',
    repName: 'Rajesh Shah',
    repDesignation: 'Managing Director',
    status: 'Approved',
    submittedAt: '2026-08-10T10:30:00Z',
    approvedAt: '2026-08-11T14:20:00Z'
  },
  {
    id: 'APP-1002',
    company: 'Narmada Bio-Pharma Solutions',
    salutation: 'Dr.',
    firstName: 'Anil',
    lastName: 'Desai',
    email: 'anil@narmadabiopharma.in',
    phone: '+91 94261 88900',
    membershipType: 'Associate',
    enterpriseType: 'Medium',
    legalStatus: 'Pvt. Ltd.',
    district: 'Bharuch',
    state: 'Gujarat',
    address: 'Survey No 88, Bulk Drug Park, Valiya Road',
    pincode: '393135',
    cin: 'U24232GJ2015PTC082190',
    gstNo: '24AABCN5678K1Z9',
    panNo: 'AABCN5678K',
    annualTurnover: '35 Crore',
    employees: '120',
    businessServices: 'Pharmaceuticals',
    primaryBusiness: 'Active Pharmaceutical Ingredients (API)',
    repName: 'Dr. Anil Desai',
    repDesignation: 'CEO',
    status: 'Pending',
    submittedAt: '2026-08-19T16:45:00Z'
  },
  {
    id: 'APP-1003',
    company: 'Apex Tech Dynamics Pvt. Ltd.',
    salutation: 'Mr.',
    firstName: 'Harsh',
    lastName: 'Vora',
    email: 'contact@apextechdynamics.com',
    phone: '+91 78619 44321',
    membershipType: 'Associate Limited',
    enterpriseType: 'Small',
    legalStatus: 'Pvt. Ltd.',
    district: 'Bharuch',
    state: 'Gujarat',
    address: '304, City Center, Railway Station Road',
    pincode: '392001',
    cin: 'U72200GJ2021PTC119045',
    gstNo: '24AAICA9012L1Z2',
    panNo: 'AAICA9012L',
    annualTurnover: '8 Crore',
    employees: '35',
    businessServices: 'Information Technology',
    primaryBusiness: 'Industrial Automation & AI IoT Monitoring',
    repName: 'Harsh Vora',
    repDesignation: 'Founder & CTO',
    status: 'Pending',
    submittedAt: '2026-08-20T11:15:00Z'
  }
];

// Initial Seed Data for Enquiries
const INITIAL_ENQUIRIES = [
  {
    id: 'ENQ-501',
    name: 'Siddharth Patel',
    company: 'Vanguard Logistics India',
    email: 'siddharth@vanguardlogistics.co.in',
    phone: '+91 98790 55432',
    subject: 'Certificate of Origin Process & Fee Structure',
    message: 'We are expanding our export shipments from Dahej port and require clarification regarding Certificate of Origin issuance timeline.',
    submittedAt: '2026-08-20T09:20:00Z'
  }
];

export class Store {
  constructor() {
    this.initStorage();
  }

  initStorage() {
    if (!localStorage.getItem(STORAGE_KEYS.APPLICATIONS)) {
      localStorage.setItem(STORAGE_KEYS.APPLICATIONS, JSON.stringify(INITIAL_APPLICATIONS));
    }
    if (!localStorage.getItem(STORAGE_KEYS.ENQUIRIES)) {
      localStorage.setItem(STORAGE_KEYS.ENQUIRIES, JSON.stringify(INITIAL_ENQUIRIES));
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
      status: 'Pending', // ALWAYS PENDING UNTIL ADMIN APPROVES
      submittedAt: new Date().toISOString()
    };
    apps.unshift(newApp);
    localStorage.setItem(STORAGE_KEYS.APPLICATIONS, JSON.stringify(apps));
    return newApp;
  }

  updateApplicationStatus(id, newStatus) {
    const apps = this.getApplications();
    const index = apps.findIndex(app => app.id === id);
    if (index !== -1) {
      apps[index].status = newStatus;
      if (newStatus === 'Approved') {
        apps[index].approvedAt = new Date().toISOString();
      }
      localStorage.setItem(STORAGE_KEYS.APPLICATIONS, JSON.stringify(apps));
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
    localStorage.setItem(STORAGE_KEYS.ENQUIRIES, JSON.stringify(enquiries));
    return newEnq;
  }

  // Admin Authentication Helpers
  isAdminAuthed() {
    return localStorage.getItem(STORAGE_KEYS.ADMIN_AUTH) === 'true';
  }

  setAdminAuth(status) {
    localStorage.setItem(STORAGE_KEYS.ADMIN_AUTH, status ? 'true' : 'false');
  }

  validateAdminCredentials(username, password) {
    const validUsers = ['admin', 'admin@bccibharuch.in', 'bcci'];
    const validPasswords = ['admin', 'admin123', 'bcci2026', 'password'];
    return validUsers.includes(username.toLowerCase().trim()) && validPasswords.includes(password.trim());
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
    const adminEmail = 'admin@bccibharuch.in';
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

  // Static Data Providers
  getLeadership() {
    return [
      { name: 'MR. KIRAN K. MAJMUDAR', role: 'President', category: 'Executive Board', initials: 'KM', image: 'assets/President_photo.webp', linkedin: 'https://www.linkedin.com/in/kiran-k-majmudar-52b235308/' },
      { name: 'MR. KAMAL KUMAR', role: 'Joint Vice President', category: 'Executive Board', initials: 'KK', image: 'assets/KAmal.webp' },
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
