// api/expenses.js
// Expense management API: submit (employee), list (employee/admin), review (admin).

import {
  saveExpense,
  getExpense,
  getExpenseDoc,
  listExpenses,
  updateExpenseReview,
} from './_lib/expenses.js';
import { validateExpenseInput, validateReviewInput } from './_lib/validation.js';
import {
  applyCors,
  handlePreflight,
  getAdminSession,
  getEmployeeSession,
  requireEmployee,
  requireAdmin,
  rateLimit,
  tooManyRequests,
  clientIp,
  str,
  withErrorHandling,
} from './_lib/http.js';

async function handler(req, res) {
  applyCors(req, res, 'GET, POST, PATCH, OPTIONS');
  if (handlePreflight(req, res)) return;

  // ── GET ──────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const ip = clientIp(req);
    const getLimit = await rateLimit(`expenses:get:${ip}`, { max: 120, windowSec: 60 });
    if (!getLimit.ok) {
      return tooManyRequests(res, getLimit.retryAfter, 'Too many requests. Please slow down.');
    }

    const adminEmail = await getAdminSession(req);
    const empSession = await getEmployeeSession(req);

    if (!adminEmail && !empSession) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }

    // Single document fetch
    if (req.query?.document === '1' || req.query?.document === 'true') {
      const id = str(req.query?.id, 50);
      if (!id) return res.status(400).json({ success: false, error: 'Expense ID required.' });

      const expense = await getExpense(id);
      if (!expense) return res.status(404).json({ success: false, error: 'Expense not found.' });

      // Authorization: Admin or owner employee
      const isOwner = empSession && empSession.employeeId === expense.employeeId;
      if (!adminEmail && !isOwner) {
        return res.status(403).json({ success: false, error: 'Unauthorized to view this document.' });
      }

      const doc = await getExpenseDoc(id);
      if (!doc) return res.status(404).json({ success: false, error: 'No document on file.' });
      return res.status(200).json({ success: true, document: doc });
    }

    // Listing
    if (adminEmail) {
      const expenses = await listExpenses({
        employeeId: req.query?.employeeId ? str(req.query.employeeId, 30).toUpperCase() : undefined,
        month: req.query?.month ? Number(req.query.month) : undefined,
        year: req.query?.year ? Number(req.query.year) : undefined,
        status: req.query?.status ? str(req.query.status, 30) : undefined,
        category: req.query?.category ? str(req.query.category, 50) : undefined,
      });

      let totalClaimed = 0;
      let totalApproved = 0;
      let totalPending = 0;
      let totalRejected = 0;

      for (const e of expenses) {
        totalClaimed += Number(e.claimedAmount) || 0;
        if (e.status === 'Approved' || e.status === 'Partially Approved') {
          totalApproved += Number(e.approvedAmount) || 0;
        } else if (e.status === 'Rejected') {
          totalRejected += Number(e.claimedAmount) || 0;
        } else {
          totalPending += Number(e.claimedAmount) || 0;
        }
      }

      return res.status(200).json({
        success: true,
        expenses,
        total: expenses.length,
        aggregates: {
          totalClaimed: Math.round(totalClaimed * 100) / 100,
          totalApproved: Math.round(totalApproved * 100) / 100,
          totalPending: Math.round(totalPending * 100) / 100,
          totalRejected: Math.round(totalRejected * 100) / 100,
        },
      });
    }

    // Employee sees only their own expenses
    const expenses = await listExpenses({ employeeId: empSession.employeeId });
    return res.status(200).json({ success: true, expenses, total: expenses.length });
  }

  // ── POST ─────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const empSession = await requireEmployee(req, res);
    if (!empSession) return;

    const ip = clientIp(req);
    const postLimit = await rateLimit(`expenses:post:${ip}`, { max: 30, windowSec: 60 });
    if (!postLimit.ok) {
      return tooManyRequests(res, postLimit.retryAfter, 'Too many expense submissions. Please wait a moment.');
    }
    const empLimit = await rateLimit(`expenses:emp:${empSession.employeeId}`, { max: 30, windowSec: 60 });
    if (!empLimit.ok) {
      return tooManyRequests(res, empLimit.retryAfter, 'Too many expense submissions for this account. Please wait a moment.');
    }

    const validation = validateExpenseInput(req.body || {});
    if (!validation.ok) {
      return res.status(400).json({ success: false, errors: validation.errors, error: validation.errors[0] });
    }

    const { claimedAmount, expenseDate, category, description, docData, docName, docMime } = validation.value;

    const saved = await saveExpense({
      employeeId: empSession.employeeId,
      employeeName: empSession.name,
      claimedAmount,
      expenseDate,
      category,
      description,
      docData,
      docName,
      docMime,
    });

    return res.status(201).json({
      success: true,
      message: 'Expense claim submitted successfully. Status is Pending Approval.',
      expense: saved,
    });
  }

  // ── PATCH ────────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const adminEmail = await requireAdmin(req, res);
    if (!adminEmail) return;

    const ip = clientIp(req);
    const patchLimit = await rateLimit(`expenses:patch:${ip}`, { max: 60, windowSec: 60 });
    if (!patchLimit.ok) {
      return tooManyRequests(res, patchLimit.retryAfter, 'Too many review actions. Please wait a moment.');
    }

    const id = str(req.body?.id, 50);
    if (!id) return res.status(400).json({ success: false, error: 'Expense ID is required.' });

    const target = await getExpense(id);
    if (!target) return res.status(404).json({ success: false, error: 'Expense not found.' });

    const validation = validateReviewInput(req.body || {}, target.claimedAmount);
    if (!validation.ok) {
      return res.status(400).json({ success: false, errors: validation.errors, error: validation.errors[0] });
    }

    const { approvedAmount, status, remark } = validation.value;

    const updated = await updateExpenseReview(id, {
      approvedAmount,
      status,
      reviewedBy: adminEmail,
      adminRemark: remark,
    });

    return res.status(200).json({
      success: true,
      message: `Expense claim updated to ${status}.`,
      expense: updated,
    });
  }

  return res.status(405).json({ success: false, error: 'Method not allowed.' });
}

export default withErrorHandling('ExpensesAPI', handler);
