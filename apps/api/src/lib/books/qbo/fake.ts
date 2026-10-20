import { QboError, type QboChange, type QboClient, type QboCompanyInfo, type QboEntity, type QboType } from './types.js';

/**
 * QuickBooks in memory — the same contract as the HTTP client, used by the
 * tests and by local development without Intuit keys (stub mode), so the
 * whole sync runs end to end anywhere. It keeps SyncTokens honestly (a
 * stale one is refused with QuickBooks' 5010), records every change for
 * change-data-capture, and lets a test play the accountant ("edit this
 * expense in QuickBooks") or an outage (failNext).
 */

interface Stored {
  entity: QboEntity;
  updatedAt: number;
}

export class FakeQboClient implements QboClient {
  readonly store = new Map<QboType, Map<string, Stored>>();
  readonly deleted: Array<{ type: QboType; id: string; at: number }> = [];
  companyName = 'Alto Sandbox Company';
  bookCloseDate: string | null = null;
  /** Calls made, for assertions ("create:Bill"). */
  readonly calls: string[] = [];
  private seq = 100;
  private failures: Array<{ match: string; error: QboError; times: number }> = [];
  /** The fake's clock (ms) — tests move it to order changes around a sync. */
  now: () => number = () => Date.now();

  constructor(readonly realmId: string) {}

  /** Make the next `times` calls matching "create:Bill" (or "*") fail with `error`. */
  failNext(match: string, error: QboError, times = 1): void {
    this.failures.push({ match, error, times });
  }

  private maybeFail(op: string): void {
    const f = this.failures.find((x) => x.match === '*' || x.match === op);
    if (!f) return;
    f.times -= 1;
    if (f.times <= 0) this.failures.splice(this.failures.indexOf(f), 1);
    throw f.error;
  }

  private bucket(type: QboType): Map<string, Stored> {
    let b = this.store.get(type);
    if (!b) this.store.set(type, (b = new Map()));
    return b;
  }

  all(type: QboType): QboEntity[] {
    return [...this.bucket(type).values()].map((s) => s.entity);
  }

  /** The accountant edits a record in QuickBooks: a new SyncToken and a change for CDC. */
  edit(type: QboType, id: string, patch: Record<string, unknown>): QboEntity {
    const s = this.bucket(type).get(id);
    if (!s) throw new Error(`fake: no ${type} ${id}`);
    const entity = { ...s.entity, ...patch, Id: id, SyncToken: String(Number(s.entity.SyncToken ?? '0') + 1), MetaData: { ...s.entity.MetaData, LastUpdatedTime: new Date(this.now()).toISOString() } };
    this.bucket(type).set(id, { entity, updatedAt: this.now() });
    return entity;
  }

  /** The accountant makes a record in QuickBooks. */
  seed(type: QboType, body: Record<string, unknown>): QboEntity {
    const id = String(this.seq++);
    const at = this.now();
    const entity = { ...body, Id: id, SyncToken: '0', MetaData: { CreateTime: new Date(at).toISOString(), LastUpdatedTime: new Date(at).toISOString() } } as QboEntity;
    this.bucket(type).set(id, { entity, updatedAt: at });
    return entity;
  }

  /** The accountant deletes a record in QuickBooks. */
  drop(type: QboType, id: string): void {
    this.bucket(type).delete(id);
    this.deleted.push({ type, id, at: this.now() });
  }

  async companyInfo(): Promise<QboCompanyInfo> {
    this.calls.push('companyInfo');
    this.maybeFail('companyInfo');
    return { companyName: this.companyName, bookCloseDate: this.bookCloseDate };
  }

