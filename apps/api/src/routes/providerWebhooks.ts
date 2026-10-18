import { Router, raw } from 'express';
import { z } from 'zod';
import type { ProviderConnection, ProviderKind } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../lib/logger.js';
import { runWithTenant, ALTO_TENANT_ID } from '../lib/tenant.js';
import { contextFor, finishEvent, recordFailure, recordInboundEvent, recordSuccess, type ProviderContext } from '../lib/providers/connections.js';
import { everifyAdapter, mapEVerifyStatus } from '../lib/providers/everify.js';
import { screeningAdapter } from '../lib/providers/screening.js';
import { drugTestAdapter } from '../lib/providers/drugTesting.js';
import { taxFilingAdapter } from '../lib/providers/taxFiling.js';
import { parseWiseWebhook } from '../lib/providers/payouts.js';
import { originationProviderFor } from '../lib/banking/origination.js';
import { applyOriginationEvents } from '../lib/banking/events.js';
import { ProviderError } from '../lib/providers/http.js';
import { applyDrugStatus, applyEVerifyState, applyFiling, applyPayoutState, applyScreeningReport } from '../lib/providers/apply.js';
import { notifyCompliance } from '../lib/providers/notices.js';

/**
 * POST /webhooks/providers/:connectionId — every provider calls back here.
 *
 * Mounted before express.json() so the exact bytes survive for the
 * signature. The connection says which provider and tenant; its adapter
 * verifies the signature (401, nothing written, when it doesn't match);
 * the event is recorded once on (connection, provider event id) — a
 * re-delivery answers 200 { duplicate: true } and changes nothing — then
 * applied to the record it names. An unknown subject is logged as IGNORED
 * with 200, so providers don't retry forever across environments.
 */
export const providerWebhooksRouter = Router();

interface Applied {
  status: 'PROCESSED' | 'IGNORED';
  subjectType?: string;
  subjectId?: string | null;
  note?: string;
}

async function handle(conn: ProviderConnection, ctx: ProviderContext, body: Buffer, headers: Record<string, string | undefined>): Promise<{ eventId: string; eventType: string; payload: unknown; apply: () => Promise<Applied> }> {
  const kind = conn.kind;
  if (kind === 'EVERIFY') {
    const adapter = everifyAdapter(conn.provider);
    const e = adapter.parseWebhook?.(ctx, body, headers);
    if (!e) throw new ProviderError('This provider does not send webhooks.', 404, 'no_webhooks');
    return {
      eventId: e.eventId,
      eventType: 'case.updated',
      payload: { caseNumber: e.caseNumber, status: e.rawStatus },
      apply: async () => {
        const i9 = await prisma.i9Verification.findFirst({ where: { eVerifyCaseNumber: e.caseNumber, tenantId: conn.tenantId }, select: { id: true, associateId: true, eVerifyStatus: true } });
        if (!i9) return { status: 'IGNORED', note: 'unknown_case' };
        const m = mapEVerifyStatus(e.rawStatus);
        await applyEVerifyState(i9.id, { caseNumber: e.caseNumber, rawStatus: e.rawStatus, status: m.status, closed: m.closed }, conn.id);
        if (m.status === 'TENTATIVE_NONCONFIRMATION' && i9.eVerifyStatus !== 'TENTATIVE_NONCONFIRMATION') {
          await notifyCompliance('An E-Verify mismatch needs you', 'E-Verify returned a Tentative Nonconfirmation. Give the employee the notice and record their choice.', `/compliance?tab=everify&associateId=${i9.associateId}`);
        }
        return { status: 'PROCESSED', subjectType: 'I9Verification', subjectId: i9.id };
      },
    };
  }
  if (kind === 'BACKGROUND_CHECK') {
    const e = screeningAdapter(conn.provider).parseWebhook(ctx, body, headers);
    return {
      eventId: e.eventId,
      eventType: e.type,
      payload: { type: e.type, status: e.rawStatus, result: e.result },
      apply: async () => {
        const ids = [e.objectId, e.reportId].filter((x): x is string => !!x);
        const check = await prisma.backgroundCheck.findFirst({ where: { tenantId: conn.tenantId, externalId: { in: ids } }, select: { id: true, status: true } });
        if (!check) return { status: 'IGNORED', note: 'unknown_check' };
        await applyScreeningReport(check.id, {
          externalId: e.reportId ?? e.objectId,
          rawStatus: e.rawStatus,
          result: e.result,
          complete: e.rawStatus === 'complete',
        });
        if (e.rawStatus === 'complete' && e.result === 'consider') {
          await notifyCompliance('A background check needs a decision', 'A report came back “consider”. Review it before deciding — adverse action has required steps.', '/compliance?tab=background');
        }
        return { status: 'PROCESSED', subjectType: 'BackgroundCheck', subjectId: check.id };
      },
    };
  }
  if (kind === 'DRUG_TEST') {
    const e = drugTestAdapter(conn.provider).parseWebhook(ctx, body, headers);
    return {
      eventId: e.eventId,
      eventType: 'order.updated',
      payload: { status: e.rawStatus, result: e.resultCode, mroVerified: e.mroVerified },
      apply: async () => {
        const t = await prisma.drugTest.findFirst({ where: { tenantId: conn.tenantId, externalId: e.externalId }, select: { id: true } });
        if (!t) return { status: 'IGNORED', note: 'unknown_order' };
        await applyDrugStatus(t.id, e);
        if (e.resultCode && e.resultCode !== 'NEGATIVE') {
          await notifyCompliance('A drug test result needs review', 'A result came back that is not a verified negative. Review it before any decision.', '/compliance?tab=drug-tests');
        }
        return { status: 'PROCESSED', subjectType: 'DrugTest', subjectId: t.id };
      },
    };
  }
  if (kind === 'TAX_FILING') {
    const e = taxFilingAdapter(conn.provider).parseWebhook(ctx, body, headers);
    return {
      eventId: e.eventId,
      eventType: 'efile.status_change',
      payload: { submissionId: e.submissionId, records: e.records.map((r) => ({ status: r.status })) },
      apply: async () => {
        const forms = await prisma.taxForm.findMany({ where: { tenantId: conn.tenantId, efileSubmissionId: e.submissionId }, select: { id: true, efileRecordId: true } });
        if (!forms.length) return { status: 'IGNORED', note: 'unknown_submission' };
        for (const f of forms) {
          const rec = e.records.find((r) => r.recordId && r.recordId === f.efileRecordId) ?? (forms.length === 1 ? e.records[0] : undefined);
          if (rec) await applyFiling(f.id, { status: rec.status, rejectionReason: rec.reason, recordId: rec.recordId || null }, null);
        }
        return { status: 'PROCESSED', subjectType: 'TaxForm', subjectId: forms[0]!.id };
      },
    };
  }
  if (kind === 'ORIGINATION') {
    const events = originationProviderFor(ctx).parseWebhook(body, headers);
    if (!events.length) throw new ProviderError('Nothing in this event applies.', 400, 'no_events');
    return {
      eventId: events.map((x) => x.eventId).join(',').slice(0, 190),
      eventType: `ach.${events[0]!.kind.toLowerCase()}`,
      payload: { events: events.map((x) => ({ kind: x.kind, ref: x.externalRef, code: 'code' in x ? x.code : undefined })) },
      apply: async () => {
        const r = await applyOriginationEvents(prisma, events);
        return r.applied ? { status: 'PROCESSED', subjectType: 'AchEntry', subjectId: r.subjectId } : { status: 'IGNORED', note: 'unknown_entry' };
      },
    };
  }
  // PAYOUT
  const e = parseWiseWebhook(ctx, body, headers);
  return {
    eventId: e.eventId,
    eventType: 'transfers#state-change',
    payload: { transferId: e.transferId, state: e.currentState, previous: e.previousState },
    apply: async () => {
      const r = await applyPayoutState(e.transferId, e.currentState);
      return r.payrollItemId ? { status: r.applied ? 'PROCESSED' : 'IGNORED', subjectType: 'PayrollItem', subjectId: r.payrollItemId, note: r.note } : { status: 'IGNORED', note: r.note };
    },
  };
}

