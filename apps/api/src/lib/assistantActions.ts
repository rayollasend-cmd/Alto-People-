import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { can } from '@alto-people/shared';
import { env } from '../config/env.js';
import { prisma } from '../db.js';
import type { SessionUser } from '../types/express.js';
import { enqueueAudit } from './audit.js';
import { ENTITY_COLUMNS, AGGREGATE_FNS, FILTER_OPS } from './reportRun.js';
import { tenantIdForWrite } from './tenant.js';
import { dayBoundsInTz, orgTimeZone, todayInTz } from './siteDay.js';
import { addDaysToKey } from './timezone.js';
import type { AssistantTool } from './assistantModel.js';

/**
 * The assistant, acting — safely.
 *
 *   It can PROPOSE: approve or deny time off, approve a timesheet, give an
 *   open shift to someone, message a crew, file an HR case for the person
 *   asking, send a schedule-change request to their lead, call out of a
 *   shift. A proposal changes nothing: it becomes a confirmation card
 *   (what will happen, to whom) and a signed, ten-minute action token.
 *
 *   Only CONFIRM acts (POST /hugo/confirm). The token must be the asker's
 *   own, unexpired and unused; it runs once. And it runs as the person, not
 *   as the assistant: the request goes through the product's own route
 *   with the person's own session (dispatchAsUser), so their permissions,
 *   their reach, the approval engine's second person and every route's own
 *   audit apply exactly as if they had clicked the button themselves. The
 *   assistant adds one more audit row, "via assistant".
 *
 *   Lookups (what's waiting, open shifts, a person by name) go the same
 *   way — through the person's own list routes — so the assistant can only
 *   ever see what they can, and a proposal can only name something that
 *   was in their own list.
 *
 *   Plain-English analytics: a question becomes a report-builder spec,
 *   run through the person's own report preview (their scope), answered as
 *   a small table with a link that opens it in the report builder.
 */

const TTL_MS = 10 * 60_000;

export interface ActionProposal {
  id: string;
  token: string;
  kind: string;
  title: string;
  detail: string | null;
  confirmLabel: string;
  expiresAt: string;
}

export interface AssistantTable {
  title: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  linkUrl: string;
}

export interface ActionContext {
  req: Request;
  user: SessionUser;
  proposals: ActionProposal[];
  tables: AssistantTable[];
}

/* ----- Running a request as the person ------------------------------------ */

export interface Dispatched {
  status: number;
  body: unknown;
}

/**
 * Send one request through this app, carrying the person's own session.
 * The route authenticates it as them — nothing here can widen what they
 * may do. The original client address travels as X-Forwarded-For so
 * network policies and rate limits see the person, not the loopback.
 */
