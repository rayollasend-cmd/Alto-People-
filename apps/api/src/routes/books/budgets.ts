import { Router, type Request } from 'express';
import { z } from 'zod';
import { BudgetCreateInputSchema, BudgetFromActualsInputSchema, BudgetLinesInputSchema, BudgetUpdateInputSchema } from '@alto-people/shared';
import { prisma } from '../../db.js';
import { HttpError } from '../../middleware/error.js';
import { requireCapability } from '../../middleware/auth.js';
import { enqueueAudit } from '../../lib/audit.js';
import { getBrandingSync } from '../../lib/branding.js';
import { budgetDetail, budgetFromActuals, budgetVsActual, createBudget, deleteBudget, listBudgets, setBudgetLines, updateBudget } from '../../lib/books/budgets/budgets.js';
import { renderBudgetVsActualXlsx } from '../../lib/books/budgets/xlsx.js';

/** /books/budgets — budgets and budget vs actual (lib/books/budgets). */
export const booksBudgetsRouter = Router();
const MANAGE = requireCapability('manage:books');
const UUID = z.string().uuid();
const id = (req: Request) => {
  const r = UUID.safeParse(req.params.id);
  if (!r.success) throw new HttpError(404, 'budget_not_found', 'Budget not found.');
  return r.data;
};
const audit = (req: Request, action: string, entityId: string, metadata: Record<string, unknown>) =>
  enqueueAudit({ actorUserId: req.user!.id, clientId: null, action, entityType: 'Budget', entityId, metadata: metadata as never }, 'books.budgets');

/** Through the last month that has ended, or the month asked for. */
function through(req: Request, year: number): string {
  const q = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional().parse(req.query.through || undefined);
  if (q) return q;
  const now = new Date();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  if (last < `${year}-01`) return `${year - 1}-12`;
  return last > `${year}-12` ? `${year}-12` : last;
}

booksBudgetsRouter.get('/', async (_req, res) => {
  res.json(await listBudgets(prisma));
});

booksBudgetsRouter.post('/', MANAGE, async (req, res) => {
  const input = BudgetCreateInputSchema.parse(req.body);
  const budget = await createBudget(prisma, input, req.user!.id);
  audit(req, 'books.budget.created', budget.id, { name: budget.name, fiscalYear: budget.fiscalYear, fromActuals: input.fromActuals ?? null });
  res.status(201).json({ budget });
});

booksBudgetsRouter.get('/:id', async (req, res) => {
  res.json({ budget: await budgetDetail(prisma, id(req)) });
});

booksBudgetsRouter.patch('/:id', MANAGE, async (req, res) => {
  const input = BudgetUpdateInputSchema.parse(req.body);
  const { budget, demoted } = await updateBudget(prisma, id(req), input);
  audit(req, 'books.budget.updated', budget.id, { ...input, demoted });
  res.json({ budget, demoted });
});

booksBudgetsRouter.delete('/:id', MANAGE, async (req, res) => {
  await deleteBudget(prisma, id(req));
  audit(req, 'books.budget.deleted', id(req), {});
  res.status(204).end();
});

booksBudgetsRouter.put('/:id/lines', MANAGE, async (req, res) => {
  const input = BudgetLinesInputSchema.parse(req.body);
  const budget = await setBudgetLines(prisma, id(req), input);
  audit(req, 'books.budget.lines', budget.id, { lines: input.lines.length });
  res.json({ budget });
});

booksBudgetsRouter.post('/:id/from-actuals', MANAGE, async (req, res) => {
  const { growthPct } = BudgetFromActualsInputSchema.parse(req.body ?? {});
  const budget = await budgetFromActuals(prisma, id(req), growthPct);
  audit(req, 'books.budget.from_actuals', budget.id, { growthPct });
  res.json({ budget });
});

booksBudgetsRouter.get('/:id/vs-actual', async (req, res) => {
  const b = await budgetDetail(prisma, id(req));
  res.json(await budgetVsActual(prisma, b.id, through(req, b.fiscalYear)));
});

booksBudgetsRouter.get('/:id/vs-actual.xlsx', async (req, res) => {
  const b = await budgetDetail(prisma, id(req));
  const report = await budgetVsActual(prisma, b.id, through(req, b.fiscalYear));
  const xlsx = await renderBudgetVsActualXlsx(report, { company: getBrandingSync().orgName, budgetName: b.name });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="budget-vs-actual-${b.fiscalYear}-through-${report.through}.xlsx"`);
  res.send(xlsx);
});