  async query(type: QboType, where?: string): Promise<QboEntity[]> {
    this.calls.push(`query:${type}`);
    this.maybeFail(`query:${type}`);
    let rows = this.all(type);
    const eq = where?.match(/^(\w+)\s*=\s*'((?:[^']|\\')*)'$/);
    if (eq) rows = rows.filter((r) => String(r[eq[1]!] ?? '') === eq[2]!.replace(/\\'/g, "'"));
    return rows.map((r) => structuredClone(r));
  }

  async get(type: QboType, id: string): Promise<QboEntity | null> {
    this.calls.push(`get:${type}`);
    this.maybeFail(`get:${type}`);
    const s = this.bucket(type).get(id);
    return s ? structuredClone(s.entity) : null;
  }

  async create(type: QboType, body: Record<string, unknown>): Promise<QboEntity> {
    this.calls.push(`create:${type}`);
    this.maybeFail(`create:${type}`);
    validate(type, body, this);
    return structuredClone(this.seed(type, body));
  }

  async update(type: QboType, body: Record<string, unknown>): Promise<QboEntity> {
    this.calls.push(`update:${type}`);
    this.maybeFail(`update:${type}`);
    const id = String(body.Id ?? '');
    const s = this.bucket(type).get(id);
    if (!s) throw new QboError('Object Not Found', 400, '610', `${type} ${id} was deleted or never existed`);
    if (String(body.SyncToken ?? '') !== String(s.entity.SyncToken ?? '0')) {
      throw new QboError('Stale Object Error', 400, '5010', `You and someone else edited this ${type} at the same time.`);
    }
    validate(type, body, this);
    // A full update replaces the record (QuickBooks drops what isn't sent); a sparse one merges.
    const next = body.sparse ? { ...s.entity, ...body } : { ...body };
    delete (next as { sparse?: unknown }).sparse;
    const entity = { ...next, Id: id, SyncToken: String(Number(s.entity.SyncToken ?? '0') + 1), MetaData: { ...s.entity.MetaData, LastUpdatedTime: new Date(this.now()).toISOString() } } as QboEntity;
    this.bucket(type).set(id, { entity, updatedAt: this.now() });
    return structuredClone(entity);
  }

  async remove(type: QboType, id: string, syncToken: string): Promise<void> {
    this.calls.push(`delete:${type}`);
    this.maybeFail(`delete:${type}`);
    const s = this.bucket(type).get(id);
    if (!s) return;
    if (syncToken !== String(s.entity.SyncToken ?? '0')) throw new QboError('Stale Object Error', 400, '5010');
    this.drop(type, id);
  }

  async voidTxn(type: QboType, id: string, syncToken: string): Promise<QboEntity> {
    this.calls.push(`void:${type}`);
    this.maybeFail(`void:${type}`);
    const s = this.bucket(type).get(id);
    if (!s) throw new QboError('Object Not Found', 400, '610');
    if (syncToken !== String(s.entity.SyncToken ?? '0')) throw new QboError('Stale Object Error', 400, '5010');
    const lines = (s.entity.Line as Array<Record<string, unknown>> | undefined) ?? [];
    return structuredClone(this.edit(type, id, { TotalAmt: 0, PrivateNote: 'Voided', Line: lines.map((l) => ({ ...l, Amount: 0 })) }));
  }

  async cdc(types: QboType[], changedSince: Date): Promise<QboChange[]> {
    this.calls.push('cdc');
    this.maybeFail('cdc');
    const since = changedSince.getTime();
    const out: QboChange[] = [];
    for (const t of types) {
      for (const s of this.bucket(t).values()) {
        if (s.updatedAt >= since) out.push({ type: t, id: s.entity.Id, deleted: false, entity: structuredClone(s.entity), lastUpdated: new Date(s.updatedAt).toISOString() });
      }
    }
    for (const d of this.deleted) {
      if (types.includes(d.type) && d.at >= since) out.push({ type: d.type, id: d.id, deleted: true, entity: null, lastUpdated: new Date(d.at).toISOString() });
    }
    return out;
  }
}

/** The checks QuickBooks itself makes that the sync could trip on. */
function validate(type: QboType, body: Record<string, unknown>, fake: FakeQboClient): void {
  if (type === 'JournalEntry') {
    const lines = (body.Line as Array<{ Amount?: number; JournalEntryLineDetail?: { PostingType?: string } }> | undefined) ?? [];
    const d = lines.filter((l) => l.JournalEntryLineDetail?.PostingType === 'Debit').reduce((s, l) => s + Math.round(Number(l.Amount ?? 0) * 100), 0);
    const c = lines.filter((l) => l.JournalEntryLineDetail?.PostingType === 'Credit').reduce((s, l) => s + Math.round(Number(l.Amount ?? 0) * 100), 0);
    if (d !== c) throw new QboError('Transaction Not Balanced', 400, '6000', 'The journal entry’s debits and credits don’t match.');
  }
  if (type === 'Account' || type === 'Vendor' || type === 'Customer' || type === 'Class' || type === 'Department' || type === 'Item') {
    const name = String(type === 'Vendor' || type === 'Customer' ? body.DisplayName : body.Name);
    if (!name || name === 'undefined') throw new QboError('Required param missing', 400, '2020', `${type} needs a name.`);
    const clash = fake.all(type).find((e) => e.Id !== body.Id && String(type === 'Vendor' || type === 'Customer' ? e.DisplayName : e.Name).toLowerCase() === name.toLowerCase());
    if (clash) throw new QboError('Duplicate Name Exists Error', 400, '6240', `The name supplied already exists: ${name}`);
  }
}

/** Stub mode's companies, by realm — one fake per company for the life of the process. */
const STUB_COMPANIES = new Map<string, FakeQboClient>();

export function stubCompany(realmId: string): FakeQboClient {
  let f = STUB_COMPANIES.get(realmId);
  if (!f) STUB_COMPANIES.set(realmId, (f = new FakeQboClient(realmId)));
  return f;
}

export function resetStubCompanies(): void {
  STUB_COMPANIES.clear();
}