export async function dispatchAsUser(req: Request, call: { method: 'GET' | 'POST' | 'PUT' | 'PATCH'; path: string; body?: unknown }): Promise<Dispatched> {
  const server = http.createServer(req.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const headers: Record<string, string> = { connection: 'close', 'x-alto-via': 'assistant' };
    if (req.headers.cookie) headers.cookie = req.headers.cookie;
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    if (req.ip) headers['x-forwarded-for'] = req.ip;
    if (call.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`http://127.0.0.1:${port}${call.path}`, { method: call.method, headers, body: call.body !== undefined ? JSON.stringify(call.body) : undefined });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

const list = (body: unknown, key: string): Array<Record<string, unknown>> => {
  const v = body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : null;
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
};
const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const nameOf = (r: Record<string, unknown>) =>
  str(r.associateName) || str(r.name) || [str(r.firstName), str(r.lastName)].filter(Boolean).join(' ') || str((r.associate as Record<string, unknown> | undefined)?.firstName);
const day = (v: unknown) => {
  const d = new Date(str(v).length === 10 ? `${str(v)}T12:00:00Z` : str(v));
  return Number.isNaN(d.getTime()) ? str(v).slice(0, 10) : new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(d);
};
/** "Fri, Dec 4, 9:00 AM" in the shift's zone when known. */
const when = (v: unknown, tz?: unknown) => {
  const d = new Date(str(v));
  if (Number.isNaN(d.getTime())) return str(v);
  return new Intl.DateTimeFormat('en-US', { timeZone: str(tz) || 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
};
const LEAVE: Record<string, string> = { SICK: 'Sick', VACATION: 'Vacation', PTO: 'Paid time off', BEREAVEMENT: 'Bereavement', JURY_DUTY: 'Jury duty', OTHER: 'Other leave' };
const leave = (v: unknown) => LEAVE[str(v)] ?? str(v).toLowerCase().replace(/_/g, ' ');

/* ----- Signed, single-use action tokens ------------------------------------ */

function secret(): string {
  return env.ASSISTANT_ACTION_SECRET ?? `${env.JWT_SECRET}:assistant-actions`;
}
const sign = (id: string, userId: string, exp: Date) => createHmac('sha256', secret()).update(`${id}.${userId}.${exp.getTime()}`).digest('base64url');

async function propose(ctx: ActionContext, p: { kind: string; params: Record<string, unknown>; title: string; detail?: string | null; confirmLabel: string }): Promise<string> {
  const expiresAt = new Date(Date.now() + TTL_MS);
  const row = await prisma.assistantAction.create({
    data: { tenantId: tenantIdForWrite(), userId: ctx.user.id, kind: p.kind, params: p.params as Prisma.InputJsonValue, title: p.title.slice(0, 300), detail: p.detail?.slice(0, 1000) ?? null, expiresAt },
  });
  ctx.proposals.push({ id: row.id, token: `${row.id}.${sign(row.id, ctx.user.id, expiresAt)}`, kind: p.kind, title: row.title, detail: row.detail, confirmLabel: p.confirmLabel, expiresAt: expiresAt.toISOString() });
  return `Proposed: ${row.title}. Nothing has happened yet — the person sees a card and must tap "${p.confirmLabel}" to do it. Tell them that in one short sentence; never say it is done.`;
}

/** What each kind of action does, as the route the person would have used. */
const EXECUTE: Record<string, (params: Record<string, unknown>) => { method: 'POST' | 'PUT' | 'PATCH'; path: string; body?: unknown }> = {
  'time_off.decide': (p) => ({ method: 'POST', path: `${str(p.base)}/${str(p.requestId)}/${p.decision === 'deny' ? 'deny' : 'approve'}`, body: p.note ? { note: p.note } : {} }),
  'timesheet.approve': (p) => ({ method: 'POST', path: `${str(p.base)}/${str(p.entryId)}/approve`, body: {} }),
  'shift.give': (p) => ({ method: 'POST', path: `/scheduling/shifts/${str(p.shiftId)}/assign`, body: { associateId: p.associateId } }),
  'crew.message': (p) => ({ method: 'POST', path: '/floor/crew-text', body: { shiftIds: p.shiftIds, body: p.body, ...(p.clientId ? { clientId: p.clientId } : {}) } }),
  'hr_case.file': (p) => ({ method: 'POST', path: '/hr-cases', body: { category: p.category, subject: p.subject, description: p.description } }),
  'schedule.request': (p) => ({ method: 'POST', path: '/hugo/handoff', body: { text: `Schedule change request: ${str(p.text)}` } }),
  'call_out': (p) => ({ method: 'POST', path: '/me/call-outs', body: { shiftId: p.shiftId, reason: p.reason, ...(p.note ? { note: p.note } : {}) } }),
};

/** Where to look once it's done. */
const AFTER: Record<string, string> = {
  'time_off.decide': '/time-off',
  'timesheet.approve': '/time',
  'shift.give': '/scheduling',
  'crew.message': '/',
  'hr_case.file': '/hr-cases',
  'schedule.request': '/messages',
  call_out: '/',
};

/** A route's refusal, in words a person can act on (the route's own message when it's already plain). */
function refusalText(body: unknown): string {
  const err = (body as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | null)?.error;
  const h = (m: unknown) => `${Math.round((Number(m) || 0) / 60)} h`;
  switch (err?.code) {
    case 'insufficient_balance':
      return `They don’t have enough leave for this (${h(err.details?.requestedMinutes)} asked, ${h(err.details?.currentMinutes)} available). To approve it anyway, open it in Time off and give a reason.`;
    case 'illegal_state':
    case 'already_decided':
      return 'Someone already decided this one.';
    case 'associate_unavailable':
      return 'They have time off or a day off then. Pick someone else, or assign it from Scheduling with an override.';
    case 'approval_pending':
      return 'A change for them is already waiting on a decision.';
    case 'forbidden':
    case 'not_found':
      return 'That’s outside what you can change.';
    default:
      return str(err?.message) || 'That didn’t go through.';
  }
}

export class ActionError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Confirm (or cancel) a proposed action. Runs once, as the person who
 * asked, through the product's own route.
 */
export async function decideAction(req: Request, token: string, decision: 'confirm' | 'cancel'): Promise<{ status: 'done' | 'pending_approval' | 'cancelled' | 'failed'; title: string; message: string; linkUrl: string | null }> {
  const user = req.user!;
  const [id, sig] = token.split('.');
  if (!id || !sig || !/^[0-9a-f-]{36}$/i.test(id)) throw new ActionError(400, 'invalid_token', 'That confirmation isn’t valid.');
  const row = await prisma.assistantAction.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
  // Someone else's proposal reads as not found: a token is no use to anyone but its owner.
  if (!row || row.userId !== user.id) throw new ActionError(404, 'action_not_found', 'That confirmation isn’t yours or no longer exists.');
  const want = sign(row.id, row.userId, row.expiresAt);
  if (want.length !== sig.length || !timingSafeEqual(Buffer.from(want), Buffer.from(sig))) throw new ActionError(400, 'invalid_token', 'That confirmation isn’t valid.');
  const now = new Date();
  const w = ACT_WORDS[actLang(user)];
  if (decision === 'cancel') {
    await prisma.assistantAction.updateMany({ where: { id, status: 'PROPOSED' }, data: { status: 'CANCELLED', decidedAt: now } });
    return { status: 'cancelled', title: row.title, message: w.cancelled, linkUrl: null };
  }
  // Claim it: one confirm, ever, and only before it expires.
  const claimed = await prisma.assistantAction.updateMany({ where: { id, status: 'PROPOSED', expiresAt: { gt: now } }, data: { status: 'CONFIRMED', decidedAt: now } });
  if (claimed.count === 0) {
    const reason = row.status !== 'PROPOSED' ? w.handled : w.expired;
    throw new ActionError(409, row.status !== 'PROPOSED' ? 'already_decided' : 'expired', reason);
  }
  const exec = EXECUTE[row.kind];
  if (!exec) throw new ActionError(400, 'unknown_action', 'I don’t know how to do that.');
  const result = await dispatchAsUser(req, exec(row.params as Record<string, unknown>));
  const ok = result.status >= 200 && result.status < 300;
  const pending = result.status === 202 || (result.body as { pending?: boolean } | null)?.pending === true;
  const message = ok ? (pending ? w.pending : w.done) : refusalText(result.body);
  await prisma.assistantAction.update({ where: { id }, data: { status: ok ? 'CONFIRMED' : 'FAILED', resultStatus: result.status, result: (result.body ?? {}) as Prisma.InputJsonValue } });
  enqueueAudit(
    { actorUserId: user.id, clientId: user.clientId, action: 'assistant.action_confirmed', entityType: 'AssistantAction', entityId: id, metadata: { kind: row.kind, via: 'assistant', status: result.status, ok } },
    'assistantActions',
  );
  return { status: ok ? (pending ? 'pending_approval' : 'done') : 'failed', title: row.title, message, linkUrl: ok ? (AFTER[row.kind] ?? null) : null };
}

/* ----- Words the person reads (associates use the assistant in six languages) ----- */

type ActLang = 'en' | 'es' | 'tr' | 'ht' | 'pt' | 'uk';
const actLang = (u: { language?: string | null }): ActLang => {
  const l = (u.language ?? 'en').slice(0, 2).toLowerCase();
  return (['en', 'es', 'tr', 'ht', 'pt', 'uk'] as const).includes(l as ActLang) ? (l as ActLang) : 'en';
};
const REASON_WORDS: Record<ActLang, Record<string, string>> = {
  en: { SICK: 'sick', FAMILY: 'family', TRANSPORT: 'ride or transportation', EMERGENCY: 'emergency', BEREAVEMENT: 'bereavement', JURY_DUTY: 'jury duty', OTHER: 'something else' },
  es: { SICK: 'enfermedad', FAMILY: 'familia', TRANSPORT: 'transporte', EMERGENCY: 'emergencia', BEREAVEMENT: 'duelo', JURY_DUTY: 'servicio de jurado', OTHER: 'otro motivo' },
  tr: { SICK: 'hastalık', FAMILY: 'aile', TRANSPORT: 'ulaşım', EMERGENCY: 'acil durum', BEREAVEMENT: 'yas', JURY_DUTY: 'jüri görevi', OTHER: 'başka bir neden' },
  ht: { SICK: 'maladi', FAMILY: 'fanmi', TRANSPORT: 'transpò', EMERGENCY: 'ijans', BEREAVEMENT: 'lanmò nan fanmi', JURY_DUTY: 'sèvis jiri', OTHER: 'lòt rezon' },
  pt: { SICK: 'doença', FAMILY: 'família', TRANSPORT: 'transporte', EMERGENCY: 'emergência', BEREAVEMENT: 'luto', JURY_DUTY: 'serviço de júri', OTHER: 'outro motivo' },
  uk: { SICK: 'хвороба', FAMILY: 'сімейні обставини', TRANSPORT: 'транспорт', EMERGENCY: 'надзвичайна ситуація', BEREAVEMENT: 'втрата близької людини', JURY_DUTY: 'обов’язки присяжного', OTHER: 'інша причина' },
};
const ACT_WORDS: Record<ActLang, {
  fileCase: (subject: string) => string; fileCaseBtn: string;
  schedule: string; scheduleBtn: string;
  callOut: (position: string, where: string | null, when: string) => string; callOutBtn: string;
  callOutDetail: (reason: string) => string;
  cancelled: string; done: string; pending: string; handled: string; expired: string;
}> = {
  en: {
    fileCase: (x) => `File an HR case: ${x}`, fileCaseBtn: 'File case',
    schedule: 'Send your lead a schedule-change request', scheduleBtn: 'Send request',
    callOut: (p, w, t) => `Call out of ${p}${w ? ` at ${w}` : ''}, ${t}`, callOutBtn: 'Call out',
    callOutDetail: (r) => `Reason: ${r}. Your lead is told and cover starts at once.`,
    cancelled: 'Cancelled — nothing was changed.', done: 'Done.', pending: 'Sent for a second person’s approval — it lands once they decide.',
    handled: 'That was already handled.', expired: 'That confirmation expired. Ask again and I’ll set it up fresh.',
  },
  es: {
    fileCase: (x) => `Abrir un caso de RR. HH.: ${x}`, fileCaseBtn: 'Abrir caso',
    schedule: 'Enviar a tu líder una solicitud de cambio de horario', scheduleBtn: 'Enviar solicitud',
    callOut: (p, w, t) => `Avisar que no irás a ${p}${w ? ` en ${w}` : ''}, ${t}`, callOutBtn: 'Avisar ausencia',
    callOutDetail: (r) => `Motivo: ${r}. Se avisa a tu líder y empieza la búsqueda de cobertura de inmediato.`,
    cancelled: 'Cancelado: no se cambió nada.', done: 'Listo.', pending: 'Enviado para la aprobación de una segunda persona; se aplica cuando decida.',
    handled: 'Eso ya se resolvió.', expired: 'Esa confirmación venció. Pídelo de nuevo y lo preparo otra vez.',
  },
  tr: {
    fileCase: (x) => `İK talebi aç: ${x}`, fileCaseBtn: 'Talep aç',
    schedule: 'Sorumluna vardiya değişikliği isteği gönder', scheduleBtn: 'İsteği gönder',
    callOut: (p, w, t) => `${p}${w ? ` (${w})` : ''} vardiyasına gelemeyeceğini bildir, ${t}`, callOutBtn: 'Gelemeyeceğimi bildir',
    callOutDetail: (r) => `Neden: ${r}. Sorumluna haber verilir ve yerine biri hemen aranır.`,
    cancelled: 'İptal edildi — hiçbir şey değişmedi.', done: 'Tamam.', pending: 'İkinci bir kişinin onayına gönderildi; karar verince uygulanır.',
    handled: 'Bu zaten halledildi.', expired: 'Bu onayın süresi doldu. Tekrar iste, yeniden hazırlayayım.',
  },
  ht: {
    fileCase: (x) => `Louvri yon dosye RH: ${x}`, fileCaseBtn: 'Louvri dosye',
    schedule: 'Voye yon demann chanjman orè bay chèf ou', scheduleBtn: 'Voye demann',
    callOut: (p, w, t) => `Di ou p ap ka vini pou ${p}${w ? ` nan ${w}` : ''}, ${t}`, callOutBtn: 'Di m p ap vini',
    callOutDetail: (r) => `Rezon: ${r}. Chèf ou ap konnen e yo kòmanse chèche yon moun ranplase w touswit.`,
    cancelled: 'Anile — anyen pa chanje.', done: 'Fini.', pending: 'Voye pou yon dezyèm moun apwouve; l ap aplike lè yo deside.',
    handled: 'Sa te deja regle.', expired: 'Konfimasyon sa a ekspire. Mande ankò e m ap prepare l ankò.',
  },
  pt: {
    fileCase: (x) => `Abrir um caso de RH: ${x}`, fileCaseBtn: 'Abrir caso',
    schedule: 'Enviar ao seu líder um pedido de mudança de horário', scheduleBtn: 'Enviar pedido',
    callOut: (p, w, t) => `Avisar que não irá ao turno de ${p}${w ? ` em ${w}` : ''}, ${t}`, callOutBtn: 'Avisar ausência',
    callOutDetail: (r) => `Motivo: ${r}. Seu líder é avisado e a busca por cobertura começa na hora.`,
    cancelled: 'Cancelado — nada foi alterado.', done: 'Pronto.', pending: 'Enviado para a aprovação de uma segunda pessoa; vale quando ela decidir.',
    handled: 'Isso já foi resolvido.', expired: 'Essa confirmação expirou. Peça de novo e eu preparo outra vez.',
  },
  uk: {
    fileCase: (x) => `Відкрити звернення до відділу кадрів: ${x}`, fileCaseBtn: 'Відкрити звернення',
    schedule: 'Надіслати керівнику запит на зміну графіка', scheduleBtn: 'Надіслати запит',
    callOut: (p, w, t) => `Повідомити, що не вийдете на зміну «${p}»${w ? ` у ${w}` : ''}, ${t}`, callOutBtn: 'Повідомити про відсутність',
    callOutDetail: (r) => `Причина: ${r}. Керівника буде повідомлено, і заміну почнуть шукати одразу.`,
    cancelled: 'Скасовано — нічого не змінено.', done: 'Готово.', pending: 'Надіслано на погодження другій особі; набуде чинності після її рішення.',
    handled: 'Це вже вирішено.', expired: 'Термін цього підтвердження минув. Попросіть ще раз — я підготую знову.',
  },
};

/* ----- The tools ------------------------------------------------------------ */

const out = (reply: string, linkUrl: string | null = null) => ({ reply, linkUrl });

/** The instant the company's day `offset` days from today begins (its own zone, DST-correct), for a shift-list window. */
function companyDayStart(offset: number, now: Date = new Date()): string {
  const tz = orgTimeZone();
  return dayBoundsInTz(addDaysToKey(todayInTz(tz, now), offset), tz).start.toISOString();
}

/** The action and analytics tools this person may use. */
export function actionTools(ctx: ActionContext): AssistantTool[] {
  const { req, user } = ctx;
  const tools: AssistantTool[] = [];
  const get = (path: string) => dispatchAsUser(req, { method: 'GET', path });

  // ---- Time off -------------------------------------------------------------
  const timeOffBase = can(user, 'manage:time') ? '/time-off/admin/requests' : can(user, 'manage:team-time-off') ? '/team/timeoff' : null;
  if (timeOffBase) {
    const listPath = timeOffBase === '/team/timeoff' ? '/team/timeoff?status=PENDING' : '/time-off/admin/requests?status=PENDING';
    const pending = async () => list((await get(listPath)).body, 'requests');
    tools.push({
      key: 'ACT_TIME_OFF_LIST',
      name: 'find_pending_time_off',
      description: 'Time-off requests waiting on this person’s decision (within their reach): id, who, dates, kind. Call before proposing a decision.',
      run: async () => {
        const rows = (await pending()).slice(0, 15);
        if (!rows.length) return out('No time-off requests are waiting.');
        return out(rows.map((r) => `${str(r.id)} — ${nameOf(r)}, ${leave(r.category)}, ${day(r.startDate)} – ${day(r.endDate)}`).join('\n'), '/time-off');
      },
    });
    tools.push({
      key: 'ACT_TIME_OFF_DECIDE',
      name: 'propose_time_off_decision',
      description: 'Propose approving or denying one pending time-off request (id from find_pending_time_off). Does NOT act; the person confirms.',
      input: { properties: { requestId: { type: 'string' }, decision: { type: 'string', enum: ['approve', 'deny'] }, note: { type: 'string', description: 'Optional note to the worker.' } }, required: ['requestId', 'decision'] },
      run: async (args) => {
        const r = (await pending()).find((x) => str(x.id) === str(args?.requestId));
        if (!r) return out('That request isn’t in their pending list — look it up again with find_pending_time_off.');
        const approve = args?.decision !== 'deny';
        return out(
          await propose(ctx, {
            kind: 'time_off.decide',
            params: { base: timeOffBase, requestId: r.id, decision: approve ? 'approve' : 'deny', note: args?.note ? str(args.note).slice(0, 500) : null },
            title: `${approve ? 'Approve' : 'Deny'} ${nameOf(r)}’s time off, ${day(r.startDate)} – ${day(r.endDate)}`,
            detail: `${leave(r.category)}${args?.note ? ` · Note to them: ${str(args.note).slice(0, 200)}` : ''}`,
            confirmLabel: approve ? 'Approve' : 'Deny',
          }),
        );
      },
    });
  }

  // ---- Timesheets ------------------------------------------------------------
  const timeBase = can(user, 'manage:time') ? '/time/admin/entries' : can(user, 'manage:team-time') ? '/team/timesheets' : null;
  if (timeBase) {
    const listPath = timeBase === '/team/timesheets' ? '/team/timesheets?status=COMPLETED' : '/time/admin/entries?status=COMPLETED';
    const pending = async () => list((await get(listPath)).body, 'entries');
    tools.push({
      key: 'ACT_TIMESHEET_LIST',
      name: 'find_timesheets_to_approve',
      description: 'Finished time entries waiting on this person’s approval: id, who, clock-in and clock-out.',
      run: async () => {
        const rows = (await pending()).slice(0, 15);
        if (!rows.length) return out('No timesheets are waiting.');
        return out(rows.map((r) => `${str(r.id)} — ${nameOf(r)}, ${str(r.clockInAt).slice(0, 16).replace('T', ' ')} to ${str(r.clockOutAt).slice(11, 16)}`).join('\n'), '/time');
      },
    });
    tools.push({
      key: 'ACT_TIMESHEET_APPROVE',
      name: 'propose_timesheet_approval',
      description: 'Propose approving one finished time entry (id from find_timesheets_to_approve). Does NOT act; the person confirms.',
      input: { properties: { entryId: { type: 'string' } }, required: ['entryId'] },
      run: async (args) => {
        const r = (await pending()).find((x) => str(x.id) === str(args?.entryId));
        if (!r) return out('That entry isn’t waiting on them — look it up again.');
        return out(
          await propose(ctx, {
            kind: 'timesheet.approve',
            params: { base: timeBase, entryId: r.id },
            title: `Approve ${nameOf(r)}’s hours, ${day(r.clockInAt)}`,
            detail: `${when(r.clockInAt)} to ${when(r.clockOutAt).split(', ').pop()}`,
            confirmLabel: 'Approve',
          }),
        );
      },
    });
  }

  // ---- Open shifts -------------------------------------------------------------
  if (can(user, 'manage:scheduling')) {
    const range = () => `from=${companyDayStart(0)}&to=${companyDayStart(14)}`;
    const openShifts = async () => list((await get(`/scheduling/shifts?status=OPEN&${range()}`)).body, 'shifts');
    tools.push({
      key: 'ACT_OPEN_SHIFTS',
      name: 'find_open_shifts',
      description: 'Open (unfilled) shifts in the next two weeks within reach: id, role, place, start.',
      run: async () => {
        const rows = (await openShifts()).slice(0, 20);
        if (!rows.length) return out('No open shifts in the next two weeks.');
        return out(rows.map((r) => `${str(r.id)} — ${str(r.position)} at ${str(r.locationName) || str(r.clientName)}, ${str(r.startsAt).slice(0, 16).replace('T', ' ')}`).join('\n'), '/scheduling');
      },
    });
    tools.push({
      key: 'ACT_FIND_PERSON',
      name: 'find_person',
      description: 'Find a worker by name within reach: id and name. Use before proposing to give them a shift.',
      input: { properties: { name: { type: 'string' } }, required: ['name'] },
      run: async (args) => {
        const rows = list((await get(`/people/directory?q=${encodeURIComponent(str(args?.name).slice(0, 80))}&limit=8`)).body, 'associates').slice(0, 8);
        if (!rows.length) return out('Nobody by that name in their reach.');
        return out(rows.map((r) => `${str(r.id)} — ${nameOf(r)}`).join('\n'));
      },
    });
    tools.push({
      key: 'ACT_GIVE_SHIFT',
      name: 'propose_give_open_shift',
      description: 'Propose giving one open shift to one worker (ids from find_open_shifts and find_person). Does NOT act; the person confirms.',
      input: { properties: { shiftId: { type: 'string' }, associateId: { type: 'string' } }, required: ['shiftId', 'associateId'] },
      run: async (args) => {
        const shift = (await openShifts()).find((s) => str(s.id) === str(args?.shiftId));
        if (!shift) return out('That shift isn’t open in their reach — look it up again.');
        const person = await get(`/people/directory/${encodeURIComponent(str(args?.associateId))}`);
        if (person.status !== 200) return out('That person isn’t in their reach.');
        const who = nameOf((person.body ?? {}) as Record<string, unknown>) || 'them';
        return out(
          await propose(ctx, {
            kind: 'shift.give',
            params: { shiftId: shift.id, associateId: args?.associateId },
            title: `Give ${who} the ${str(shift.position)} shift, ${when(shift.startsAt, shift.timezone)}`,
            detail: str(shift.locationName) || str(shift.clientName) || null,
            confirmLabel: 'Give shift',
          }),
        );
      },
    });
  }

  // ---- Messaging a crew ----------------------------------------------------------
  if (can(user, 'message:crew')) {
    // Today and tomorrow on the company's clock (`to` is exclusive: the start of the day after).
    const today = async () =>
      list((await get(`/scheduling/shifts?status=ASSIGNED&from=${companyDayStart(0)}&to=${companyDayStart(2)}`)).body, 'shifts');
    tools.push({
      key: 'ACT_CREW_SHIFTS',
      name: 'find_crew_shifts_today',
      description: 'Today’s and tomorrow’s staffed shifts at this person’s store: id, role, start, who. Use to pick whom a crew message goes to.',
      run: async () => {
        const rows = (await today()).slice(0, 30);
        if (!rows.length) return out('Nobody is scheduled today or tomorrow.');
        return out(rows.map((r) => `${str(r.id)} — ${str(r.position)}, ${str(r.startsAt).slice(0, 16).replace('T', ' ')}, ${str(r.assignedAssociateName)}`).join('\n'));
      },
    });
    tools.push({
      key: 'ACT_CREW_MESSAGE',
      name: 'propose_crew_message',
      description: 'Propose a text to the people on some of today’s shifts (ids from find_crew_shifts_today). Does NOT send; the person confirms.',
      input: { properties: { shiftIds: { type: 'array', items: { type: 'string' } }, body: { type: 'string', description: 'The message, under 600 characters.' } }, required: ['shiftIds', 'body'] },
      run: async (args) => {
        const ids = Array.isArray(args?.shiftIds) ? (args!.shiftIds as unknown[]).map(str) : [];
        const mine = (await today()).filter((s) => ids.includes(str(s.id)));
        if (!mine.length) return out('None of those shifts are on their floor today — look them up again.');
        const body = str(args?.body).slice(0, 600);
        if (!body.trim()) return out('The message is empty.');
        const people = [...new Set(mine.map((s) => str(s.assignedAssociateName)).filter(Boolean))];
        return out(
          await propose(ctx, {
            kind: 'crew.message',
            params: { shiftIds: mine.map((s) => s.id), body },
            title: `Text ${people.length} ${people.length === 1 ? 'person' : 'people'}: “${body.slice(0, 80)}${body.length > 80 ? '…' : ''}”`,
            detail: people.slice(0, 8).join(', '),
            confirmLabel: 'Send text',
          }),
        );
      },
    });
  }

  // ---- The person's own things ----------------------------------------------------
  if (user.associateId) {
    tools.push({
      key: 'ACT_HR_CASE',
      name: 'propose_hr_case',
      description: 'Propose filing an HR case for the person asking (their own case only). Categories: BENEFITS, PAYROLL, TIME_OFF, PERSONAL_INFO, WORKPLACE_CONCERN, HARASSMENT, PERFORMANCE, OTHER. Does NOT file; they confirm.',
      input: {
        properties: {
          category: { type: 'string', enum: ['BENEFITS', 'PAYROLL', 'TIME_OFF', 'PERSONAL_INFO', 'WORKPLACE_CONCERN', 'HARASSMENT', 'PERFORMANCE', 'OTHER'] },
          subject: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['category', 'subject', 'description'],
      },
      run: async (args) =>
        out(
          await propose(ctx, {
            kind: 'hr_case.file',
            params: { category: str(args?.category) || 'OTHER', subject: str(args?.subject).slice(0, 200), description: str(args?.description).slice(0, 4000) },
            title: ACT_WORDS[actLang(user)].fileCase(str(args?.subject).slice(0, 120)),
            detail: str(args?.description).slice(0, 300),
            confirmLabel: ACT_WORDS[actLang(user)].fileCaseBtn,
          }),
        ),
    });
    tools.push({
      key: 'ACT_SCHEDULE_REQUEST',
      name: 'propose_schedule_change_request',
      description: 'Propose sending the person’s lead a schedule-change request in their words (days, times, availability). Does NOT send; they confirm.',
      input: { properties: { text: { type: 'string' } }, required: ['text'] },
      run: async (args) =>
        out(
          await propose(ctx, {
            kind: 'schedule.request',
            params: { text: str(args?.text).slice(0, 450) },
            title: ACT_WORDS[actLang(user)].schedule,
            detail: str(args?.text).slice(0, 300),
            confirmLabel: ACT_WORDS[actLang(user)].scheduleBtn,
          }),
        ),
    });
    tools.push({
      key: 'ACT_CALL_OUT',
      name: 'propose_call_out',
      description: 'Propose calling out of one of the person’s own upcoming shifts (they can’t make it). Reasons: SICK, FAMILY, TRANSPORT, EMERGENCY, BEREAVEMENT, JURY_DUTY, OTHER. Omit shiftId for their next shift. Does NOT act; they confirm.',
      input: { properties: { shiftId: { type: 'string' }, reason: { type: 'string', enum: ['SICK', 'FAMILY', 'TRANSPORT', 'EMERGENCY', 'BEREAVEMENT', 'JURY_DUTY', 'OTHER'] }, note: { type: 'string' } }, required: ['reason'] },
      run: async (args) => {
        const now = new Date();
        const shift = await prisma.shift.findFirst({
          where: { assignedAssociateId: user.associateId!, status: 'ASSIGNED', startsAt: { gt: now }, ...(args?.shiftId ? { id: str(args.shiftId) } : { startsAt: { gt: now, lte: new Date(now.getTime() + 7 * 86_400_000) } }) },
          orderBy: { startsAt: 'asc' },
          select: { id: true, position: true, startsAt: true, locationRel: { select: { name: true, timezone: true } } },
        });
        if (!shift) return out('They have no upcoming shift to call out of.');
        return out(
          await propose(ctx, {
            kind: 'call_out',
            params: { shiftId: shift.id, reason: str(args?.reason) || 'OTHER', note: args?.note ? str(args.note).slice(0, 500) : null },
            title: ACT_WORDS[actLang(user)].callOut(shift.position, shift.locationRel?.name ?? null, when(shift.startsAt, shift.locationRel?.timezone)),
            detail: ACT_WORDS[actLang(user)].callOutDetail(REASON_WORDS[actLang(user)][str(args?.reason)] ?? REASON_WORDS[actLang(user)].OTHER!),
            confirmLabel: ACT_WORDS[actLang(user)].callOutBtn,
          }),
        );
      },
    });
  }

  // ---- Plain-English analytics ---------------------------------------------------
  if (can(user, 'view:analytics')) {
    const catalog = Object.entries(ENTITY_COLUMNS)
      .map(([e, cols]) => `${e}: ${Object.keys(cols).join(', ')}`)
      .join('; ');
    tools.push({
      key: 'ACT_REPORT',
      name: 'run_report',
      description:
        `Answer a numbers question with the report builder, inside the person's own reach. Entities and columns — ${catalog}. ` +
        `Filters: {column, op, value} with op in ${FILTER_OPS.join('/')}; op "period" takes this-week, last-week, this-month, last-month, this-quarter, last-quarter, this-year, last-year. ` +
        `Group with groupBy (≤4 columns) and aggregates [{fn: ${AGGREGATE_FNS.join('|')}, column?}] — sum/avg/min/max only on grossAmount, netAmount, totalGross, totalNet, amount. Returns a small table and a link to open it in the report builder.`,
      input: {
        properties: {
          title: { type: 'string', description: 'A short title for the table.' },
          entity: { type: 'string', enum: Object.keys(ENTITY_COLUMNS) },
          columns: { type: 'array', items: { type: 'string' } },
          filters: { type: 'array', items: { type: 'object', properties: { column: { type: 'string' }, op: { type: 'string' }, value: {} }, required: ['column', 'op'] } },
          groupBy: { type: 'array', items: { type: 'string' } },
          aggregates: { type: 'array', items: { type: 'object', properties: { fn: { type: 'string' }, column: { type: 'string' } }, required: ['fn'] } },
        },
        required: ['entity'],
      },
      run: async (args) => {
        const entity = str(args?.entity);
        const groupBy = Array.isArray(args?.groupBy) ? (args!.groupBy as string[]).slice(0, 4) : undefined;
        const columns = Array.isArray(args?.columns) && (args!.columns as unknown[]).length ? (args!.columns as string[]) : groupBy?.length ? groupBy : Object.keys(ENTITY_COLUMNS[entity] ?? { id: 'id' }).slice(0, 5);
        const spec = {
          columns,
          filters: Array.isArray(args?.filters) ? args!.filters : [],
          sort: [],
          limit: 200,
          ...(groupBy?.length ? { groupBy, aggregates: Array.isArray(args?.aggregates) && (args!.aggregates as unknown[]).length ? args!.aggregates : [{ fn: 'count' }] } : {}),
        };
        const title = str(args?.title) || 'Report';
        const r = await dispatchAsUser(req, { method: 'POST', path: '/reports/preview', body: { name: title.slice(0, 160), entity, spec } });
        if (r.status !== 200) return out(`The report builder refused that: ${str((r.body as { error?: { message?: string } } | null)?.error?.message) || r.status}. Adjust the spec and try again.`);
        const body = r.body as { columns: string[]; rows: Array<Record<string, unknown>> };
        const linkUrl = `/reports?draft=${Buffer.from(JSON.stringify({ name: title, entity, spec })).toString('base64url')}`;
        ctx.tables.push({ title, columns: body.columns, rows: body.rows.slice(0, 25), linkUrl });
        if (!body.rows.length) return out('No rows match.', linkUrl);
        const head = body.rows.slice(0, 10).map((row) => body.columns.map((c) => `${c}: ${str(row[c])}`).join(', ')).join('\n');
        return out(`${body.rows.length} rows${body.rows.length > 10 ? ' (first 10)' : ''}:\n${head}\nThe person sees the table under your answer; summarise it in a sentence.`, linkUrl);
      },
    });
  }
  return tools;
}
