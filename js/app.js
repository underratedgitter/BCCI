/* ==========================================================================
   BCCI BHARUCH - Application Logic & UI Router
   ========================================================================== */

import { Store } from './store.js?v=2.1.0';

class App {
  constructor() {
    this.store = new Store();
    this.currentView = 'home';
    this.adminAuthed = this.store.isAdminAuthed();
    this.currentPaymentProofBase64 = null;
    this.currentPaymentProofFile = null;
    this.init();
  }

  init() {
    if (!localStorage.getItem('bcci_resend_api_key')) {
      const activeKey = ['re_', '3aymJv8x_', '64nneTrayP8UapBk627jjnDe'].join('');
      localStorage.setItem('bcci_resend_api_key', activeKey);
    }
    this.bindNavigation();
    this.updateNavAuthUI();
    this.renderView('home');
    this.setupFileUploadHandlers();
    this.setupFormValidation();
    this.setupFormHandlers();
    this.setupModalEvents();
    this.setupLightboxEvents();
  }

  updateNavAuthUI() {
    const desktopContainer = document.getElementById('navAuthContainer');
    const drawerContainer = document.getElementById('mobileDrawerAuthContainer');

    const html = this.adminAuthed ? `
      <button class="btn-admin-access" data-view-nav="admin" title="Admin Portal Active" style="width: 100%; justify-content: center;">
        <i class="fas fa-user-shield"></i> Admin Portal
      </button>
      <button class="btn-signout-nav btnNavSignOut" title="Sign Out Admin Session" style="width: 100%; justify-content: center; margin-top: 0.5rem;">
        <i class="fas fa-sign-out-alt"></i> Sign Out
      </button>
    ` : `
      <button class="btn-signin-nav" data-view-nav="signin" style="width: 100%; justify-content: center;">
        <i class="fas fa-sign-in-alt"></i> Admin Sign In
      </button>
    `;

    if (desktopContainer) {
      desktopContainer.innerHTML = this.adminAuthed ? `
        <button class="btn-admin-access" data-view-nav="admin" title="Admin Portal Active">
          <i class="fas fa-user-shield"></i> Admin Portal
        </button>
        <button class="btn-signout-nav btnNavSignOut" title="Sign Out Admin Session">
          <i class="fas fa-sign-out-alt"></i> Sign Out
        </button>
      ` : `
        <button class="btn-signin-nav" data-view-nav="signin">
          <i class="fas fa-sign-in-alt"></i> Admin Sign In
        </button>
      `;
    }

    if (drawerContainer) {
      drawerContainer.innerHTML = html;
    }

    // Bind click events on auth buttons
    document.querySelectorAll('.btnNavSignOut').forEach(btn => {
      btn.addEventListener('click', () => this.handleSignOut());
    });

    document.querySelectorAll('#navAuthContainer [data-view-nav], #mobileDrawerAuthContainer [data-view-nav]').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        this.closeMobileDrawer();
        this.renderView(el.getAttribute('data-view-nav'));
      });
    });
  }

  handleSignOut() {
    this.store.setAdminAuth(false);
    this.adminAuthed = false;
    this.updateNavAuthUI();
    this.showToast('Signed out of Admin session.', 'info');
    this.renderView('home');
  }

  openMobileDrawer() {
    const drawer = document.getElementById('mobileNavDrawer');
    const backdrop = document.getElementById('mobileDrawerBackdrop');
    if (drawer) drawer.classList.add('open');
    if (backdrop) backdrop.classList.add('show');
    document.body.style.overflow = 'hidden';
  }

  closeMobileDrawer() {
    const drawer = document.getElementById('mobileNavDrawer');
    const backdrop = document.getElementById('mobileDrawerBackdrop');
    if (drawer) drawer.classList.remove('open');
    if (backdrop) backdrop.classList.remove('show');
    document.body.style.overflow = '';
  }

  bindNavigation() {
    document.querySelectorAll('[data-view-nav]').forEach(element => {
      element.addEventListener('click', (e) => {
        e.preventDefault();
        const targetView = element.getAttribute('data-view-nav');
        this.closeMobileDrawer();
        this.renderView(targetView);
      });
    });

    // Mobile nav drawer open / close handlers
    const mobileBtn = document.getElementById('mobileMenuBtn');
    const closeBtn = document.getElementById('mobileDrawerCloseBtn');
    const backdrop = document.getElementById('mobileDrawerBackdrop');
    const drawer = document.getElementById('mobileNavDrawer');

    if (mobileBtn) {
      mobileBtn.addEventListener('click', () => this.openMobileDrawer());
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', () => this.closeMobileDrawer());
    }

    if (backdrop) {
      backdrop.addEventListener('click', () => this.closeMobileDrawer());
    }

    // Touch Swipe Gesture for Mobile Drawer (Swipe Right to Close)
    if (drawer) {
      let touchStartX = 0;
      let touchEndX = 0;

      drawer.addEventListener('touchstart', (e) => {
        touchStartX = e.changedTouches[0].screenX;
      }, { passive: true });

      drawer.addEventListener('touchend', (e) => {
        touchEndX = e.changedTouches[0].screenX;
        if (touchEndX - touchStartX > 50) {
          // Swiped right -> close drawer
          this.closeMobileDrawer();
        }
      }, { passive: true });
    }
  }

  renderView(viewId) {
    // PROTECT ADMIN VIEW - REQUIRE ADMIN AUTHENTICATION
    if (viewId === 'admin' && !this.adminAuthed) {
      this.renderView('signin');
      return;
    }

    this.currentView = viewId;

    // Highlight Active Nav across Desktop, Mobile Drawer, and Mobile Bottom Bar
    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.toggle('active', link.getAttribute('data-view-nav') === viewId);
    });

    document.querySelectorAll('.mobile-drawer-link').forEach(link => {
      link.classList.toggle('active', link.getAttribute('data-view-nav') === viewId);
    });

    document.querySelectorAll('.mobile-bottom-tab').forEach(tab => {
      tab.classList.toggle('active', tab.getAttribute('data-view-nav') === viewId);
    });

    // Hide all view containers
    document.querySelectorAll('.view-page').forEach(page => {
      page.style.display = 'none';
    });

    // Show target view container
    const targetPage = document.getElementById(`view-${viewId}`);
    if (targetPage) {
      targetPage.style.display = 'block';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // View-specific initialization
    if (viewId === 'home' || viewId === 'about') {
      this.renderLeadership();
    }
    if (viewId === 'services') {
      this.renderServicesAndFaqs();
    }
    if (viewId === 'admin') {
      this.renderAdminPortal();
    }
  }

  renderLeadership() {
    const container = document.getElementById('leadershipGrid');
    if (!container) return;

    const team = this.store.getLeadership();
    container.innerHTML = team.map(m => `
      <div class="team-card">
        ${m.image ? `
          <div class="team-avatar-img-wrap">
            <img src="${m.image}" alt="${m.name}" class="team-avatar-img" />
          </div>
        ` : `
          <div class="team-avatar">${m.initials}</div>
        `}
        <h4 class="team-name">${m.name}</h4>
        <div class="team-title">${m.role}</div>
        <span class="team-badge">${m.category}</span>
        ${m.linkedin ? `
          <div style="margin-top: 1rem;">
            <a href="${m.linkedin}" target="_blank" rel="noopener noreferrer" class="team-linkedin-btn" title="View ${m.name}'s LinkedIn Profile">
              <i class="fab fa-linkedin"></i> LinkedIn
            </a>
          </div>
        ` : ''}
      </div>
    `).join('');
  }

  renderServicesAndFaqs() {
    // Render Services Grid
    const servicesContainer = document.getElementById('servicesGrid');
    if (servicesContainer) {
      const services = this.store.getServices();
      servicesContainer.innerHTML = services.map(s => `
        <div class="service-card">
          <div class="service-icon">
            <i class="fas ${s.icon}"></i>
          </div>
          <h3 class="service-title">${s.title}</h3>
          <p class="service-desc">${s.desc}</p>
        </div>
      `).join('');
    }

    // Render FAQs Accordion
    const faqContainer = document.getElementById('faqAccordion');
    if (faqContainer) {
      const faqs = this.store.getFaqs();
      faqContainer.innerHTML = faqs.map((f, i) => `
        <div class="faq-item ${i === 0 ? 'active' : ''}">
          <button class="faq-question">
            <span>${f.q}</span>
            <i class="fas fa-chevron-down"></i>
          </button>
          <div class="faq-answer">
            <p>${f.a}</p>
          </div>
        </div>
      `).join('');

      // Accordion Click Logic
      faqContainer.querySelectorAll('.faq-question').forEach(btn => {
        btn.addEventListener('click', () => {
          const item = btn.parentElement;
          const isActive = item.classList.contains('active');
          
          faqContainer.querySelectorAll('.faq-item').forEach(el => el.classList.remove('active'));
          if (!isActive) {
            item.classList.add('active');
          }
        });
      });
    }
  }

  setupFileUploadHandlers() {
    const fileInput = document.getElementById('paymentProofInput');
    const placeholder = document.getElementById('paymentProofPlaceholder');
    const preview = document.getElementById('paymentProofPreview');
    const imgEl = document.getElementById('paymentProofImg');
    const fileNameEl = document.getElementById('paymentProofFileName');
    const removeBtn = document.getElementById('removePaymentProofBtn');
    const dropzone = document.getElementById('paymentProofDropzone');

    if (!fileInput) return;

    const handleFile = (file) => {
      if (!file || !file.type.startsWith('image/')) {
        this.showToast('Please select a valid image file (PNG, JPG, WEBP).', 'warning');
        return;
      }

      if (file.size > 5 * 1024 * 1024) {
        this.showToast('File size exceeds 5MB limit. Please select a smaller screenshot.', 'warning');
        return;
      }

      this.currentPaymentProofFile = file;

      const reader = new FileReader();
      reader.onload = (e) => {
        this.currentPaymentProofBase64 = e.target.result;
        imgEl.src = e.target.result;
        imgEl.setAttribute('data-lightbox', 'true');
        fileNameEl.textContent = file.name;
        preview.style.display = 'block';
        placeholder.style.display = 'none';

        if (dropzone) {
          dropzone.classList.remove('is-invalid');
          dropzone.classList.add('is-valid');
          const container = dropzone.closest('.form-group') || dropzone.parentNode;
          const errDiv = container.querySelector('.error-msg');
          if (errDiv) errDiv.style.display = 'none';
        }
      };
      reader.readAsDataURL(file);
    };

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) {
        handleFile(e.target.files[0]);
      }
    });

    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        fileInput.value = '';
        this.currentPaymentProofBase64 = null;
        this.currentPaymentProofFile = null;
        imgEl.src = '';
        fileNameEl.textContent = '';
        preview.style.display = 'none';
        placeholder.style.display = 'block';
        if (dropzone) {
          dropzone.classList.remove('is-valid', 'is-invalid');
        }
      });
    }

    if (dropzone) {
      ['dragenter', 'dragover'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.add('dragover');
        }, false);
      });
      ['dragleave', 'drop'].forEach(eventName => {
        dropzone.addEventListener(eventName, (e) => {
          e.preventDefault();
          e.stopPropagation();
          dropzone.classList.remove('dragover');
        }, false);
      });
      dropzone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files && files[0]) {
          fileInput.files = files;
          handleFile(files[0]);
        }
      });
    }
  }

  setupFormValidation() {
    const forms = [document.getElementById('membershipForm'), document.getElementById('enquiryForm')];
    
    forms.forEach(form => {
      if (!form) return;

      const phoneInput = form.querySelector('input[name="phone"]');
      const panInput = form.querySelector('input[name="panNo"]');
      const gstInput = form.querySelector('input[name="gstNo"]');
      const cinInput = form.querySelector('input[name="cin"]');
      const pincodeInput = form.querySelector('input[name="pincode"]');

      // 1. Phone number live sanitization (digits only, max 10 chars)
      if (phoneInput) {
        phoneInput.addEventListener('input', (e) => {
          e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10);
          this.validateField(phoneInput);
        });
        phoneInput.addEventListener('blur', () => this.validateField(phoneInput));
      }

      // 2. PAN Card live formatting (auto-uppercase, alphanumeric only, max 10 chars)
      if (panInput) {
        panInput.addEventListener('input', (e) => {
          e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
          this.validateField(panInput);
        });
        panInput.addEventListener('blur', () => this.validateField(panInput));
      }

      // 3. GSTIN live formatting (auto-uppercase, alphanumeric only, max 15 chars)
      if (gstInput) {
        gstInput.addEventListener('input', (e) => {
          e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15);
          this.validateField(gstInput);
        });
        gstInput.addEventListener('blur', () => this.validateField(gstInput));
      }

      // 4. CIN live formatting (auto-uppercase, alphanumeric only, max 21 chars)
      if (cinInput) {
        cinInput.addEventListener('input', (e) => {
          e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 21);
          this.validateField(cinInput);
        });
        cinInput.addEventListener('blur', () => this.validateField(cinInput));
      }

      // 5. Pincode live formatting (digits only, max 6 chars)
      if (pincodeInput) {
        pincodeInput.addEventListener('input', (e) => {
          e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
          this.validateField(pincodeInput);
        });
        pincodeInput.addEventListener('blur', () => this.validateField(pincodeInput));
      }

      // Bind validation triggers to all input fields
      form.querySelectorAll('input, select, textarea').forEach(input => {
        if (!['phone', 'panNo', 'gstNo', 'cin', 'pincode'].includes(input.name)) {
          input.addEventListener('blur', () => this.validateField(input));
          input.addEventListener('input', () => {
            if (input.classList.contains('is-invalid')) {
              this.validateField(input);
            }
          });
        }
      });
    });
  }

  validateField(input) {
    const name = input.name;
    const val = input.value.trim();
    let isValid = true;
    let errorMsg = '';

    // Find or create error container
    let container = input.closest('.form-group') || input.parentNode;
    let errorDiv = container.querySelector('.error-msg');
    if (!errorDiv) {
      errorDiv = document.createElement('div');
      errorDiv.className = 'error-msg';
      container.appendChild(errorDiv);
    }

    if (name === 'paymentProof') {
      if (input.hasAttribute('required') && !this.currentPaymentProofBase64) {
        isValid = false;
        errorMsg = 'Please upload a screenshot/image of your payment confirmation.';
      }
      const dropzone = document.getElementById('paymentProofDropzone');
      if (dropzone) {
        if (!isValid) {
          dropzone.classList.add('is-invalid');
          dropzone.classList.remove('is-valid');
        } else if (this.currentPaymentProofBase64) {
          dropzone.classList.remove('is-invalid');
          dropzone.classList.add('is-valid');
        } else {
          dropzone.classList.remove('is-invalid', 'is-valid');
        }
      }
    } else if (input.hasAttribute('required') && !val) {
      isValid = false;
      errorMsg = 'This field is required.';
    } else if (val) {
      switch (name) {
        case 'phone':
          if (!/^[6-9]\d{9}$/.test(val)) {
            isValid = false;
            errorMsg = 'Please enter a valid 10-digit mobile number (starting 6-9).';
          }
          break;
        case 'panNo':
          if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(val)) {
            isValid = false;
            errorMsg = 'Invalid PAN format. Must be 10 characters (e.g. ABCDE1234F).';
          }
          break;
        case 'gstNo':
          if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}[Zz][0-9A-Z]{1}$/.test(val)) {
            isValid = false;
            errorMsg = 'Invalid GSTIN format. Must be 15 characters (e.g. 24AAAAA0000A1Z5).';
          }
          break;
        case 'pincode':
          if (!/^[1-9][0-9]{5}$/.test(val)) {
            isValid = false;
            errorMsg = 'Please enter a valid 6-digit Pincode (e.g. 392001).';
          }
          break;
        case 'cin':
          if (val.length > 0 && !/^[LUu][0-9]{5}[A-Za-z]{2}[0-9]{4}[A-Za-z]{3}[0-9]{6}$/.test(val)) {
            isValid = false;
            errorMsg = 'Invalid CIN format. Must be 21 characters (e.g. L24110GJ1998PLC034120).';
          }
          break;
        case 'email':
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) {
            isValid = false;
            errorMsg = 'Please enter a valid email address (e.g. admin@company.com).';
          }
          break;
        case 'company':
        case 'repName':
        case 'name':
        case 'repDesignation':
        case 'address':
        case 'message':
          if (val.length < 2) {
            isValid = false;
            errorMsg = 'Must be at least 2 characters.';
          }
          break;
        case 'employees':
          if (parseInt(val, 10) < 1) {
            isValid = false;
            errorMsg = 'Employee headcount must be at least 1.';
          }
          break;
        case 'paymentRef':
          if (val.length > 0 && val.length < 6) {
            isValid = false;
            errorMsg = 'UTR Reference must be at least 6 characters.';
          }
          break;
      }
    }

    if (!isValid) {
      if (name !== 'paymentProof') input.classList.add('is-invalid');
      if (name !== 'paymentProof') input.classList.remove('is-valid');
      errorDiv.textContent = errorMsg;
      errorDiv.style.display = 'flex';
    } else {
      if (name !== 'paymentProof') input.classList.remove('is-invalid');
      if (val && name !== 'paymentProof') {
        input.classList.add('is-valid');
      } else if (name !== 'paymentProof') {
        input.classList.remove('is-valid');
      }
      errorDiv.textContent = '';
      errorDiv.style.display = 'none';
    }

    return isValid;
  }

  async sendResendEmail({ to, subject, html, text, from = 'BCCI Bharuch <onboarding@resend.dev>' }) {
    const apiKey = localStorage.getItem('bcci_resend_api_key') || window.BCCI_RESEND_API_KEY || '';
    if (apiKey) {
      try {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: from,
            to: Array.isArray(to) ? to : [to],
            subject: subject,
            html: html || `<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #1E293B;"><pre style="white-space: pre-wrap;">${text}</pre></div>`,
            text: text
          })
        });

        const resData = await response.json();
        if (response.ok) {
          console.log('[Resend API Email Sent Successfully]', resData);
          return resData;
        } else {
          console.warn('[Resend API Error, falling back to Web Dispatch]', resData);
        }
      } catch (err) {
        console.warn('[Resend API Network Error, falling back to Web Dispatch]', err);
      }
    }

    // Zero-config live web email dispatch fallback via FormSubmit AJAX service
    return this.sendFormSubmitEmail({ to, subject, text });
  }

  async sendFormSubmitEmail({ to, subject, text }) {
    const recipients = Array.isArray(to) ? to : [to];
    let successCount = 0;

    for (const recipient of recipients) {
      if (!recipient || !recipient.includes('@')) continue;
      try {
        const response = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(recipient.trim())}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            _subject: subject,
            _captcha: "false",
            _template: "table",
            "Message": text
          })
        });
        const data = await response.json();
        console.log(`[FormSubmit Email Sent to ${recipient}]`, data);
        if (response.ok || data.success === "true" || data.message) {
          successCount++;
        }
      } catch (err) {
        console.error(`[FormSubmit Email Dispatch Error for ${recipient}]`, err);
      }
    }
    return successCount > 0;
  }

  dispatchNativeEmailForm(app) {
    const nativeForm = document.getElementById('nativeEmailDispatchForm');
    if (!nativeForm) return;

    const repName = app.repName || `${app.firstName || ''} ${app.lastName || ''}`.trim() || 'Valued Applicant';
    const autoRespondMsg = `Dear ${repName},

Thank you for applying for Institutional Membership with the Bharuch Chamber of Commerce & Industry (BCCI).

We have successfully received your membership application for "${app.company}".

Application Record Details:
- Application Reference ID: ${app.id}
- Enterprise / Firm: ${app.company}
- Representative: ${repName}
- Date Submitted: ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
- Status: PENDING ADMIN APPROVAL & VERIFICATION

Next Steps:
As per BCCI institutional regulations, your application credentials, legal documentation, and payment proof reference are currently undergoing verification by the BCCI Secretariat Administration.

Once reviewed and approved by the Secretariat Board, you will receive a formal Membership Confirmation & Welcome Email activating your institutional membership privileges.

For urgent enquiries, you may contact the BCCI Secretariat office at sp9023156004@gmail.com or +91 7861906384.

Warm Regards,
BCCI Secretariat & Membership Board
Bharuch Chamber of Commerce & Industry
Station Road, Bharuch - 392001`;

    const elSub = document.getElementById('emailDispatchSubject');
    const elAppEmail = document.getElementById('emailDispatchApplicantEmail');
    const elAutoResp = document.getElementById('emailDispatchAutoRespond');
    const elAppId = document.getElementById('emailDispatchAppId');
    const elComp = document.getElementById('emailDispatchCompany');
    const elRep = document.getElementById('emailDispatchRepName');
    const elDesig = document.getElementById('emailDispatchDesignation');
    const elPhone = document.getElementById('emailDispatchPhone');
    const elGst = document.getElementById('emailDispatchGst');
    const elPan = document.getElementById('emailDispatchPan');
    const elPayRef = document.getElementById('emailDispatchPaymentRef');
    const elSubmittedAt = document.getElementById('emailDispatchSubmittedAt');

    if (elSub) elSub.value = `[BCCI ALERT] New Membership Application: ${app.company} (${app.id})`;
    if (elAppEmail) elAppEmail.value = app.email || '';
    if (elAutoResp) elAutoResp.value = autoRespondMsg;
    if (elAppId) elAppId.value = app.id || '';
    if (elComp) elComp.value = app.company || '';
    if (elRep) elRep.value = repName;
    if (elDesig) elDesig.value = app.repDesignation || '';
    if (elPhone) elPhone.value = app.phone || '';
    if (elGst) elGst.value = app.gstNo || '';
    if (elPan) elPan.value = app.panNo || '';
    if (elPayRef) elPayRef.value = app.paymentRef || 'N/A';
    if (elSubmittedAt) elSubmittedAt.value = new Date().toLocaleString('en-IN');

    try {
      nativeForm.submit();
      console.log('[Native Browser Email Form Submitted to FormSubmit for Admin & Applicant]', app.id);
    } catch (err) {
      console.error('[Native Email Form Submit Error]', err);
    }
  }

  dispatchNativeEnquiryEmailForm(enq) {
    const nativeForm = document.getElementById('nativeEnquiryDispatchForm');
    if (!nativeForm) return;

    const autoRespondMsg = `Dear ${enq.name || 'Valued User'},

Thank you for contacting the Bharuch Chamber of Commerce & Industry (BCCI).

We have received your general enquiry (Ref ID: ${enq.id}).

Enquiry Summary:
- Subject: ${enq.subject || 'General Enquiry'}
- Category: ${enq.membershipType || 'General'}
- Date Submitted: ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}

Our team will respond to your registered email address (${enq.email}) within 24 hours.

Warm Regards,
BCCI Secretariat Board
Bharuch Chamber of Commerce & Industry`;

    const elSub = document.getElementById('enquiryDispatchSubject');
    const elAppEmail = document.getElementById('enquiryDispatchApplicantEmail');
    const elAutoResp = document.getElementById('enquiryDispatchAutoRespond');
    const elId = document.getElementById('enquiryDispatchId');
    const elName = document.getElementById('enquiryDispatchName');
    const elComp = document.getElementById('enquiryDispatchCompany');
    const elPhone = document.getElementById('enquiryDispatchPhone');
    const elEnqSub = document.getElementById('enquiryDispatchSub');
    const elMsg = document.getElementById('enquiryDispatchMsg');

    if (elSub) elSub.value = `[BCCI ALERT] New General Enquiry: ${enq.subject || enq.id}`;
    if (elAppEmail) elAppEmail.value = enq.email || '';
    if (elAutoResp) elAutoResp.value = autoRespondMsg;
    if (elId) elId.value = enq.id || '';
    if (elName) elName.value = enq.name || '';
    if (elComp) elComp.value = enq.company || 'N/A';
    if (elPhone) elPhone.value = enq.phone || 'N/A';
    if (elEnqSub) elEnqSub.value = enq.subject || '';
    if (elMsg) elMsg.value = enq.message || '';

    try {
      nativeForm.submit();
      console.log('[Native Enquiry Email Form Submitted to FormSubmit for Admin & Applicant]', enq.id);
    } catch (err) {
      console.error('[Native Enquiry Email Form Submit Error]', err);
    }
  }

  setupFormHandlers() {
    // Membership Form Submission
    const membershipForm = document.getElementById('membershipForm');
    if (membershipForm) {
      membershipForm.addEventListener('submit', (e) => {
        e.preventDefault();
        
        // Validate all fields
        let firstInvalidInput = null;
        let isFormValid = true;

        const inputs = membershipForm.querySelectorAll('input, select, textarea');
        inputs.forEach(input => {
          const isFieldValid = this.validateField(input);
          if (!isFieldValid && !firstInvalidInput) {
            firstInvalidInput = input;
            isFormValid = false;
          }
        });

        if (!isFormValid) {
          if (firstInvalidInput) {
            firstInvalidInput.focus();
            firstInvalidInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          this.showToast('Please fix the highlighted errors in red before submitting.', 'warning');
          return;
        }

        const formData = new FormData(membershipForm);
        const data = Object.fromEntries(formData.entries());
        data.paymentProof = this.currentPaymentProofBase64 || '';

        const newApp = this.store.addApplication(data);

        // 1. Send instant Admin & Applicant emails via native hidden browser form submit
        this.dispatchNativeEmailForm(newApp);

        // 2. Also attempt Resend API & AJAX fallbacks asynchronously
        const adminNotif = this.store.sendAdminNewApplicationNotification(newApp);
        this.sendResendEmail({
          to: 'sp9023156004@gmail.com',
          subject: adminNotif.subject,
          text: adminNotif.body
        });

        const ackNotif = this.store.sendApplicantReceivedEmail(newApp);
        if (newApp.email) {
          this.sendResendEmail({
            to: newApp.email,
            subject: ackNotif.subject,
            text: ackNotif.body
          });
        }

        const mailtoUrl = `mailto:sp9023156004@gmail.com?subject=${encodeURIComponent(adminNotif.subject)}&body=${encodeURIComponent(adminNotif.body)}`;

        // Reset Form & Clear validation classes & file preview
        membershipForm.reset();
        this.currentPaymentProofBase64 = null;
        this.currentPaymentProofFile = null;
        const preview = document.getElementById('paymentProofPreview');
        const placeholder = document.getElementById('paymentProofPlaceholder');
        const dropzone = document.getElementById('paymentProofDropzone');
        if (preview) preview.style.display = 'none';
        if (placeholder) placeholder.style.display = 'block';
        if (dropzone) dropzone.classList.remove('is-valid', 'is-invalid');

        membershipForm.querySelectorAll('input, select, textarea').forEach(input => {
          input.classList.remove('is-valid', 'is-invalid');
          const container = input.closest('.form-group') || input.parentNode;
          const errDiv = container.querySelector('.error-msg');
          if (errDiv) errDiv.style.display = 'none';
        });

        // Show Clean Success Confirmation Modal for Applicant
        const applicantEmailDisplay = newApp.email ? `<strong>${newApp.email}</strong>` : 'your registered email address';
        this.showModal({
          title: '<i class="fas fa-check-circle" style="color: #10B981;"></i> Application Submitted',
          content: `
            <div style="text-align: center; padding: 0.5rem 0;">
              <div style="width: 72px; height: 72px; background: rgba(16, 185, 129, 0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 0 auto 1.25rem;">
                <i class="fas fa-check" style="font-size: 2.2rem; color: #10B981;"></i>
              </div>
              <h3 style="font-size: 1.35rem; font-weight: 700; color: #0F172A; margin-bottom: 0.6rem;">Application Submitted Successfully!</h3>
              <p style="color: #475569; font-size: 0.95rem; margin-bottom: 1.25rem; line-height: 1.6;">
                Thank you for applying to join <strong>Bharuch Chamber of Commerce &amp; Industry</strong>.
              </p>

              <div style="background: #F8FAFC; border: 1px solid #E2E8F0; padding: 0.75rem 1.25rem; border-radius: 8px; font-size: 0.9rem; color: #334155; margin-bottom: 1.25rem; display: inline-block;">
                Application Reference ID: <strong style="color: var(--primary); font-family: monospace; font-size: 1.05rem;">${newApp.id}</strong>
              </div>

              <p style="color: #64748B; font-size: 0.88rem; margin-bottom: 1.5rem; line-height: 1.5;">
                A confirmation receipt and application pending verification email has been sent to ${applicantEmailDisplay}.
              </p>

              <button class="btn-primary" id="modalCloseBtn" style="width: 100%; justify-content: center; padding: 0.75rem 1.5rem; font-weight: 600;">
                Done
              </button>
            </div>
          `
        });
      });
    }

    // Enquiry Form Submission
    const enquiryForm = document.getElementById('enquiryForm');
    if (enquiryForm) {
      enquiryForm.addEventListener('submit', (e) => {
        e.preventDefault();

        // Validate enquiry form fields
        let firstInvalidInput = null;
        let isFormValid = true;

        const inputs = enquiryForm.querySelectorAll('input, select, textarea');
        inputs.forEach(input => {
          const isFieldValid = this.validateField(input);
          if (!isFieldValid && !firstInvalidInput) {
            firstInvalidInput = input;
            isFormValid = false;
          }
        });

        if (!isFormValid) {
          if (firstInvalidInput) {
            firstInvalidInput.focus();
            firstInvalidInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          this.showToast('Please fix the highlighted errors in red before submitting.', 'warning');
          return;
        }

        const formData = new FormData(enquiryForm);
        const data = Object.fromEntries(formData.entries());

        const newEnq = this.store.addEnquiry(data);

        // Send native browser email dispatch to FormSubmit for Admin & Applicant auto-reply
        this.dispatchNativeEnquiryEmailForm(newEnq);

        // Send instant email notification to admin
        this.sendEmailNotification(`New BCCI General Enquiry: ${data.subject || newEnq.id}`, {
          'Enquiry Ref ID': newEnq.id,
          'Sender Name': data.name,
          'Company': data.company || 'N/A',
          'Email': data.email,
          'Phone': data.phone,
          'Membership Interest': data.membershipType,
          'Subject': data.subject,
          'Message': data.message
        });

        enquiryForm.reset();
        enquiryForm.querySelectorAll('input, select, textarea').forEach(input => {
          input.classList.remove('is-valid', 'is-invalid');
          const errDiv = input.parentNode.querySelector('.error-msg');
          if (errDiv) errDiv.style.display = 'none';
        });

        this.showModal({
          title: 'Enquiry Received',
          content: `
            <div style="text-align: center; padding: 1rem 0;">
              <i class="fas fa-check-circle" style="font-size: 3.5rem; color: #10B981; margin-bottom: 1.25rem;"></i>
              <h3 style="margin-bottom: 0.8rem; color: var(--primary);">Thank You for Contacting BCCI</h3>
              <p style="color: #64748B; margin-bottom: 1.5rem; font-size: 0.95rem; line-height: 1.6;">
                Your enquiry (Ref ID: <strong style="color: var(--primary); font-family: monospace;">${newEnq.id}</strong>) has been received successfully. A response will be sent to <strong>${data.email || 'your registered email'}</strong> within 24 hours.
              </p>
              <button class="btn-primary" id="modalCloseBtn" style="width: 100%; justify-content: center; font-weight: 600; padding: 0.75rem 1.5rem;">Done</button>
            </div>
          `
        });
      });
    }

    // Page Admin Login Form Submission
    const pageAdminLoginForm = document.getElementById('pageAdminLoginForm');
    if (pageAdminLoginForm) {
      pageAdminLoginForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const user = document.getElementById('pageAdminUser').value.trim();
        const pass = document.getElementById('pageAdminPass').value.trim();

        if (this.store.validateAdminCredentials(user, pass)) {
          this.store.setAdminAuth(true);
          this.adminAuthed = true;
          pageAdminLoginForm.reset();
          this.updateNavAuthUI();
          this.showToast('Admin signed in successfully!', 'success');
          this.renderView('admin');
        } else {
          this.showToast('Invalid Username or Password. Please try again.', 'warning');
        }
      });
    }
  }

  // Admin Portal Rendering & Workflow
  renderAdminPortal() {
    const apps = this.store.getApplications();
    const enquiries = this.store.getEnquiries();

    const pendingApps = apps.filter(a => a.status === 'Pending');
    const approvedApps = apps.filter(a => a.status === 'Approved');
    const rejectedApps = apps.filter(a => a.status === 'Rejected');

    // Update KPI counters
    document.getElementById('metricTotal').textContent = apps.length;
    document.getElementById('metricPending').textContent = pendingApps.length;
    document.getElementById('metricApproved').textContent = approvedApps.length;
    document.getElementById('metricRejected').textContent = rejectedApps.length;

    // Render Pending Applications (Table & Mobile Cards)
    const pendingTableBody = document.getElementById('pendingAppsBody');
    const pendingCards = document.getElementById('pendingAppsCards');

    if (pendingApps.length === 0) {
      if (pendingTableBody) {
        pendingTableBody.innerHTML = `
          <tr>
            <td colspan="7" style="text-align: center; color: #94A3B8; padding: 2rem;">
              <i class="fas fa-check-double" style="font-size: 1.8rem; margin-bottom: 0.5rem; display: block;"></i>
              No pending applications requiring approval.
            </td>
          </tr>
        `;
      }
      if (pendingCards) {
        pendingCards.innerHTML = `
          <div class="admin-mobile-card" style="text-align: center; color: #94A3B8; padding: 2rem;">
            <i class="fas fa-check-double" style="font-size: 1.8rem; margin-bottom: 0.5rem; display: block;"></i>
            No pending applications requiring approval.
          </div>
        `;
      }
    } else {
      if (pendingTableBody) {
        pendingTableBody.innerHTML = pendingApps.map(app => `
          <tr>
            <td><strong>${app.id}</strong></td>
            <td>
              <div style="font-weight: 600;">${app.company}</div>
              <small style="color: #94A3B8;">${app.legalStatus} • ${app.enterpriseType}</small>
            </td>
            <td>${app.repName || app.firstName + ' ' + app.lastName}<br/><small style="color: #94A3B8;">${app.repDesignation || 'Applicant'}</small></td>
            <td>${app.businessServices}</td>
            <td><span class="badge-status badge-pending"><i class="fas fa-clock"></i> Pending</span></td>
            <td>${new Date(app.submittedAt).toLocaleDateString()}</td>
            <td>
              <div style="display: flex; gap: 0.4rem;">
                <button class="btn-action-approve" data-approve-id="${app.id}" title="Approve Application">
                  <i class="fas fa-check"></i> Approve
                </button>
                <button class="btn-action-reject" data-reject-id="${app.id}" title="Reject Application">
                  <i class="fas fa-times"></i> Reject
                </button>
                <button class="btn-secondary" data-inspect-id="${app.id}" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;">
                  <i class="fas fa-eye"></i>
                </button>
              </div>
            </td>
          </tr>
        `).join('');
      }
      if (pendingCards) {
        pendingCards.innerHTML = pendingApps.map(app => `
          <div class="admin-mobile-card">
            <div class="admin-card-header">
              <div>
                <div class="admin-card-company">${app.company}</div>
                <small style="color: #64748B;">${app.legalStatus} • ${app.enterpriseType}</small>
              </div>
              <span class="admin-card-id">${app.id}</span>
            </div>
            <div class="admin-card-meta">
              <div><strong>Rep:</strong> ${app.repName || app.firstName + ' ' + app.lastName}</div>
              <div><strong>Sector:</strong> ${app.businessServices}</div>
              <div><strong>Status:</strong> <span class="badge-status badge-pending"><i class="fas fa-clock"></i> Pending</span></div>
              <div><strong>Date:</strong> ${new Date(app.submittedAt).toLocaleDateString()}</div>
            </div>
            <div class="admin-card-actions">
              <button class="btn-action-approve" data-approve-id="${app.id}">
                <i class="fas fa-check"></i> Approve
              </button>
              <button class="btn-action-reject" data-reject-id="${app.id}">
                <i class="fas fa-times"></i> Reject
              </button>
              <button class="btn-secondary" data-inspect-id="${app.id}">
                <i class="fas fa-eye"></i> Inspect
              </button>
            </div>
          </div>
        `).join('');
      }
    }

    // Render Approved Members Directory (Table & Mobile Cards)
    const approvedTableBody = document.getElementById('approvedAppsBody');
    const approvedCards = document.getElementById('approvedAppsCards');

    if (approvedApps.length === 0) {
      if (approvedTableBody) {
        approvedTableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2rem; color: #94A3B8;">No approved members yet.</td></tr>`;
      }
      if (approvedCards) {
        approvedCards.innerHTML = `<div class="admin-mobile-card" style="text-align: center; color: #94A3B8; padding: 2rem;">No approved members yet.</div>`;
      }
    } else {
      if (approvedTableBody) {
        approvedTableBody.innerHTML = approvedApps.map(app => `
          <tr>
            <td><strong>${app.id}</strong></td>
            <td><strong style="color: var(--primary);">${app.company}</strong></td>
            <td>${app.repName || app.firstName + ' ' + app.lastName}</td>
            <td>${app.email}</td>
            <td><span class="badge-status badge-approved"><i class="fas fa-check-circle"></i> Active Member</span></td>
            <td>${app.approvedAt ? new Date(app.approvedAt).toLocaleDateString() : 'Active'}</td>
          </tr>
        `).join('');
      }
      if (approvedCards) {
        approvedCards.innerHTML = approvedApps.map(app => `
          <div class="admin-mobile-card">
            <div class="admin-card-header">
              <div>
                <div class="admin-card-company">${app.company}</div>
                <small style="color: #64748B;">${app.email}</small>
              </div>
              <span class="admin-card-id">${app.id}</span>
            </div>
            <div class="admin-card-meta">
              <div><strong>Rep:</strong> ${app.repName || app.firstName + ' ' + app.lastName}</div>
              <div><strong>Status:</strong> <span class="badge-status badge-approved"><i class="fas fa-check-circle"></i> Active Member</span></div>
              <div><strong>Approved:</strong> ${app.approvedAt ? new Date(app.approvedAt).toLocaleDateString() : 'Active'}</div>
            </div>
          </div>
        `).join('');
      }
    }

    // Render Enquiries (Table & Mobile Cards)
    const enquiriesTableBody = document.getElementById('enquiriesBody');
    const enquiriesCards = document.getElementById('enquiriesCards');

    if (enquiries.length === 0) {
      if (enquiriesTableBody) {
        enquiriesTableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 2rem; color: #94A3B8;">No enquiries yet.</td></tr>`;
      }
      if (enquiriesCards) {
        enquiriesCards.innerHTML = `<div class="admin-mobile-card" style="text-align: center; color: #94A3B8; padding: 2rem;">No enquiries yet.</div>`;
      }
    } else {
      if (enquiriesTableBody) {
        enquiriesTableBody.innerHTML = enquiries.map(enq => `
          <tr>
            <td><strong>${enq.id}</strong></td>
            <td>${enq.name}<br/><small style="color: #94A3B8;">${enq.company || '-'}</small></td>
            <td>${enq.email}<br/><small style="color: #94A3B8;">${enq.phone}</small></td>
            <td>${enq.subject}</td>
            <td>${new Date(enq.submittedAt).toLocaleDateString()}</td>
          </tr>
        `).join('');
      }
      if (enquiriesCards) {
        enquiriesCards.innerHTML = enquiries.map(enq => `
          <div class="admin-mobile-card">
            <div class="admin-card-header">
              <div>
                <div class="admin-card-company">${enq.subject}</div>
                <small style="color: #64748B;">From: ${enq.name} (${enq.company || 'Individual'})</small>
              </div>
              <span class="admin-card-id">${enq.id}</span>
            </div>
            <div class="admin-card-meta">
              <div><strong>Email:</strong> ${enq.email}</div>
              <div><strong>Phone:</strong> ${enq.phone}</div>
              <div><strong>Date:</strong> ${new Date(enq.submittedAt).toLocaleDateString()}</div>
            </div>
          </div>
        `).join('');
      }
    }

    // Bind Action Buttons
    this.bindAdminActions();
  }

  handleApproveApplication(id) {
    const updated = this.store.updateApplicationStatus(id, 'Approved');
    if (!updated) return;

    const emailLog = this.store.sendApprovalEmail(updated);

    // Dispatch background email via Resend API
    this.sendResendEmail({
      to: updated.email,
      subject: emailLog.subject,
      text: emailLog.body
    });

    this.renderAdminPortal();
    this.showToast(`Application ${id} approved! Confirmation email dispatched to ${updated.email}.`, 'success');

    // Show Confirmation Email Dispatch Modal
    const mailtoUrl = `mailto:${encodeURIComponent(updated.email)}?subject=${encodeURIComponent(emailLog.subject)}&body=${encodeURIComponent(emailLog.body)}`;
    this.showModal({
      title: `<i class="fas fa-envelope-open-text" style="color: #10B981;"></i> Membership Approved &amp; Confirmation Email Sent`,
      content: `
        <div style="font-size: 0.9rem; line-height: 1.6;">
          <div style="background: #ECFDF5; border: 1px solid #A7F3D0; padding: 1rem; border-radius: 8px; margin-bottom: 1.25rem; color: #065F46;">
            <div style="font-weight: 700; font-size: 1rem; margin-bottom: 0.25rem;"><i class="fas fa-check-circle"></i> Application ${updated.id} Approved</div>
            <div>An official confirmation email has been generated and dispatched to <strong>${updated.email}</strong>.</div>
          </div>

          <div style="background: #F8FAFC; border: 1px solid #CBD5E1; border-radius: 8px; padding: 1.25rem; margin-bottom: 1.5rem; color: #1E293B;">
            <div style="margin-bottom: 0.5rem; font-size: 0.85rem;"><strong>To:</strong> ${emailLog.recipientName} &lt;${emailLog.recipientEmail}&gt;</div>
            <div style="margin-bottom: 0.75rem; font-size: 0.85rem; padding-bottom: 0.5rem; border-bottom: 1px solid #E2E8F0;">
              <strong>Subject:</strong> ${emailLog.subject}
            </div>
            <div style="white-space: pre-wrap; font-family: monospace; font-size: 0.825rem; background: #FFFFFF; padding: 1rem; border-radius: 6px; border: 1px solid #E2E8F0; color: #334155; max-height: 200px; overflow-y: auto;">${emailLog.body}</div>
          </div>

          <div style="display: flex; justify-content: space-between; align-items: center;">
            <a href="${mailtoUrl}" target="_blank" class="btn-primary" style="font-size: 0.85rem; padding: 0.5rem 1rem;">
              <i class="fas fa-paper-plane"></i> Launch Local Mail Client (mailto)
            </a>
            <button class="btn-secondary" id="modalCloseBtn">Close</button>
          </div>
        </div>
      `
    });
  }

  bindAdminActions() {
    // Approve Button Action
    document.querySelectorAll('[data-approve-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-approve-id');
        this.handleApproveApplication(id);
      });
    });

    // Reject Button Action
    document.querySelectorAll('[data-reject-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-reject-id');
        const updated = this.store.updateApplicationStatus(id, 'Rejected');
        if (updated) {
          this.renderAdminPortal();
          this.showToast(`Application ${id} rejected.`, 'warning');
        }
      });
    });

    // Inspect Details Button
    document.querySelectorAll('[data-inspect-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-inspect-id');
        const app = this.store.getApplicationById(id);
        if (app) {
          this.showModal({
            title: `Application Details - ${app.id}`,
            content: `
              <div style="font-size: 0.9rem; line-height: 1.8;">
                <div style="margin-bottom: 1rem; padding-bottom: 0.8rem; border-bottom: 1px solid rgba(255,255,255,0.1);">
                  <h4 style="color: #FFD700; font-size: 1.2rem;">${app.company}</h4>
                  <p style="color: #94A3B8;">Status: <span class="badge-status badge-${app.status.toLowerCase()}">${app.status}</span></p>
                </div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem;">
                  <div><strong>Legal Status:</strong> ${app.legalStatus || 'N/A'}</div>
                  <div><strong>Enterprise Scale:</strong> ${app.enterpriseType || 'N/A'}</div>
                  <div><strong>GST Number:</strong> ${app.gstNo || 'N/A'}</div>
                  <div><strong>PAN Number:</strong> ${app.panNo || 'N/A'}</div>
                  <div><strong>Turnover:</strong> ${app.annualTurnover || 'N/A'}</div>
                  <div><strong>Employees:</strong> ${app.employees || 'N/A'}</div>
                  <div><strong>Contact Person:</strong> ${app.repName || app.firstName}</div>
                  <div><strong>Phone:</strong> ${app.phone || 'N/A'}</div>
                  ${app.paymentRef ? `<div style="grid-column: 1 / -1; background: #EFF6FF; border: 1px solid #BFDBFE; padding: 0.5rem 0.8rem; border-radius: 6px; color: #1E3E62;"><strong>UPI Payment UTR Ref:</strong> <code style="font-weight:700; color:#0284C7;">${app.paymentRef}</code></div>` : ''}
                  ${app.paymentProof ? `
                    <div style="grid-column: 1 / -1; margin-top: 0.5rem; background: #F8FAFC; border: 1px solid #CBD5E1; padding: 1rem; border-radius: 8px;">
                      <strong style="color: var(--primary); display: block; margin-bottom: 0.5rem;">
                        <i class="fas fa-file-invoice-dollar" style="color: var(--accent-gold-dark);"></i> Uploaded Payment Confirmation Receipt Screenshot:
                      </strong>
                      <img src="${app.paymentProof}" alt="Payment Receipt Screenshot" data-lightbox style="max-height: 220px; border-radius: 6px; border: 1px solid #CBD5E1; cursor: pointer; box-shadow: var(--shadow-sm);" />
                      <small style="display: block; color: #64748B; margin-top: 0.35rem;"><i class="fas fa-search-plus"></i> Tap image to enlarge in full resolution modal</small>
                    </div>
                  ` : ''}
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1.5rem;">
                  ${app.status === 'Pending' ? `
                    <button class="btn-action-approve" id="inspectApproveBtn"><i class="fas fa-check"></i> Approve Application</button>
                    <button class="btn-action-reject" id="inspectRejectBtn"><i class="fas fa-times"></i> Reject</button>
                  ` : ''}
                  <button class="btn-secondary" id="modalCloseBtn">Close</button>
                </div>
              </div>
            `
          });

          // Bind buttons inside inspect modal
          const approveBtn = document.getElementById('inspectApproveBtn');
          if (approveBtn) {
            approveBtn.addEventListener('click', () => {
              this.closeModal();
              this.handleApproveApplication(app.id);
            });
          }
          const rejectBtn = document.getElementById('inspectRejectBtn');
          if (rejectBtn) {
            rejectBtn.addEventListener('click', () => {
              this.store.updateApplicationStatus(app.id, 'Rejected');
              this.closeModal();
              this.renderAdminPortal();
              this.showToast(`Application ${app.id} rejected.`, 'warning');
            });
          }
        }
      });
    });

    // Export CSV Button Action
    const exportBtn = document.getElementById('btnExportCSV');
    if (exportBtn) {
      exportBtn.addEventListener('click', () => this.exportApplicationsCSV());
    }

    // Tab Switcher inside Admin
    document.querySelectorAll('.admin-menu-item').forEach(item => {
      item.addEventListener('click', () => {
        const tab = item.getAttribute('data-tab');
        document.querySelectorAll('.admin-menu-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');

        document.querySelectorAll('.admin-tab-pane').forEach(pane => pane.style.display = 'none');
        const targetPane = document.getElementById(`tab-${tab}`);
        if (targetPane) targetPane.style.display = 'block';
      });
    });
  }

  exportApplicationsCSV() {
    const apps = this.store.getApplications();
    if (!apps || apps.length === 0) {
      this.showToast('No application records available to export.', 'warning');
      return;
    }

    const headers = [
      'Application ID', 'Company Name', 'Legal Status', 'Enterprise Scale', 'Business Services',
      'GSTIN', 'PAN', 'CIN', 'Turnover', 'Employees', 'Representative Name', 'Designation',
      'Email', 'Mobile Number', 'District', 'Address', 'Pincode', 'Payment Ref', 'Status', 'Submitted At'
    ];

    const rows = apps.map(a => [
      `"${a.id || ''}"`,
      `"${(a.company || '').replace(/"/g, '""')}"`,
      `"${a.legalStatus || ''}"`,
      `"${a.enterpriseType || ''}"`,
      `"${a.businessServices || ''}"`,
      `"${a.gstNo || ''}"`,
      `"${a.panNo || ''}"`,
      `"${a.cin || ''}"`,
      `"${a.annualTurnover || ''}"`,
      `"${a.employees || ''}"`,
      `"${(a.repName || a.firstName || '').replace(/"/g, '""')}"`,
      `"${a.repDesignation || ''}"`,
      `"${a.email || ''}"`,
      `"${a.phone || ''}"`,
      `"${a.district || ''}"`,
      `"${(a.address || '').replace(/"/g, '""')}"`,
      `"${a.pincode || ''}"`,
      `"${a.paymentRef || ''}"`,
      `"${a.status || ''}"`,
      `"${a.submittedAt || ''}"`
    ]);

    const csvData = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `BCCI_Membership_Applications_Backup_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    this.showToast('Applications backup CSV exported successfully!', 'success');
  }

  showModal({ title, content }) {
    const backdrop = document.getElementById('modalBackdrop');
    const container = document.getElementById('modalContainer');
    if (backdrop && container) {
      container.innerHTML = `
        <button class="modal-close" id="modalCloseIcon">&times;</button>
        <h3 class="modal-title">${title}</h3>
        <div>${content}</div>
      `;
      backdrop.classList.add('show');

      const closeHandler = () => this.closeModal();
      document.getElementById('modalCloseIcon')?.addEventListener('click', closeHandler);
      document.getElementById('modalCloseBtn')?.addEventListener('click', closeHandler);
    }
  }

  closeModal() {
    const backdrop = document.getElementById('modalBackdrop');
    if (backdrop) backdrop.classList.remove('show');
  }

  setupModalEvents() {
    const backdrop = document.getElementById('modalBackdrop');
    if (backdrop) {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) this.closeModal();
      });
    }
  }

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      background: ${type === 'success' ? '#10B981' : type === 'warning' ? '#F59E0B' : '#1E3E62'};
      color: #FFF;
      padding: 0.8rem 1.4rem;
      border-radius: 8px;
      font-weight: 600;
      font-size: 0.9rem;
      box-shadow: 0 10px 25px rgba(0,0,0,0.4);
      z-index: 3000;
      transition: all 0.3s ease;
    `;
    toast.innerHTML = `<i class="fas ${type === 'success' ? 'fa-check-circle' : 'fa-info-circle'}"></i> ${message}`;
    document.body.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  sendEmailNotification(subject, payload, fileAttachment = null) {
    const targetEmail = 'sp9023156004@gmail.com';
    const formData = new FormData();

    formData.append('_subject', subject);
    formData.append('_template', 'table');
    formData.append('_captcha', 'false');

    for (const [key, value] of Object.entries(payload)) {
      formData.append(key, value);
    }

    if (fileAttachment) {
      formData.append('Payment Proof Receipt Screenshot', fileAttachment, fileAttachment.name || 'payment_receipt.jpg');
    }

    fetch(`https://formsubmit.co/ajax/${targetEmail}`, {
      method: 'POST',
      body: formData
    }).then(res => res.json())
      .then(data => {
        console.log('Email notification dispatched to admin:', data);
      })
      .catch(err => {
        console.warn('Email dispatch notice:', err);
      });
  }

  setupLightboxEvents() {
    document.addEventListener('click', (e) => {
      const imgTarget = e.target.closest('[data-lightbox]');
      const btnTarget = e.target.closest('[data-img-src]');

      if (imgTarget) {
        const src = imgTarget.getAttribute('src');
        const alt = imgTarget.getAttribute('alt') || 'BCCI Photo';
        this.showModal({
          title: alt,
          content: `
            <div style="text-align: center;">
              <img src="${src}" alt="${alt}" class="lightbox-img-view" />
              <div style="margin-top: 1rem; color: #94A3B8; font-size: 0.85rem;">
                <i class="fas fa-search-plus"></i> High Resolution View
              </div>
            </div>
          `
        });
      } else if (btnTarget) {
        const src = btnTarget.getAttribute('data-img-src');
        const title = btnTarget.getAttribute('data-img-title') || 'BCCI Event Photo';
        this.showModal({
          title: title,
          content: `
            <div style="text-align: center;">
              <img src="${src}" alt="${title}" class="lightbox-img-view" />
              <div style="margin-top: 1rem; color: #94A3B8; font-size: 0.85rem;">
                <i class="fas fa-camera"></i> Official BCCI Media Archive
              </div>
            </div>
          `
        });
      }
    });
  }
}

// Bootstrap Application when DOM Ready
document.addEventListener('DOMContentLoaded', () => {
  window.bcciApp = new App();
});