providerWebhooksRouter.post('/:connectionId', raw({ type: () => true, limit: '512kb' }), async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.connectionId);
  if (!id.success) {
    res.status(404).json({ error: 'unknown_connection' });
    return;
  }
  const conn = await prisma.providerConnection.findUnique({ where: { id: id.data } });
  if (!conn) {
    res.status(404).json({ error: 'unknown_connection' });
    return;
  }
  const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v])) as Record<string, string | undefined>;

  await runWithTenant(conn.tenantId ?? ALTO_TENANT_ID, 'job', async () => {
    const ctx = contextFor(conn);
    let parsed: Awaited<ReturnType<typeof handle>>;
    try {
      parsed = await handle(conn, ctx, body, headers);
    } catch (err) {
      const status = err instanceof ProviderError && err.status === 401 ? 401 : err instanceof SyntaxError ? 400 : err instanceof ProviderError && err.status ? err.status : 400;
      if (status === 401) logger.warn({ connectionId: conn.id, provider: conn.provider }, 'provider webhook: bad signature');
      res.status(status).json({ error: status === 401 ? 'invalid_signature' : 'invalid_payload' });
      return;
    }
    const event = await recordInboundEvent({ connection: ctx, kind: conn.kind as ProviderKind, eventType: parsed.eventType, externalId: parsed.eventId, payload: parsed.payload });
    if (!event) {
      res.json({ ok: true, duplicate: true });
      return;
    }
    if (!conn.active) {
      await finishEvent(event.id, { status: 'IGNORED', error: 'connection_paused' });
      res.json({ ok: true, ignored: 'connection_paused' });
      return;
    }
    try {
      const out = await parsed.apply();
      await finishEvent(event.id, { status: out.status, subjectType: out.subjectType, subjectId: out.subjectId ?? null, error: out.status === 'IGNORED' ? (out.note ?? null) : null });
      await recordSuccess(conn.id);
      res.json({ ok: true, ...(out.status === 'IGNORED' ? { ignored: out.note } : {}) });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not apply the update.';
      await recordFailure(conn.id, `A webhook could not be applied: ${message}`);
      logger.error({ err, connectionId: conn.id }, 'provider webhook: apply failed');
      // 500 so the provider retries; the event row is reset so the retry is not a "duplicate".
      await prisma.providerEvent.delete({ where: { id: event.id } }).catch(() => undefined);
      res.status(500).json({ error: 'apply_failed' });
    }
  });
});
