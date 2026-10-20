import { Router } from 'express';
import { PayrollGoLiveSchema } from '@alto-people/shared';
import { prisma } from '../db.js';
import { payrollGoLive } from '../lib/payrollGoLive.js';

/** GET /payroll/go-live — running payroll in-house: what's set up, what's missing (lib/payrollGoLive). */
export const payrollGoLiveRouter = Router();

payrollGoLiveRouter.get('/', async (_req, res, next) => {
  try {
    res.json(PayrollGoLiveSchema.parse(await payrollGoLive(prisma)));
  } catch (err) {
    next(err);
  }
});
