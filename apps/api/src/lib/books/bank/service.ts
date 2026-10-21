import { Prisma, type BankFeedAccount, type BankRule, type BankTransaction, type LedgerAccount, type PrismaClient } from '@prisma/client';
import type {
  BankAccountCreateInput,
  BankAccountUpdateInput,
  BankBulkAction,
  BankBulkResult,
  BankCategorizeInput,
  BankCsvMapping,
  BankFeedAccountView,
  BankImportPreview,
  BankImportResult,
  BankPlaidAccount,
  BankReconciliationDetail,
  BankReconciliationSummary,
  BankRuleInput,
  BankRuleView,
  BankTxnCounts,
  BankTxnStatus,
  BankTxnSuggestions,
  BankTxnView,
} from '@alto-people/shared';
import { HttpError } from '../../../middleware/error.js';
import { tenantIdForWrite } from '../../tenant.js';
import { emitBooksChange } from '../events.js';
import { accountBalance, accountIndex, fromCents, postEntry, toCents, voidEntry } from '../ledger.js';
import { csvToTransactions, detectCsvMapping, isOfx, parseCsv, parseOfx, type ParsedTxn, type ParseResult } from './parse.js';
import { clientFor, itemToken, plaidRef, requirePlaid, splitPlaidRef, storeItemToken, withPlaidHealth, plaidConnection } from './plaid.js';
import { contextFor } from '../../providers/connections.js';

/**
 * The books' bank and card accounts (lib/books/bank). A feed account sits
 * on one BANK or CREDIT_CARD ledger account; its transactions come in from
 * a file or Plaid and each one is decided:
 *
 *   MATCHED      it is a ledger line already in the books (a payroll
 *                deposit, a bill payment) — nothing new is posted;
 *   CATEGORIZED  it's new to the books: an entry is posted (source BANK,
 *                sourceKey bank-txn:<id>) between the account and a category;
 *   EXCLUDED     a duplicate, or something booked another way.
 *
 * Undo puts it back to UNMATCHED (voiding the entry it made). Rules suggest
 * a category from the description; an autoApply rule categorizes on import.
 *
 * Reconciliation ticks the account's ledger lines against a statement until
 * statement balance − (beginning balance + cleared) is zero.
 */

type Db = PrismaClient;

const dateOnly = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const DAY = 86_400_000;
const FEED_SUBTYPES = new Set(['BANK', 'CREDIT_CARD']);

/** Ledger net (debit − credit) → the account's normal side: a bank's balance, a card's balance owed. */
const normal = (a: Pick<LedgerAccount, 'type'>, netCents: number) => (a.type === 'ASSET' || a.type === 'EXPENSE' ? netCents : -netCents);

/* ---- Accounts --------------------------------------------------------------- */

async function feedOr404(db: Db, id: string): Promise<BankFeedAccount & { ledger: LedgerAccount }> {
  const feed = await db.bankFeedAccount.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
  if (!feed) throw new HttpError(404, 'bank_account_not_found', 'Bank account not found.');
  const ledger = await db.ledgerAccount.findFirst({ where: { id: feed.ledgerAccountId, tenantId: tenantIdForWrite() } });
  if (!ledger) throw new HttpError(404, 'bank_account_not_found', 'The ledger account behind this bank account is gone.');
  return { ...feed, ledger };
}

export async function listFeedAccounts(db: Db): Promise<BankFeedAccountView[]> {
  const tenantId = tenantIdForWrite();
  const feeds = await db.bankFeedAccount.findMany({ where: { tenantId }, orderBy: [{ isActive: 'desc' }, { name: 'asc' }] });
  if (feeds.length === 0) return [];
  const { byId } = await accountIndex(db);
  const [review, recs] = await Promise.all([
    db.bankTransaction.groupBy({ by: ['feedAccountId'], where: { tenantId, status: 'UNMATCHED', feedAccountId: { in: feeds.map((f) => f.id) } }, _count: { _all: true } }),
    db.bankReconciliation.findMany({ where: { tenantId, status: 'COMPLETED', feedAccountId: { in: feeds.map((f) => f.id) } }, orderBy: { statementEndDate: 'desc' } }),
  ]);
  const reviewOf = new Map(review.map((r) => [r.feedAccountId, r._count._all]));
  const today = ymd(new Date(Date.now() + 366 * DAY));
  const out: BankFeedAccountView[] = [];
  for (const f of feeds) {
    const ledger = byId.get(f.ledgerAccountId);
    if (!ledger) continue;
    const last = recs.find((r) => r.feedAccountId === f.id);
    out.push(view(f, ledger, await accountBalance(db, ledger.id, today), reviewOf.get(f.id) ?? 0, last ? { statementEndDate: ymd(last.statementEndDate), statementBalance: Number(last.statementBalance) } : null));
  }
  return out;
}

function view(f: BankFeedAccount, ledger: LedgerAccount, booksBalance: number, forReview: number, lastReconciled: BankFeedAccountView['lastReconciled']): BankFeedAccountView {
  return {
    id: f.id,
    ledgerAccountId: ledger.id,
    ledgerCode: ledger.code,
    ledgerName: ledger.name,
    subtype: ledger.subtype,
    name: f.name,
    institution: f.institution,
    mask: f.mask,
    feed: f.feed as 'MANUAL' | 'PLAID',
    isActive: f.isActive,
    booksBalance,
    bankBalance: f.currentBalance === null ? null : Number(f.currentBalance),
    lastSyncedAt: f.lastSyncedAt?.toISOString() ?? null,
    lastError: f.lastError,
    forReview,
    lastReconciled,
  };
}

export async function getFeedAccount(db: Db, id: string): Promise<BankFeedAccountView> {
  const all = await listFeedAccounts(db);
  const v = all.find((a) => a.id === id);
  if (!v) throw new HttpError(404, 'bank_account_not_found', 'Bank account not found.');
  return v;
}

