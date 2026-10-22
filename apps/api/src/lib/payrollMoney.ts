import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../middleware/error.js';
import { isInternallyScoped } from './scope.js';
import type { SessionUser } from '../types/express.js';

/**
 * Payroll dollars are the whole company's. An office account narrowed to
 * some sites or regions (User.scopeSiteIds / scopeRegionIds) may run the
 * people side of payroll — readiness, schedules, local tax rules — but
 * never reads a run, a paycheck, a paystub or a report, because each of
 * those carries amounts that span every site (system audit 2026-10-21,
 * Tier 1 #10). The executive view, the tax desk and the two payroll inbox
 * sources already refuse the same way; this is the rule for routes/payroll*.
 */
export const WHOLE_COMPANY_ONLY = 'whole_company_only';

export function payrollMoneyAllowed(user: SessionUser): boolean {
  // An associate reads their own paystubs (scoped per route); a site-bound office account reads no amounts.
  return user.role === 'ASSOCIATE' || !isInternallyScoped(user);
}

export function refuseSiteBoundMoney(): HttpError {
  return new HttpError(403, WHOLE_COMPANY_ONLY, 'Payroll amounts cover the whole company. Your access is limited to some sites, so ask a payroll admin with full access.');
}

/**
 * Router middleware: refuses money-bearing paths for a site-bound caller.
 * `allow` names the paths a site-bound office account may still use —
 * the ones with no amounts on them.
 */
export function payrollMoneyGate(allow: RegExp[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user || !isInternallyScoped(user)) return next();
    const path = req.path.replace(/\/+$/, '') || '/';
    if (allow.some((rx) => rx.test(path))) return next();
    next(refuseSiteBoundMoney());
  };
}

/** The payroll routes a site-bound office account may still reach (no amounts on them). */
export const PAYROLL_NO_MONEY_PATHS: RegExp[] = [
  /^\/readiness(\/|$)/,
  /^\/schedules(\/|$)/,
  /^\/config$/,
  /^\/local-tax-rules(\/|$)/,
  /^\/associates\/[^/]+\/local-tax-rule$/,
  /^\/associates\/[^/]+\/branch-enrollment$/,
  /^\/new-hire-report(\/|\.csv|$)/,
  /^\/disbursement\/webhook-status$/,
  /^\/period-ledger$/,
  /^\/me(\/|$)/,
];
