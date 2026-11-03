// Admin-operated retry surface. No public recipient/template selection.
import { applyCors, handlePreflight, requireAdmin, str, withErrorHandling } from './_lib/http.js';
import { listEmailIntents, deliverEmailIntent } from './_lib/email-outbox.js';

async function handler(req, res) {
  applyCors(req, res, 'GET, POST, OPTIONS');
  if (handlePreflight(req, res)) return;
  if (!(await requireAdmin(req, res))) return;
  if (req.method === 'GET') {
    const intents = await listEmailIntents();
    return res.status(200).json({ success: true, intents });
  }
  if (req.method === 'POST') {
    const id = str(req.body?.id, 150);
    if (id) {
      const result = await deliverEmailIntent(id, { force: true });
      return res.status(result ? 200 : 404).json(result || { error: 'Email intent not found' });
    }
    const due = (await listEmailIntents(20, { runnableOnly: true })).filter(item => item.nextAttemptAt <= Date.now());
    const results = [];
    // Limit work per serverless request; the admin can invoke again to drain.
    for (const item of due.slice(0, 1)) results.push({ id: item.id, ...await deliverEmailIntent(item.id) });
    return res.status(200).json({ success: true, results });
  }
  return res.status(405).json({ error: 'Method not allowed' });
}

export default withErrorHandling('Email retries', handler);
