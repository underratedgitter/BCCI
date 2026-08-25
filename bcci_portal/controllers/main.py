import os
import random
import time
import logging

from odoo import http
from odoo.http import request, Response

_logger = logging.getLogger(__name__)

# OTP expiry in seconds (10 minutes)
OTP_EXPIRY = 600


class BCCIPortalController(http.Controller):
    """
    BCCI Bharuch Membership Portal Controller.

    Serves the full custom SPA and provides secure OTP endpoints
    that replace Firebase Phone Auth and formsubmit.co email OTP.

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
            return Response('BCCI Portal: portal.html not found in static/', status=500)
        return Response(html_content, content_type='text/html;charset=utf-8', status=200)

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
