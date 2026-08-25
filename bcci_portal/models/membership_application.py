from odoo import models, fields, api
import random
import string


def generate_app_id():
    return 'APP-' + ''.join(random.choices(string.digits, k=4))


class BCCIMembershipApplication(models.Model):
    """
    Stores every membership application submitted through the BCCI portal.
    Replaces localStorage['bcci_membership_applications'].
    Admin reviews and approves/rejects from the Odoo backend UI.
    """
    _name = 'bcci.membership.application'
    _description = 'BCCI Membership Application'
    _order = 'submitted_at desc'
    _rec_name = 'company'

    # ── Identity ─────────────────────────────────────────────────────────────
    app_id = fields.Char(
        string='Application ID', readonly=True, index=True,
        default=generate_app_id, copy=False
    )
    status = fields.Selection([
        ('Pending',  'Pending Review'),
        ('Approved', 'Approved'),
        ('Rejected', 'Rejected'),
    ], string='Status', default='Pending', index=True, tracking=True)

    # ── Company Details ───────────────────────────────────────────────────────
    company         = fields.Char('Company / Firm Name', required=True)
    legal_status    = fields.Char('Legal Status')        # Pvt Ltd, LLP, etc.
    enterprise_type = fields.Char('Enterprise Scale')    # MSME, Large, etc.
    gst_no          = fields.Char('GSTIN')
    pan_no          = fields.Char('PAN')
    business_services = fields.Text('Business / Services Description')
    address         = fields.Text('Registered Address')
    city            = fields.Char('City')
    pincode         = fields.Char('Pincode')
    website         = fields.Char('Company Website')

    # ── Representative ────────────────────────────────────────────────────────
    rep_name        = fields.Char('Representative Name', required=True)
    rep_designation = fields.Char('Designation')
    email           = fields.Char('Email', required=True, index=True)
    phone           = fields.Char('Phone', index=True)

    # ── Membership ────────────────────────────────────────────────────────────
    membership_type = fields.Char('Membership Category')  # Corporate / Associate
    payment_ref     = fields.Char('UTR / Payment Reference')
    payment_proof   = fields.Binary('Payment Proof (Image)', attachment=True)
    payment_proof_name = fields.Char('Payment Proof Filename')

    # ── Timestamps ────────────────────────────────────────────────────────────
    submitted_at    = fields.Datetime('Submitted At', default=fields.Datetime.now, readonly=True)
    approved_at     = fields.Datetime('Approved At', readonly=True)
    renewal_years   = fields.Integer('Renewal Years', default=1)
    last_renewed_at = fields.Datetime('Last Renewed At')

    # ── Odoo relational ───────────────────────────────────────────────────────
    approved_by     = fields.Many2one('res.users', string='Approved By', readonly=True)

    # ── Compute: membership validity ─────────────────────────────────────────
    valid_until     = fields.Datetime('Valid Until', compute='_compute_valid_until', store=True)
    days_remaining  = fields.Integer('Days Remaining', compute='_compute_valid_until')
    validity_state  = fields.Selection([
        ('ACTIVE',       'Active'),
        ('RENEWAL_DUE',  'Renewal Due'),
        ('EXPIRED',      'Expired'),
    ], string='Validity', compute='_compute_valid_until')

    @api.depends('approved_at', 'submitted_at', 'renewal_years', 'status')
    def _compute_valid_until(self):
        from datetime import timedelta, datetime
        for rec in self:
            if rec.status != 'Approved':
                rec.valid_until = False
                rec.days_remaining = 0
                rec.validity_state = 'ACTIVE'
                continue
            base = rec.approved_at or rec.submitted_at or fields.Datetime.now()
            years = rec.renewal_years or 1
            # Add years manually (handles leap years)
            valid = base.replace(year=base.year + years)
            rec.valid_until = valid
            diff = (valid - fields.Datetime.now()).days
            rec.days_remaining = max(0, diff)
            if diff <= 0:
                rec.validity_state = 'EXPIRED'
            elif diff <= 30:
                rec.validity_state = 'RENEWAL_DUE'
            else:
                rec.validity_state = 'ACTIVE'

    def action_approve(self):
        """Approve application and set approved_at timestamp."""
        for rec in self:
            rec.write({
                'status': 'Approved',
                'approved_at': fields.Datetime.now(),
                'approved_by': self.env.user.id,
            })
            rec._send_approval_email()

    def action_reject(self):
        """Reject application."""
        for rec in self:
            rec.write({'status': 'Rejected'})

    def _send_approval_email(self):
        """Send a branded approval confirmation email to the applicant."""
        if not self.email:
            return
        mail_values = {
            'email_to': self.email,
            'subject': f'Official Membership Approval — BCCI Bharuch ({self.app_id})',
            'body_html': f"""
                <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;
                            border: 1px solid #D4AF37; border-radius: 10px; overflow: hidden;">
                  <div style="background: #0F2C59; padding: 20px 24px;">
                    <h2 style="color: #D4AF37; margin: 0; letter-spacing: 1px; font-size: 1rem;">
                      BHARUCH CHAMBER OF COMMERCE &amp; INDUSTRY
                    </h2>
                  </div>
                  <div style="padding: 24px;">
                    <p>Dear <strong>{self.rep_name}</strong>,</p>
                    <p>We are pleased to inform you that your membership application for
                       <strong>{self.company}</strong> has been
                       <span style="color:#059669; font-weight:700;">APPROVED</span>
                       by the BCCI Secretariat Board.</p>
                    <table style="width:100%; border-collapse:collapse; margin: 16px 0;
                                  background:#F8FAFC; border-radius:8px; overflow:hidden;">
                      <tr style="border-bottom:1px solid #E2E8F0;">
                        <td style="padding:8px 12px; color:#64748B; font-size:0.85rem;">Application ID</td>
                        <td style="padding:8px 12px; font-weight:700; font-family:monospace; color:#0F2C59;">{self.app_id}</td>
                      </tr>
                      <tr style="border-bottom:1px solid #E2E8F0;">
                        <td style="padding:8px 12px; color:#64748B; font-size:0.85rem;">Enterprise</td>
                        <td style="padding:8px 12px; font-weight:600;">{self.company}</td>
                      </tr>
                      <tr>
                        <td style="padding:8px 12px; color:#64748B; font-size:0.85rem;">Approved On</td>
                        <td style="padding:8px 12px;">{fields.Datetime.now().strftime('%d %B %Y')}</td>
                      </tr>
                    </table>
                    <p>Welcome to Asia's Largest Industrial Corridor Network.</p>
                    <p style="color:#64748B; font-size:0.85rem;">
                      BCCI Secretariat · admin@bccibharuch.in · +91 7861906384
                    </p>
                  </div>
                </div>
            """,
            'author_id': self.env.ref('base.user_root').partner_id.id,
        }
        self.env['mail.mail'].sudo().create(mail_values).sudo().send()
