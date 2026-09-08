// api/employees.js
// Admin management of BCCI employees (add, list, deactivate, inspect history).

import {
  saveEmployee,
  listEmployees,
  getEmployeeByCode,
  getEmployeeByUsername,
  updateEmployeeStatus,
  getEmployeeExpenseStats,
  listExpenses,
  EXP_KEYS,
} from './_lib/expenses.js';
import { redis } from './_lib/redis.js';
import { validateEmployeeInput } from './_lib/validation.js';
import {
  applyCors,
  handlePreflight,
  requireAdmin,
  str,
  withErrorHandling,
} from './_lib/http.js';

async function handler(req, res) {
  applyCors(req, res, 'GET, POST, PATCH, OPTIONS');
  if (handlePreflight(req, res)) return;

  const adminEmail = await requireAdmin(req, res);
  if (!adminEmail) return;

  // ── GET ──────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const targetCode = str(req.query?.id, 30).toUpperCase();
    if (targetCode) {
      const emp = await getEmployeeByCode(targetCode);
      if (!emp) return res.status(404).json({ success: false, error: 'Employee not found.' });
      const stats = await getEmployeeExpenseStats(targetCode);
      const history = await listExpenses({ employeeId: targetCode, limit: 1000 });
      return res.status(200).json({
        success: true,
        employee: {
          id: emp.id,
          employeeId: emp.employeeId,
          name: emp.name,
          username: emp.username,
          email: emp.email,
          status: emp.status,
          createdAt: emp.createdAt,
          updatedAt: emp.updatedAt,
          stats,
          history,
        },
      });
    }

    const employees = await listEmployees();
    const enriched = await Promise.all(
      employees.map(async (e) => {
        const stats = await getEmployeeExpenseStats(e.employeeId);
        return {
          id: e.id,
          employeeId: e.employeeId,
          name: e.name,
          username: e.username,
          email: e.email,
          status: e.status,
          createdAt: e.createdAt,
          totalClaims: stats.totalClaims,
          totalApprovedAmount: stats.approvedAmount,
        };
      })
    );

    return res.status(200).json({ success: true, employees: enriched, total: enriched.length });
  }

  // ── POST ─────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const validation = validateEmployeeInput(req.body || {});
    if (!validation.ok) {
      return res.status(400).json({ success: false, errors: validation.errors, error: validation.errors[0] });
    }

    const { name, employeeId, username, password, email, status } = validation.value;

    const existingCode = await getEmployeeByCode(employeeId);
    if (existingCode) {
      return res.status(409).json({ success: false, error: `Employee ID "${employeeId}" is already assigned.` });
    }

    const existingUser = await getEmployeeByUsername(username);
    if (existingUser) {
      return res.status(409).json({ success: false, error: `Username "${username}" is already taken.` });
    }

    try {
      const created = await saveEmployee({ name, employeeId, username, password, email, status });
      return res.status(201).json({
        success: true,
        message: 'Employee created successfully.',
        employee: {
          id: created.id,
          employeeId: created.employeeId,
          name: created.name,
          username: created.username,
          email: created.email,
          status: created.status,
          createdAt: created.createdAt,
        },
      });
    } catch (err) {
      if (err.statusCode === 409) {
        return res.status(409).json({ success: false, error: err.message });
      }
      throw err;
    }
  }

  // ── PATCH ────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const employeeId = str(req.body?.employeeId || req.body?.id, 30).toUpperCase();
    const targetStatus = req.body?.status === 'inactive' ? 'inactive' : 'active';

    const emp = await getEmployeeByCode(employeeId);
    if (!emp) return res.status(404).json({ success: false, error: 'Employee not found.' });

    const updated = await updateEmployeeStatus(emp.id, targetStatus);

    if (targetStatus === 'inactive') {
      const rawTokens = await redis.get(`bcci:emp_tokens:${emp.id}`);
      const tokens = rawTokens ? (typeof rawTokens === 'string' ? JSON.parse(rawTokens) : rawTokens) : [];
      for (const t of tokens) {
        await redis.del(EXP_KEYS.empSession(t)).catch(() => {});
      }
      await redis.del(`bcci:emp_tokens:${emp.id}`).catch(() => {});
    }

    return res.status(200).json({
      success: true,
      message: `Employee status updated to ${targetStatus}.`,
      employee: {
        id: updated.id,
        employeeId: updated.employeeId,
        name: updated.name,
        username: updated.username,
        status: updated.status,
        updatedAt: updated.updatedAt,
      },
    });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed.' });
}

export default withErrorHandling('EmployeesAPI', handler);