export async function createFeedAccount(db: Db, input: BankAccountCreateInput, userId: string | null): Promise<BankFeedAccountView> {
  const tenantId = tenantIdForWrite();
  await accountIndex(db); // the chart, seeded if this is the books' first use
  let ledger: LedgerAccount | null;
  let madeLedger = false;
  if (input.ledgerAccountId) {
    ledger = await db.ledgerAccount.findFirst({ where: { id: input.ledgerAccountId, tenantId } });
    if (!ledger) throw new HttpError(404, 'account_not_found', 'Ledger account not found.');
    if (!FEED_SUBTYPES.has(ledger.subtype)) throw new HttpError(400, 'not_a_bank_account', `${ledger.code} ${ledger.name} isn’t a bank or credit card account.`);
  } else {
    const n = input.newAccount!;
    if (await db.ledgerAccount.findFirst({ where: { tenantId, code: n.code } })) throw new HttpError(409, 'code_taken', `Account ${n.code} already exists.`);
    ledger = await db.ledgerAccount.create({ data: { tenantId, code: n.code, name: n.name, type: n.subtype === 'BANK' ? 'ASSET' : 'LIABILITY', subtype: n.subtype } });
    madeLedger = true;
  }
  if (await db.bankFeedAccount.findFirst({ where: { tenantId, ledgerAccountId: ledger.id } })) {
    throw new HttpError(409, 'already_a_feed', `${ledger.code} ${ledger.name} already has a bank feed.`);
  }
  let plaid: { connectionId: string; ref: string; name: string; mask: string | null; institution: string | null } | null = null;
  if (input.plaid) {
    const { row, ctx, client } = await requirePlaid();
    const token = itemToken(ctx, input.plaid.itemId);
    if (!token) throw new HttpError(409, 'plaid_item_unknown', 'Link this bank with Plaid again — its access was not found.');
    const ref = plaidRef(input.plaid.itemId, input.plaid.accountId);
    if (await db.bankFeedAccount.findFirst({ where: { tenantId, providerAccountId: ref } })) throw new HttpError(409, 'already_a_feed', 'That Plaid account is already a feed.');
    const got = await withPlaidHealth(row, () => client.accountsGet(token));
    const acct = got.accounts.find((a) => a.account_id === input.plaid!.accountId);
    if (!acct) throw new HttpError(404, 'plaid_account_not_found', 'Plaid no longer lists that account.');
    plaid = { connectionId: row.id, ref, name: acct.official_name || acct.name, mask: acct.mask, institution: got.institutionName ?? null };
  }
  const feed = await db.bankFeedAccount.create({
    data: {
      tenantId,
      ledgerAccountId: ledger.id,
      name: input.name ?? plaid?.name ?? ledger.name,
      institution: input.institution ?? plaid?.institution ?? null,
      mask: input.mask ?? plaid?.mask ?? null,
      feed: plaid ? 'PLAID' : 'MANUAL',
      providerConnectionId: plaid?.connectionId ?? null,
      providerAccountId: plaid?.ref ?? null,
    },
  });
  if (madeLedger) emitBooksChange({ localType: 'LedgerAccount', localId: ledger.id, op: 'UPSERT' });
  void userId;
  return getFeedAccount(db, feed.id);
}

export async function updateFeedAccount(db: Db, id: string, input: BankAccountUpdateInput): Promise<BankFeedAccountView> {
  const feed = await feedOr404(db, id);
  await db.bankFeedAccount.update({
    where: { id: feed.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.institution !== undefined ? { institution: input.institution } : {}),
      ...(input.mask !== undefined ? { mask: input.mask } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });
  return getFeedAccount(db, id);
}

/** Every active ledger account, for the category pickers (the chart seeded on first use). */
export async function categoryAccounts(db: Db): Promise<Array<{ id: string; code: string; name: string; type: string; subtype: string }>> {
  const { byId } = await accountIndex(db);
  return [...byId.values()]
    .filter((a) => a.isActive)
    .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
    .map((a) => ({ id: a.id, code: a.code, name: a.name, type: a.type, subtype: a.subtype }));
}

/* ---- Transactions ----------------------------------------------------------- */

export async function listTransactions(db: Db, feedId: string, q: { status?: BankTxnStatus; q?: string; from?: string; to?: string; limit?: number }): Promise<{ transactions: BankTxnView[]; counts: BankTxnCounts }> {
  const feed = await feedOr404(db, feedId);
  const tenantId = tenantIdForWrite();
  const where: Prisma.BankTransactionWhereInput = {
    tenantId,
    feedAccountId: feed.id,
    ...(q.status ? { status: q.status } : {}),
    ...(q.q ? { OR: [{ description: { contains: q.q, mode: 'insensitive' } }, { payee: { contains: q.q, mode: 'insensitive' } }, { reference: { contains: q.q } }] } : {}),
    ...(q.from || q.to ? { postedOn: { ...(q.from ? { gte: dateOnly(q.from) } : {}), ...(q.to ? { lte: dateOnly(q.to) } : {}) } } : {}),
  };
  const [rows, grouped] = await Promise.all([
    db.bankTransaction.findMany({ where, orderBy: [{ postedOn: 'desc' }, { createdAt: 'desc' }], take: Math.min(q.limit ?? 500, 2000) }),
    db.bankTransaction.groupBy({ by: ['status'], where: { tenantId, feedAccountId: feed.id }, _count: { _all: true } }),
  ]);
  const counts: BankTxnCounts = { UNMATCHED: 0, MATCHED: 0, CATEGORIZED: 0, EXCLUDED: 0 };
  for (const g of grouped) counts[g.status as BankTxnStatus] = g._count._all;
  return { transactions: await views(db, feed, rows), counts };
}

async function views(db: Db, feed: BankFeedAccount, rows: BankTransaction[]): Promise<BankTxnView[]> {
  const tenantId = tenantIdForWrite();
  const { byId } = await accountIndex(db);
  const entryIds = rows.map((r) => r.journalEntryId).filter((x): x is string => !!x);
  const lineIds = rows.map((r) => r.matchedLineId).filter((x): x is string => !!x);
  const ruleIds = [...new Set(rows.map((r) => r.ruleId).filter((x): x is string => !!x))];
  const [entryLines, matchedLines, rules] = await Promise.all([
    entryIds.length ? db.journalLine.findMany({ where: { tenantId, entryId: { in: entryIds }, accountId: { not: feed.ledgerAccountId } }, select: { entryId: true, accountId: true } }) : [],
    lineIds.length ? db.journalLine.findMany({ where: { tenantId, id: { in: lineIds } }, include: { entry: { select: { id: true, number: true, memo: true, entryDate: true } } } }) : [],
    ruleIds.length ? db.bankRule.findMany({ where: { tenantId, id: { in: ruleIds } }, select: { id: true, name: true } }) : [],
  ]);
  const categoryOf = new Map(entryLines.map((l) => [l.entryId, l.accountId]));
  const lineOf = new Map(matchedLines.map((l) => [l.id, l]));
  const ruleName = new Map(rules.map((r) => [r.id, r.name]));
  return rows.map((r) => {
    const catId = r.journalEntryId ? categoryOf.get(r.journalEntryId) : undefined;
    const cat = catId ? byId.get(catId) : undefined;
    const m = r.matchedLineId ? lineOf.get(r.matchedLineId) : undefined;
    return {
      id: r.id,
      feedAccountId: r.feedAccountId,
      postedOn: ymd(r.postedOn),
      amount: Number(r.amount),
      description: r.description,
      payee: r.payee,
      reference: r.reference,
      importedFrom: r.importedFrom as BankTxnView['importedFrom'],
      status: r.status as BankTxnStatus,
      category: cat ? { accountId: cat.id, code: cat.code, name: cat.name, transfer: FEED_SUBTYPES.has(cat.subtype) } : null,
      matched: m ? { lineId: m.id, entryId: m.entry.id, entryNumber: m.entry.number, memo: m.memo ?? m.entry.memo, date: ymd(m.entry.entryDate) } : null,
      journalEntryId: r.journalEntryId,
      ruleName: r.ruleId ? (ruleName.get(r.ruleId) ?? null) : null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
    };
  });
}

async function txnOr404(db: Db, id: string): Promise<BankTransaction> {
  const t = await db.bankTransaction.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
  if (!t) throw new HttpError(404, 'bank_transaction_not_found', 'Bank transaction not found.');
  return t;
}

export async function transactionView(db: Db, id: string): Promise<BankTxnView> {
  const t = await txnOr404(db, id);
  const feed = await feedOr404(db, t.feedAccountId);
  return (await views(db, feed, [t]))[0]!;
}

/* ---- Import ----------------------------------------------------------------- */

function parseFile(filename: string, content: string, mapping?: BankCsvMapping): { format: 'CSV' | 'OFX'; result: ParseResult; rows: string[][]; mapping: BankCsvMapping | null } {
  if (isOfx(content) || /\.(ofx|qfx|qbo)$/i.test(filename)) return { format: 'OFX', result: parseOfx(content), rows: [], mapping: null };
  const rows = parseCsv(content);
  const m = mapping ?? detectCsvMapping(rows);
  if (!m) return { format: 'CSV', result: { transactions: [], errors: ['Couldn’t tell which columns hold the date, description and amount — choose them below.'] }, rows, mapping: null };
  return { format: 'CSV', result: csvToTransactions(rows, m), rows, mapping: m };
}

export async function previewImport(db: Db, feedId: string, filename: string, content: string, mapping?: BankCsvMapping): Promise<BankImportPreview> {
  const feed = await feedOr404(db, feedId);
  const p = parseFile(filename, content, mapping);
  const existing = await existingIds(db, feed.id, p.result.transactions.map((t) => t.externalId));
  const header = p.rows[0] ?? [];
  const columns = p.format === 'CSV' ? (p.mapping?.hasHeader === false || !p.mapping ? header.map((_, i) => `Column ${i + 1}`) : header) : [];
  return {
    format: p.format,
    columns: p.mapping && !p.mapping.hasHeader ? header.map((_, i) => `Column ${i + 1}`) : columns,
    sample: p.format === 'CSV' ? p.rows.slice(p.mapping?.hasHeader === false ? 0 : 1, 6) : [],
    mapping: p.mapping,
    parsed: p.result.transactions.slice(0, 20).map((t) => ({ postedOn: t.postedOn, amount: t.amount, description: t.description, reference: t.reference })),
    total: p.result.transactions.length,
    duplicates: existing.size,
    errors: p.result.errors.slice(0, 20),
  };
}

async function existingIds(db: Db, feedId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.bankTransaction.findMany({ where: { tenantId: tenantIdForWrite(), feedAccountId: feedId, externalId: { in: ids } }, select: { externalId: true } });
  return new Set(rows.map((r) => r.externalId));
}

async function insertParsed(db: Db, feed: BankFeedAccount, txns: ParsedTxn[], importedFrom: 'FEED' | 'CSV' | 'OFX'): Promise<{ added: BankTransaction[]; duplicates: number }> {
  const existing = await existingIds(db, feed.id, txns.map((t) => t.externalId));
  const fresh = txns.filter((t) => !existing.has(t.externalId));
  const tenantId = tenantIdForWrite();
  const added: BankTransaction[] = [];
  for (const t of fresh) {
    try {
      added.push(
        await db.bankTransaction.create({
          data: { tenantId, feedAccountId: feed.id, postedOn: dateOnly(t.postedOn), amount: new Prisma.Decimal(t.amount.toFixed(2)), description: t.description, payee: t.payee, reference: t.reference, externalId: t.externalId, importedFrom },
        }),
      );
    } catch (err) {
      // Two imports racing on the same file: the unique key keeps one.
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
    }
  }
  return { added, duplicates: txns.length - fresh.length };
}

export async function importFile(db: Db, feedId: string, filename: string, content: string, mapping: BankCsvMapping | undefined, userId: string | null): Promise<BankImportResult> {
  const feed = await feedOr404(db, feedId);
  const p = parseFile(filename, content, mapping);
  if (p.format === 'CSV' && !p.mapping) throw new HttpError(400, 'csv_mapping_required', p.result.errors[0] ?? 'Choose the columns.');
  const { added, duplicates } = await insertParsed(db, feed, p.result.transactions, p.format);
  if (p.result.ledgerBalance) {
    await db.bankFeedAccount.update({ where: { id: feed.id }, data: { currentBalance: new Prisma.Decimal(normalBank(feed.ledger, p.result.ledgerBalance.amount).toFixed(2)), lastSyncedAt: new Date() } });
  }
  const autoCategorized = await applyRules(db, { feedAccountId: feed.id, onlyIds: added.map((a) => a.id), autoOnly: true, userId });
  return { added: added.length, duplicates, updated: 0, removed: 0, autoCategorized, errors: p.result.errors.slice(0, 50) };
}

/** A bank's own balance figure, to the books' normal side (a card statement's balance is what's owed). */
function normalBank(ledger: LedgerAccount, bankFigure: number): number {
  return ledger.type === 'LIABILITY' ? Math.abs(bankFigure) : bankFigure;
}

/* ---- Rules ------------------------------------------------------------------ */

function ruleFits(r: BankRule, t: Pick<BankTransaction, 'description' | 'payee' | 'amount'>): boolean {
  const amount = Number(t.amount);
  const hay = `${t.description} ${t.payee ?? ''}`.toLowerCase();
  if (!hay.includes(r.contains.toLowerCase())) return false;
  if (r.direction === 'IN' && amount <= 0) return false;
  if (r.direction === 'OUT' && amount >= 0) return false;
  const abs = Math.abs(amount);
  if (r.minAmount !== null && abs < Number(r.minAmount)) return false;
  if (r.maxAmount !== null && abs > Number(r.maxAmount)) return false;
  return true;
}

async function activeRules(db: Db): Promise<BankRule[]> {
  return db.bankRule.findMany({ where: { tenantId: tenantIdForWrite(), isActive: true }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] });
}

