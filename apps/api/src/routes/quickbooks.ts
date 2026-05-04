import { Router } from 'express';
import {
  QboAccountConfigInputSchema,
  QboAccountListResponseSchema,
  QboSyncAssociatesResponseSchema,
  type QboAccountListResponse,
  type QboAuthorizeStartResponse,
  type QboStatus,
  type QboSyncAssociatesResponse,
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
  listQboAccounts,
  postPayrollJournalEntry,
  saveConnection,
  syncAssociateToQbo,
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
      jeMode: conn?.jeMode ?? 'AGGREGATE',
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
quickbooksRouter.get('/connect/callback', async (req, res) => {
  // Intuit lands the user's browser on this URL — any error here surfaces
  // directly on screen, so we never call next(err) (the JSON errorHandler
  // would dump a `{"error":...}` envelope onto the page). Redirect to the
  // SPA with an error code instead so the UI can toast it.
  const code = typeof req.query.code === 'string' ? req.query.code : null;
  const state = typeof req.query.state === 'string' ? req.query.state : null;
  const realmId =
    typeof req.query.realmId === 'string' ? req.query.realmId : null;
  if (!code || !state || !realmId) {
    return res.redirect(`${env.APP_BASE_URL}/clients?qbo_error=invalid_callback`);
  }
  const clientId = verifyState(state);
  if (!clientId) {
    return res.redirect(`${env.APP_BASE_URL}/clients?qbo_error=invalid_state`);
  }
  try {
    const tokens = await exchangeCode(code);
    await saveConnection(prisma, clientId, realmId, tokens);
    res.redirect(`${env.APP_BASE_URL}/clients/${clientId}?qbo=connected`);
  } catch (err) {
    console.error('[alto-people/api] qbo callback error:', err);
    res.redirect(`${env.APP_BASE_URL}/clients/${clientId}?qbo_error=connect_failed`);
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
 * GET /quickbooks/accounts/list?clientId=X
 * Wave 3.1 — fetches the QBO chart-of-accounts so the mapping UI can offer
 * a real dropdown of GL accounts. Stub mode returns 9 sample accounts.
 */
quickbooksRouter.get('/accounts/list', MANAGE, async (req, res, next) => {
  try {
    const clientId = req.query.clientId;
    if (typeof clientId !== 'string' || clientId.length === 0) {
      throw new HttpError(400, 'invalid_query', 'clientId is required');
    }
    const conn = await prisma.quickbooksConnection.findUnique({ where: { clientId } });
    if (!conn) throw new HttpError(404, 'not_connected', 'QuickBooks not connected for this client');
    const accounts = await listQboAccounts(prisma, clientId);
    const body: QboAccountListResponse = QboAccountListResponseSchema.parse({ accounts });
    res.json(body);
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

    const txnDate = run.disbursedAt ?? run.finalizedAt ?? new Date();
    const periodLabel = `${run.periodStart.toISOString().slice(0, 10)} – ${run.periodEnd
      .toISOString()
      .slice(0, 10)}`;

    try {
      let primaryJournalId: string;

      if (conn.jeMode === 'PER_EMPLOYEE') {
        // Wave 5.2 — one JE per item, EmployeeRef on every line. Requires
        // every associate has been synced to QBO first; we fail-fast if
        // any aren't, rather than skipping silently and producing an
        // unbalanced ledger.
        const items = await prisma.payrollItem.findMany({
          take: 100,
          where: { payrollRunId: run.id },
          include: {
            associate: {
              select: {
                firstName: true,
                lastName: true,
                employmentType: true,
                qboEmployeeId: true,
                qboVendorId: true,
              },
            },
          },
        });
        const missing = items.filter((i) => {
          const isW2 = i.associate.employmentType === 'W2_EMPLOYEE';
          return isW2 ? !i.associate.qboEmployeeId : !i.associate.qboVendorId;
        });
        if (missing.length > 0) {
          throw new HttpError(
            409,
            'qbo_associates_not_synced',
            `${missing.length} associate(s) need to be synced to QuickBooks before per-employee JE posting. Run "Sync associates to QuickBooks" first.`
          );
        }

        const ids: string[] = [];
        for (const i of items) {
          const totals = aggregateRunForJournalEntry([i]);
          const isW2 = i.associate.employmentType === 'W2_EMPLOYEE';
          const refValue = isW2 ? i.associate.qboEmployeeId! : i.associate.qboVendorId!;
          const result = await postPayrollJournalEntry(prisma, run.clientId, {
            txnDate,
            memo: `Payroll ${periodLabel} — ${i.associate.firstName} ${i.associate.lastName}`,
            ...totals,
            entityRef: { type: isW2 ? 'Employee' : 'Vendor', value: refValue },
          });
          ids.push(result.journalEntryId);
        }
        primaryJournalId = ids[0] ?? '';
        // Persist all ids in a comma-joined string on the legacy field so
        // existing UI keeps working; the count is recoverable from split.
        await prisma.payrollRun.update({
          where: { id: run.id },
          data: {
            qboJournalEntryId: ids.join(','),
            qboSyncedAt: new Date(),
            qboSyncError: null,
          },
        });
      } else {
        const totals = aggregateRunForJournalEntry(run.items);
        const result = await postPayrollJournalEntry(prisma, run.clientId, {
          txnDate,
          memo: `Payroll ${periodLabel}`,
          ...totals,
        });
        primaryJournalId = result.journalEntryId;
        await prisma.payrollRun.update({
          where: { id: run.id },
          data: {
            qboJournalEntryId: result.journalEntryId,
            qboSyncedAt: new Date(),
            qboSyncError: null,
          },
        });
      }

      await recordPayrollEvent({
        actorUserId: req.user!.id,
        action: 'payroll.qbo_synced',
        payrollRunId: run.id,
        clientId: run.clientId,
        metadata: {
          journalEntryId: primaryJournalId,
          jeMode: conn.jeMode,
          stubMode: isStubMode(),
        },
        req,
      });
      const body: QboSyncResponse = {
        journalEntryId: primaryJournalId,
        syncedAt: new Date().toISOString(),
      };
      res.json(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await prisma.payrollRun.update({
        where: { id: run.id },
        data: { qboSyncError: msg.slice(0, 500) },
      });
      if (err instanceof HttpError) throw err;
      throw new HttpError(502, 'qbo_post_failed', `QuickBooks rejected the post: ${msg}`);
    }
  } catch (err) {
    next(err);
  }
});

/**
 * POST /quickbooks/sync-associates { clientId }
 * Wave 3.2 — pushes every active associate at the client to QBO as either
 * an Employee (W2) or Vendor (1099). Skips already-synced records that
 * haven't changed; per-record failures don't abort the batch.
 */
quickbooksRouter.post('/sync-associates', MANAGE, async (req, res, next) => {
  try {
    const clientId =
      typeof req.body?.clientId === 'string' ? req.body.clientId : null;
    if (!clientId) {
      throw new HttpError(400, 'invalid_body', 'clientId is required');
    }
    const conn = await prisma.quickbooksConnection.findUnique({ where: { clientId } });
    if (!conn) {
      throw new HttpError(409, 'qbo_not_connected', 'QuickBooks not connected for this client');
    }

    // Pull all active associates currently working at this client. Two
    // scopes possible: by application.clientId (HR's view) or by recent
    // shifts. We use applications because that's the canonical "who works
    // here" relationship; LIVE_ASN-style operational mappings are a
    // separate phase.
    const associates = await prisma.associate.findMany({
      take: 1000,
      where: {
        deletedAt: null,
        applications: { some: { clientId, deletedAt: null } },
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        state: true,
        zip: true,
        employmentType: true,
        qboEmployeeId: true,
        qboVendorId: true,
      },
    });

    let synced = 0;
    let failed = 0;
    const errors: Array<{ associateId: string; name: string; reason: string }> = [];
    for (const a of associates) {
      try {
        const result = await syncAssociateToQbo(prisma, clientId, a);
        if (result.changed) synced += 1;
      } catch (err) {
        failed += 1;
        errors.push({
          associateId: a.id,
          name: `${a.firstName} ${a.lastName}`,
          reason: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
        });
      }
    }

    const body: QboSyncAssociatesResponse = QboSyncAssociatesResponseSchema.parse({
      scanned: associates.length,
      synced,
      failed,
      errors,
    });
    res.json(body);
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
