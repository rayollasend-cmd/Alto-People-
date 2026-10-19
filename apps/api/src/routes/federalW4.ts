import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import { assertAssociateInScope } from '../lib/scope.js';
import { enqueueAudit } from '../lib/audit.js';
import { federalW4Fields } from '../lib/payrollTax.js';

/**
 * The federal W-4 facts payroll records that the worker's own W-4 form
 * doesn't carry: an "Exempt" claim and its year, nonresident-alien status,
 * a 2019-or-earlier W-4 never replaced, and an IRS lock-in letter. Payroll
 * (process:payroll) only; every change is audited.
 *
 *   GET /payroll/federal-w4/:associateId   what withholding reads today
 *   PUT /payroll/federal-w4/:associateId   set any of the facts
 */
export const federalW4Router = Router();

const PROCESS = requireCapability('process:payroll');

const Body = z
  .object({
    exempt: z.boolean().optional(),
    exemptTaxYear: z.number().int().min(2020).max(2100).nullable().optional(),
    nonresidentAlien: z.boolean().optional(),
    pre2020Allowances: z.number().int().min(0).max(99).nullable().optional(),
    lockIn: z
      .object({
        filingStatus: z.enum(['SINGLE', 'MARRIED_FILING_JOINTLY', 'HEAD_OF_HOUSEHOLD']),
        multipleJobs: z.boolean().default(false),
        effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .nullable()
      .optional(),
  })
  .strict();

async function load(associateId: string) {
  const w4 = await prisma.w4Submission.findUnique({ where: { associateId } });
  if (!w4) throw new HttpError(404, 'no_w4', 'This person has no W-4 on file yet.');
  return w4;
}

function view(w4: Awaited<ReturnType<typeof load>>) {
  const reads = federalW4Fields(w4, new Date());
  return {
    exempt: w4.exempt,
    exemptTaxYear: w4.exemptTaxYear,
    nonresidentAlien: w4.nonresidentAlien,
    pre2020Allowances: w4.pre2020Allowances,
    lockIn: w4.lockInFilingStatus
      ? { filingStatus: w4.lockInFilingStatus, multipleJobs: !!w4.lockInMultipleJobs, effectiveDate: w4.lockInEffectiveDate?.toISOString().slice(0, 10) ?? null }
      : null,
    /** How withholding reads the W-4 today (exempt expiry and lock-in applied). */
    effective: reads,
  };
}

federalW4Router.get('/:associateId', PROCESS, async (req, res, next) => {
  try {
    const associateId = z.string().uuid().parse(req.params.associateId);
    await assertAssociateInScope(prisma, req.user!, associateId);
    res.json(view(await load(associateId)));
  } catch (err) {
    next(err);
  }
});

federalW4Router.put('/:associateId', PROCESS, async (req, res, next) => {
  try {
    const associateId = z.string().uuid().parse(req.params.associateId);
    await assertAssociateInScope(prisma, req.user!, associateId);
    const body = Body.parse(req.body ?? {});
    const before = await load(associateId);
    const updated = await prisma.w4Submission.update({
      where: { associateId },
      data: {
        ...(body.exempt !== undefined ? { exempt: body.exempt, exemptTaxYear: body.exempt ? (body.exemptTaxYear ?? new Date().getUTCFullYear()) : null } : {}),
        ...(body.exemptTaxYear !== undefined && body.exempt === undefined ? { exemptTaxYear: body.exemptTaxYear } : {}),
        ...(body.nonresidentAlien !== undefined ? { nonresidentAlien: body.nonresidentAlien } : {}),
        ...(body.pre2020Allowances !== undefined ? { pre2020Allowances: body.pre2020Allowances } : {}),
        ...(body.lockIn !== undefined
          ? body.lockIn
            ? { lockInFilingStatus: body.lockIn.filingStatus, lockInMultipleJobs: body.lockIn.multipleJobs, lockInEffectiveDate: new Date(`${body.lockIn.effectiveDate}T00:00:00Z`), lockInReceivedAt: new Date() }
            : { lockInFilingStatus: null, lockInMultipleJobs: null, lockInEffectiveDate: null, lockInReceivedAt: null }
          : {}),
      },
    });
    enqueueAudit(
      {
        actorUserId: req.user!.id,
        clientId: null,
        action: 'payroll.federal_w4_updated',
        entityType: 'W4Submission',
        entityId: updated.id,
        metadata: JSON.parse(JSON.stringify({ associateId, before: view(before), after: { exempt: updated.exempt, nonresidentAlien: updated.nonresidentAlien, pre2020Allowances: updated.pre2020Allowances, lockIn: updated.lockInFilingStatus } })),
      },
      'federalW4.update',
    );
    res.json(view(updated));
  } catch (err) {
    next(err);
  }
});
