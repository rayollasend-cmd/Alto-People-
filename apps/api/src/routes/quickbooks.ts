import { Router } from 'express';
import {
  QboAccountConfigInputSchema,
  type QboAuthorizeStartResponse,
  type QboStatus,
  type QboSyncResponse,
} from '@alto-people/shared';
import { prisma } from '../db.js';
import { env } from '../config/env.js';
import { HttpError } from '../middleware/error.js';
import { requireCapability } from '../middleware/auth.js';
import {
  buildAuthorizeUrl,
  exchangeCode,
  isStubMode,
  postPayrollJournalEntry,
  saveConnection,
  verifyState,
} from '../lib/quickbooks.js';
import { recordPayrollEvent } from '../lib/audit.js';

export const quickbooksRouter = Router();

const MANAGE = requireCapability('process:payroll');
const VIEW = requireCapability('view:payroll');

/**
 * GET /quickbooks/status?clientId=X
 * Connection state for the UI badge + the account-mapping form. Returns
 * connected:false when no connection exists or when stub mode is on
 * without a row to back it.
 */
quickbooksRouter.get('/status', VIEW, async (req, res, next) => {
  try {
    const clientId = req.query.clientId;
    if (typeof clientId !== 'string' || clientId.length === 0) {
      throw new HttpError(400, 'invalid_query', 'clientId is required');
    }
    const conn = await prisma.quickbooksConnection.findUnique({
      where: { clientId },
    });
    const body: QboStatus = {
      connected: !!conn,
      realmId: conn?.realmId ?? null,
      expiresAt: conn?.expiresAt ? conn.expiresAt.toISOString() : null,
      lastRefreshedAt: conn?.lastRefreshedAt
        ? conn.lastRefreshedAt.toISOString()
        : null,
      stubMode: isStubMode(),
      accountSalariesExpense: conn?.accountSalariesExpense ?? null,
      accountFederalTaxPayable: conn?.accountFederalTaxPayable ?? null,
      accountStateTaxPayable: conn?.accountStateTaxPayable ?? null,
      accountFicaPayable: conn?.accountFicaPayable ?? null,
      accountMedicarePayable: conn?.accountMedicarePayable ?? null,
      accountBenefitsPayable: conn?.accountBenefitsPayable ?? null,
      accountNetPayPayable: conn?.accountNetPayPayable ?? null,
    };
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /quickbooks/connect/start { clientId }
 * Returns the Intuit authorize URL the browser should redirect to. The
 * `state` parameter encodes the targetClientId so the callback knows
 * where to attach the connection.
 */
quickbooksRouter.post('/connect/start', MANAGE, async (req, res, next) => {
  try {
    const clientId =
      typeof req.body?.clientId === 'string' ? req.body.clientId : null;
    if (!clientId) {
      throw new HttpError(400, 'invalid_body', 'clientId is required');
    }
    const client = await prisma.client.findFirst({
      where: { id: clientId, deletedAt: null },
      select: { id: true },
    });
    if (!client) throw new HttpError(404, 'client_not_found', 'Client not found');

    const body: QboAuthorizeStartResponse = buildAuthorizeUrl(clientId);
    res.json(body);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /quickbooks/connect/callback?code=...&state=...&realmId=...
 * Intuit redirects the browser here after the user grants access.
 * Validates the signed state, exchanges the code for tokens, persists the
 * connection (encrypting both tokens), then redirects the browser back to
 * the client detail page.
 */
quickbooksRouter.get('/connect/callback', async (req, res, next) => {
  try {
    const code = typeof req.query.code === 'string' ? req.query.code : null;
    const state = typeof req.query.state === 'string' ? req.query.state : null;
    const realmId =
      typeof req.query.realmId === 'string' ? req.query.realmId : null;
    if (!code || !state || !realmId) {
      throw new HttpError(400, 'invalid_callback', 'Missing code, state, or realmId');
    }
    const clientId = verifyState(state);
    if (!clientId) {
      throw new HttpError(400, 'invalid_state', 'State signature mismatch');
    }
    const tokens = await exchangeCode(code);
    await saveConnection(prisma, clientId, realmId, tokens);
    // Redirect the browser back to the client detail page so the UI can
    // re-fetch /status and show "connected".
    res.redirect(`${env.APP_BASE_URL}/clients/${clientId}?qbo=connected`);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /quickbooks/disconnect { clientId }
 * Drops the connection row. Note: this does NOT revoke the token at
 * Intuit's end — HR can do that from the QBO admin console if needed.
 * For our purposes, deleting the row is enough to stop posting JEs.
 */
quickbooksRouter.post('/disconnect', MANAGE, async (req, res, next) => {
  try {
    const clientId =
      typeof req.body?.clientId === 'string' ? req.body.clientId : null;
    if (!clientId) {
      throw new HttpError(400, 'invalid_body', 'clientId is required');
    }
    await prisma.quickbooksConnection
      .delete({ where: { clientId } })
      .catch(() => {
        // Already disconnected — idempotent no-op.
      });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /quickbooks/accounts { clientId, ...accountRefs }
 * Configures the QBO account refs used by JournalEntry lines. HR pulls
 * these from their QBO chart-of-accounts (Account.Id values).
 */
quickbooksRouter.patch('/accounts', MANAGE, async (req, res, next) => {
  try {
    const clientId =
      typeof req.body?.clientId === 'string' ? req.body.clientId : null;
    if (!clientId) {
      throw new HttpError(400, 'invalid_body', 'clientId is required');
    }
    const parsed = QboAccountConfigInputSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new HttpError(400, 'invalid_body', 'Invalid request body', parsed.error.flatten());
    }
    const updated = await prisma.quickbooksConnection.update({
      where: { clientId },
      data: parsed.data,
    });
    res.json({ ok: true, accountSalariesExpense: updated.accountSalariesExpense });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /quickbooks/sync-run/:runId
 * Manually post (or re-post) a payroll run as a JournalEntry. Idempotency:
 * we don't refuse if qboJournalEntryId is already set — re-syncing is
 * sometimes necessary after fixing a typo in account refs. The most
 * recent JE id wins.
 */
quickbooksRouter.post('/sync-run/:runId', MANAGE, async (req, res, next) => {
  try {
    const run = await prisma.payrollRun.findUnique({
      where: { id: req.params.runId },
      include: { items: true },
    });
    if (!run) throw new HttpError(404, 'run_not_found', 'Payroll run not found');
    if (run.status === 'DRAFT') {
      throw new HttpError(
        409,
        'run_not_finalized',
        'Run must be FINALIZED or DISBURSED before posting to QuickBooks'
      );
    }
    if (!run.clientId) {
      throw new HttpError(
        409,
        'no_client',
        'Cross-client runs cannot post to a single QuickBooks company'
      );
    }
    const conn = await prisma.quickbooksConnection.findUnique({
      where: { clientId: run.clientId },
    });
    if (!conn) {
      throw new HttpError(
        409,
        'qbo_not_connected',
        'This client has no QuickBooks connection. Connect first.'
      );
    }

    const totals = aggregateRunForJournalEntry(run.items);
    const txnDate = run.disbursedAt ?? run.finalizedAt ?? new Date();
    try {
      const result = await postPayrollJournalEntry(prisma, run.clientId, {
        txnDate,
        memo: `Payroll ${run.periodStart.toISOString().slice(0, 10)} – ${run.periodEnd
          .toISOString()
          .slice(0, 10)}`,
        ...totals,
      });
      const updated = await prisma.payrollRun.update({
        where: { id: run.id },
        data: {
          qboJournalEntryId: result.journalEntryId,
          qboSyncedAt: new Date(),
          qboSyncError: null,
        },
      });
      await recordPayrollEvent({
        actorUserId: req.user!.id,
        action: 'payroll.qbo_synced',
        payrollRunId: run.id,
        clientId: run.clientId,
        metadata: { journalEntryId: result.journalEntryId, stubMode: isStubMode() },
        req,
      });
      const body: QboSyncResponse = {
        journalEntryId: result.journalEntryId,
        syncedAt: updated.qboSyncedAt!.toISOString(),
      };
      res.json(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await prisma.payrollRun.update({
        where: { id: run.id },
        data: { qboSyncError: msg.slice(0, 500) },
      });
      throw new HttpError(502, 'qbo_post_failed', `QuickBooks rejected the post: ${msg}`);
    }
  } catch (err) {
    next(err);
  }
});

interface RunItem {
  grossPay: { toString(): string } | number;
  federalWithholding: { toString(): string } | number;
  fica: { toString(): string } | number;
  medicare: { toString(): string } | number;
  stateWithholding: { toString(): string } | number;
  preTaxDeductions: { toString(): string } | number;
  netPay: { toString(): string } | number;
  employerFica: { toString(): string } | number;
  employerMedicare: { toString(): string } | number;
  employerFuta: { toString(): string } | number;
  employerSuta: { toString(): string } | number;
}

function aggregateRunForJournalEntry(items: RunItem[]) {
  let totalGross = 0;
  let totalFederal = 0;
  let totalState = 0;
  let totalFica = 0;
  let totalMedicare = 0;
  let totalBenefits = 0;
  let totalNet = 0;
  let totalEmployerTax = 0;
  for (const i of items) {
    totalGross += Number(i.grossPay);
    totalFederal += Number(i.federalWithholding);
    totalState += Number(i.stateWithholding);
    totalFica += Number(i.fica) + Number(i.employerFica);
    totalMedicare += Number(i.medicare) + Number(i.employerMedicare);
    totalBenefits += Number(i.preTaxDeductions);
    totalNet += Number(i.netPay);
    totalEmployerTax +=
      Number(i.employerFica) +
      Number(i.employerMedicare) +
      Number(i.employerFuta) +
      Number(i.employerSuta);
  }
  return {
    totalGross,
    totalEmployerTax,
    totalFederal,
    totalState,
    totalFica,
    totalMedicare,
    totalBenefits,
    totalNet,
  };
}
