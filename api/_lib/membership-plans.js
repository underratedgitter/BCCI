// api/_lib/membership-plans.js
// Membership tiers: the built-in plans below plus any the Secretariat adds
// from the admin portal. Every fee check on the server goes through here, so
// an applicant can only ever pay the amount the chosen plan is listed at.
//
// A plan's label ("Corporate VIP Membership - ₹1,00,000/-") is what an
// application stores as membershipPlan, so a label never changes once a plan
// exists. Deleting a plan only takes it off the application form; members who
// joined on it keep their stored label.

import { listCustomPlans, insertCustomPlan, deleteCustomPlan } from './records.js';

// Keep in sync with MEMBERSHIP_FEES in js/app.js and the #appMembershipPlan
// options in index.html (the form's fallback when the API is unreachable).
const BUILT_IN_PLANS = [
  ['Micro & Small - ₹500 / Year', 500],
  ['Medium - ₹1,000 / Year', 1000],
  ['Large - ₹2,500 / Year', 2500],
  ['General Membership - ₹5,000/-', 5000],
  ['Executive Membership - ₹10,000/-', 10000],
  ['Executive VIP Membership - ₹15,000/-', 15000],
  ['Corporate Membership - ₹25,000/-', 25000],
  ['Corporate VIP Membership - ₹1,00,000/-', 100000],
].map(([label, fee]) => Object.freeze({
  id: planId(label.replace(/\s*-\s*₹.*$/, '')),
  name: label.replace(/\s*-\s*₹.*$/, ''),
  fee,
  label,
  builtIn: true,
}));

export const PLAN_NAME_MIN = 3;
export const PLAN_NAME_MAX = 60;
export const PLAN_FEE_MAX = 10000000; // ₹1 crore
export const MAX_CUSTOM_PLANS = 25;

const tooManyPlansMessage = () =>
  `You can add up to ${MAX_CUSTOM_PLANS} membership types. Delete one you no longer offer first.`;

// Letters, digits and the punctuation tier names actually use. No "₹": the
// amount is appended by the server, never typed into the name.
const PLAN_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 &()'.,/+-]*$/;

/** Stable id for a plan name: "Corporate VIP Membership" → "corporate-vip-membership". */
function planId(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** "₹1,00,000/-" — Indian digit grouping, matching the built-in labels. */
function formatPlanFee(fee) {
  return `₹${Number(fee).toLocaleString('en-IN')}/-`;
}

export class PlanError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'PlanError';
    this.status = status;
  }
}

/** What the public API returns for a plan: no admin email, no internals. */
function publicPlan(plan) {
  return { id: plan.id, name: plan.name, fee: plan.fee, label: plan.label, builtIn: !!plan.builtIn };
}

/**
 * Every plan an applicant can choose, cheapest first: built-ins plus the
 * admin-added ones. A malformed stored record is skipped, not served.
 */
export async function getMembershipPlans() {
  const custom = (await listCustomPlans())
    .filter(p => p && p.id && p.label && Number.isInteger(p.fee) && p.fee > 0)
    .map(p => ({ ...publicPlan(p), builtIn: false }));
  // sort() is stable, so built-ins keep their order among equal fees.
  return [...BUILT_IN_PLANS.map(publicPlan), ...custom].sort((a, b) => a.fee - b.fee);
}

/** Fee in INR for a plan label, or undefined when no such plan exists. */
export async function getMembershipFee(label) {
  if (!label) return undefined;
  const plan = (await getMembershipPlans()).find(p => p.label === label);
  return plan ? plan.fee : undefined;
}

/**
 * Checks admin input and builds the plan record. Throws PlanError(400) with
 * a message fit for the admin when the input is unusable.
 */
export function buildPlan({ name, fee } = {}, createdBy = 'admin') {
  const cleanName = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (cleanName.length < PLAN_NAME_MIN || cleanName.length > PLAN_NAME_MAX) {
    throw new PlanError(400, `Membership type name must be ${PLAN_NAME_MIN}–${PLAN_NAME_MAX} characters.`);
  }
  if (!PLAN_NAME_PATTERN.test(cleanName)) {
    throw new PlanError(400, 'Membership type name may only use letters, numbers, spaces and & ( ) \' . , / + -');
  }
  const id = planId(cleanName);
  if (!id) {
    throw new PlanError(400, 'Membership type name must contain letters or numbers.');
  }

  const rawFee = typeof fee === 'string' ? fee.replace(/[,\s₹]/g, '') : fee;
  const amount = Number(rawFee);
  if (rawFee === '' || rawFee === null || rawFee === undefined || !Number.isInteger(amount) || amount < 1 || amount > PLAN_FEE_MAX) {
    throw new PlanError(400, `Amount must be a whole number of rupees between ₹1 and ${formatPlanFee(PLAN_FEE_MAX)}.`);
  }

  return {
    id,
    name: cleanName,
    fee: amount,
    label: `${cleanName} - ${formatPlanFee(amount)}`,
    builtIn: false,
    createdAt: new Date().toISOString(),
    createdBy,
  };
}

/** Adds an admin-defined plan. Throws PlanError on bad input or a clash. */
export async function createMembershipPlan(input, createdBy) {
  const plan = buildPlan(input, createdBy);

  const builtInClash = BUILT_IN_PLANS.find(p => p.id === plan.id || p.label === plan.label);
  if (builtInClash) {
    throw new PlanError(409, `"${builtInClash.name}" is already a membership type.`);
  }
  const existing = await listCustomPlans();
  if (existing.some(p => p.id === plan.id)) {
    throw new PlanError(409, `"${plan.name}" is already a membership type.`);
  }
  // Fast path with a clear message. The same cap is enforced again inside the
  // insert, under the plan lock, so this read-then-insert cannot be raced past
  // by two admins adding a tier at the same moment.
  if (existing.length >= MAX_CUSTOM_PLANS) throw new PlanError(409, tooManyPlansMessage());

  const inserted = await insertCustomPlan(plan, { max: MAX_CUSTOM_PLANS });
  if (!inserted.ok) {
    if (inserted.reason === 'limit') throw new PlanError(409, tooManyPlansMessage());
    throw new PlanError(409, `"${plan.name}" is already a membership type.`);
  }
  return publicPlan(plan);
}

/** Deletes an admin-added plan. Built-in plans cannot be deleted. */
export async function removeMembershipPlan(id) {
  const cleanId = planId(id);
  if (!cleanId) throw new PlanError(400, 'Membership type ID is required.');
  if (BUILT_IN_PLANS.some(p => p.id === cleanId)) {
    throw new PlanError(400, 'Built-in membership types cannot be deleted.');
  }
  if (!(await deleteCustomPlan(cleanId))) {
    throw new PlanError(404, 'Membership type not found.');
  }
}
