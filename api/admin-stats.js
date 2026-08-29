// api/admin-stats.js
// Dashboard counters for the admin portal.

import { listApplications, countEnquiries, STATUS } from './_lib/redis.js';
import {
  applyCors,
  handlePreflight,
  requireAdmin,
  withErrorHandling,
} from './_lib/http.js';

async function handler(req, res) {
  applyCors(req, res, 'GET, OPTIONS');
  if (handlePreflight(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed.' });
  }

  // Previously this read a `bcci:admin_sessions` hash that admin-auth.js never
  // wrote, so it returned 401 to every valid admin. It now uses the same
  // session store as every other route.
  if (!(await requireAdmin(req, res))) return;

  const applications = await listApplications();
  const totalEnquiries = await countEnquiries();

  const stats = {
    total: applications.length,
    pending: applications.filter((a) => a.status === STATUS.PENDING).length,
    approved: applications.filter((a) => a.status === STATUS.APPROVED).length,
    rejected: applications.filter((a) => a.status === STATUS.REJECTED).length,
    totalEnquiries,
    recentApplications: applications.slice(0, 5).map((a) => ({
      id: a.id,
      company: a.company,
      status: a.status,
      submittedAt: a.submittedAt,
    })),
  };

  return res.status(200).json({ success: true, stats });
}

export default withErrorHandling('AdminStats', handler);
