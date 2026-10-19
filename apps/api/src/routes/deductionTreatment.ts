import { Router } from 'express';
import { prisma } from '../db.js';
import { requireCapability } from '../middleware/auth.js';
import { scopeActiveAssociates, scopeWhere } from '../lib/scope.js';
import { tenantIdForWrite } from '../lib/tenant.js';
import { CODES, UNVERIFIED, sitExempt, suiExempt, NO_WAGE_INCOME_TAX, type DeductionCode } from '../lib/deductionTaxability.js';

/**
 * GET /payroll/deduction-treatment — how each pre-tax deduction is taxed in
 * the states this company's people live in (lib/deductionTaxability), and
 * where the treatment is the federal fallback without a source behind it,
 * for payroll to confirm with its tax adviser. Shown on the state tax page.
 */
export const deductionTreatmentRouter = Router();

const PRE_TAX: DeductionCode[] = ['RET_401K', 'RET_403B', 'RET_457B', 'MEDICAL', 'DENTAL', 'VISION', 'HSA', 'HEALTH_FSA', 'DCAP', 'LIFE', 'DISABILITY'];

deductionTreatmentRouter.get('/payroll/deduction-treatment', requireCapability('process:payroll'), async (req, res) => {
  const people = await prisma.associate.groupBy({
    by: ['state'],
    where: scopeWhere(scopeActiveAssociates(req.user!), { tenantId: tenantIdForWrite(), employmentType: 'W2_EMPLOYEE' }),
    _count: { _all: true },
  });
  const peopleBy = new Map(people.filter((p) => p.state).map((p) => [p.state!.toUpperCase(), p._count._all]));
  const states = [...peopleBy.keys()].sort();
  // Where a state taxes a deduction the federal rules don't (PA 401(k), NJ §125/HSA, CA HSA …).
  const differences = states.flatMap((st) =>
    PRE_TAX.flatMap((code) => {
      const out: Array<{ state: string; code: string; label: string; base: 'Income tax' | 'Unemployment'; taxed: true }> = [];
      if (!NO_WAGE_INCOME_TAX.has(st) && !sitExempt(code, st)) out.push({ state: st, code, label: CODES[code].label, base: 'Income tax', taxed: true });
      if (CODES[code].kind !== 'DEFERRAL' && !suiExempt(code, st)) out.push({ state: st, code, label: CODES[code].label, base: 'Unemployment', taxed: true });
      return out;
    }),
  );
  res.json({
    differences,
    unverified: UNVERIFIED.map((u) => ({ ...u, people: peopleBy.get(u.state) ?? 0 })).sort((a, b) => b.people - a.people || a.state.localeCompare(b.state)),
  });
});
