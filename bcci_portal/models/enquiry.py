from odoo import models, fields


class BCCIEnquiry(models.Model):
    """
    Stores contact/enquiry form submissions from the BCCI portal.
    Replaces localStorage['bcci_enquiries'].
    """
    _name = 'bcci.enquiry'
    _description = 'BCCI Portal Enquiry'
    _order = 'submitted_at desc'
    _rec_name = 'name'

    enq_id      = fields.Char('Enquiry ID', readonly=True, index=True)
    name        = fields.Char('Name', required=True)
    email       = fields.Char('Email', required=True)
    phone       = fields.Char('Phone')
    company     = fields.Char('Company')
    subject     = fields.Char('Subject')
    message     = fields.Text('Message')
    submitted_at = fields.Datetime('Submitted At', default=fields.Datetime.now, readonly=True)
    is_read     = fields.Boolean('Read', default=False)