/**
 * Categorize UNMATCHED transactions by the rules (the first that fits, by
 * priority). autoOnly: only rules marked autoApply (on import / the job);
 * otherwise every rule ("apply rules now"). Returns how many were categorized.
 */
export async function applyRules(db: Db, opts: { feedAccountId?: string; onlyIds?: string[]; autoOnly: boolean; userId: string | null }): Promise<number> {
  const rules = (await activeRules(db)).filter((r) => !opts.autoOnly || r.autoApply);
  if (rules.length === 0 || (opts.onlyIds && opts.onlyIds.length === 0)) return 0;
  const txns = await db.bankTransaction.findMany({
    where: { tenantId: tenantIdForWrite(), status: 'UNMATCHED', ...(opts.feedAccountId ? { feedAccountId: opts.feedAccountId } : {}), ...(opts.onlyIds ? { id: { in: opts.onlyIds } } : {}) },
    orderBy: { postedOn: 'asc' },
    take: 2000,
  });
  const feeds = new Map<string, BankFeedAccount>();
  let n = 0;
  for (const t of txns) {
    const r = rules.find((x) => ruleFits(x, t));
    if (!r) continue;
    let feed = feeds.get(t.feedAccountId);
    if (!feed) {
      feed = (await db.bankFeedAccount.findFirst({ where: { id: t.feedAccountId, tenantId: tenantIdForWrite() } })) ?? undefined;
      if (!feed) continue;
      feeds.set(t.feedAccountId, feed);
    }
    if (r.accountId === feed.ledgerAccountId) continue;
    try {
      await categorizeTxn(db, t, feed, { accountId: r.accountId, vendorId: r.vendorId, clientId: r.clientId, departmentId: r.departmentId }, opts.userId, r.id);
      n += 1;
    } catch (err) {
      // A rule pointing at an inactive account: leave it for a person.
      if (!(err instanceof HttpError)) throw err;
    }
  }
  return n;
}

