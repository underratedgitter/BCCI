/* ==========================================================================
   BCCI BHARUCH - Application Logic & UI Router
   ========================================================================== */

import { Store } from './store.js';

class App {
  constructor() {
    this.store = new Store();
    this.currentView = 'home';
    this.adminAuthed = this.store.isAdminAuthed();
    this.init();
  }

  init() {
    this.bindNavigation();
    this.updateNavAuthUI();
    this.renderView('home');
    this.setupFormHandlers();
    this.setupModalEvents();
    this.setupLightboxEvents();
  }

  updateNavAuthUI() {
    const container = document.getElementById('navAuthContainer');
    if (!container) return;

    if (this.adminAuthed) {
      container.innerHTML = `
        <button class="btn-admin-access" data-view-nav="admin" title="Admin Portal Active">
          <i class="fas fa-user-shield"></i> Admin Portal
        </button>
        <button class="btn-signout-nav" id="btnNavSignOut" title="Sign Out Admin Session">
          <i class="fas fa-sign-out-alt"></i> Sign Out
        </button>
      `;

      const signOutBtn = document.getElementById('btnNavSignOut');
      if (signOutBtn) {
        signOutBtn.addEventListener('click', () => this.handleSignOut());
      }
      container.querySelectorAll('[data-view-nav]').forEach(el => {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          this.renderView(el.getAttribute('data-view-nav'));
        });
      });
    } else {
      container.innerHTML = `
        <button class="btn-signin-nav" id="btnNavSignIn">
          <i class="fas fa-sign-in-alt"></i> Admin Sign In
        </button>
      `;

      const signInBtn = document.getElementById('btnNavSignIn');
      if (signInBtn) {
        signInBtn.addEventListener('click', () => this.showAdminSignInModal());
      }
    }
  }

  showAdminSignInModal() {
    this.showModal({
      title: 'Admin Sign In Portal',
      content: `
        <form id="adminLoginForm" style="padding-top: 0.5rem;">
          <div style="text-align: center; margin-bottom: 1.5rem;">
            <div style="width: 56px; height: 56px; background: #EFF6FF; border: 1px solid #BFDBFE; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; color: var(--primary); font-size: 1.5rem; margin-bottom: 0.75rem;">
              <i class="fas fa-user-shield"></i>
            </div>
            <h4 style="color: var(--primary); font-size: 1.15rem; margin-bottom: 0.3rem;">BCCI Admin Authentication</h4>
            <p style="color: var(--text-muted); font-size: 0.85rem;">Sign in with official administrator credentials to access approval portal.</p>
          </div>

          <div style="display: flex; flex-direction: column; gap: 1rem; margin-bottom: 1.25rem;">
            <div class="form-group">
              <label class="form-label">Username / Official Email <span class="req">*</span></label>
              <input type="text" id="adminUser" class="form-control" placeholder="e.g. admin" required value="admin" />
            </div>
            <div class="form-group">
              <label class="form-label">Password <span class="req">*</span></label>
              <input type="password" id="adminPass" class="form-control" placeholder="Enter password" required value="admin123" />
            </div>
          </div>

          <div style="background: #F8FAFC; border: 1px solid var(--border-color); padding: 0.75rem 1rem; border-radius: var(--radius-sm); font-size: 0.8rem; color: var(--text-muted); margin-bottom: 1.5rem;">
            <i class="fas fa-key" style="color: var(--accent-gold-dark);"></i> <strong>Admin Credentials:</strong> Username: <code style="font-weight: 700; color: var(--primary);">admin</code> | Password: <code style="font-weight: 700; color: var(--primary);">admin123</code>
          </div>

          <button type="submit" class="btn-primary" style="width: 100%; justify-content: center; padding: 0.8rem;">
            <i class="fas fa-sign-in-alt"></i> Sign In to Admin Portal
          </button>
        </form>
      `
    });

    const form = document.getElementById('adminLoginForm');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const user = document.getElementById('adminUser').value.trim();
        const pass = document.getElementById('adminPass').value.trim();

        if (this.store.validateAdminCredentials(user, pass)) {
          this.store.setAdminAuth(true);
          this.adminAuthed = true;
          this.closeModal();
          this.updateNavAuthUI();
          this.showToast('Admin signed in successfully!', 'success');
          this.renderView('admin');
        } else {
          this.showToast('Invalid Username or Password. Please try again.', 'warning');
        }
      });
    }
  }

  handleSignOut() {
    this.store.setAdminAuth(false);
    this.adminAuthed = false;
    this.updateNavAuthUI();
    this.showToast('Signed out of Admin session.', 'info');
    this.renderView('home');
  }

  bindNavigation() {
    document.querySelectorAll('[data-view-nav]').forEach(element => {
      element.addEventListener('click', (e) => {
        e.preventDefault();
        const targetView = element.getAttribute('data-view-nav');
        this.renderView(targetView);
      });
    });

    // Mobile nav toggle
    const mobileBtn = document.getElementById('mobileMenuBtn');
    const navLinks = document.getElementById('navLinks');
    if (mobileBtn && navLinks) {
      mobileBtn.addEventListener('click', () => {
        navLinks.classList.toggle('show');
      });
    }
  }

  renderView(viewId) {
    // PROTECT ADMIN VIEW - REQUIRE ADMIN AUTHENTICATION
    if (viewId === 'admin' && !this.adminAuthed) {
      this.showAdminSignInModal();
      return;
    }

    this.currentView = viewId;

    // Highlight Active Nav
    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.toggle('active', link.getAttribute('data-view-nav') === viewId);
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
        <div class="team-avatar">${m.initials}</div>
        <h4 class="team-name">${m.name}</h4>
        <div class="team-title">${m.role}</div>
        <span class="team-badge">${m.category}</span>
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

  setupFormHandlers() {
    // Membership Form Submission
    const membershipForm = document.getElementById('membershipForm');
    if (membershipForm) {
      membershipForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const formData = new FormData(membershipForm);
        const data = Object.fromEntries(formData.entries());

        const newApp = this.store.addApplication(data);

        // Reset Form
        membershipForm.reset();

        // Show Success Confirmation Modal
        this.showModal({
          title: 'Membership Registration Submitted',
          content: `
            <div style="text-align: center; padding: 1rem 0;">
              <i class="fas fa-clock" style="font-size: 3.5rem; color: #F59E0B; margin-bottom: 1.25rem;"></i>
              <h3 style="margin-bottom: 0.8rem;">Application Pending Admin Approval</h3>
              <p style="color: #94A3B8; margin-bottom: 1.5rem; font-size: 0.95rem;">
                Thank you for applying to join <strong>Bharuch Chamber of Commerce & Industry</strong>.<br/>
                Your Application ID is <strong style="color: #FFD700;">${newApp.id}</strong>.
              </p>
              <div style="background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); padding: 1rem; border-radius: 8px; font-size: 0.85rem; color: #F59E0B; text-align: left; margin-bottom: 1.5rem;">
                <i class="fas fa-info-circle"></i> <strong>Note:</strong> As per BCCI policy, user accounts are activated <u>only after explicit Admin verification</u>. You can check the Admin Portal to view your application status.
              </div>
              <button class="btn-primary" id="modalCloseBtn" style="width: 100%; justify-content: center;">
                Understood & Continue
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
        const formData = new FormData(enquiryForm);
        const data = Object.fromEntries(formData.entries());

        const newEnq = this.store.addEnquiry(data);
        enquiryForm.reset();

        this.showModal({
          title: 'Enquiry Received',
          content: `
            <div style="text-align: center; padding: 1rem 0;">
              <i class="fas fa-check-circle" style="font-size: 3.5rem; color: #10B981; margin-bottom: 1.25rem;"></i>
              <h3 style="margin-bottom: 0.8rem;">Thank You for Contacting BCCI</h3>
              <p style="color: #94A3B8; margin-bottom: 1.5rem; font-size: 0.95rem;">
                Your enquiry (Ref: <strong style="color: #FFD700;">${newEnq.id}</strong>) has been routed to our secretarial team. We will respond within 24 hours.
              </p>
              <button class="btn-primary" id="modalCloseBtn" style="width: 100%; justify-content: center;">Close</button>
            </div>
          `
        });
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

    // Render Pending Applications Table
    const pendingTableBody = document.getElementById('pendingAppsBody');
    if (pendingTableBody) {
      if (pendingApps.length === 0) {
        pendingTableBody.innerHTML = `
          <tr>
            <td colspan="7" style="text-align: center; color: #94A3B8; padding: 2rem;">
              <i class="fas fa-check-double" style="font-size: 1.8rem; margin-bottom: 0.5rem; display: block;"></i>
              No pending applications requiring approval.
            </td>
          </tr>
        `;
      } else {
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
    }

    // Render Approved Members Directory Table
    const approvedTableBody = document.getElementById('approvedAppsBody');
    if (approvedTableBody) {
      if (approvedApps.length === 0) {
        approvedTableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2rem; color: #94A3B8;">No approved members yet.</td></tr>`;
      } else {
        approvedTableBody.innerHTML = approvedApps.map(app => `
          <tr>
            <td><strong>${app.id}</strong></td>
            <td><strong style="color: #FFF;">${app.company}</strong></td>
            <td>${app.repName || app.firstName + ' ' + app.lastName}</td>
            <td>${app.email}</td>
            <td><span class="badge-status badge-approved"><i class="fas fa-check-circle"></i> Active Member</span></td>
            <td>${app.approvedAt ? new Date(app.approvedAt).toLocaleDateString() : 'Active'}</td>
          </tr>
        `).join('');
      }
    }

    // Render Enquiries Table
    const enquiriesTableBody = document.getElementById('enquiriesBody');
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

    // Bind Action Buttons
    this.bindAdminActions();
  }

  bindAdminActions() {
    // Approve Button Action
    document.querySelectorAll('[data-approve-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-approve-id');
        const updated = this.store.updateApplicationStatus(id, 'Approved');
        if (updated) {
          this.renderAdminPortal();
          this.showToast(`Application ${id} approved! Member account activated.`, 'success');
        }
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
                  <div style="grid-column: 1 / -1;"><strong>Address:</strong> ${app.address || ''}, ${app.district || ''}, ${app.state || ''}</div>
                  ${app.paymentRef ? `<div style="grid-column: 1 / -1; background: #EFF6FF; border: 1px solid #BFDBFE; padding: 0.5rem 0.8rem; border-radius: 6px; color: #1E3E62;"><strong>UPI Payment UTR Ref:</strong> <code style="font-weight:700; color:#0284C7;">${app.paymentRef}</code></div>` : ''}
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
              this.store.updateApplicationStatus(app.id, 'Approved');
              this.closeModal();
              this.renderAdminPortal();
              this.showToast(`Application ${app.id} approved!`, 'success');
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
