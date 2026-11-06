/* ==========================================================================
   BCCI BHARUCH — Public leadership roster
   Shared by the About page (via js/store.js) and the board-admin check that
   compares this published list with the portal's sign-in roster. Keep it pure
   data: the API imports this file too.
   ========================================================================== */

export const LEADERSHIP = [
  { name: 'MR. KIRAN K. MAJMUDAR', role: 'President', category: 'Executive Board', initials: 'KM', image: '/assets/President_photo.webp?v=2', linkedin: 'https://www.linkedin.com/in/kiran-k-majmudar-52b235308/' },
  { name: 'MR. KAMAL KUMAR', role: 'Joint Vice President', category: 'Executive Board', initials: 'KK', image: '/assets/KAmal.webp?v=2', linkedin: 'https://www.linkedin.com/in/kamal-kumar-165a5b86' },
  { name: 'MR. ANISH PARIKH', role: 'Joint Vice President', category: 'Executive Board', initials: 'AP', image: '/assets/anish.webp?v=2', linkedin: 'https://www.linkedin.com/in/anish-parikh-4a5156b6/' },
  { name: 'MR. TUSHAR P. SHAH', role: 'Secretary', category: 'Executive Board', initials: 'TS', image: '/assets/tushar.webp?v=2' },
  {
    name: 'DR. C. D. SHELAT', role: 'Executive Secretary', category: 'Administration', initials: 'CS', image: '/assets/cd-shelat.webp?v=2', linkedin: 'https://www.linkedin.com/in/dr-c-d-shelat-16902563/',
    bio: [
      'Retired Deputy Commissioner, FDCA, Government of Gujarat, with over 35 years of service in pharmaceutical regulation, drug safety and quality assurance. He received the Pharma Ratan – Lifetime Achievement Award and helped set up India\'s first State Price Monitoring Unit.',
      'He is Director – Skill Development at Dhanvantari College of Pharmacy and Chairperson – Advisory Body at Ribosome Research Centre.',
    ],
  },
  { name: 'MR. TUSHAR J. SHAH', role: 'Hon. Treasurer', category: 'Finance', initials: 'TJ', image: '/assets/tushar_j_shah.jpeg?v=2' },
  {
    name: 'MR. BHAAVIK BAROT', role: 'Social Media & IT Support', category: 'Executive Board', initials: 'BB', image: '/assets/bhavik-barot.webp?v=2', linkedin: 'https://www.linkedin.com/in/bhavikbarot/',
    bio: [
      'Founder & Director of D-TECH Solution Integrators Pvt. Ltd. and a technology strategy consultant, with over 34 years of experience in IT infrastructure, cybersecurity, SAP/ERP, custom software and automation.',
      'He guides organizations on technology planning, vendor selection and long-term investment value. "Lead with Trust. Inspire with Vision."',
    ],
  },
  {
    name: 'MR. BHARAT SHAH', role: 'Vendor Development & Education', category: 'Executive Board', initials: 'BS', image: '/assets/bharat-shah.webp?v=2',
    bio: [
      'Mr. Bharat Shah is a pharmaceutical trader in Bharuch, running Aakash Medicines, Shah Medico and Shah Medicines.',
      'He has been President of the Bharuch & Narmada District Chemist and Druggist Association since 1995, and is Vice President of the Federation of Gujarat State Chemist & Druggist Association and a trustee of two charitable trusts.',
    ],
  },
  {
    name: 'MR. NIRMAL SHAH', role: 'Membership Drive', category: 'Executive Board', initials: 'NS', image: '/assets/nirmal-shah.webp?v=2',
    bio: [
      'Managing Director of V C Shahpatel Services Pvt. Ltd., a Bharuch group in business since 1990 and certified ISO 9001, 14001 and 45001. It supplies manpower and housekeeping services to industry, including Abbott, BASF, Asian Paints and UPL.',
      'The group also runs staffing, car hire, Force Motors and Eicher dealerships, and vehicle fabrication.',
    ],
  },
  {
    name: 'DR. TRUPTI ALMOLA', role: 'Women Empowerment & Entrepreneurship', category: 'Executive Board', initials: 'TA', image: '/assets/trupti-almola.webp?v=2',
    bio: [
      'Dr. Trupti is a civil engineer (NIT Surat) with an MBA, a PG Diploma in HRD and a Ph.D. in Leadership. After 10 years in industry, she spent over 25 years in academics, rising to Director of Narmada College of Management and serving three terms as Dean, Faculty of Management, GTU.',
      'She has run Dhwani School for the hearing impaired since 2007, is Vice Chairperson of ISTD Bharuch Chapter, a past President of Rotary Club of Bharuch, Narmada Nagari, and Professor and Director at UPL University of Sustainable Technology.',
    ],
  },
  {
    name: 'MR. RAJESHKUMAR DUDHAT', role: 'MSME & Capacity Building', category: 'Executive Board', initials: 'RD', image: '/assets/rajesh-dudhat.webp?v=2',
    bio: [
      'Mr. Dudhat is CEO of Kohinoor Group of Industries, which he has led since 2002. The group has 12 manufacturing companies and 15 associates across dyestuffs, pharmaceuticals, speciality chemicals, engineering, packaging and export-import trading.',
      'With over 24 years in industry, he is also President of the Lions Club of Ankleshwar Industrial Area and a trustee of two community trusts.',
    ],
  },
  {
    name: 'MR. NIRMALSINH YADAV', role: 'Government Licensing & Media', category: 'Executive Board', initials: 'NY', image: '/assets/nirmalsinh-yadav.webp?v=2',
    bio: [
      'Head of Corporate Affairs and Group Nodal Officer – CSR at Deepak Group of Companies, with over 30 years in the chemical industry at UPL, GFL, SRF and Jubilant. M.Com., LL.B. and a PG Diploma in Industrial Relations and Personnel Management.',
      'His expertise spans greenfield and brownfield projects, HR, industrial relations, government affairs and CSR. He has chaired the BDMA CSR Forum for over six years, is a past President of the Rotary Club of Bharuch Narmada Nagari, and serves on the Managing Committee of SVADES.',
    ],
  },
  {
    name: 'DR. MAHESH R. VASHI', role: 'CSR & Skill Development', category: 'Executive Board', initials: 'MV', image: '/assets/mahesh-vashi.webp?v=2',
    bio: [
      'General Manager – HR & Admin cum Site Head at Colourtex Industries Limited, Vilayat, Bharuch, with over 25 years in personnel and HR management, recruitment, training, welfare, payroll and statutory compliance. He holds a doctorate in management studies, master\'s degrees in labour welfare and HRD, an LLB and a BSc in Chemistry.',
      'He is President and founder member of the Vilayat GIDC Industries Association, past Honorary Secretary General of the Bharuch District Management Association, and a trustee of ARES/SRICT College and the NGO SHE. A DISH-certified trainer for 36 environment, health and safety programmes, he also trains on management and the Shrimad Bhagavad Gita.',
    ],
  },
  {
    name: 'MR. URJIT BHUPENDRABHAI PATEL', portalNames: ['Urjit Patel'], role: 'Event Management & Exhibitions', category: 'Executive Board', initials: 'UP', image: '/assets/urjit-patel.webp?v=1',
    bio: [
      'Director of SLD Infrastructure Private Limited, Bharuch, and a real-estate, construction and infrastructure entrepreneur active in real estate since 2008. His residential and commercial portfolio includes SLD Essenza, SLD Nirvana, SLD Valencia, SLD Homes and SLD Commercial Complex.',
      'An agriculturalist cultivating approximately 80–100 acres with around 12,000 mango trees, he combines property development with agricultural enterprise. He is a member of the Rotary Club of Bharuch and is involved in developing the Rotary Youth Center at Bharuch, supporting youth development and community engagement.',
    ],
  },
  {
    name: 'MR. RAJESH MAKWANA', role: 'Regulatory & Finance', category: 'Executive Board', initials: 'RM', image: '/assets/rajesh-makwana.webp?v=2',
    bio: [
      'Senior finance and taxation professional with over 28 years in finance, taxation, treasury and compliance, and an MBA from IIM Kozhikode. Named among the "100 CFOs of India", he has held leadership roles at Zentiva (formerly Sanofi India), Gharda Chemicals and Cheminova India, and led the carve-out of Sanofi\'s Ankleshwar business into Zentiva.',
      'Since 2015 he has led the Finance & Taxation Forum of Bharuch District Management Association, and he is a key link between Bharuch industry and the Income Tax and GST authorities.',
    ],
  },
  {
    name: 'ADV. JIGAR S. PATEL', role: 'Legal Affairs, Arbitration & MSME Dispute Resolution', category: 'Executive Board', initials: 'JP', image: '/assets/jigar-patel.webp?v=1', linkedin: 'https://www.linkedin.com/in/jigar-patel-fciarb-0b3800179',
    bio: [
      'Adv. Jigar S. Patel is an advocate, arbitrator and mediator based in Bharuch with around two decades of practice in commercial arbitration, mediation, contractual disputes and corporate legal advisory. He holds a B.Com., LL.B., LL.M. and a Diploma in International Commercial Arbitration, and is a Fellow of the Chartered Institute of Arbitrators (UK).',
      'He is associated with leading arbitration institutions in India, Malaysia and Thailand, including the Asian International Arbitration Centre (AIAC), the Thailand Arbitration Center (THAC) and the Gujarat International Maritime Arbitration Centre (GIMAC), and has served as sole arbitrator in more than 100 domestic matters. A former Vice President of the Bharuch District Bar Association, he contributes to legal education as a visiting lecturer and through arbitration-related publications.',
    ],
  },
];
