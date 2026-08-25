{
    'name': 'BCCI Bharuch Portal',
    'version': '17.0.1.0.0',
    'category': 'Website',
    'summary': 'Bharuch Chamber of Commerce & Industry Official Membership Portal',
    'author': 'BCCI Bharuch',
    'website': 'https://bccibharuch.odoo.com',
    'license': 'LGPL-3',
    'depends': ['base', 'web', 'mail', 'sms'],
    'data': [
        'security/ir.model.access.csv',
        'views/membership_application_views.xml',
        'views/enquiry_views.xml',
        'views/portal_template.xml',
    ],
    'installable': True,
    'auto_install': False,
    'application': True,
}