function ruleView(r: BankRule, byId: Map<string, LedgerAccount>): BankRuleView {
  const a = byId.get(r.accountId);
  return {
    id: r.id,
    name: r.name,
    contains: r.contains,
    direction: r.direction as BankRuleView['direction'],
    minAmount: r.minAmount === null ? null : Number(r.minAmount),
    maxAmount: r.maxAmount === null ? null : Number(r.maxAmount),
    accountId: r.accountId,
    accountCode: a?.code ?? '',
    accountName: a?.name ?? 'An account',
    vendorId: r.vendorId,
    clientId: r.clientId,
    departmentId: r.departmentId,
    priority: r.priority,
    autoApply: r.autoApply,
    isActive: r.isActive,
  };
}

export async function listRules(db: Db): Promise<BankRuleView[]> {
  const { byId } = await accountIndex(db);
  const rules = await db.bankRule.findMany({ where: { tenantId: tenantIdForWrite() }, orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] });
  return rules.map((r) => ruleView(r, byId));
}

async function assertCategoryAccount(db: Db, accountId: string): Promise<LedgerAccount> {
  const { byId } = await accountIndex(db);
  const a = byId.get(accountId);
  if (!a) throw new HttpError(404, 'account_not_found', 'Ledger account not found.');
  if (!a.isActive) throw new HttpError(400, 'inactive_account', `${a.code} ${a.name} is inactive.`);
  return a;
}

export async function createRule(db: Db, input: BankRuleInput, userId: string | null): Promise<BankRuleView> {
  await assertCategoryAccount(db, input.accountId);
  if (input.minAmount != null && input.maxAmount != null && input.minAmount > input.maxAmount) throw new HttpError(400, 'bad_range', 'The smallest amount is more than the largest.');
  const r = await db.bankRule.create({
    data: {
      tenantId: tenantIdForWrite(),
      name: input.name,
      contains: input.contains,
      direction: input.direction,
      minAmount: input.minAmount != null ? new Prisma.Decimal(input.minAmount) : null,
      maxAmount: input.maxAmount != null ? new Prisma.Decimal(input.maxAmount) : null,
      accountId: input.accountId,
      vendorId: input.vendorId ?? null,
      clientId: input.clientId ?? null,
      departmentId: input.departmentId ?? null,
      priority: input.priority,
      autoApply: input.autoApply,
      isActive: input.isActive,
      createdById: userId,
    },
  });
  return ruleView(r, (await accountIndex(db)).byId);
}

export async function updateRule(db: Db, id: string, input: Partial<BankRuleInput>): Promise<BankRuleView> {
  const r = await db.bankRule.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
  if (!r) throw new HttpError(404, 'rule_not_found', 'Rule not found.');
  if (input.accountId) await assertCategoryAccount(db, input.accountId);
  const u = await db.bankRule.update({
    where: { id: r.id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.contains !== undefined ? { contains: input.contains } : {}),
      ...(input.direction !== undefined ? { direction: input.direction } : {}),
      ...(input.minAmount !== undefined ? { minAmount: input.minAmount === null ? null : new Prisma.Decimal(input.minAmount) } : {}),
      ...(input.maxAmount !== undefined ? { maxAmount: input.maxAmount === null ? null : new Prisma.Decimal(input.maxAmount) } : {}),
      ...(input.accountId !== undefined ? { accountId: input.accountId } : {}),
      ...(input.vendorId !== undefined ? { vendorId: input.vendorId } : {}),
      ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
      ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.autoApply !== undefined ? { autoApply: input.autoApply } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });
  return ruleView(u, (await accountIndex(db)).byId);
}

export async function deleteRule(db: Db, id: string): Promise<void> {
  const r = await db.bankRule.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
  if (!r) throw new HttpError(404, 'rule_not_found', 'Rule not found.');
  await db.bankRule.delete({ where: { id: r.id } });
}

/* ---- Review: suggest, categorize, match, exclude, undo ----------------------- */

