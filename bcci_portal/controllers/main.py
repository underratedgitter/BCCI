import os
import random
import time
import logging

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)

# OTP expiry in seconds (10 minutes)
OTP_EXPIRY = 600


class BCCIPortalController(http.Controller):
    """
    BCCI Bharuch Membership Portal Controller.

    Serves the full custom SPA and provides secure OTP endpoints
    that power Email and Phone authentication via Odoo backend.

    Auth Endpoints:
        POST /bcci/auth/send-email-otp   – Generate & email OTP via Odoo mail
        POST /bcci/auth/send-phone-otp   – Generate & SMS OTP via Odoo IAP SMS
        POST /bcci/auth/verify-otp       – Verify code from session
    """

    # ── Portal Page ─────────────────────────────────────────────────────────

    @http.route(['/bcci', '/bcci/'], type='http', auth='public',
                website=False, csrf=False, save_session=False)
    def bcci_portal(self, **kwargs):
        """Serve the full BCCI Bharuch SPA as standalone HTML."""
        module_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        html_path = os.path.join(module_path, 'static', 'portal.html')
        try:
            with open(html_path, 'r', encoding='utf-8') as f:
                html_content = f.read()
        except FileNotFoundError:
            return request.make_response('BCCI Portal: portal.html not found in static/', status=500)
        return request.make_response(
            html_content,
            headers=[('Content-Type', 'text/html; charset=utf-8')]
        )

    # ── Email OTP ────────────────────────────────────────────────────────────

    @http.route('/bcci/auth/send-email-otp', type='json', auth='public',
                methods=['POST'], csrf=False)
    def send_email_otp(self, **kwargs):
        """
        Generate a 6-digit OTP, store it in Odoo session (server-side),
        and send it to the applicant's email via Odoo's mail.mail model.
        """
        params = request.jsonrequest
        email = (params.get('email') or '').strip().lower()
        name = (params.get('name') or '').strip()

        if not email or not name:
            return {'success': False, 'error': 'Email and name are required.'}

        otp = str(random.randint(100000, 999999))
        request.session['bcci_email_otp'] = otp
        request.session['bcci_email_otp_target'] = email
        request.session['bcci_email_otp_name'] = name
        request.session['bcci_email_otp_ts'] = time.time()

        try:
            mail_values = {
                'email_to': email,
                'subject': f'BCCI Bharuch Verification Code: {otp}',
                'body_html': f"""
                    <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;
                                border: 1px solid #D4AF37; border-radius: 10px; overflow: hidden;">
                      <div style="background: #0F2C59; padding: 20px 24px;">
                        <h2 style="color: #D4AF37; margin: 0; font-size: 1.1rem; letter-spacing: 1px;">
                          BHARUCH CHAMBER OF COMMERCE &amp; INDUSTRY
                        </h2>
                      </div>
                      <div style="padding: 24px;">
                        <p style="color: #1E293B;">Dear <strong>{name}</strong>,</p>
                        <p style="color: #475569;">
                          Your one-time verification code for the BCCI Membership Portal is:
                        </p>
                        <div style="background: #F8FAFC; border: 2px dashed #D4AF37; border-radius: 8px;
                                    text-align: center; padding: 20px; margin: 16px 0;">
                          <span style="font-size: 2.5rem; font-weight: 800; font-family: monospace;
                                       color: #0F2C59; letter-spacing: 8px;">{otp}</span>
                        </div>
                        <p style="color: #94A3B8; font-size: 0.85rem;">
                          This code expires in <strong>10 minutes</strong>. Do not share it with anyone.
                        </p>
                      </div>
                      <div style="background: #F1F5F9; padding: 12px 24px;
                                  font-size: 0.75rem; color: #94A3B8; text-align: center;">
                        BCCI Bharuch · City Center, Station Road, Bharuch - 392001
                      </div>
                    </div>
                """,
                'author_id': request.env.ref('base.user_root').partner_id.id,
            }
            mail = request.env['mail.mail'].sudo().create(mail_values)
            mail.sudo().send()
            _logger.info('[BCCI Email OTP] Sent to %s', email)
            return {'success': True, 'message': f'Verification code sent to {email}'}
        except Exception as e:
            _logger.error('[BCCI Email OTP Error] %s', str(e))
            return {'success': False, 'error': 'Failed to send email. Please try again.'}

    # ── Phone / SMS OTP ──────────────────────────────────────────────────────

    @http.route('/bcci/auth/send-phone-otp', type='json', auth='public',
                methods=['POST'], csrf=False)
    def send_phone_otp(self, **kwargs):
        """
        Generate a 6-digit OTP, store it in Odoo session (server-side),
        and send it via Odoo's IAP SMS service.
        """
        params = request.jsonrequest
        phone = (params.get('phone') or '').strip()
        name = (params.get('name') or '').strip()

        if not phone or not name:
            return {'success': False, 'error': 'Phone and name are required.'}

        # Normalise to E.164 format for India
        if not phone.startswith('+'):
            phone_e164 = f'+91{phone}'
        else:
            phone_e164 = phone

        otp = str(random.randint(100000, 999999))
        request.session['bcci_phone_otp'] = otp
        request.session['bcci_phone_otp_target'] = phone_e164
        request.session['bcci_phone_otp_name'] = name
        request.session['bcci_phone_otp_ts'] = time.time()

        sms_body = f'Your BCCI Bharuch verification code is: {otp}. Valid for 10 mins. Do not share.'

        try:
            # Use Odoo's built-in SMS IAP service (requires IAP credits on paid Odoo plan)
            request.env['sms.sms'].sudo().create({
                'number': phone_e164,
                'body': sms_body,
                'state': 'outgoing',
            }).sudo().send()
            _logger.info('[BCCI Phone OTP] Sent to %s', phone_e164)
            return {'success': True, 'message': f'SMS code sent to {phone_e164}'}
        except Exception as e:
            _logger.error('[BCCI Phone OTP Error] %s', str(e))
            return {'success': False, 'error': 'Failed to send SMS. Please try again.'}

    # ── Verify OTP ───────────────────────────────────────────────────────────

    @http.route('/bcci/auth/verify-otp', type='json', auth='public',
                methods=['POST'], csrf=False)
    def verify_otp(self, **kwargs):
        """
        Verify OTP code from session. Returns session data on success.
        Clears OTP from session after successful verification.
        """
        params = request.jsonrequest
        otp_type = (params.get('type') or '').strip()   # 'email' or 'phone'
        code = (params.get('code') or '').strip()

        if otp_type == 'email':
            stored_otp = request.session.get('bcci_email_otp')
            stored_ts = request.session.get('bcci_email_otp_ts', 0)
            email = request.session.get('bcci_email_otp_target', '')
            name = request.session.get('bcci_email_otp_name', '')

            if not stored_otp:
                return {'success': False, 'error': 'No OTP session found. Please request a new code.'}
            if time.time() - stored_ts > OTP_EXPIRY:
                # Clear expired OTP
                for k in ['bcci_email_otp', 'bcci_email_otp_target', 'bcci_email_otp_name', 'bcci_email_otp_ts']:
                    request.session.pop(k, None)
                return {'success': False, 'error': 'OTP has expired. Please request a new code.'}
            if code != stored_otp:
                return {'success': False, 'error': 'Invalid code. Please check and try again.'}

            # Clear OTP after successful use
            for k in ['bcci_email_otp', 'bcci_email_otp_target', 'bcci_email_otp_name', 'bcci_email_otp_ts']:
                request.session.pop(k, None)

            return {
                'success': True,
                'session_data': {
                    'email': email,
                    'name': name,
                    'authenticatedAt': str(time.time()),
                    'authMethod': 'email_otp',
                }
            }

        elif otp_type == 'phone':
            stored_otp = request.session.get('bcci_phone_otp')
            stored_ts = request.session.get('bcci_phone_otp_ts', 0)
            phone = request.session.get('bcci_phone_otp_target', '')
            name = request.session.get('bcci_phone_otp_name', '')

            if not stored_otp:
                return {'success': False, 'error': 'No OTP session found. Please request a new code.'}
            if time.time() - stored_ts > OTP_EXPIRY:
                for k in ['bcci_phone_otp', 'bcci_phone_otp_target', 'bcci_phone_otp_name', 'bcci_phone_otp_ts']:
                    request.session.pop(k, None)
                return {'success': False, 'error': 'OTP has expired. Please request a new code.'}
            if code != stored_otp:
                return {'success': False, 'error': 'Invalid code. Please check and try again.'}

            # Clear OTP after successful use
            for k in ['bcci_phone_otp', 'bcci_phone_otp_target', 'bcci_phone_otp_name', 'bcci_phone_otp_ts']:
                request.session.pop(k, None)

            # Strip +91 for display
            phone_display = phone.replace('+91', '') if phone.startswith('+91') else phone

            return {
                'success': True,
                'session_data': {
                    'phone': phone_display,
                    'email': f'{phone_display}@mobile.bcci',
                    'name': name,
                    'authenticatedAt': str(time.time()),
                    'authMethod': 'phone_otp',
                }
            }

        return {'success': False, 'error': 'Invalid OTP type. Must be "email" or "phone".'}

    # ── Membership Application ────────────────────────────────────────────────

    @http.route('/bcci/application/submit', type='json', auth='public',
                methods=['POST'], csrf=False)
    def submit_application(self, **kwargs):
        """
        Accepts a full membership application from the portal form
        and saves it to the Odoo database (bcci.membership.application).
        """
        params = request.jsonrequest
        required = ['company', 'repName', 'email']
        for field in required:
            if not params.get(field):
                return {'success': False, 'error': f'Missing required field: {field}'}

        try:
            app = request.env['bcci.membership.application'].sudo().create({
                'company':           params.get('company', ''),
                'legal_status':      params.get('legalStatus', ''),
                'enterprise_type':   params.get('enterpriseType', ''),
                'gst_no':            params.get('gstNo', ''),
                'pan_no':            params.get('panNo', ''),
                'business_services': params.get('businessServices', ''),
                'address':           params.get('address', ''),
                'city':              params.get('city', ''),
                'pincode':           params.get('pincode', ''),
                'website':           params.get('website', ''),
                'rep_name':          params.get('repName', ''),
                'rep_designation':   params.get('repDesignation', ''),
                'email':             params.get('email', '').lower().strip(),
                'phone':             params.get('phone', ''),
                'membership_type':   params.get('membershipType', ''),
                'payment_ref':       params.get('paymentRef', ''),
            })
            _logger.info('[BCCI Application] Submitted: %s by %s (%s)',
                         app.app_id, app.rep_name, app.email)
            # Send acknowledgement email to applicant
            self._send_ack_email(app)
            return {
                'success': True,
                'application': {
                    'id':          app.app_id,
                    'company':     app.company,
                    'status':      app.status,
                    'submittedAt': app.submitted_at.isoformat() if app.submitted_at else '',
                    'repName':     app.rep_name,
                    'email':       app.email,
                }
            }
        except Exception as e:
            _logger.error('[BCCI Application Submit Error] %s', str(e))
            return {'success': False, 'error': 'Failed to submit application. Please try again.'}

    def _send_ack_email(self, app):
        """Send an acknowledgement email to the applicant on form submission."""
        if not app.email:
            return
        mail_values = {
            'email_to': app.email,
            'subject': f'BCCI Membership Application Received ({app.app_id})',
            'body_html': f"""
                <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;
                            border:1px solid #D4AF37;border-radius:10px;overflow:hidden;">
                  <div style="background:#0F2C59;padding:20px 24px;">
                    <h2 style="color:#D4AF37;margin:0;font-size:1rem;letter-spacing:1px;">
                      BHARUCH CHAMBER OF COMMERCE &amp; INDUSTRY
                    </h2>
                  </div>
                  <div style="padding:24px;">
                    <p>Dear <strong>{app.rep_name}</strong>,</p>
                    <p>We have successfully received your membership application for
                       <strong>{app.company}</strong>.</p>
                    <table style="width:100%;border-collapse:collapse;margin:16px 0;
                                  background:#F8FAFC;border-radius:8px;overflow:hidden;">
                      <tr style="border-bottom:1px solid #E2E8F0;">
                        <td style="padding:8px 12px;color:#64748B;font-size:0.85rem;">Application ID</td>
                        <td style="padding:8px 12px;font-weight:700;font-family:monospace;color:#0F2C59;">{app.app_id}</td>
                      </tr>
                      <tr style="border-bottom:1px solid #E2E8F0;">
                        <td style="padding:8px 12px;color:#64748B;font-size:0.85rem;">Status</td>
                        <td style="padding:8px 12px;color:#D97706;font-weight:700;">⏳ PENDING REVIEW</td>
                      </tr>
                    </table>
                    <p>The BCCI Secretariat will review your application and notify you of the decision.</p>
                    <p style="color:#64748B;font-size:0.85rem;">
                      BCCI Secretariat · admin@bccibharuch.in · +91 7861906384
                    </p>
                  </div>
                </div>
            """,
            'author_id': request.env.ref('base.user_root').partner_id.id,
        }
        request.env['mail.mail'].sudo().create(mail_values).sudo().send()

    @http.route('/bcci/application/status', type='json', auth='public',
                methods=['POST'], csrf=False)
    def get_application_status(self, **kwargs):
        """
        Look up an application by email or phone — used after applicant logs in
        to show their membership status instead of the application form.
        """
        params = request.jsonrequest
        identifier = (params.get('email') or params.get('phone') or '').strip().lower()
        if not identifier:
            return {'success': False, 'error': 'Email or phone required.'}

        domain = ['|',
                  ('email', '=', identifier),
                  ('phone', 'like', identifier.replace('+91', ''))]
        app = request.env['bcci.membership.application'].sudo().search(
            domain, order='submitted_at desc', limit=1
        )

        if not app:
            return {'success': True, 'application': None}

        validity = {}
        if app.status == 'Approved' and app.valid_until:
            validity = {
                'validUntilDate': app.valid_until.strftime('%d %B %Y'),
                'daysRemaining':  app.days_remaining,
                'state':          app.validity_state,
            }

        return {
            'success': True,
            'application': {
                'id':             app.app_id,
                'company':        app.company,
                'repName':        app.rep_name,
                'repDesignation': app.rep_designation or '',
                'email':          app.email,
                'phone':          app.phone or '',
                'status':         app.status,
                'membershipType': app.membership_type or '',
                'enterpriseType': app.enterprise_type or '',
                'submittedAt':    app.submitted_at.isoformat() if app.submitted_at else '',
                'approvedAt':     app.approved_at.isoformat() if app.approved_at else '',
                'renewalYears':   app.renewal_years,
                'validity':       validity,
            }
        }

    # ── Enquiry / Contact Form ────────────────────────────────────────────────

    @http.route('/bcci/enquiry/submit', type='json', auth='public',
                methods=['POST'], csrf=False)
    def submit_enquiry(self, **kwargs):
        """Save a contact/enquiry form submission to the Odoo database."""
        params = request.jsonrequest
        if not params.get('email') or not params.get('name'):
            return {'success': False, 'error': 'Name and email are required.'}

        import random, string
        enq_id = 'ENQ-' + ''.join(random.choices(string.digits, k=3))

        try:
            request.env['bcci.enquiry'].sudo().create({
                'enq_id':  enq_id,
                'name':    params.get('name', ''),
                'email':   params.get('email', '').lower().strip(),
                'phone':   params.get('phone', ''),
                'company': params.get('company', ''),
                'subject': params.get('subject', ''),
                'message': params.get('message', ''),
            })
            return {'success': True, 'id': enq_id}
        except Exception as e:
            _logger.error('[BCCI Enquiry Error] %s', str(e))
            return {'success': False, 'error': 'Failed to submit enquiry. Please try again.'}

