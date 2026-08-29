/* ==========================================================================
   BCCI BHARUCH - Application Logic & UI Router
   Production-grade SPA with server-backed data persistence.
   All store operations are async — Vercel API + Redis backend.
   ========================================================================== */

import { Store } from './store.js?v=4.0.0';

// ── Configuration ──────────────────────────────────────────────
const CONFIG = {
  ADMIN_EMAIL: 'admin@bccibharuch.in',
  SUPPORT_PHONE: '+91 7861906384',
  UPI_ID: '7861906384.eazypay@icici',
};

// ── XSS Sanitization ──────────────────────────────────────────
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

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
    this.bindNavigation();
    this.updateNavAuthUI();
    this.renderView('home');
    this.updateApplicantAuthUI();
    this.setupSecretAccessHandlers();
    this.setupApplicantAuthHandlers();
    this.setupFileUploadHandlers();
    this.setupFormValidation();
    this.setupFormHandlers();
    this.setupModalEvents();
    this.setupLightboxEvents();
    this.setupScrollToTop();
    this.setupScrollReveal();
  }

  setupScrollReveal() {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

    document.querySelectorAll('.reveal, .stagger-children').forEach(el => observer.observe(el));

    // Re-observe on view changes
    this._revealObserver = observer;
  }

  _refreshScrollReveal() {
    if (!this._revealObserver) return;
    setTimeout(() => {
      document.querySelectorAll('.reveal:not(.visible), .stagger-children:not(.visible)').forEach(el => {
        this._revealObserver.observe(el);
      });
    }, 100);
  }

  setupScrollToTop() {
    const btn = document.createElement('button');
    btn.id = 'scrollToTopBtn';
    btn.innerHTML = '<i class="fas fa-chevron-up"></i>';
    btn.title = 'Scroll to top';
    btn.setAttribute('aria-label', 'Scroll to top');
    btn.style.cssText = `
      opacity: 0; visibility: hidden; transform: translateY(10px);
    `;
    btn.onclick = () => window.scrollTo({ top: 0, behavior: 'smooth' });
    document.body.appendChild(btn);

    window.addEventListener('scroll', () => {
      if (window.scrollY > 400) {
        btn.style.opacity = '1'; btn.style.visibility = 'visible'; btn.style.transform = 'translateY(0)';
      } else {
        btn.style.opacity = '0'; btn.style.visibility = 'hidden'; btn.style.transform = 'translateY(10px)';
      }
    }, { passive: true });
  }

  _updateScrollToTopBtn() {
    const btn = document.getElementById('scrollToTopBtn');
    if (btn) {
      btn.style.opacity = '0'; btn.style.visibility = 'hidden';
    }
  }

  /* ── OTP API Helper ─────────────────────────────────────────────── */
  get OTP_API_BASE() { return ''; }

  async callOtpApi(endpoint, payload) {
    const res = await fetch(`${this.OTP_API_BASE}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok && res.status !== 400 && res.status !== 429) {
      throw new Error(`Server error: ${res.status}`);
    }
    return res.json();
  }

  /* ════════════════════════════════════════════════════════════════════
     APPLICANT OTP AUTHENTICATION
     ════════════════════════════════════════════════════════════════════ */

  setupApplicantAuthHandlers() {
    const otpStep1Form = document.getElementById('otpStep1Form');
    const otpStep2Form = document.getElementById('otpStep2Form');
    const otpSendBtn = document.getElementById('otpSendBtn');
    const otpVerifyBtn = document.getElementById('otpVerifyBtn');
    const otpResendBtn = document.getElementById('otpResendBtn');
    const otpBackBtn = document.getElementById('otpBackBtn');

    let pendingSession = null;

    const setLoading = (btn, loading, label, icon) => {
      if (!btn) return;
      btn.disabled = loading;
      btn.innerHTML = loading
        ? `<i class="fas fa-spinner fa-spin"></i> ${label}`
        : `<i class="${icon}"></i> ${label}`;
    };

    const sendOtp = async (email, name) => {
      setLoading(otpSendBtn, true, 'Sending Code…', 'fas fa-spinner fa-spin');
      try {
        const result = await this.callOtpApi('/api/send-otp', { email, name });
        if (result.success) {
          pendingSession = { email, name };
          otpStep1Form.style.display = 'none';
          otpStep2Form.style.display = 'block';
          const noticeBanner = document.getElementById('otpNoticeBanner');
          if (noticeBanner) {
            noticeBanner.innerHTML = `<i class="fas fa-envelope-open-text"></i> Verification code sent to <strong>${email}</strong>. Check your inbox (and spam folder).`;
          }
          this.showToast(`Verification code sent to ${email}`, 'success');
        } else {
          this.showToast(result.error || 'Failed to send code. Please try again.', 'error');
        }
      } catch (err) {
        console.error('[OTP Send Error]', err);
        this.showToast('Network error. Please check your connection and try again.', 'error');
      } finally {
        setLoading(otpSendBtn, false, 'Send Verification Code', 'fas fa-paper-plane');
      }
    };

    if (otpStep1Form) {
      otpStep1Form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('otpEmailInput').value.trim().toLowerCase();
        const name = document.getElementById('otpNameInput').value.trim();
        if (!email || !name) return;
        await sendOtp(email, name);
      });
    }

    if (otpResendBtn) {
      otpResendBtn.addEventListener('click', async () => {
        if (!pendingSession) return;
        otpResendBtn.disabled = true;
        otpResendBtn.textContent = 'Sending…';
        await sendOtp(pendingSession.email, pendingSession.name);
        const codeInput = document.getElementById('otpCodeInput');
        if (codeInput) codeInput.value = '';
        otpResendBtn.disabled = false;
        otpResendBtn.textContent = 'Resend Code';
      });
    }

    if (otpBackBtn) {
      otpBackBtn.addEventListener('click', () => {
        pendingSession = null;
        otpStep2Form.style.display = 'none';
        otpStep1Form.style.display = 'block';
        const codeInput = document.getElementById('otpCodeInput');
        if (codeInput) codeInput.value = '';
      });
    }

    if (otpStep2Form) {
      otpStep2Form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!pendingSession) return;
        const code = document.getElementById('otpCodeInput').value.trim();
        if (!code || code.length !== 6) {
          this.showToast('Please enter the full 6-digit verification code.', 'warning');
          return;
        }

        setLoading(otpVerifyBtn, true, 'Verifying…', 'fas fa-spinner fa-spin');
        try {
          const result = await this.callOtpApi('/api/verify-otp', {
            email: pendingSession.email,
            name: pendingSession.name,
            code
          });

          if (result.success && result.session) {
            this.store.setApplicantSession(result.session);
            this.updateApplicantAuthUI();
            this.showToast(`Welcome, ${result.session.name}! Identity verified successfully.`, 'success');
            pendingSession = null;
          } else {
            this.showToast(result.error || 'Invalid code. Please try again.', 'error');
            const codeInput = document.getElementById('otpCodeInput');
            if (codeInput) {
              codeInput.style.borderColor = '#EF4444';
              codeInput.value = '';
              setTimeout(() => { codeInput.style.borderColor = ''; }, 2000);
            }
          }
        } catch (err) {
          console.error('[OTP Verify Error]', err);
          this.showToast('Network error. Please check your connection and try again.', 'error');
        } finally {
          setLoading(otpVerifyBtn, false, 'Verify & Access Application', 'fas fa-check-shield');
        }
      });
    }

    // Delegated event listeners
    document.addEventListener('click', (e) => {
      const signOutBtn = e.target.closest('#applicantSignOutBtn') || e.target.closest('.btnUserSignOut');
      const cardBtn = e.target.closest('.btnViewDigitalCard');
      const renewBtn = e.target.closest('.btnRenewMembership');
      const session = this.store.getApplicantSession();

      if (signOutBtn) {
        this.store.clearApplicantSession();
        this.closeModal();
        this.updateApplicantAuthUI();
        this.showToast('Session ended. You have been signed out successfully.', 'info');
      }

      if (cardBtn && session) {
        this.store.getApplicationByEmail(session.email).then(memberApp => {
          if (memberApp) this.showDigitalMemberCardModal(memberApp);
        });
      }

      if (renewBtn && session) {
        this.store.getApplicationByEmail(session.email).then(memberApp => {
          if (memberApp) this.showRenewalModal(memberApp);
        });
      }
    });

    // Profile button handler removed — now handled by profile dropdown

    this.updateApplicantAuthUI();
  }

  async showApplicantProfileModal(session, memberApp) {
    let statusHtml = '<span style="color: #64748B; background: #F1F5F9; padding: 3px 10px; border-radius: 12px; font-size: 0.8rem; font-weight: 600;">Form Not Submitted</span>';
    let detailsHtml = '';

    if (memberApp) {
      if (memberApp.status === 'Approved') {
        const validity = this.store.getMembershipValidity(memberApp);
        statusHtml = `<span style="color: #059669; background: #ECFDF5; border: 1px solid #A7F3D0; padding: 4px 12px; border-radius: 20px; font-size: 0.8rem; font-weight: 700;"><i class="fas fa-check-circle"></i> ⭐ ACTIVE MEMBER</span>`;
        detailsHtml = `
          <div style="background: #F8FAFC; border: 1px solid #E2E8F0; padding: 1rem; border-radius: 8px; margin: 1rem 0; font-size: 0.85rem;">
            <div><strong>Company:</strong> ${memberApp.company}</div>
            <div><strong>Member ID:</strong> <code style="color: var(--primary); font-weight:700;">${memberApp.id}</code></div>
            <div><strong>Valid Until:</strong> ${validity ? validity.validUntilDate : 'Active'}</div>
          </div>
        `;
      } else if (memberApp.status === 'Pending') {
        statusHtml = `<span style="color: #D97706; background: #FEF3C7; border: 1px solid #FDE68A; padding: 4px 12px; border-radius: 20px; font-size: 0.8rem; font-weight: 700;"><i class="fas fa-clock"></i> ⌛ PENDING ADMIN APPROVAL</span>`;
        detailsHtml = `
          <div style="background: #FEF3C7; border: 1px solid #FDE68A; color: #92400E; padding: 0.85rem; border-radius: 8px; margin: 1rem 0; font-size: 0.85rem;">
            <strong>Ref ID: ${memberApp.id}</strong> — Submitted on ${new Date(memberApp.submittedAt).toLocaleDateString()}. Pending Secretariat review.
          </div>
        `;
      }
    }

    this.showModal({
      title: `<i class="fas fa-user-circle" style="color: var(--primary);"></i> My BCCI Profile &amp; Account`,
      content: `
        <div style="padding: 0.5rem 0;">
          <div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem;">
            <div style="width: 52px; height: 52px; background: linear-gradient(135deg, #0F2C59 0%, #1E3E62 100%); color: #FFD700; border: 2px solid #D4AF37; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 1.3rem;">
              ${(session.name || session.email).charAt(0).toUpperCase()}
            </div>
            <div>
              <div style="font-size: 1.1rem; font-weight: 700; color: #0F172A;">${session.name || 'BCCI Applicant'}</div>
              <div style="font-size: 0.85rem; color: #64748B;">${session.email}</div>
            </div>
          </div>
          <div style="margin-bottom: 1rem;">
            <label style="font-size: 0.75rem; text-transform: uppercase; color: #94A3B8; font-weight: 700; display: block; margin-bottom: 4px;">Account Status</label>
            ${statusHtml}
          </div>
          ${detailsHtml}
          <div style="display: flex; flex-direction: column; gap: 0.6rem; margin-top: 1.5rem;">
            ${memberApp && memberApp.status === 'Approved' ? `
              <button type="button" class="btn-primary btnViewDigitalCard" style="width: 100%; justify-content: center; font-size: 0.85rem;">
                <i class="fas fa-id-card"></i> View Digital Membership Pass
              </button>
            ` : ''}
            <button type="button" class="btnUserSignOut" style="width: 100%; justify-content: center; padding: 0.65rem; background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: var(--radius-sm); color: #EF4444; font-size: 0.88rem; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 8px;">
              <i class="fas fa-sign-out-alt"></i> Sign Out Account
            </button>
            <button type="button" class="btn-secondary" id="modalCloseBtn" style="width: 100%; justify-content: center;">Close</button>
          </div>
        </div>
      `
    });
  }

  async updateApplicantAuthUI() {
    const gate = document.getElementById('applicantAuthGate');
    const banner = document.getElementById('applicantAuthBanner');
    const wrapper = document.getElementById('membershipFormWrapper');
    const signInReminder = document.getElementById('signInReminder');
    const membershipSubmitBtn = document.querySelector('#membershipForm button[type="submit"]');
    const emailDisplay = document.getElementById('applicantEmailDisplay');
    const avatarInitial = document.getElementById('applicantAvatarInitial');
    const profileBtnText = document.getElementById('userProfileBtnText');
    const headerSignOutBtn = document.getElementById('btnHeaderSignOut');

    const session = this.store.getApplicantSession();
    if (session && session.email) {
      if (gate) gate.style.display = 'none';
      if (banner) banner.style.display = 'flex';
      if (signInReminder) signInReminder.style.display = 'none';
      if (membershipSubmitBtn) {
        membershipSubmitBtn.disabled = false;
        membershipSubmitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Application';
        membershipSubmitBtn.style.opacity = '1';
        membershipSubmitBtn.style.cursor = 'pointer';
      }
      if (headerSignOutBtn) headerSignOutBtn.style.display = 'inline-flex';

      const memberApp = await this.store.getApplicationByEmail(session.email);

      if (memberApp && memberApp.status === 'Approved') {
        const validity = this.store.getMembershipValidity(memberApp);
        if (wrapper) wrapper.style.display = 'none';

        let statusBadgeClass = 'background: rgba(16, 185, 129, 0.15); color: #34D399; border: 1px solid #10B981;';
        let statusLabel = `⭐ ACTIVE MEMBER (Valid until ${validity.validUntilDate})`;

        if (validity.state === 'RENEWAL_DUE') {
          statusBadgeClass = 'background: rgba(245, 158, 11, 0.2); color: #FBBF24; border: 1px solid #F59E0B;';
          statusLabel = `⚠️ RENEWAL DUE SOON (${validity.daysRemaining} days left)`;
        } else if (validity.state === 'EXPIRED') {
          statusBadgeClass = 'background: rgba(239, 68, 68, 0.2); color: #FCA5A5; border: 1px solid #EF4444;';
          statusLabel = `❌ MEMBERSHIP EXPIRED (${validity.validUntilDate})`;
        }

        if (emailDisplay) {
          emailDisplay.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span style="font-size: 1.15rem; font-weight: 800; color: #FFFFFF;">${memberApp.company}</span>
              <span style="font-size: 0.75rem; background: rgba(255,215,0,0.2); color: #FFD700; border: 1px solid #FFD700; padding: 2px 8px; border-radius: 12px; font-family: monospace; font-weight: 700;">${memberApp.id}</span>
            </div>
            <div style="font-size: 0.85rem; color: #CBD5E1; margin-top: 3px;">
              Delegate: <strong style="color: #FFFFFF;">${memberApp.repName}</strong> (${session.email})
            </div>
            <div style="display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center; margin-top: 0.6rem;">
              <span style="font-size: 0.8rem; font-weight: 700; padding: 4px 12px; border-radius: 20px; ${statusBadgeClass}">
                ${statusLabel}
              </span>
              <button type="button" class="btn-primary btnViewDigitalCard" style="padding: 0.35rem 0.85rem; font-size: 0.78rem; background: linear-gradient(135deg, #D4AF37 0%, #AA7C11 100%); color: #0F2C59; font-weight: 800; border: none; box-shadow: 0 2px 6px rgba(212, 175, 55, 0.4);">
                <i class="fas fa-id-card"></i> Digital Membership Pass
              </button>
              <button type="button" class="btn-secondary btnRenewMembership" style="padding: 0.35rem 0.85rem; font-size: 0.78rem; color: #FFD700; border-color: rgba(255,215,0,0.4); background: rgba(255,215,0,0.1); font-weight: 700;">
                <i class="fas fa-sync-alt"></i> Annual Renewal
              </button>
            </div>
          `;
        }

        this.updateHeaderMemberBadge(memberApp, validity);
        if (profileBtnText) profileBtnText.textContent = `${memberApp.company} (Member)`;

      } else if (memberApp && memberApp.status === 'Pending') {
        if (wrapper) wrapper.style.display = 'none';
        if (emailDisplay) {
          emailDisplay.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span style="font-size: 1.05rem; font-weight: 800; color: #FFFFFF;">${memberApp.company}</span>
              <span style="font-size: 0.75rem; background: rgba(251,191,36,0.2); color: #FBBF24; border: 1px solid #F59E0B; padding: 2px 8px; border-radius: 12px; font-family: monospace; font-weight: 700;">${memberApp.id}</span>
            </div>
            <div style="font-size: 0.85rem; color: #FCD34D; margin-top: 3px;">
              <i class="fas fa-hourglass-half"></i> <strong>Application Status: PENDING SECRETARIAT REVIEW</strong>
            </div>
            <div style="font-size: 0.8rem; color: #94A3B8; margin-top: 0.2rem;">
              Submitted on ${new Date(memberApp.submittedAt).toLocaleDateString()}. The Secretariat Board is reviewing your documentation.
            </div>
          `;
        }
        this.updateHeaderMemberBadge(memberApp, null);
        if (profileBtnText) profileBtnText.textContent = `Pending (${memberApp.id})`;
      } else {
        if (wrapper) wrapper.style.display = 'grid';
        if (emailDisplay) emailDisplay.textContent = `${session.name || 'Applicant'} (${session.email})`;
        this.updateHeaderMemberBadge(null, null);
        if (profileBtnText) profileBtnText.textContent = `Profile (${session.name || session.email.split('@')[0]})`;

        const emailInput = document.querySelector('#membershipForm input[name="email"]');
        const repInput = document.querySelector('#membershipForm input[name="repName"]');
        if (emailInput && !emailInput.value) emailInput.value = session.email;
        if (repInput && !repInput.value && session.name) repInput.value = session.name;
      }

      if (avatarInitial) avatarInitial.textContent = (session.name || session.email).charAt(0).toUpperCase();

    } else {
      if (gate) gate.style.display = 'block';
      if (banner) banner.style.display = 'none';
      if (wrapper) wrapper.style.display = 'grid';
      if (signInReminder) signInReminder.style.display = 'flex';
      if (membershipSubmitBtn) {
        membershipSubmitBtn.disabled = true;
        membershipSubmitBtn.innerHTML = '<i class="fas fa-lock"></i> Sign In to Submit';
        membershipSubmitBtn.style.opacity = '0.65';
        membershipSubmitBtn.style.cursor = 'not-allowed';
      }
      this.updateHeaderMemberBadge(null, null);
      if (profileBtnText) profileBtnText.textContent = 'My Profile / Sign In';
      if (headerSignOutBtn) headerSignOutBtn.style.display = 'none';
    }
  }

  updateHeaderMemberBadge(memberApp, validity) {
    const desktopAuthContainer = document.getElementById('navAuthContainer');
    let badgeEl = document.getElementById('navHeaderMemberBadge');

    if (!memberApp || memberApp.status !== 'Approved') {
      if (badgeEl) badgeEl.remove();
      return;
    }

    if (!badgeEl) {
      badgeEl = document.createElement('div');
      badgeEl.id = 'navHeaderMemberBadge';
      if (desktopAuthContainer) {
        desktopAuthContainer.parentNode.insertBefore(badgeEl, desktopAuthContainer);
      }
    }

    let starColor = '#FFD700';
    let badgeBg = 'linear-gradient(135deg, #0F2C59 0%, #1E3E62 100%)';
    let badgeBorder = '#D4AF37';
    let badgeText = '#FFFFFF';

    if (validity && validity.state === 'EXPIRED') {
      starColor = '#EF4444';
      badgeBg = '#7F1D1D';
      badgeBorder = '#FCA5A5';
    }

    badgeEl.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 0.45rem;
      background: ${badgeBg};
      border: 1px solid ${badgeBorder};
      color: ${badgeText};
      padding: 0.4rem 0.85rem;
      border-radius: 20px;
      font-size: 0.82rem;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(15, 44, 89, 0.25);
    `;
    badgeEl.innerHTML = `<i class="fas fa-award" style="color: ${starColor}; font-size: 0.95rem;"></i> OFFICIAL MEMBER: ${memberApp.company} <span style="color: #FFD700; font-family: monospace; font-size: 0.75rem; background: rgba(255,215,0,0.15); padding: 1px 6px; border-radius: 8px;">${memberApp.id}</span>`;
    badgeEl.title = `Official Member ID: ${memberApp.id} - Tap to view Digital Membership Pass`;

    badgeEl.onclick = () => this.showDigitalMemberCardModal(memberApp);
  }

  showDigitalMemberCardModal(app) {
    const validity = this.store.getMembershipValidity(app);
    this.showModal({
      title: `<i class="fas fa-id-card" style="color: var(--accent-gold-dark);"></i> Official BCCI Digital Membership Pass`,
      content: `
        <div style="padding: 0.5rem 0;">
          <div class="bcci-membership-card-wrapper" style="margin-bottom: 1.5rem;">
            <div class="bcci-membership-card">
              <div class="bcci-card-hologram"></div>
              <div class="bcci-card-pattern"></div>
              <div class="bcci-card-border"></div>
              <div class="bcci-card-premium-badge">MEMBER</div>
              
              <div class="bcci-card-content">
                <div class="bcci-card-header">
                  <div class="bcci-card-logo-section">
                    <div class="bcci-card-logo">
                      <img src="assets/BCCIBHARUCH.webp" alt="BCCI" />
                    </div>
                    <div class="bcci-card-org">
                      <div class="bcci-card-org-name">Bharuch Chamber</div>
                      <div class="bcci-card-org-sub">of Commerce & Industry</div>
                    </div>
                  </div>
                  <div class="bcci-card-type">
                    <div class="bcci-card-type-label">Membership</div>
                    <div class="bcci-card-type-value">${escapeHtml(app.enterpriseType || 'Corporate')}</div>
                  </div>
                </div>

                <div class="bcci-card-middle">
                  <div class="bcci-card-member-info">
                    <div class="bcci-card-member-label">Cardholder</div>
                    <div class="bcci-card-member-name">${escapeHtml(app.repName || 'Member')}</div>
                    <div class="bcci-card-member-company">${escapeHtml(app.company || 'BCCI Member')}</div>
                  </div>
                </div>

                <div class="bcci-card-microprint"></div>

                <div class="bcci-card-footer">
                  <div class="bcci-card-details">
                    <div class="bcci-card-detail">
                      <div class="bcci-card-detail-label">Member ID</div>
                      <div class="bcci-card-detail-value">${escapeHtml(app.id)}</div>
                    </div>
                    <div class="bcci-card-detail">
                      <div class="bcci-card-detail-label">Since</div>
                      <div class="bcci-card-detail-value">${escapeHtml(validity ? validity.approvedDate : 'N/A')}</div>
                    </div>
                  </div>
                  <div class="bcci-card-validity">
                    <div class="bcci-card-validity-label">Status</div>
                    <div class="bcci-card-validity-value ${validity && validity.state === 'ACTIVE' ? 'active' : validity && validity.state === 'RENEWAL_DUE' ? 'expiring' : 'expired'}">${validity ? (validity.state === 'ACTIVE' ? 'ACTIVE MEMBER' : validity.state === 'RENEWAL_DUE' ? 'RENEWAL DUE' : 'EXPIRED') : 'N/A'}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div style="display: flex; gap: 0.75rem; justify-content: center;">
            <button type="button" class="btn-primary" onclick="window.print();" style="flex: 1; justify-content: center; font-size: 0.85rem;">
              <i class="fas fa-print"></i> Print Card
            </button>
            <button type="button" class="btn-secondary" id="viewFullCardBtn" style="flex: 1; justify-content: center; font-size: 0.85rem;">
              <i class="fas fa-expand-alt"></i> View Full Card
            </button>
            <button type="button" class="btn-secondary" id="modalCloseBtn" style="padding: 0.6rem 1.25rem;">Close</button>
          </div>
        </div>
      `
    });

    // Bind view full card button
    setTimeout(() => {
      document.getElementById('viewFullCardBtn')?.addEventListener('click', () => {
        this.closeModal();
        this.renderView('card');
      });
    }, 100);
  }

  showRenewalModal(app) {
    const validity = this.store.getMembershipValidity(app);
    this.showModal({
      title: `<i class="fas fa-sync-alt" style="color: var(--primary);"></i> Annual Membership Renewal (1-Year Extension)`,
      content: `
        <div style="padding: 0.5rem 0;">
          <div style="background: #EFF6FF; border: 1px solid #BFDBFE; padding: 1rem; border-radius: 8px; margin-bottom: 1.25rem; font-size: 0.9rem; color: #1E3E62;">
            <div style="font-weight: 700; margin-bottom: 0.25rem;"><i class="fas fa-building"></i> Enterprise: ${app.company} (${app.id})</div>
            <div>Current Validity: <strong>${validity ? validity.validUntilDate : 'N/A'}</strong></div>
            <div style="margin-top: 0.4rem; color: var(--primary); font-weight: 600;">
              Renewing will extend your BCCI membership by +1 Year (${validity ? validity.yearsTenure + 1 : 2} Years Total).
            </div>
          </div>
          <div style="margin-bottom: 1.25rem; text-align: center; background: #F8FAFC; padding: 1rem; border-radius: 8px; border: 1px solid #E2E8F0;">
            <img src="assets/banks.webp" alt="BCCI Payment QR" style="max-height: 180px; border-radius: 6px; border: 1px solid #CBD5E1; margin-bottom: 0.5rem;" />
            <div style="font-size: 0.85rem; font-weight: 700; color: var(--primary);">Scan UPI QR Code for Annual Renewal Fee Payment</div>
            <code style="font-size: 0.8rem; background: #DBEAFE; padding: 2px 8px; border-radius: 4px; color: #1E40AF;">7861906384.eazypay@icici</code>
          </div>
          <form id="renewalForm">
            <div class="form-group" style="margin-bottom: 1.25rem;">
              <label class="form-label">Payment UTR / Transaction Ref No. <span class="req">*</span></label>
              <input type="text" id="renewalUtrInput" class="form-control" placeholder="e.g. UPI/589410238491" required />
            </div>
            <div style="display: flex; gap: 0.75rem; justify-content: center;">
              <button type="submit" class="btn-primary" style="width: 100%; justify-content: center; font-weight: 600;">
                <i class="fas fa-check-circle"></i> Confirm 1-Year Membership Renewal
              </button>
            </div>
          </form>
        </div>
      `
    });

    setTimeout(() => {
      const renForm = document.getElementById('renewalForm');
      if (renForm) {
        renForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const utr = document.getElementById('renewalUtrInput').value.trim();
          if (!utr) return;

          try {
            await this.store.renewMembership(app.id, utr);
            this.closeModal();
            this.showToast(`Membership ${app.id} successfully renewed for +1 Year!`, 'success');
            this.updateApplicantAuthUI();
          } catch (err) {
            this.showToast('Failed to renew membership. Please try again.', 'error');
          }
        });
      }
    }, 100);
  }

  /* ════════════════════════════════════════════════════════════════════
     ADMIN AUTHENTICATION — Server-backed sessions
     ════════════════════════════════════════════════════════════════════ */

  setupSecretAccessHandlers() {
    const handleHashChange = () => {
      const hash = (window.location.hash || '').toLowerCase();
      if (hash === '#admin' || hash === '#secret-admin') {
        this.renderView(this.adminAuthed ? 'admin' : 'signin');
      } else if (hash === '#signin' || hash === '#login') {
        this.renderView('signin');
      }
    };

    window.addEventListener('hashchange', handleHashChange);
    if (window.location.hash) handleHashChange();

    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault();
        this.renderView(this.adminAuthed ? 'admin' : 'signin');
        this.showToast('Secretariat Access Shortcut Triggered', 'info');
      }
    });
  }

  updateNavAuthUI() {
    const desktopContainer = document.getElementById('navAuthContainer');
    const drawerContainer = document.getElementById('mobileDrawerAuthContainer');
    const session = this.store.getApplicantSession();

    // Close any open dropdowns
    document.querySelectorAll('.nav-profile-dropdown.open').forEach(d => d.classList.remove('open'));

    let desktopHtml = '';
    let drawerHtml = '';

    if (this.adminAuthed) {
      // Admin Portal button hidden — access via Ctrl+Shift+A or #admin hash only
      desktopHtml = `
        <button class="btn-signout-nav btnNavSignOut" title="Sign Out Admin Session">
          <i class="fas fa-sign-out-alt"></i> Sign Out
        </button>
      `;
      drawerHtml = `
        <button class="btn-signout-nav btnNavSignOut" title="Sign Out Admin Session" style="width: 100%; justify-content: center; margin-top: 0.5rem;">
          <i class="fas fa-sign-out-alt"></i> Sign Out
        </button>
      `;
    } else if (session && session.email) {
      const initial = (session.name || session.email).charAt(0).toUpperCase();
      desktopHtml = `
        <div class="nav-profile-wrapper">
          <button type="button" class="nav-profile-avatar" id="navProfileAvatarBtn" title="My Profile">
            ${initial}
            <span class="online-dot"></span>
          </button>
          <div class="nav-profile-dropdown" id="navProfileDropdown"></div>
        </div>
      `;
      drawerHtml = `
        <div class="nav-profile-wrapper" style="width:100%;">
          <button type="button" class="nav-profile-avatar" id="mobileProfileAvatarBtn" title="My Profile" style="margin: 0 auto 0.5rem; display: flex;">
            ${initial}
            <span class="online-dot"></span>
          </button>
          <div class="nav-profile-dropdown" id="mobileProfileDropdown" style="position: static; width: 100%; transform: none; box-shadow: 0 1px 4px rgba(0,0,0,0.08);"></div>
        </div>
      `;
    } else {
      desktopHtml = `
        <button type="button" class="btn-signin-nav" onclick="document.querySelector('[data-view-nav=membership]').click()">
          <i class="fas fa-user"></i> Sign In
        </button>
      `;
      drawerHtml = `
        <button type="button" class="btn-signin-nav" style="width: 100%; justify-content: center;" onclick="document.querySelector('[data-view-nav=membership]').click()">
          <i class="fas fa-user"></i> Sign In
        </button>
      `;
    }

    if (desktopContainer) desktopContainer.innerHTML = desktopHtml;
    if (drawerContainer) drawerContainer.innerHTML = drawerHtml;

    // Show/hide View Card button based on membership status
    const viewCardBtn = document.getElementById('viewCardBtn');
    if (viewCardBtn && session && session.email) {
      this.store.getApplicationByEmail(session.email).then(app => {
        if (app && app.status === 'Approved') {
          viewCardBtn.style.display = 'inline-flex';
          viewCardBtn.onclick = () => this.renderView('card');
        } else {
          viewCardBtn.style.display = 'none';
        }
      });
    } else if (viewCardBtn) {
      viewCardBtn.style.display = 'none';
    }

    // Admin sign out
    document.querySelectorAll('.btnNavSignOut').forEach(btn => {
      btn.onclick = () => this.handleAdminSignOut();
    });

    // Profile dropdown toggle
    const setupDropdownToggle = (avatarBtnId, dropdownId) => {
      const avatarBtn = document.getElementById(avatarBtnId);
      const dropdown = document.getElementById(dropdownId);
      if (!avatarBtn || !dropdown) return;

      avatarBtn.onclick = async (e) => {
        e.stopPropagation();
        const isOpen = dropdown.classList.contains('open');
        // Close all other dropdowns
        document.querySelectorAll('.nav-profile-dropdown.open').forEach(d => d.classList.remove('open'));
        if (!isOpen) {
          // Show loading skeleton immediately
          dropdown.innerHTML = `
            <div style="padding: 1.25rem;">
              <div style="display:flex;align-items:center;gap:0.85rem;margin-bottom:1rem;">
                <div style="width:48px;height:48px;border-radius:50%;background:#E2E8F0;animation:pulse 1.5s infinite;"></div>
                <div style="flex:1;">
                  <div style="height:14px;width:120px;background:#E2E8F0;border-radius:4px;margin-bottom:6px;animation:pulse 1.5s infinite;"></div>
                  <div style="height:10px;width:180px;background:#E2E8F0;border-radius:4px;animation:pulse 1.5s infinite;"></div>
                </div>
              </div>
              <div style="height:32px;background:#E2E8F0;border-radius:8px;margin-bottom:0.5rem;animation:pulse 1.5s infinite;"></div>
              <div style="height:18px;width:80%;background:#F1F5F9;border-radius:4px;margin-bottom:4px;animation:pulse 1.5s infinite;"></div>
              <div style="height:18px;width:60%;background:#F1F5F9;border-radius:4px;animation:pulse 1.5s infinite;"></div>
            </div>
          `;
          dropdown.classList.add('open');
          // Build actual content
          const activeSession = this.store.getApplicantSession();
          let memberApp = null;
          let validity = null;
          if (activeSession && activeSession.email) {
            memberApp = await this.store.getApplicationByEmail(activeSession.email);
            if (memberApp && memberApp.status === 'Approved') {
              validity = this.store.getMembershipValidity(memberApp);
            }
          }
          dropdown.innerHTML = this._buildProfileDropdownHtml(activeSession, memberApp, validity);
          this._bindProfileDropdownActions(dropdown);
        }
      };
    };

    setupDropdownToggle('navProfileAvatarBtn', 'navProfileDropdown');
    setupDropdownToggle('mobileProfileAvatarBtn', 'mobileProfileDropdown');

    // Close dropdown on outside click (only bind once)
    if (!this._outsideClickBound) {
      this._outsideClickBound = true;
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.nav-profile-wrapper')) {
          document.querySelectorAll('.nav-profile-dropdown.open').forEach(d => d.classList.remove('open'));
        }
      });
    }

    document.querySelectorAll('#navAuthContainer [data-view-nav], #mobileDrawerAuthContainer [data-view-nav]').forEach(el => {
      el.onclick = (e) => {
        e.preventDefault();
        this.closeMobileDrawer();
        this.renderView(el.getAttribute('data-view-nav'));
      };
    });

    // Populate dropdowns if already open
    this._populateProfileDropdowns();
  }

  _buildProfileDropdownHtml(session, memberApp, validity) {
    const initial = (session.name || session.email).charAt(0).toUpperCase();
    const displayName = session.name || 'BCCI Member';
    const displayEmail = session.email;

    let statusHtml = '';
    let infoHtml = '';

    if (memberApp) {
      if (memberApp.status === 'Approved') {
        let statusClass = 'active';
        let statusIcon = 'fa-check-circle';
        let statusText = '⭐ Active Member';
        if (validity && validity.state === 'RENEWAL_DUE') {
          statusClass = 'pending';
          statusIcon = 'fa-exclamation-triangle';
          statusText = `⚠️ Renewal Due (${validity.daysRemaining} days)`;
        } else if (validity && validity.state === 'EXPIRED') {
          statusClass = 'expired';
          statusIcon = 'fa-times-circle';
          statusText = '❌ Membership Expired';
        }
        statusHtml = `<div class="profile-dropdown-status ${statusClass}"><i class="fas ${statusIcon}"></i> ${statusText}</div>`;
        infoHtml = `
          <div class="profile-dropdown-info"><span class="info-label">Company</span><span class="info-value">${memberApp.company}</span></div>
          <div class="profile-dropdown-info"><span class="info-label">Member ID</span><span class="info-value" style="font-family:monospace;color:var(--primary);">${memberApp.id}</span></div>
          <div class="profile-dropdown-info"><span class="info-label">Valid Until</span><span class="info-value" style="color:${validity && validity.state === 'EXPIRED' ? '#DC2626' : '#059669'};">${validity ? validity.validUntilDate : 'Active'}</span></div>
        `;
      } else if (memberApp.status === 'Pending') {
        statusHtml = `<div class="profile-dropdown-status pending"><i class="fas fa-hourglass-half"></i> ⏳ Pending Approval</div>`;
        infoHtml = `
          <div class="profile-dropdown-info"><span class="info-label">Company</span><span class="info-value">${memberApp.company}</span></div>
          <div class="profile-dropdown-info"><span class="info-label">Ref ID</span><span class="info-value" style="font-family:monospace;color:#D97706;">${memberApp.id}</span></div>
          <div class="profile-dropdown-info"><span class="info-label">Submitted</span><span class="info-value">${new Date(memberApp.submittedAt).toLocaleDateString()}</span></div>
        `;
      }
    } else {
      statusHtml = `<div class="profile-dropdown-status unverified"><i class="fas fa-info-circle"></i> Verified via Email OTP</div>`;
    }

    let actionsHtml = '';
    if (memberApp && memberApp.status === 'Approved') {
      actionsHtml = `
        <button class="pd-btn-gold pdBtnDigitalCard"><i class="fas fa-id-card"></i> View Digital Card</button>
        <button class="pd-btn-primary pdBtnRenew"><i class="fas fa-sync-alt"></i> Annual Renewal</button>
      `;
    } else if (!memberApp) {
      actionsHtml = `
        <button class="pd-btn-primary pdBtnApply"><i class="fas fa-building"></i> Apply for Membership</button>
      `;
    }
    actionsHtml += `
      <button class="pd-btn-danger pdBtnSignOut"><i class="fas fa-sign-out-alt"></i> Sign Out</button>
    `;

    return `
      <div class="profile-dropdown-header">
        <div class="profile-dropdown-avatar">${initial}</div>
        <div>
          <div class="profile-dropdown-name">${displayName}</div>
          <div class="profile-dropdown-email">${displayEmail}</div>
        </div>
      </div>
      <div class="profile-dropdown-body">
        ${statusHtml}
        ${infoHtml}
      </div>
      <div class="profile-dropdown-actions">
        ${actionsHtml}
      </div>
    `;
  }

  _bindProfileDropdownActions(dropdown) {
    dropdown.querySelector('.pdBtnDigitalCard')?.addEventListener('click', async () => {
      dropdown.classList.remove('open');
      const session = this.store.getApplicantSession();
      if (session && session.email) {
        const memberApp = await this.store.getApplicationByEmail(session.email);
        if (memberApp) this.showDigitalMemberCardModal(memberApp);
      }
    });
    dropdown.querySelector('.pdBtnRenew')?.addEventListener('click', async () => {
      dropdown.classList.remove('open');
      const session = this.store.getApplicantSession();
      if (session && session.email) {
        const memberApp = await this.store.getApplicationByEmail(session.email);
        if (memberApp) this.showRenewalModal(memberApp);
      }
    });
    dropdown.querySelector('.pdBtnApply')?.addEventListener('click', () => {
      dropdown.classList.remove('open');
      this.closeMobileDrawer();
      this.renderView('membership');
    });
    dropdown.querySelector('.pdBtnSignOut')?.addEventListener('click', () => {
      dropdown.classList.remove('open');
      this.handleApplicantSignOut();
    });
  }

  async _populateProfileDropdowns() {
    const session = this.store.getApplicantSession();
    if (!session || !session.email) return;

    const memberApp = await this.store.getApplicationByEmail(session.email);
    let validity = null;
    if (memberApp && memberApp.status === 'Approved') {
      validity = this.store.getMembershipValidity(memberApp);
    }

    ['navProfileDropdown', 'mobileProfileDropdown'].forEach(id => {
      const dd = document.getElementById(id);
      if (dd && dd.children.length === 0) {
        dd.innerHTML = this._buildProfileDropdownHtml(session, memberApp, validity);
        this._bindProfileDropdownActions(dd);
      }
    });
  }

  async handleAdminSignOut() {
    await this.store.clearAdminSession();
    this.adminAuthed = false;
    this.updateNavAuthUI();
    this.showToast('Signed out of Admin session.', 'info');
    this.renderView('home');
  }

  handleApplicantSignOut() {
    this.store.clearApplicantSession();
    this.updateNavAuthUI();
    this.updateApplicantAuthUI();
    this.showToast('Session ended. You have been signed out successfully.', 'info');
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

    const mobileBtn = document.getElementById('mobileMenuBtn');
    const drawerCloseBtn = document.getElementById('mobileDrawerCloseBtn');
    const backdrop = document.getElementById('mobileDrawerBackdrop');

    if (mobileBtn) mobileBtn.addEventListener('click', () => this.openMobileDrawer());
    if (drawerCloseBtn) drawerCloseBtn.addEventListener('click', () => this.closeMobileDrawer());
    if (backdrop) backdrop.addEventListener('click', () => this.closeMobileDrawer());

    const drawer = document.getElementById('mobileNavDrawer');
    if (drawer) {
      let touchStartX = 0;
      drawer.addEventListener('touchstart', (e) => { touchStartX = e.changedTouches[0].screenX; }, { passive: true });
      drawer.addEventListener('touchend', (e) => {
        if (e.changedTouches[0].screenX - touchStartX > 50) this.closeMobileDrawer();
      }, { passive: true });
    }
  }

  async renderView(viewId) {
    if (viewId === 'admin' && !this.adminAuthed) {
      this.renderView('signin');
      return;
    }
    if (viewId === 'signin' && this.adminAuthed) {
      this.renderView('admin');
      return;
    }

    this.currentView = viewId;

    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.toggle('active', link.getAttribute('data-view-nav') === viewId);
    });
    document.querySelectorAll('.mobile-drawer-link').forEach(link => {
      link.classList.toggle('active', link.getAttribute('data-view-nav') === viewId);
    });
    document.querySelectorAll('.mobile-bottom-tab').forEach(tab => {
      tab.classList.toggle('active', tab.getAttribute('data-view-nav') === viewId);
    });

    // Show/hide scroll-to-top button
    this._updateScrollToTopBtn();

    // Refresh scroll reveal for new content
    this._refreshScrollReveal();

    document.querySelectorAll('.view-page').forEach(page => { page.style.display = 'none'; });

    const targetPage = document.getElementById(`view-${viewId}`);
    if (targetPage) {
      targetPage.style.display = 'block';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    if (viewId === 'home' || viewId === 'about') this.renderLeadership();
    if (viewId === 'services') this.renderServicesAndFaqs();
    if (viewId === 'membership') this.updateApplicantAuthUI();
    if (viewId === 'card') this.renderMembershipCard();
    if (viewId === 'admin') await this.renderAdminPortal();
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
    const servicesContainer = document.getElementById('servicesGrid');
    if (servicesContainer) {
      const services = this.store.getServices();
      servicesContainer.innerHTML = services.map(s => `
        <div class="service-card">
          <div class="service-icon"><i class="fas ${s.icon}"></i></div>
          <h3 class="service-title">${s.title}</h3>
          <p class="service-desc">${s.desc}</p>
        </div>
      `).join('');
    }

    const faqContainer = document.getElementById('faqAccordion');
    if (faqContainer) {
      const faqs = this.store.getFaqs();
      faqContainer.innerHTML = faqs.map((f, i) => {
        const faqId = `faq-${i}`;
        const isActive = i === 0;
        return `
        <div class="faq-item ${isActive ? 'active' : ''}">
          <button class="faq-question" aria-expanded="${isActive}" aria-controls="${faqId}">
            <span>${escapeHtml(f.q)}</span>
            <i class="fas fa-chevron-down" aria-hidden="true"></i>
          </button>
          <div class="faq-answer" id="faqId" role="region"><p>${escapeHtml(f.a)}</p></div>
        </div>
      `;
      }).join('');

      faqContainer.querySelectorAll('.faq-question').forEach(btn => {
        btn.addEventListener('click', () => {
          const item = btn.parentElement;
          const isActive = item.classList.contains('active');
          faqContainer.querySelectorAll('.faq-item').forEach(el => {
            el.classList.remove('active');
            el.querySelector('.faq-question')?.setAttribute('aria-expanded', 'false');
          });
          if (!isActive) {
            item.classList.add('active');
            btn.setAttribute('aria-expanded', 'true');
          }
        });
      });
    }
  }

  /* ════════════════════════════════════════════════════════════════════
     MEMBERSHIP CARD RENDERER
     ════════════════════════════════════════════════════════════════════ */

  async renderMembershipCard() {
    const container = document.getElementById('membershipCardContainer');
    if (!container) return;

    const session = this.store.getApplicantSession();
    if (!session || !session.email) {
      container.innerHTML = `
        <div style="text-align: center; padding: 60px 20px; background: var(--white); border: var(--rule);">
          <i class="fas fa-id-card" style="font-size: 48px; color: var(--gray-300); margin-bottom: 16px;"></i>
          <p style="color: var(--gray-500); font-size: 14px;">Sign in to view your membership card</p>
          <button class="btn-primary" style="margin-top: 16px;" data-view-nav="membership">
            <i class="fas fa-sign-in-alt"></i> Sign In
          </button>
        </div>`;
      return;
    }

    try {
      const app = await this.store.getApplicationByEmail(session.email);
      if (!app || app.status !== 'Approved') {
        container.innerHTML = `
          <div style="text-align: center; padding: 60px 20px; background: var(--white); border: var(--rule);">
            <i class="fas fa-clock" style="font-size: 48px; color: var(--warning); margin-bottom: 16px;"></i>
            <p style="color: var(--gray-600); font-size: 16px; font-weight: 600; margin-bottom: 8px;">Membership Pending Approval</p>
            <p style="color: var(--gray-500); font-size: 14px;">Your membership card will be available once your application is approved.</p>
          </div>`;
        return;
      }

      const validity = this.store.getMembershipValidity(app);
      const validityClass = validity.state === 'ACTIVE' ? 'active' : validity.state === 'RENEWAL_DUE' ? 'expiring' : 'expired';
      const validityText = validity.state === 'ACTIVE' ? `VALID TILL ${validity.validUntilDate.toUpperCase()}` : validity.state === 'RENEWAL_DUE' ? `EXPIRES IN ${validity.daysRemaining} DAYS` : 'EXPIRED';

      container.innerHTML = `
        <div class="bcci-membership-card-wrapper">
          <div class="bcci-membership-card">
            <div class="bcci-card-hologram"></div>
            <div class="bcci-card-pattern"></div>
            <div class="bcci-card-border"></div>
            <div class="bcci-card-premium-badge">MEMBER</div>
            
            <div class="bcci-card-content">
              <div class="bcci-card-header">
                <div class="bcci-card-logo-section">
                  <div class="bcci-card-logo">
                    <img src="assets/BCCIBHARUCH.webp" alt="BCCI" />
                  </div>
                  <div class="bcci-card-org">
                    <div class="bcci-card-org-name">Bharuch Chamber</div>
                    <div class="bcci-card-org-sub">of Commerce & Industry</div>
                  </div>
                </div>
                <div class="bcci-card-type">
                  <div class="bcci-card-type-label">Membership</div>
                  <div class="bcci-card-type-value">${escapeHtml(app.enterpriseType || 'Corporate')}</div>
                </div>
              </div>

              <div class="bcci-card-middle">
                <div class="bcci-card-member-info">
                  <div class="bcci-card-member-label">Cardholder</div>
                  <div class="bcci-card-member-name">${escapeHtml(app.repName || 'Member')}</div>
                  <div class="bcci-card-member-company">${escapeHtml(app.company || 'BCCI Member')}</div>
                </div>
                <div class="bcci-card-qr" id="cardQRCode"></div>
              </div>

              <div class="bcci-card-microprint"></div>

              <div class="bcci-card-footer">
                <div class="bcci-card-details">
                  <div class="bcci-card-detail">
                    <div class="bcci-card-detail-label">Member ID</div>
                    <div class="bcci-card-detail-value">${escapeHtml(app.id)}</div>
                  </div>
                  <div class="bcci-card-detail">
                    <div class="bcci-card-detail-label">Since</div>
                    <div class="bcci-card-detail-value">${escapeHtml(validity.approvedDate)}</div>
                  </div>
                </div>
                <div class="bcci-card-validity">
                  <div class="bcci-card-validity-label">Status</div>
                  <div class="bcci-card-validity-value ${validityClass}">${validityText}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="bcci-card-actions">
          <button class="bcci-card-action-btn primary" id="downloadCardBtn">
            <i class="fas fa-download"></i> Download Card
          </button>
          <button class="bcci-card-action-btn secondary" id="printCardBtn">
            <i class="fas fa-print"></i> Print Card
          </button>
          <button class="bcci-card-action-btn secondary" id="shareCardBtn">
            <i class="fas fa-share-alt"></i> Share
          </button>
        </div>

        <div class="bcci-card-benefits">
          <div class="bcci-card-benefits-title">
            <i class="fas fa-star" style="color: #d4af37;"></i>
            Member Benefits
          </div>
          <div class="bcci-card-benefits-grid">
            <div class="bcci-card-benefit">
              <i class="fas fa-certificate"></i>
              <span>Certificate of Origin</span>
            </div>
            <div class="bcci-card-benefit">
              <i class="fas fa-globe-asia"></i>
              <span>Trade Facilitation</span>
            </div>
            <div class="bcci-card-benefit">
              <i class="fas fa-passport"></i>
              <span>Visa Recommendations</span>
            </div>
            <div class="bcci-card-benefit">
              <i class="fas fa-file-signature"></i>
              <span>Document Attestation</span>
            </div>
            <div class="bcci-card-benefit">
              <i class="fas fa-briefcase"></i>
              <span>Policy Advisory</span>
            </div>
            <div class="bcci-card-benefit">
              <i class="fas fa-chalkboard-teacher"></i>
              <span>Training & Workshops</span>
            </div>
          </div>
        </div>`;

      // Store card data for download
      this.currentCardId = app.id;
      this.currentCardName = app.repName || 'Member';
      this.currentCardCompany = app.company || 'BCCI Member';

      // Generate QR code
      this.generateCardQR(app.id, app.repName, app.company);

      // Bind action buttons
      setTimeout(() => {
        document.getElementById('downloadCardBtn')?.addEventListener('click', () => this.downloadCardAsImage());
        document.getElementById('printCardBtn')?.addEventListener('click', () => window.print());
        document.getElementById('shareCardBtn')?.addEventListener('click', () => {
          if (navigator.share) {
            navigator.share({
              title: 'BCCI Membership Card',
              text: `Official BCCI Membership Card - ${app.repName}`,
              url: window.location.href
            });
          } else {
            navigator.clipboard?.writeText(window.location.href);
            this.showToast('Link copied to clipboard!', 'success');
          }
        });
      }, 100);

    } catch (err) {
      console.error('[Card] Failed to render:', err);
      container.innerHTML = `
        <div style="text-align: center; padding: 60px 20px; background: var(--white); border: var(--rule);">
          <i class="fas fa-exclamation-triangle" style="font-size: 48px; color: var(--danger); margin-bottom: 16px;"></i>
          <p style="color: var(--gray-600); font-size: 14px;">Failed to load membership card</p>
          <button class="btn-primary" style="margin-top: 16px;" onclick="location.reload()">
            <i class="fas fa-redo"></i> Retry
          </button>
        </div>`;
    }
  }

  generateCardQR(memberId, name, company) {
    const qrContainer = document.getElementById('cardQRCode');
    if (!qrContainer) return;

    // Clear previous QR
    qrContainer.innerHTML = '';

    // Generate QR code data
    const qrData = JSON.stringify({
      id: memberId,
      name: name,
      org: company,
      type: 'BCCI_MEMBER',
      verify: `https://bccibharuch.in/verify/${memberId}`
    });

    // Use QRCode.js library if available
    if (typeof QRCode !== 'undefined') {
      new QRCode(qrContainer, {
        text: qrData,
        width: 62,
        height: 62,
        colorDark: '#0a1628',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.H
      });
    } else {
      // Fallback: simple canvas pattern
      const canvas = document.createElement('canvas');
      canvas.width = 62;
      canvas.height = 62;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 62, 62);
      ctx.fillStyle = '#0a1628';
      
      // Generate deterministic pattern
      let hash = 0;
      for (let i = 0; i < memberId.length; i++) {
        hash = ((hash << 5) - hash) + memberId.charCodeAt(i);
        hash = hash & hash;
      }
      
      for (let y = 0; y < 15; y++) {
        for (let x = 0; x < 15; x++) {
          if ((hash >> ((y * 15 + x) % 32)) & 1) {
            ctx.fillRect(x * 4, y * 4, 4, 4);
          }
        }
      }
      qrContainer.appendChild(canvas);
    }
  }

  async downloadCardAsImage() {
    const card = document.querySelector('.bcci-membership-card');
    if (!card) return;

    try {
      // Create a canvas to render the card
      const canvas = document.createElement('canvas');
      const scale = 2; // High resolution
      canvas.width = 420 * scale;
      canvas.height = 265 * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);

      // Draw background
      const gradient = ctx.createLinearGradient(0, 0, 420, 265);
      gradient.addColorStop(0, '#0a1628');
      gradient.addColorStop(0.3, '#1a2d4a');
      gradient.addColorStop(0.7, '#0d1f3c');
      gradient.addColorStop(1, '#0a1628');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 420, 265);

      // Draw border
      ctx.strokeStyle = '#d4af37';
      ctx.lineWidth = 3;
      ctx.strokeRect(2, 2, 416, 261);

      // Draw text
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 12px Inter, sans-serif';
      ctx.fillText('BHARUCH CHAMBER OF COMMERCE & INDUSTRY', 80, 40);

      ctx.fillStyle = '#d4af37';
      ctx.font = 'bold 18px Inter, sans-serif';
      ctx.fillText(this.currentCardName || 'MEMBER', 30, 150);

      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.font = '11px Inter, sans-serif';
      ctx.fillText(this.currentCardCompany || '', 30, 170);

      ctx.fillStyle = '#d4af37';
      ctx.font = '10px JetBrains Mono, monospace';
      ctx.fillText(`ID: ${this.currentCardId || ''}`, 30, 230);

      // Create download link
      const link = document.createElement('a');
      link.download = `BCCI_Membership_${this.currentCardId || 'Card'}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();

      this.showToast('Card downloaded successfully!', 'success');
    } catch (err) {
      console.error('[Card] Download failed:', err);
      this.showToast('Failed to download card. Try printing instead.', 'error');
    }
  }

  /* ════════════════════════════════════════════════════════════════════
     FILE UPLOAD HANDLERS
     ════════════════════════════════════════════════════════════════════ */

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
      if (file.size > 10 * 1024 * 1024) {
        this.showToast('File size exceeds 10MB limit.', 'warning');
        return;
      }

      this.currentPaymentProofFile = file;

      const reader = new FileReader();
      reader.onload = (e) => {
        const rawBase64 = e.target.result;
        const img = new Image();
        img.onload = () => {
          const maxDim = 1200;
          let w = img.width, h = img.height;
          if (w > maxDim || h > maxDim) {
            if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
            else { w = Math.round((w * maxDim) / h); h = maxDim; }
          }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          this.currentPaymentProofBase64 = canvas.toDataURL('image/jpeg', 0.82);
          imgEl.src = this.currentPaymentProofBase64;
          imgEl.setAttribute('data-lightbox', 'true');
          fileNameEl.textContent = file.name;
          preview.style.display = 'block';
          placeholder.style.display = 'none';
          if (dropzone) { dropzone.classList.remove('is-invalid'); dropzone.classList.add('is-valid'); }
        };
        img.onerror = () => {
          this.currentPaymentProofBase64 = rawBase64;
          imgEl.src = rawBase64;
          fileNameEl.textContent = file.name;
          preview.style.display = 'block';
          placeholder.style.display = 'none';
        };
        img.src = rawBase64;
      };
      reader.readAsDataURL(file);
    };

    fileInput.addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) handleFile(e.target.files[0]);
    });

    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        fileInput.value = '';
        this.currentPaymentProofBase64 = null;
        this.currentPaymentProofFile = null;
        imgEl.src = ''; fileNameEl.textContent = '';
        preview.style.display = 'none'; placeholder.style.display = 'block';
        if (dropzone) dropzone.classList.remove('is-valid', 'is-invalid');
      });
    }

    if (dropzone) {
      // Click to open file picker
      dropzone.addEventListener('click', (e) => {
        // Don't trigger if clicking on the remove button or inside preview
        if (e.target.closest('#removePaymentProofBtn') || e.target.closest('#paymentProofPreview')) return;
        fileInput.click();
      });

      ['dragenter', 'dragover'].forEach(ev => {
        dropzone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.add('dragover'); }, false);
      });
      ['dragleave', 'drop'].forEach(ev => {
        dropzone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); dropzone.classList.remove('dragover'); }, false);
      });
      dropzone.addEventListener('drop', (e) => {
        const files = e.dataTransfer?.files;
        if (files && files[0]) {
          try { fileInput.files = files; } catch {}
          handleFile(files[0]);
        }
      });
    }
  }

  /* ════════════════════════════════════════════════════════════════════
     FORM VALIDATION
     ════════════════════════════════════════════════════════════════════ */

  setupFormValidation() {
    const forms = [document.getElementById('membershipForm'), document.getElementById('enquiryForm')];

    forms.forEach(form => {
      if (!form) return;

      const phoneInput = form.querySelector('input[name="phone"]');
      const panInput = form.querySelector('input[name="panNo"]');
      const gstInput = form.querySelector('input[name="gstNo"]');
      const cinInput = form.querySelector('input[name="cin"]');
      const pincodeInput = form.querySelector('input[name="pincode"]');

      if (phoneInput) {
        phoneInput.addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 10); this.validateField(phoneInput); });
        phoneInput.addEventListener('blur', () => this.validateField(phoneInput));
      }
      if (panInput) {
        panInput.addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10); this.validateField(panInput); });
        panInput.addEventListener('blur', () => this.validateField(panInput));
      }
      if (gstInput) {
        gstInput.addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15); this.validateField(gstInput); });
        gstInput.addEventListener('blur', () => this.validateField(gstInput));
      }
      if (cinInput) {
        cinInput.addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 21); this.validateField(cinInput); });
        cinInput.addEventListener('blur', () => this.validateField(cinInput));
      }
      if (pincodeInput) {
        pincodeInput.addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); this.validateField(pincodeInput); });
        pincodeInput.addEventListener('blur', () => this.validateField(pincodeInput));
      }

      form.querySelectorAll('input, select, textarea').forEach(input => {
        if (!['phone', 'panNo', 'gstNo', 'cin', 'pincode'].includes(input.name)) {
          input.addEventListener('blur', () => this.validateField(input));
          input.addEventListener('input', () => { if (input.classList.contains('is-invalid')) this.validateField(input); });
        }
      });
    });
  }

  validateField(input) {
    if (!input) return true;
    const name = input.name;
    const val = (input.value || '').trim();
    let isValid = true;
    let errorMsg = '';

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
        errorMsg = 'Please upload a screenshot of your payment confirmation.';
      }
      const dropzone = document.getElementById('paymentProofDropzone');
      if (dropzone) {
        dropzone.classList.toggle('is-invalid', !isValid);
        dropzone.classList.toggle('is-valid', isValid && !!this.currentPaymentProofBase64);
      }
    } else if (input.hasAttribute('required') && !val) {
      isValid = false; errorMsg = 'This field is required.';
    } else if (val) {
      switch (name) {
        case 'phone':
          if (!/^[6-9]\d{9}$/.test(val.replace(/\D/g, '').slice(-10))) { isValid = false; errorMsg = 'Enter a valid 10-digit mobile number (6-9).'; }
          break;
        case 'panNo':
          if (!/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(val.toUpperCase())) { isValid = false; errorMsg = 'Invalid PAN (e.g. ABCDE1234F).'; }
          break;
        case 'gstNo':
          if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}[Zz][0-9A-Z]{1}$/.test(val.toUpperCase())) { isValid = false; errorMsg = 'Invalid GSTIN (15 chars).'; }
          break;
        case 'pincode':
          if (!/^[1-9][0-9]{5}$/.test(val)) { isValid = false; errorMsg = 'Invalid 6-digit pincode.'; }
          break;
        case 'cin':
          if (val.length > 0 && !/^[LU][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/.test(val.toUpperCase())) { isValid = false; errorMsg = 'Invalid CIN (21 chars).'; }
          break;
        case 'email':
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) { isValid = false; errorMsg = 'Invalid email address.'; }
          break;
        case 'company': case 'repName': case 'name': case 'repDesignation': case 'address': case 'message':
          if (val.length < 2) { isValid = false; errorMsg = 'Must be at least 2 characters.'; }
          break;
        case 'employees':
          if (parseInt(val, 10) < 1) { isValid = false; errorMsg = 'Must be at least 1.'; }
          break;
        case 'paymentRef':
          if (val.length > 0 && val.length < 6) { isValid = false; errorMsg = 'UTR must be at least 6 characters.'; }
          break;
      }
    }

    if (!isValid) {
      if (name !== 'paymentProof') { input.classList.add('is-invalid'); input.classList.remove('is-valid'); }
      errorDiv.textContent = errorMsg;
      errorDiv.style.display = 'flex';
    } else {
      if (name !== 'paymentProof') {
        input.classList.remove('is-invalid');
        input.classList.toggle('is-valid', !!val);
      }
      errorDiv.textContent = '';
      errorDiv.style.display = 'none';
    }

    return isValid;
  }

  /* ════════════════════════════════════════════════════════════════════
     EMAIL DISPATCH — Via Vercel Serverless API
     ════════════════════════════════════════════════════════════════════ */

  /* ════════════════════════════════════════════════════════════════════
     FORM HANDLERS — Membership & Enquiry Submission
     ════════════════════════════════════════════════════════════════════ */

  setupFormHandlers() {
    // ── Membership Form ──────────────────────────────────────────────
    const membershipForm = document.getElementById('membershipForm');
    if (membershipForm) {
      membershipForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        // Check if user is authenticated before allowing submission
        const session = this.store.getApplicantSession();
        if (!session || !session.email) {
          this.showToast('Please sign in with your email to submit the application.', 'warning');
          const authGate = document.getElementById('applicantAuthGate');
          if (authGate) authGate.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return;
        }

        let firstInvalidInput = null;
        let isFormValid = true;
        membershipForm.querySelectorAll('input, select, textarea').forEach(input => {
          const isFieldValid = this.validateField(input);
          if (!isFieldValid && !firstInvalidInput) { firstInvalidInput = input; isFormValid = false; }
        });

        if (!isFormValid) {
          if (firstInvalidInput) { firstInvalidInput.focus(); firstInvalidInput.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
          this.showToast('Please fix the highlighted errors before submitting.', 'warning');
          return;
        }

        const submitBtn = membershipForm.querySelector('button[type="submit"]');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting…'; }

        try {
          const formData = new FormData(membershipForm);
          const data = Object.fromEntries(formData.entries());
          data.paymentProof = this.currentPaymentProofBase64 || '';

          const newApp = await this.store.addApplication(data);

          // ── Send Emails via Unified Email API ──────────────────────
          const emailDate = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

          // 1. User receives: "Application Submitted" confirmation
          if (newApp.email) {
            this.store.sendEmail('application_submitted', newApp.email, {
              appId: newApp.id,
              company: newApp.company,
              repName: newApp.repName,
              sector: newApp.businessServices,
              date: emailDate,
            }).catch(err => console.warn('[Email] application_submitted failed:', err));
          }

          // 2. Admin receives: "New Application" alert with full details
          this.store.sendEmail('admin_new_application', CONFIG.ADMIN_EMAIL, {
            appId: newApp.id,
            company: newApp.company,
            repName: newApp.repName,
            repDesignation: newApp.repDesignation,
            email: newApp.email,
            phone: newApp.phone,
            sector: newApp.businessServices,
            enterpriseType: newApp.enterpriseType,
            legalStatus: newApp.legalStatus,
            gstNo: newApp.gstNo,
            panNo: newApp.panNo,
            paymentRef: newApp.paymentRef,
            date: emailDate,
          }).catch(err => console.warn('[Email] admin_new_application failed:', err));

          // Reset form
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
            const errDiv = input.closest('.form-group')?.querySelector('.error-msg');
            if (errDiv) errDiv.style.display = 'none';
          });

          const applicantEmailDisplay = newApp.email ? `<strong>${newApp.email}</strong>` : 'your registered email';
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
                  A confirmation email has been sent to ${applicantEmailDisplay}.
                </p>
                <button class="btn-primary" id="modalCloseBtn" style="width: 100%; justify-content: center; padding: 0.75rem 1.5rem; font-weight: 600;">Done</button>
              </div>
            `
          });
        } catch (err) {
          console.error('[Membership Submit Error]', err);
          this.showToast(err.message || 'Submission failed. Please try again.', 'error');
        } finally {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Application for Admin Approval'; }
        }
      });
    }

    // ── Enquiry Form ─────────────────────────────────────────────────
    const enquiryForm = document.getElementById('enquiryForm');
    if (enquiryForm) {
      enquiryForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        let firstInvalidInput = null;
        let isFormValid = true;
        enquiryForm.querySelectorAll('input, select, textarea').forEach(input => {
          const isFieldValid = this.validateField(input);
          if (!isFieldValid && !firstInvalidInput) { firstInvalidInput = input; isFormValid = false; }
        });

        if (!isFormValid) {
          if (firstInvalidInput) { firstInvalidInput.focus(); firstInvalidInput.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
          this.showToast('Please fix the highlighted errors before submitting.', 'warning');
          return;
        }

        const submitBtn = enquiryForm.querySelector('button[type="submit"]');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting…'; }

        try {
          const formData = new FormData(enquiryForm);
          const data = Object.fromEntries(formData.entries());
          const newEnq = await this.store.addEnquiry(data);

          // Notify admin via Vercel API
          this.store.sendEmail('admin_new_application', CONFIG.ADMIN_EMAIL, {
            appId: newEnq.id,
            company: data.company || 'N/A',
            repName: data.name,
            repDesignation: 'Enquiry Sender',
            email: data.email,
            phone: data.phone,
            sector: data.subject || 'General Enquiry',
            enterpriseType: 'N/A',
            legalStatus: 'N/A',
            gstNo: 'N/A',
            panNo: 'N/A',
            paymentRef: '',
            date: new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
          }).catch(err => console.warn('[Email] enquiry notification failed:', err));

          enquiryForm.reset();
          enquiryForm.querySelectorAll('input, select, textarea').forEach(input => {
            input.classList.remove('is-valid', 'is-invalid');
            const errDiv = input.closest('.form-group')?.querySelector('.error-msg');
            if (errDiv) errDiv.style.display = 'none';
          });

          this.showModal({
            title: 'Enquiry Received',
            content: `
              <div style="text-align: center; padding: 1rem 0;">
                <i class="fas fa-check-circle" style="font-size: 3.5rem; color: #10B981; margin-bottom: 1.25rem;"></i>
                <h3 style="margin-bottom: 0.8rem; color: var(--primary);">Thank You for Contacting BCCI</h3>
                <p style="color: #64748B; margin-bottom: 1.5rem; font-size: 0.95rem; line-height: 1.6;">
                  Your enquiry (Ref: <strong style="color: var(--primary); font-family: monospace;">${newEnq.id}</strong>) has been received. We'll respond at <strong>${data.email || 'your email'}</strong> within 24 hours.
                </p>
                <button class="btn-primary" id="modalCloseBtn" style="width: 100%; justify-content: center; font-weight: 600; padding: 0.75rem 1.5rem;">Done</button>
              </div>
            `
          });
        } catch (err) {
          console.error('[Enquiry Submit Error]', err);
          this.showToast(err.message || 'Submission failed. Please try again.', 'error');
        } finally {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit Enquiry'; }
        }
      });
    }

    // ── Admin Login Form ─────────────────────────────────────────────
    const pageAdminLoginForm = document.getElementById('pageAdminLoginForm');
    if (pageAdminLoginForm) {
      pageAdminLoginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = document.getElementById('pageAdminUser').value.trim();
        const pass = document.getElementById('pageAdminPass').value.trim();
        const submitBtn = pageAdminLoginForm.querySelector('button[type="submit"]');

        if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Authenticating…'; }

        try {
          const result = await this.store.setAdminAuth(user, pass);
          if (result.success) {
            this.adminAuthed = true;
            pageAdminLoginForm.reset();
            this.updateNavAuthUI();
            this.showToast('Admin authenticated successfully!', 'success');
            this.renderView('admin');
          } else {
            this.showToast(result.error || 'Invalid credentials.', 'warning');
          }
        } catch (err) {
          this.showToast('Authentication failed. Please try again.', 'error');
        } finally {
          if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i> Sign In to Admin Portal'; }
        }
      });
    }
  }

  /* ════════════════════════════════════════════════════════════════════
     ADMIN PORTAL — Server-backed data
     ════════════════════════════════════════════════════════════════════ */

  async renderAdminPortal() {
    const [apps, enquiries] = await Promise.all([
      this.store.getApplications(),
      this.store.getEnquiries()
    ]);

    const pendingApps = apps.filter(a => a.status === 'Pending');
    const approvedApps = apps.filter(a => a.status === 'Approved');
    const rejectedApps = apps.filter(a => a.status === 'Rejected');

    document.getElementById('metricTotal').textContent = apps.length;
    document.getElementById('metricPending').textContent = pendingApps.length;
    document.getElementById('metricApproved').textContent = approvedApps.length;
    document.getElementById('metricRejected').textContent = rejectedApps.length;

    // Render Pending Applications
    const pendingTableBody = document.getElementById('pendingAppsBody');
    const pendingCards = document.getElementById('pendingAppsCards');

    if (pendingApps.length === 0) {
      const emptyHtml = `<div style="text-align: center; color: #94A3B8; padding: 2rem;"><i class="fas fa-check-double" style="font-size: 1.8rem; margin-bottom: 0.5rem; display: block;"></i>No pending applications.</div>`;
      if (pendingTableBody) pendingTableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #94A3B8; padding: 2rem;">${emptyHtml}</td></tr>`;
      if (pendingCards) pendingCards.innerHTML = emptyHtml;
    } else {
      if (pendingTableBody) {
        pendingTableBody.innerHTML = pendingApps.map(app => `
          <tr>
            <td><strong>${app.id}</strong></td>
            <td><div style="font-weight: 600;">${app.company}</div><small style="color: #94A3B8;">${app.legalStatus} • ${app.enterpriseType}</small></td>
            <td>${app.repName}<br/><small style="color: #94A3B8;">${app.repDesignation || 'Applicant'}</small></td>
            <td>${app.businessServices}</td>
            <td><span class="badge-status badge-pending"><i class="fas fa-clock"></i> Pending</span></td>
            <td>${new Date(app.submittedAt).toLocaleDateString()}</td>
            <td>
              <div style="display: flex; gap: 0.4rem;">
                <button class="btn-action-approve" data-approve-id="${app.id}"><i class="fas fa-check"></i> Approve</button>
                <button class="btn-action-reject" data-reject-id="${app.id}"><i class="fas fa-times"></i> Reject</button>
                <button class="btn-secondary" data-inspect-id="${app.id}" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;"><i class="fas fa-eye"></i></button>
              </div>
            </td>
          </tr>
        `).join('');
      }
      if (pendingCards) {
        pendingCards.innerHTML = pendingApps.map(app => `
          <div class="admin-mobile-card">
            <div class="admin-card-header">
              <div><div class="admin-card-company">${app.company}</div><small style="color: #64748B;">${app.legalStatus} • ${app.enterpriseType}</small></div>
              <span class="admin-card-id">${app.id}</span>
            </div>
            <div class="admin-card-meta">
              <div><strong>Rep:</strong> ${app.repName}</div>
              <div><strong>Sector:</strong> ${app.businessServices}</div>
              <div><strong>Status:</strong> <span class="badge-status badge-pending"><i class="fas fa-clock"></i> Pending</span></div>
              <div><strong>Date:</strong> ${new Date(app.submittedAt).toLocaleDateString()}</div>
            </div>
            <div class="admin-card-actions">
              <button class="btn-action-approve" data-approve-id="${app.id}"><i class="fas fa-check"></i> Approve</button>
              <button class="btn-action-reject" data-reject-id="${app.id}"><i class="fas fa-times"></i> Reject</button>
              <button class="btn-secondary" data-inspect-id="${app.id}"><i class="fas fa-eye"></i> Inspect</button>
            </div>
          </div>
        `).join('');
      }
    }

    // Render Approved Members
    const approvedTableBody = document.getElementById('approvedAppsBody');
    const approvedCards = document.getElementById('approvedAppsCards');

    if (approvedApps.length === 0) {
      const emptyHtml = `<div style="text-align: center; color: #94A3B8; padding: 2rem;">No approved members yet.</div>`;
      if (approvedTableBody) approvedTableBody.innerHTML = `<tr><td colspan="6" style="text-align: center; padding: 2rem; color: #94A3B8;">No approved members yet.</td></tr>`;
      if (approvedCards) approvedCards.innerHTML = emptyHtml;
    } else {
      if (approvedTableBody) {
        approvedTableBody.innerHTML = approvedApps.map(app => `
          <tr>
            <td><strong>${app.id}</strong></td>
            <td><strong style="color: var(--primary);">${app.company}</strong></td>
            <td>${app.repName}</td>
            <td>${app.email}</td>
            <td><span class="badge-status badge-approved"><i class="fas fa-check-circle"></i> Active</span></td>
            <td>${app.approvedAt ? new Date(app.approvedAt).toLocaleDateString() : 'Active'}</td>
          </tr>
        `).join('');
      }
      if (approvedCards) {
        approvedCards.innerHTML = approvedApps.map(app => `
          <div class="admin-mobile-card">
            <div class="admin-card-header">
              <div><div class="admin-card-company">${app.company}</div><small style="color: #64748B;">${app.email}</small></div>
              <span class="admin-card-id">${app.id}</span>
            </div>
            <div class="admin-card-meta">
              <div><strong>Rep:</strong> ${app.repName}</div>
              <div><strong>Status:</strong> <span class="badge-status badge-approved"><i class="fas fa-check-circle"></i> Active</span></div>
            </div>
          </div>
        `).join('');
      }
    }

    // Render Enquiries
    const enquiriesTableBody = document.getElementById('enquiriesBody');
    const enquiriesCards = document.getElementById('enquiriesCards');

    if (enquiries.length === 0) {
      const emptyHtml = `<div style="text-align: center; color: #94A3B8; padding: 2rem;">No enquiries yet.</div>`;
      if (enquiriesTableBody) enquiriesTableBody.innerHTML = `<tr><td colspan="5" style="text-align: center; padding: 2rem; color: #94A3B8;">No enquiries yet.</td></tr>`;
      if (enquiriesCards) enquiriesCards.innerHTML = emptyHtml;
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
              <div><div class="admin-card-company">${enq.subject}</div><small style="color: #64748B;">From: ${enq.name}</small></div>
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

    this.bindAdminActions();
  }

  async handleApproveApplication(id) {
    try {
      const updated = await this.store.updateApplicationStatus(id, 'Approved');
      if (!updated) return;

      // ── Send Approval Email via Unified API ────────────────────────
      const validity = this.store.getMembershipValidity(updated);
      this.store.sendEmail('application_approved', updated.email, {
        appId: updated.id,
        company: updated.company,
        repName: updated.repName,
        validUntil: validity ? validity.validUntilDate : 'Active',
      }).catch(err => console.warn('[Email] application_approved failed:', err));

      await this.renderAdminPortal();
      this.showToast(`Application ${id} approved! Confirmation email sent to ${updated.email}.`, 'success');

      this.showModal({
        title: `<i class="fas fa-envelope-open-text" style="color: #10B981;"></i> Membership Approved & Confirmation Email Sent`,
        content: `
          <div style="font-size: 0.9rem; line-height: 1.6;">
            <div style="background: #ECFDF5; border: 1px solid #A7F3D0; padding: 1rem; border-radius: 8px; margin-bottom: 1.25rem; color: #065F46;">
              <div style="font-weight: 700; font-size: 1rem; margin-bottom: 0.25rem;"><i class="fas fa-check-circle"></i> Application ${updated.id} Approved</div>
              <div>Confirmation email with digital membership card sent to <strong>${updated.email}</strong>.</div>
            </div>
            <div style="background: #EFF6FF; border: 1px solid #BFDBFE; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; font-size: 0.85rem; color: #1E3E62;">
              <strong>Email dispatched:</strong> application_approved notification with membership validity details.
            </div>
            <button class="btn-secondary" id="modalCloseBtn" style="width: 100%; justify-content: center;">Close</button>
          </div>
        `
      });
    } catch (err) {
      this.showToast('Failed to approve application. Please try again.', 'error');
    }
  }

  async handleRejectApplication(id) {
    const app = await this.store.getApplicationById(id);
    if (!app) return;

    this.showModal({
      title: `<i class="fas fa-times-circle" style="color: #EF4444;"></i> Reject Application: ${app.company}`,
      content: `
        <div style="padding: 0.5rem 0;">
          <div style="background: #FEF2F2; border: 1px solid #FECACA; padding: 1rem; border-radius: 8px; margin-bottom: 1.25rem; font-size: 0.9rem; color: #991B1B;">
            <strong>Applicant:</strong> ${app.repName} (${app.email})<br>
            <strong>Company:</strong> ${app.company} (${app.id})
          </div>
          <div class="form-group" style="margin-bottom: 1.25rem;">
            <label class="form-label">Rejection Reason (optional)</label>
            <textarea id="rejectionReasonInput" class="form-control" rows="3" placeholder="e.g. Incomplete documentation, invalid GSTIN, payment not verified..."></textarea>
          </div>
          <div style="display: flex; gap: 0.75rem;">
            <button type="button" class="btn-secondary" id="modalCloseBtn" style="flex: 1; justify-content: center;">Cancel</button>
            <button type="button" class="btn-primary" id="confirmRejectBtn" style="flex: 1; justify-content: center; background: #DC2626; border-color: #B91C1C;">
              <i class="fas fa-times"></i> Confirm Rejection
            </button>
          </div>
        </div>
      `
    });

    setTimeout(() => {
      document.getElementById('confirmRejectBtn')?.addEventListener('click', async () => {
        const reason = document.getElementById('rejectionReasonInput')?.value?.trim() || '';
        this.closeModal();
        try {
          const updated = await this.store.updateApplicationStatus(id, 'Rejected');
          if (!updated) return;
          this.store.sendEmail('application_declined', updated.email, {
            appId: updated.id,
            company: updated.company,
            repName: updated.repName,
            reason,
          }).catch(err => console.warn('[Email] application_declined failed:', err));
          await this.renderAdminPortal();
          this.showToast(`Application ${id} rejected. Notification email sent to ${updated.email}.`, 'warning');
        } catch (err) {
          this.showToast('Failed to reject application. Please try again.', 'error');
        }
      });
    }, 100);
  }

  bindAdminActions() {
    document.querySelectorAll('[data-approve-id]').forEach(btn => {
      btn.addEventListener('click', () => this.handleApproveApplication(btn.getAttribute('data-approve-id')));
    });

    document.querySelectorAll('[data-reject-id]').forEach(btn => {
      btn.addEventListener('click', () => this.handleRejectApplication(btn.getAttribute('data-reject-id')));
    });

    document.querySelectorAll('[data-inspect-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-inspect-id');
        const app = await this.store.getApplicationById(id);
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
                  <div><strong>GST:</strong> ${app.gstNo || 'N/A'}</div>
                  <div><strong>PAN:</strong> ${app.panNo || 'N/A'}</div>
                  <div><strong>Turnover:</strong> ${app.annualTurnover || 'N/A'}</div>
                  <div><strong>Employees:</strong> ${app.employees || 'N/A'}</div>
                  <div><strong>Contact:</strong> ${app.repName}</div>
                  <div><strong>Phone:</strong> ${app.phone || 'N/A'}</div>
                  ${app.paymentRef ? `<div style="grid-column: 1 / -1; background: #EFF6FF; border: 1px solid #BFDBFE; padding: 0.5rem 0.8rem; border-radius: 6px; color: #1E3E62;"><strong>UPI UTR:</strong> <code style="font-weight:700; color:#0284C7;">${app.paymentRef}</code></div>` : ''}
                  ${app.paymentProof ? `
                    <div style="grid-column: 1 / -1; margin-top: 0.5rem; background: #F8FAFC; border: 1px solid #CBD5E1; padding: 1rem; border-radius: 8px;">
                      <strong style="color: var(--primary); display: block; margin-bottom: 0.5rem;"><i class="fas fa-file-invoice-dollar" style="color: var(--accent-gold-dark);"></i> Payment Receipt:</strong>
                      <img src="${app.paymentProof}" alt="Payment Receipt" data-lightbox style="max-height: 220px; border-radius: 6px; border: 1px solid #CBD5E1; cursor: pointer;" />
                    </div>
                  ` : ''}
                </div>
                <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1.5rem;">
                  ${app.status === 'Pending' ? `
                    <button class="btn-action-approve" id="inspectApproveBtn"><i class="fas fa-check"></i> Approve</button>
                    <button class="btn-action-reject" id="inspectRejectBtn"><i class="fas fa-times"></i> Reject</button>
                  ` : ''}
                  <button class="btn-secondary" id="modalCloseBtn">Close</button>
                </div>
              </div>
            `
          });

          const approveBtn = document.getElementById('inspectApproveBtn');
          if (approveBtn) approveBtn.addEventListener('click', () => { this.closeModal(); this.handleApproveApplication(app.id); });
          const rejectBtn = document.getElementById('inspectRejectBtn');
          if (rejectBtn) rejectBtn.addEventListener('click', () => { this.closeModal(); this.handleRejectApplication(app.id); });
        }
      });
    });

    const exportBtn = document.getElementById('btnExportCSV');
    if (exportBtn) exportBtn.addEventListener('click', () => this.exportApplicationsCSV());

    document.querySelectorAll('.admin-menu-item').forEach(item => {
      item.onclick = () => {
        const tab = item.getAttribute('data-tab');
        document.querySelectorAll('.admin-menu-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        document.querySelectorAll('.admin-tab-pane').forEach(pane => pane.style.display = 'none');
        const targetPane = document.getElementById(`tab-${tab}`);
        if (targetPane) targetPane.style.display = 'block';
      };
    });
  }

  async exportApplicationsCSV() {
    const apps = await this.store.getApplications();
    if (!apps || apps.length === 0) {
      this.showToast('No records to export.', 'warning');
      return;
    }

    const headers = [
      'Application ID', 'Company Name', 'Legal Status', 'Enterprise Scale', 'Business Services',
      'GSTIN', 'PAN', 'CIN', 'Turnover', 'Employees', 'Representative Name', 'Designation',
      'Email', 'Mobile Number', 'District', 'Address', 'Pincode', 'Payment Ref', 'Status', 'Submitted At'
    ];

    const rows = apps.map(a => [
      `"${a.id || ''}"`, `"${(a.company || '').replace(/"/g, '""')}"`, `"${a.legalStatus || ''}"`,
      `"${a.enterpriseType || ''}"`, `"${a.businessServices || ''}"`, `"${a.gstNo || ''}"`,
      `"${a.panNo || ''}"`, `"${a.cin || ''}"`, `"${a.annualTurnover || ''}"`, `"${a.employees || ''}"`,
      `"${(a.repName || '').replace(/"/g, '""')}"`, `"${a.repDesignation || ''}"`,
      `"${a.email || ''}"`, `"${a.phone || ''}"`, `"${a.district || ''}"`,
      `"${(a.address || '').replace(/"/g, '""')}"`, `"${a.pincode || ''}"`,
      `"${a.paymentRef || ''}"`, `"${a.status || ''}"`, `"${a.submittedAt || ''}"`
    ]);

    const csvData = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `BCCI_Backup_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    this.showToast('CSV exported successfully!', 'success');
  }



  /* ════════════════════════════════════════════════════════════════════
     MODAL, TOAST, LIGHTBOX — UI Utilities
     ════════════════════════════════════════════════════════════════════ */

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
      document.getElementById('modalCloseIcon')?.addEventListener('click', () => this.closeModal());
      document.getElementById('modalCloseBtn')?.addEventListener('click', () => this.closeModal());
    }
  }

  closeModal() {
    const backdrop = document.getElementById('modalBackdrop');
    if (backdrop) backdrop.classList.remove('show');
  }

  setupModalEvents() {
    const backdrop = document.getElementById('modalBackdrop');
    if (backdrop) backdrop.addEventListener('click', (e) => { if (e.target === backdrop) this.closeModal(); });

    // Escape key closes modal + profile dropdown
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.closeModal();
        document.querySelectorAll('.nav-profile-dropdown.open').forEach(d => d.classList.remove('open'));
        this.closeMobileDrawer();
      }
    });
  }

  showToast(message, type = 'info') {
    const toast = document.createElement('div');
    const bgColor = type === 'success' ? '#10B981' : type === 'warning' ? '#F59E0B' : type === 'error' ? '#EF4444' : '#1E3E62';
    const icon = type === 'success' ? 'fa-check-circle' : type === 'error' ? 'fa-exclamation-circle' : 'fa-info-circle';
    toast.style.cssText = `
      position: fixed; right: 1.5rem; background: ${bgColor};
      color: #FFF; padding: 0.85rem 1.4rem; border-radius: 10px; font-weight: 600;
      font-size: 0.9rem; box-shadow: 0 8px 24px rgba(0,0,0,0.3); z-index: 3000;
      transition: all 0.35s cubic-bezier(0.4,0,0.2,1); opacity: 1; transform: translateX(0);
      max-width: 420px; display: flex; align-items: center; gap: 0.6rem;
      animation: toastSlideIn 0.35s ease;
    `;
    toast.innerHTML = `<i class="fas ${icon}" style="font-size:1.1rem;"></i> <span>${message}</span>`;
    // Stack toasts vertically
    const existingToasts = document.querySelectorAll('.bcci-toast');
    let bottomOffset = 2;
    existingToasts.forEach(t => { bottomOffset += t.offsetHeight + 0.75; });
    toast.classList.add('bcci-toast');
    toast.style.bottom = bottomOffset + 'rem';
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(120%)';
      setTimeout(() => toast.remove(), 400);
    }, 4000);
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
          content: `<div style="text-align: center;"><img src="${src}" alt="${alt}" class="lightbox-img-view" /><div style="margin-top: 1rem; color: #94A3B8; font-size: 0.85rem;"><i class="fas fa-search-plus"></i> High Resolution View</div></div>`
        });
      } else if (btnTarget) {
        const src = btnTarget.getAttribute('data-img-src');
        const title = btnTarget.getAttribute('data-img-title') || 'BCCI Event Photo';
        this.showModal({
          title: title,
          content: `<div style="text-align: center;"><img src="${src}" alt="${title}" class="lightbox-img-view" /><div style="margin-top: 1rem; color: #94A3B8; font-size: 0.85rem;"><i class="fas fa-camera"></i> Official BCCI Media Archive</div></div>`
        });
      }
    });
  }
}

// Bootstrap
document.addEventListener('DOMContentLoaded', () => {
  window.bcciApp = new App();
});