const payeeKey = (t: Pick<BankTransaction, 'payee' | 'description'>) =>
  (t.payee || t.description)
    .toLowerCase()
    .replace(/[0-9#*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 3)
    .join(' ');

/** What every suggestion on a page shares: the rules, the chart, the feeds. Loaded once per request. */
interface SuggestCtx {
  rules: BankRule[];
  byId: Map<string, LedgerAccount>;
  feeds: Map<string, BankFeedAccount>;
  /** Loaded on the first deposit: who a deposit might be from. */
  clients?: Array<{ id: string; name: string; key: string }>;
}

/** A company name, reduced to what a bank description would carry. */
const NAME_NOISE = new Set(['inc', 'llc', 'ltd', 'corp', 'corporation', 'co', 'company', 'the', 'lp', 'llp', 'pllc']);
const nameKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !NAME_NOISE.has(w))
    .join(' ');

/** Who a deposit is from: the rule's client, or the client whose name the description carries (the longest such name). */
async function depositClient(db: Db, t: BankTransaction, ruleClientId: string | null, ctx: SuggestCtx): Promise<{ id: string; name: string } | null> {
  if (Number(t.amount) <= 0) return null;
  ctx.clients ??= (await db.client.findMany({ where: { tenantId: tenantIdForWrite() }, select: { id: true, name: true } }))
    .map((c) => ({ ...c, key: nameKey(c.name) }))
    .filter((c) => c.key.length >= 4);
  if (ruleClientId) {
    const c = ctx.clients.find((x) => x.id === ruleClientId);
    if (c) return { id: c.id, name: c.name };
  }
  const text = ` ${nameKey(`${t.payee ?? ''} ${t.description}`)} `;
  const hit = ctx.clients.filter((c) => text.includes(` ${c.key} `)).sort((a, b) => b.key.length - a.key.length)[0];
  return hit ? { id: hit.id, name: hit.name } : null;
}

async function suggestCtx(db: Db): Promise<SuggestCtx> {
  const [rules, { byId }] = await Promise.all([activeRules(db), accountIndex(db)]);
  return { rules, byId, feeds: new Map() };
}

export async function suggestionsFor(db: Db, id: string): Promise<BankTxnSuggestions> {
  return suggest(db, await txnOr404(db, id), await suggestCtx(db));
}

const NOTHING: BankTxnSuggestions = { matches: [], rule: null, lastTime: null, exactLineId: null, client: null };

/** Suggestions for several transactions in one call — the review list asks once per page. Unknown or decided ids get none. */
export async function suggestionsForMany(db: Db, ids: string[]): Promise<Record<string, BankTxnSuggestions>> {
  const rows = await db.bankTransaction.findMany({ where: { tenantId: tenantIdForWrite(), id: { in: ids } } });
  const ctx = await suggestCtx(db);
  const out: Record<string, BankTxnSuggestions> = {};
  // A few at a time: each is a handful of small queries.
  for (let i = 0; i < rows.length; i += 8) {
    const chunk = rows.slice(i, i + 8);
    const got = await Promise.all(chunk.map((t) => (t.status === 'UNMATCHED' ? suggest(db, t, ctx) : NOTHING)));
    chunk.forEach((t, k) => (out[t.id] = got[k]!));
  }
  return out;
}

async function feedFor(db: Db, t: BankTransaction, ctx: SuggestCtx): Promise<BankFeedAccount> {
  let feed = ctx.feeds.get(t.feedAccountId);
  if (!feed) {
    feed = await feedOr404(db, t.feedAccountId);
    ctx.feeds.set(t.feedAccountId, feed);
  }
  return feed;
}

async function suggest(db: Db, t: BankTransaction, ctx: SuggestCtx): Promise<BankTxnSuggestions> {
  const feed = await feedFor(db, t, ctx);
  const tenantId = tenantIdForWrite();
  const cents = toCents(t.amount);
  const from = new Date(t.postedOn.getTime() - 5 * DAY);
  const to = new Date(t.postedOn.getTime() + 5 * DAY);
  const candidates = await db.journalLine.findMany({
    where: {
      tenantId,
      accountId: feed.ledgerAccountId,
      entry: { status: 'POSTED', entryDate: { gte: from, lte: to } },
      ...(cents > 0 ? { debit: new Prisma.Decimal(fromCents(cents).toFixed(2)) } : { credit: new Prisma.Decimal(fromCents(-cents).toFixed(2)) }),
    },
    include: { entry: { select: { id: true, number: true, memo: true, entryDate: true, source: true } } },
    take: 50,
  });
  // A line already matched, or one this feed's own categorizations posted, isn't a candidate.
  const taken = new Set(
    (await db.bankTransaction.findMany({ where: { tenantId, feedAccountId: feed.id, status: 'MATCHED', matchedLineId: { in: candidates.map((c) => c.id) } }, select: { matchedLineId: true } })).map((x) => x.matchedLineId),
  );
  const ownEntries = new Set(
    (await db.bankTransaction.findMany({ where: { tenantId, feedAccountId: feed.id, journalEntryId: { in: candidates.map((c) => c.entry.id) } }, select: { journalEntryId: true } })).map((x) => x.journalEntryId),
  );
  const matches = candidates
    .filter((c) => !taken.has(c.id) && !ownEntries.has(c.entry.id))
    .map((c) => ({
      lineId: c.id,
      entryId: c.entry.id,
      entryNumber: c.entry.number,
      date: ymd(c.entry.entryDate),
      memo: c.memo ?? c.entry.memo,
      source: c.entry.source,
      amount: Number(t.amount),
      daysApart: Math.round(Math.abs(c.entry.entryDate.getTime() - t.postedOn.getTime()) / DAY),
    }))
    .sort((a, b) => a.daysApart - b.daysApart);
  // Unambiguous: the only candidate, or the only one on the same day.
  const sameDay = matches.filter((m) => m.daysApart === 0);
  const exactLineId = matches.length === 1 ? matches[0]!.lineId : sameDay.length === 1 ? sameDay[0]!.lineId : null;

  const { byId } = ctx;
  const rule = ctx.rules.find((r) => ruleFits(r, t)) ?? null;
  const ruleAcct = rule ? byId.get(rule.accountId) : undefined;

  // What the same payee was categorized as last time.
  let lastTime: BankTxnSuggestions['lastTime'] = null;
  const key = payeeKey(t);
  if (key) {
    const prior = await db.bankTransaction.findMany({
      where: { tenantId, status: 'CATEGORIZED', id: { not: t.id }, journalEntryId: { not: null }, OR: [{ payee: { contains: key.split(' ')[0]!, mode: 'insensitive' } }, { description: { contains: key.split(' ')[0]!, mode: 'insensitive' } }] },
      orderBy: { decidedAt: 'desc' },
      take: 20,
    });
    const hit = prior.find((p) => payeeKey(p) === key);
    if (hit?.journalEntryId) {
      const pfeed = await db.bankFeedAccount.findFirst({ where: { id: hit.feedAccountId, tenantId } });
      const line = await db.journalLine.findFirst({ where: { tenantId, entryId: hit.journalEntryId, accountId: { not: pfeed?.ledgerAccountId ?? '' } } });
      const a = line ? byId.get(line.accountId) : undefined;
      if (a && a.id !== feed.ledgerAccountId) lastTime = { accountId: a.id, accountCode: a.code, accountName: a.name };
    }
  }
  return {
    matches,
    rule: rule && ruleAcct ? { ruleId: rule.id, name: rule.name, accountId: ruleAcct.id, accountCode: ruleAcct.code, accountName: ruleAcct.name, vendorId: rule.vendorId, clientId: rule.clientId, departmentId: rule.departmentId } : null,
    lastTime,
    exactLineId,
    client: await depositClient(db, t, rule?.clientId ?? null, ctx),
  };
}

/**
 * Decide many at once (For review → "Accept all suggested", "Match all
 * exact", or the selection excluded). Each is its own decision — an accepted
 * one posts its own entry, idempotent by its key — and anything already
 * decided, or with nothing to take, is skipped with why. Sending the same
 * list twice does nothing the second time.
 */
export async function bulkDecide(db: Db, action: BankBulkAction, ids: string[], userId: string | null): Promise<BankBulkResult> {
  const rows = await db.bankTransaction.findMany({ where: { tenantId: tenantIdForWrite(), id: { in: [...new Set(ids)] } }, orderBy: [{ postedOn: 'asc' }, { createdAt: 'asc' }] });
  const found = new Set(rows.map((r) => r.id));
  const result: BankBulkResult = { action, done: [], skipped: ids.filter((id) => !found.has(id)).map((id) => ({ id, reason: 'Not found.' })) };
  const ctx = await suggestCtx(db);
  for (const t of rows) {
    if (t.status !== 'UNMATCHED') {
      result.skipped.push({ id: t.id, reason: 'Already decided.' });
      continue;
    }
    try {
      if (action === 'EXCLUDE') {
        const done = await db.bankTransaction.updateMany({ where: { id: t.id, status: 'UNMATCHED' }, data: { status: 'EXCLUDED', decidedById: userId, decidedAt: new Date() } });
        if (done.count === 0) throw new HttpError(409, 'already_decided', 'Already decided.');
      } else {
        // Asked again for each, so one decided earlier in this batch is seen by the next.
        const s = await suggest(db, t, ctx);
        if (action === 'MATCH') {
          if (!s.exactLineId) {
            result.skipped.push({ id: t.id, reason: s.matches.length ? 'More than one entry could be it — match it by hand.' : 'Nothing in the books to match.' });
            continue;
          }
          await match(db, t.id, s.exactLineId, userId);
        } else {
          if (s.matches.length > 0) {
            result.skipped.push({ id: t.id, reason: 'It’s already in the books — match it instead.' });
            continue;
          }
          const feed = await feedFor(db, t, ctx);
          const pick = s.rule ? { accountId: s.rule.accountId, vendorId: s.rule.vendorId, clientId: s.rule.clientId, departmentId: s.rule.departmentId } : s.lastTime ? { accountId: s.lastTime.accountId } : null;
          if (!pick) {
            result.skipped.push({ id: t.id, reason: 'No suggestion to accept.' });
            continue;
          }
          await categorizeTxn(db, t, feed, pick, userId, s.rule?.ruleId ?? null);
        }
      }
      result.done.push(t.id);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      result.skipped.push({ id: t.id, reason: err.message });
    }
  }
  return result;
}

function assertUndecided(t: BankTransaction): void {
  if (t.status !== 'UNMATCHED') throw new HttpError(409, 'already_decided', 'This transaction is already decided — undo it first.');
}

async function categorizeTxn(db: Db, t: BankTransaction, feed: BankFeedAccount, input: BankCategorizeInput, userId: string | null, ruleId: string | null = null): Promise<void> {
  assertUndecided(t);
  const category = await assertCategoryAccount(db, input.accountId);
  if (category.id === feed.ledgerAccountId) throw new HttpError(400, 'same_account', 'Pick the other side of the transaction — not this account itself.');
  const amount = Math.abs(Number(t.amount));
  const moneyIn = Number(t.amount) > 0;
  const tenantId = tenantIdForWrite();
  const prior = await db.journalEntry.count({ where: { tenantId, sourceType: 'BankTransaction', sourceId: t.id } });
  const memo = input.memo ?? (t.payee && !t.description.includes(t.payee) ? `${t.payee} — ${t.description}` : t.description);
  const dims = { vendorId: input.vendorId ?? null, clientId: input.clientId ?? null, departmentId: input.departmentId ?? null };
  const entry = await postEntry(db, {
    date: ymd(t.postedOn),
    memo: memo.slice(0, 500),
    source: 'BANK',
    sourceType: 'BankTransaction',
    sourceId: t.id,
    sourceKey: prior === 0 ? `bank-txn:${t.id}` : `bank-txn:${t.id}#${prior + 1}`,
    createdById: userId,
    lines: moneyIn
      ? [
          { account: feed.ledgerAccountId, debit: amount, memo: t.description.slice(0, 300) },
          { account: category.id, credit: amount, memo: input.memo ?? null, ...dims },
        ]
      : [
          { account: category.id, debit: amount, memo: input.memo ?? null, ...dims },
          { account: feed.ledgerAccountId, credit: amount, memo: t.description.slice(0, 300) },
        ],
  });
  // Only if still undecided (a person and a rule racing on one transaction).
  const done = await db.bankTransaction.updateMany({ where: { id: t.id, status: 'UNMATCHED' }, data: { status: 'CATEGORIZED', journalEntryId: entry.id, ruleId, decidedById: userId, decidedAt: new Date() } });
  if (done.count === 0) {
    await voidEntry(db, entry.id, { reason: 'Decided twice at once', userId });
    throw new HttpError(409, 'already_decided', 'This transaction was just decided by someone else.');
  }
}

export async function categorize(db: Db, id: string, input: BankCategorizeInput, userId: string | null): Promise<BankTxnView> {
  const t = await txnOr404(db, id);
  const feed = await feedOr404(db, t.feedAccountId);
  await categorizeTxn(db, t, feed, input, userId);
  return transactionView(db, id);
}

export async function match(db: Db, id: string, lineId: string, userId: string | null): Promise<BankTxnView> {
  const t = await txnOr404(db, id);
  assertUndecided(t);
  const feed = await feedOr404(db, t.feedAccountId);
  const tenantId = tenantIdForWrite();
  const line = await db.journalLine.findFirst({ where: { id: lineId, tenantId }, include: { entry: { select: { status: true } } } });
  if (!line || line.accountId !== feed.ledgerAccountId) throw new HttpError(400, 'wrong_line', 'That line isn’t on this account.');
  if (line.entry.status !== 'POSTED') throw new HttpError(409, 'line_void', 'That entry is void.');
  if (toCents(line.debit) - toCents(line.credit) !== toCents(t.amount)) throw new HttpError(400, 'amount_mismatch', 'The amounts differ — categorize it, or match the right line.');
  const already = await db.bankTransaction.findFirst({ where: { tenantId, matchedLineId: line.id, status: 'MATCHED' } });
  if (already) throw new HttpError(409, 'line_taken', 'Another bank transaction is already matched to that line.');
  const done = await db.bankTransaction.updateMany({ where: { id: t.id, status: 'UNMATCHED' }, data: { status: 'MATCHED', matchedLineId: line.id, decidedById: userId, decidedAt: new Date() } });
  if (done.count === 0) throw new HttpError(409, 'already_decided', 'This transaction was just decided by someone else.');
  return transactionView(db, id);
}

export async function exclude(db: Db, id: string, userId: string | null): Promise<BankTxnView> {
  const t = await txnOr404(db, id);
  assertUndecided(t);
  await db.bankTransaction.update({ where: { id: t.id }, data: { status: 'EXCLUDED', decidedById: userId, decidedAt: new Date() } });
  return transactionView(db, id);
}

/** Back to For review. A categorization's entry is voided (or, its month closed, reversed). */
export async function undo(db: Db, id: string, userId: string | null): Promise<BankTxnView> {
  const t = await txnOr404(db, id);
  if (t.status === 'UNMATCHED') throw new HttpError(409, 'not_decided', 'Nothing to undo.');
  if (t.matchedLineId || t.journalEntryId) {
    const lineIds = t.matchedLineId ? [t.matchedLineId] : (await db.journalLine.findMany({ where: { entryId: t.journalEntryId!, tenantId: tenantIdForWrite() }, select: { id: true } })).map((l) => l.id);
    const cleared = await db.journalLine.count({ where: { id: { in: lineIds }, clearedAt: { not: null } } });
    if (cleared > 0) throw new HttpError(409, 'reconciled', 'This is in a completed reconciliation. Undo that reconciliation first.');
  }
  if (t.status === 'CATEGORIZED' && t.journalEntryId) {
    const entry = await db.journalEntry.findFirst({ where: { id: t.journalEntryId, tenantId: tenantIdForWrite() } });
    if (entry && entry.status === 'POSTED') await voidEntry(db, entry.id, { reason: 'Bank transaction sent back for review', userId });
  }
  await db.bankTransaction.update({ where: { id: t.id }, data: { status: 'UNMATCHED', matchedLineId: null, journalEntryId: null, ruleId: null, decidedById: null, decidedAt: null } });
  return transactionView(db, id);
}

/* ---- Plaid ------------------------------------------------------------------ */

export async function plaidStatus(): Promise<{ configured: boolean; environment: 'SANDBOX' | 'PRODUCTION' | null }> {
  const row = await plaidConnection();
  return { configured: !!row, environment: row ? (row.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX') : null };
}

export async function plaidLinkToken(userId: string, clientName: string): Promise<string> {
  const { row, client } = await requirePlaid();
  return (await withPlaidHealth(row, () => client.linkTokenCreate({ userId, clientName }))).link_token;
}

export async function plaidExchange(db: Db, publicToken: string): Promise<{ itemId: string; accounts: BankPlaidAccount[] }> {
  const { row, client } = await requirePlaid();
  const ex = await withPlaidHealth(row, () => client.publicTokenExchange(publicToken));
  await storeItemToken(row, ex.item_id, ex.access_token);
  const got = await withPlaidHealth(row, () => client.accountsGet(ex.access_token));
  const feeds = await db.bankFeedAccount.findMany({ where: { tenantId: tenantIdForWrite(), providerAccountId: { startsWith: `${ex.item_id}/` } }, select: { id: true, providerAccountId: true } });
  return {
    itemId: ex.item_id,
    accounts: got.accounts.map((a) => ({
      accountId: a.account_id,
      name: a.official_name || a.name,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
      institution: got.institutionName ?? null,
      linkedFeedId: feeds.find((f) => f.providerAccountId === plaidRef(ex.item_id, a.account_id))?.id ?? null,
    })),
  };
}

/** Pull an Item's new, changed and removed transactions since its cursor, for every feed on it. */
export async function syncPlaidItem(db: Db, itemId: string): Promise<BankImportResult> {
  const tenantId = tenantIdForWrite();
  const row = await plaidConnection();
  if (!row) throw new HttpError(409, 'plaid_not_configured', 'Connect Plaid under Settings › Integrations first.');
  const ctx = contextFor(row);
  const token = itemToken(ctx, itemId);
  if (!token) throw new HttpError(409, 'plaid_item_unknown', 'Link this bank with Plaid again — its access was not found.');
  const feeds = await db.bankFeedAccount.findMany({ where: { tenantId, feed: 'PLAID', providerAccountId: { startsWith: `${itemId}/` } } });
  const result: BankImportResult = { added: 0, duplicates: 0, updated: 0, removed: 0, autoCategorized: 0, errors: [] };
  if (feeds.length === 0) return result;
  const client = clientFor(ctx);
  const feedFor = new Map(feeds.map((f) => [splitPlaidRef(f.providerAccountId)!.accountId, f]));
  let cursor = feeds.find((f) => f.cursor)?.cursor ?? null;
  const addedIds: string[] = [];
  try {
    for (let page = 0; page < 50; page++) {
      const p = await withPlaidHealth(row, () => client.transactionsSync(token, cursor));
      for (const t of p.added) {
        const feed = feedFor.get(t.account_id);
        if (!feed || t.pending) continue;
        const r = await insertParsed(db, feed, [plaidParsed(t)], 'FEED');
        result.added += r.added.length;
        result.duplicates += r.duplicates;
        addedIds.push(...r.added.map((a) => a.id));
      }
      for (const t of p.modified) {
        const feed = feedFor.get(t.account_id);
        if (!feed || t.pending) continue;
        const parsed = plaidParsed(t);
        const u = await db.bankTransaction.updateMany({
          where: { tenantId, feedAccountId: feed.id, externalId: parsed.externalId, status: 'UNMATCHED' },
          data: { postedOn: dateOnly(parsed.postedOn), amount: new Prisma.Decimal(parsed.amount.toFixed(2)), description: parsed.description, payee: parsed.payee },
        });
        if (u.count === 0) {
          const r = await insertParsed(db, feed, [parsed], 'FEED');
          result.added += r.added.length;
          addedIds.push(...r.added.map((a) => a.id));
        } else result.updated += u.count;
      }
      for (const t of p.removed) {
        const d = await db.bankTransaction.deleteMany({ where: { tenantId, feedAccountId: { in: feeds.map((f) => f.id) }, externalId: `plaid:${t.transaction_id}`, status: 'UNMATCHED' } });
        result.removed += d.count;
        if (d.count === 0) {
          const kept = await db.bankTransaction.count({ where: { tenantId, feedAccountId: { in: feeds.map((f) => f.id) }, externalId: `plaid:${t.transaction_id}` } });
          if (kept) result.errors.push(`The bank withdrew a transaction already decided here (${t.transaction_id}) — check it.`);
        }
      }
      cursor = p.next_cursor;
      if (!p.has_more) break;
    }
    const bal = await withPlaidHealth(row, () => client.accountsGet(token));
    const ledgers = await db.ledgerAccount.findMany({ where: { tenantId, id: { in: feeds.map((f) => f.ledgerAccountId) } } });
    for (const f of feeds) {
      const a = bal.accounts.find((x) => x.account_id === splitPlaidRef(f.providerAccountId)!.accountId);
      const ledger = ledgers.find((l) => l.id === f.ledgerAccountId);
      const current = a?.balances.current;
      await db.bankFeedAccount.update({
        where: { id: f.id },
        data: { cursor, lastSyncedAt: new Date(), lastError: null, ...(current != null && ledger ? { currentBalance: new Prisma.Decimal(normalBank(ledger, current).toFixed(2)) } : {}) },
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Plaid sync failed.';
    // What came in before the failure stays; the cursor only moves on success.
    await db.bankFeedAccount.updateMany({ where: { id: { in: feeds.map((f) => f.id) } }, data: { lastError: message.slice(0, 500) } });
    throw err;
  }
  result.autoCategorized = await applyRules(db, { onlyIds: addedIds, autoOnly: true, userId: null });
  return result;
}

function plaidParsed(t: { transaction_id: string; amount: number; date: string; name: string; merchant_name?: string | null; check_number?: string | null }): ParsedTxn {
  return {
    postedOn: t.date,
    // Plaid: positive is money out. Here: positive is money in.
    amount: Math.round(-t.amount * 100) / 100,
    description: (t.name || t.merchant_name || '(no description)').slice(0, 300),
    payee: t.merchant_name?.slice(0, 160) ?? null,
    reference: t.check_number?.slice(0, 80) ?? null,
    externalId: `plaid:${t.transaction_id}`,
  };
}

export async function syncFeed(db: Db, feedId: string): Promise<BankImportResult> {
  const feed = await feedOr404(db, feedId);
  const ref = splitPlaidRef(feed.providerAccountId);
  if (feed.feed !== 'PLAID' || !ref) throw new HttpError(409, 'not_a_feed', 'This account takes file uploads, not a live feed.');
  return syncPlaidItem(db, ref.itemId);
}

/* ---- Reconciliation --------------------------------------------------------- */

async function recOr404(db: Db, id: string) {
  const r = await db.bankReconciliation.findFirst({ where: { id, tenantId: tenantIdForWrite() } });
  if (!r) throw new HttpError(404, 'reconciliation_not_found', 'Reconciliation not found.');
  return r;
}

async function names(db: Db, ids: Array<string | null>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const us = await db.user.findMany({ where: { id: { in: want } }, select: { id: true, email: true, displayName: true } });
  return new Map(us.map((u) => [u.id, u.displayName ?? u.email]));
}

export async function listReconciliations(db: Db, feedId: string): Promise<BankReconciliationSummary[]> {
  const feed = await feedOr404(db, feedId);
  const tenantId = tenantIdForWrite();
  const recs = await db.bankReconciliation.findMany({ where: { tenantId, feedAccountId: feed.id }, orderBy: { statementEndDate: 'desc' } });
  const counts = await db.journalLine.groupBy({ by: ['reconciliationId'], where: { tenantId, reconciliationId: { in: recs.map((r) => r.id) } }, _count: { _all: true } });
  const countOf = new Map(counts.map((c) => [c.reconciliationId, c._count._all]));
  const who = await names(db, recs.map((r) => r.completedById));
  return recs.map((r) => ({
    id: r.id,
    statementEndDate: ymd(r.statementEndDate),
    statementBalance: Number(r.statementBalance),
    beginningBalance: Number(r.beginningBalance),
    status: r.status as 'IN_PROGRESS' | 'COMPLETED',
    completedAt: r.completedAt?.toISOString() ?? null,
    completedByName: r.completedById ? (who.get(r.completedById) ?? null) : null,
    clearedCount: countOf.get(r.id) ?? 0,
  }));
}

export async function startReconciliation(db: Db, feedId: string, input: { statementEndDate: string; statementBalance: number }, userId: string | null): Promise<BankReconciliationDetail> {
  const feed = await feedOr404(db, feedId);
  const tenantId = tenantIdForWrite();
  const open = await db.bankReconciliation.findFirst({ where: { tenantId, feedAccountId: feed.id, status: 'IN_PROGRESS' } });
  if (open) throw new HttpError(409, 'reconciliation_in_progress', `A reconciliation through ${ymd(open.statementEndDate)} is already open — finish or reopen that one.`, { reconciliationId: open.id });
  const last = await db.bankReconciliation.findFirst({ where: { tenantId, feedAccountId: feed.id, status: 'COMPLETED' }, orderBy: { statementEndDate: 'desc' } });
  if (last && ymd(last.statementEndDate) >= input.statementEndDate) {
    throw new HttpError(400, 'statement_too_early', `This account is reconciled through ${ymd(last.statementEndDate)}; pick a later statement.`);
  }
  const rec = await db.bankReconciliation.create({
    data: {
      tenantId,
      feedAccountId: feed.id,
      statementEndDate: dateOnly(input.statementEndDate),
      statementBalance: new Prisma.Decimal(input.statementBalance.toFixed(2)),
      beginningBalance: last ? last.statementBalance : new Prisma.Decimal(0),
      createdById: userId,
    },
  });
  // Pre-tick what the bank already showed: matched lines, and the lines its categorizations posted.
  const end = dateOnly(input.statementEndDate);
  const decided = await db.bankTransaction.findMany({ where: { tenantId, feedAccountId: feed.id, postedOn: { lte: end }, status: { in: ['MATCHED', 'CATEGORIZED'] } }, select: { matchedLineId: true, journalEntryId: true } });
  const lineIds = decided.map((d) => d.matchedLineId).filter((x): x is string => !!x);
  const entryIds = decided.map((d) => d.journalEntryId).filter((x): x is string => !!x);
  await db.journalLine.updateMany({
    where: {
      tenantId,
      accountId: feed.ledgerAccountId,
      clearedAt: null,
      reconciliationId: null,
      entry: { status: 'POSTED', entryDate: { lte: end } },
      OR: [{ id: { in: lineIds } }, { entryId: { in: entryIds } }],
    },
    data: { reconciliationId: rec.id },
  });
  return reconciliationDetail(db, rec.id);
}

export async function reconciliationDetail(db: Db, id: string): Promise<BankReconciliationDetail> {
  const rec = await recOr404(db, id);
  const feed = await feedOr404(db, rec.feedAccountId);
  const tenantId = tenantIdForWrite();
  const done = rec.status === 'COMPLETED';
  const lines = await db.journalLine.findMany({
    where: done
      ? { tenantId, reconciliationId: rec.id }
      : { tenantId, accountId: feed.ledgerAccountId, clearedAt: null, entry: { status: 'POSTED', entryDate: { lte: rec.statementEndDate } }, OR: [{ reconciliationId: null }, { reconciliationId: rec.id }] },
    include: { entry: { select: { id: true, number: true, memo: true, entryDate: true, source: true } } },
    orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { number: 'asc' } }],
    take: 5000,
  });
  let cleared = 0;
  const out = lines.map((l) => {
    const amount = normal(feed.ledger, toCents(l.debit) - toCents(l.credit));
    const isCleared = l.reconciliationId === rec.id;
    if (isCleared) cleared += amount;
    return { lineId: l.id, entryId: l.entry.id, entryNumber: l.entry.number, date: ymd(l.entry.entryDate), memo: l.memo ?? l.entry.memo, source: l.entry.source, amount: fromCents(amount), cleared: isCleared };
  });
  const latest = await db.bankReconciliation.findFirst({ where: { tenantId, feedAccountId: feed.id, status: 'COMPLETED' }, orderBy: { statementEndDate: 'desc' } });
  const anyOpen = await db.bankReconciliation.count({ where: { tenantId, feedAccountId: feed.id, status: 'IN_PROGRESS' } });
  const [summary] = await listReconciliations(db, feed.id).then((all) => all.filter((r) => r.id === rec.id));
  const beginning = toCents(rec.beginningBalance);
  return {
    ...summary!,
    feedAccountId: feed.id,
    accountName: feed.name,
    subtype: feed.ledger.subtype,
    lines: out,
    clearedBalance: fromCents(cleared),
    difference: fromCents(toCents(rec.statementBalance) - (beginning + cleared)),
    canUndo: done && latest?.id === rec.id && anyOpen === 0,
  };
}

export async function tick(db: Db, id: string, lineIds: string[], cleared: boolean): Promise<BankReconciliationDetail> {
  const rec = await recOr404(db, id);
  if (rec.status !== 'IN_PROGRESS') throw new HttpError(409, 'reconciliation_completed', 'This reconciliation is complete. Undo it to change what cleared.');
  const feed = await feedOr404(db, rec.feedAccountId);
  const tenantId = tenantIdForWrite();
  await db.journalLine.updateMany({
    where: {
      tenantId,
      id: { in: lineIds },
      accountId: feed.ledgerAccountId,
      clearedAt: null,
      entry: { status: 'POSTED', entryDate: { lte: rec.statementEndDate } },
      reconciliationId: cleared ? null : rec.id,
    },
    data: { reconciliationId: cleared ? rec.id : null },
  });
  return reconciliationDetail(db, id);
}

export async function completeReconciliation(db: Db, id: string, userId: string | null): Promise<BankReconciliationDetail> {
  const detail = await reconciliationDetail(db, id);
  if (detail.status !== 'IN_PROGRESS') throw new HttpError(409, 'reconciliation_completed', 'This reconciliation is already complete.');
  if (toCents(detail.difference) !== 0) {
    throw new HttpError(409, 'reconciliation_difference', `The difference is ${detail.difference.toFixed(2)} — it has to be 0.00 to complete.`);
  }
  const now = new Date();
  await db.$transaction([
    db.journalLine.updateMany({ where: { tenantId: tenantIdForWrite(), reconciliationId: id }, data: { clearedAt: now } }),
    db.bankReconciliation.update({ where: { id }, data: { status: 'COMPLETED', completedAt: now, completedById: userId } }),
  ]);
  return reconciliationDetail(db, id);
}

/** Reopen the most recent completed reconciliation: its lines go back to ticked-but-uncleared. */
export async function undoReconciliation(db: Db, id: string): Promise<BankReconciliationDetail> {
  const detail = await reconciliationDetail(db, id);
  if (!detail.canUndo) throw new HttpError(409, 'not_latest', 'Only the most recent completed reconciliation can be undone, and not while another is open.');
  await db.$transaction([
    db.journalLine.updateMany({ where: { tenantId: tenantIdForWrite(), reconciliationId: id }, data: { clearedAt: null } }),
    db.bankReconciliation.update({ where: { id }, data: { status: 'IN_PROGRESS', completedAt: null, completedById: null } }),
  ]);
  return reconciliationDetail(db, id);
}

/* ---- The job ---------------------------------------------------------------- */

/** Every Plaid Item not synced in the last `staleHours`, then any auto rules over what's waiting. */
export async function syncStaleFeeds(db: Db, now: Date = new Date(), staleHours = 4): Promise<number> {
  const tenantId = tenantIdForWrite();
  if (!(await plaidConnection())) return 0;
  const stale = new Date(now.getTime() - staleHours * 3_600_000);
  const feeds = await db.bankFeedAccount.findMany({ where: { tenantId, feed: 'PLAID', isActive: true, OR: [{ lastSyncedAt: null }, { lastSyncedAt: { lt: stale } }] }, select: { providerAccountId: true } });
  const items = [...new Set(feeds.map((f) => splitPlaidRef(f.providerAccountId)?.itemId).filter((x): x is string => !!x))];
  let synced = 0;
  for (const itemId of items) {
    try {
      await syncPlaidItem(db, itemId);
      synced += 1;
    } catch (err) {
      console.error('[books] plaid sync failed', itemId, err instanceof Error ? err.message : err);
    }
  }
  return synced;
}
