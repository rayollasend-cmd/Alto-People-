import type { Prisma, PrismaClient } from '@prisma/client';
import type { GoLiveCheck, GoLiveSection, PayrollGoLive } from '@alto-people/shared';
import { env } from '../config/env.js';
import { tenantIdForWrite } from './tenant.js';
import { NO_SIT_STATES, isStateTaxSupported, primeStateAcknowledgments, stateAwaitingReview } from './payrollTax.js';
import { LOCAL_TAX_STATES } from './deductionTaxability.js';
import { bankingProfile, originationGaps, ownAccount, usesOurAch } from './banking/ach.js';
import { loadApprovalPolicy, rolesHolding } from './approvalPolicy.js';
import { PAY_RUN_POPULATION_WHERE, scheduleMembershipFor, unscheduledWithTime } from './payScheduleMembership.js';
import { postingGaps } from './books/posting/gaps.js';

/**
 * Running payroll in-house (GET /payroll/go-live): every company-level
 * account and setting a real payroll needs, read for the tenant in context
 * — the checklist a payroll provider walks a new customer through before
 * the first live run, answered by the site's own records.
 *
 * What it can't see, it says: an IRS EFTPS enrollment or a state agency's
 * online account exists outside the site, so those checks read the account
 * numbers and deposit schedules on the tax desk and say what to confirm.
 */

type Db = PrismaClient | Prisma.TransactionClient;

const DAY = 86_400_000;
// eslint-disable-next-line no-restricted-syntax -- UTC on purpose: YYYY-MM-DD of a @db.Date column (stored at UTC midnight) or a UTC-midnight anchor.
const ymd = (d: Date) => d.toISOString().slice(0, 10);

const done = (key: string, title: string, detail: string, fix: GoLiveCheck['fix'] = null): GoLiveCheck => ({ key, title, status: 'DONE', detail, fix });
const missing = (key: string, title: string, detail: string, fix: GoLiveCheck['fix']): GoLiveCheck => ({ key, title, status: 'MISSING', detail, fix });
const warning = (key: string, title: string, detail: string, fix: GoLiveCheck['fix']): GoLiveCheck => ({ key, title, status: 'WARNING', detail, fix });
const info = (key: string, title: string, detail: string, fix: GoLiveCheck['fix'] = null): GoLiveCheck => ({ key, title, status: 'INFO', detail, fix });

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export async function payrollGoLive(db: Db, now: Date = new Date()): Promise<PayrollGoLive> {
  const tenantId = tenantIdForWrite();
  const year = now.getUTCFullYear();
  const sections: GoLiveSection[] = [];

  /* ---- Company ------------------------------------------------------- */
  const employer = await db.employerOrganization.findFirst({ where: { tenantId, isDefault: true } });
  const company: GoLiveCheck[] = [];
  const toEmployers = { label: 'Open employers', to: '/admin/employers' };
  if (!employer) {
    company.push(missing('employer', 'The company on file', 'No employer is set up. Payroll, W-2s and every tax filing carry the legal name and EIN of the employer.', toEmployers));
  } else {
    const ein = (employer.ein ?? '').replace(/\D/g, '');
    company.push(
      employer.legalName && ein.length === 9
        ? done('employer', 'Legal name and EIN', `${employer.legalName}, EIN ending ${ein.slice(-4)}.`, toEmployers)
        : missing('employer', 'Legal name and EIN', 'The federal EIN is missing or isn’t 9 digits. Every deposit, return and W-2 is filed under it.', toEmployers),
    );
    company.push(
      employer.addressLine1 && employer.city && employer.state && employer.zip
        ? done('address', 'Business address', `${employer.addressLine1}, ${employer.city}, ${employer.state} ${employer.zip}.`, toEmployers)
        : missing('address', 'Business address', 'The company’s street address is incomplete. It goes on W-2s, the quarterly returns and every paystub.', toEmployers),
    );
    company.push(
      employer.wcCarrierName && employer.wcPolicyNumber
        ? done('workers-comp', 'Workers’ compensation policy', `${employer.wcCarrierName}, policy ${employer.wcPolicyNumber}.`, toEmployers)
        : warning('workers-comp', 'Workers’ compensation policy', 'No carrier and policy number on file. Most states require coverage before anyone works, and some require it on the pay notice.', toEmployers),
    );
  }
  sections.push({ key: 'company', title: 'Company', checks: company });

  /* ---- Where people live and work ------------------------------------- */
  const since = new Date(now.getTime() - 120 * DAY);
  const people = await db.associate.findMany({
    where: { tenantId, deletedAt: null, separatedAt: null },
    select: { id: true, state: true },
  });
  const workSites = await db.timeEntry.findMany({
    where: { tenantId, clockInAt: { gte: since }, location: { state: { not: null } } },
    select: { location: { select: { state: true } } },
    distinct: ['locationId'],
  });
  const states = [
    ...new Set([
      ...people.map((p) => p.state?.toUpperCase().trim()).filter((s): s is string => !!s && s.length === 2),
      ...workSites.map((w) => w.location?.state?.toUpperCase().trim()).filter((s): s is string => !!s && s.length === 2),
    ]),
  ].sort();

  /* ---- Federal --------------------------------------------------------- */
  const accounts = await db.taxAgencyAccount.findMany({ where: { tenantId, status: 'ACTIVE' } });
  const toAgencies = { label: 'Open tax accounts', to: '/payroll/taxes?tab=agencies' };
  const federal: GoLiveCheck[] = [];
  const fit = accounts.find((a) => a.kind === 'FEDERAL_WITHHOLDING');
  federal.push(
    fit
      ? done('federal-withholding', 'Federal withholding and FICA (Form 941)', `Deposits ${fit.depositFrequency.toLowerCase().replace(/_/g, ' ')}${fit.accountNumber ? `, account ${fit.accountNumber}` : ''}. Confirm the company is enrolled in EFTPS to make the deposits.`, toAgencies)
      : missing('federal-withholding', 'Federal withholding and FICA (Form 941)', 'No federal withholding account with a deposit schedule (monthly or semiweekly). Without it the site can’t tell you when deposits are due.', toAgencies),
  );
  const futa = accounts.find((a) => a.kind === 'FEDERAL_UNEMPLOYMENT');
  federal.push(
    futa
      ? done('federal-unemployment', 'Federal unemployment (Form 940)', `On file${futa.accountNumber ? ` — ${futa.accountNumber}` : ''}.`, toAgencies)
      : missing('federal-unemployment', 'Federal unemployment (Form 940)', 'No federal unemployment account. FUTA is owed on the first $7,000 of each person’s wages and deposited quarterly.', toAgencies),
  );
  sections.push({ key: 'federal', title: 'Federal taxes', checks: federal });

  /* ---- States and local ------------------------------------------------- */
  await primeStateAcknowledgments(db as PrismaClient);
  const stateChecks: GoLiveCheck[] = [];
  if (states.length === 0) {
    stateChecks.push(info('states-none', 'States', 'Nobody has a home state or a work site with a state yet, so there are no state accounts to check. Add people’s addresses first.'));
  }
  for (const s of states) {
    const problems: string[] = [];
    const notes: string[] = [];
    if (!isStateTaxSupported(s)) {
      const review = stateAwaitingReview(s);
      problems.push(review ? `the ${review.taxYear} withholding table is waiting for your review` : 'the site has no withholding table for it');
    }
    const sit = accounts.find((a) => a.kind === 'STATE_WITHHOLDING' && a.jurisdiction.toUpperCase() === s);
    if (!NO_SIT_STATES.has(s) && !sit) problems.push('no state withholding account');
    if (sit) notes.push(`withholding ${sit.depositFrequency.toLowerCase()}`);
    const sui = accounts.find((a) => a.kind === 'STATE_UNEMPLOYMENT' && a.jurisdiction.toUpperCase() === s);
    if (!sui) problems.push('no state unemployment account');
    else if (sui.rate === null || (sui.rateYear !== null && sui.rateYear < year)) problems.push(`no ${year} unemployment rate`);
    else notes.push(`unemployment ${(Number(sui.rate) * 100).toFixed(2)}% for ${sui.rateYear ?? year}`);
    if (NO_SIT_STATES.has(s)) notes.unshift('no state income tax');
    stateChecks.push(
      problems.length === 0
        ? done(`state-${s}`, s, `${notes.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()), toAgencies)
        : missing(`state-${s}`, s, `${problems.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()), !isStateTaxSupported(s) ? { label: 'Open state tax tables', to: '/payroll/tax-tables?tab=state' } : toAgencies),
    );
  }
  const localStates = states.filter((s) => LOCAL_TAX_STATES.has(s));
  if (localStates.length > 0) {
    const local = accounts.filter((a) => a.kind === 'LOCAL');
    stateChecks.push(
      local.length > 0
        ? done('local', 'Local taxes', `${plural(local.length, 'local account', 'local accounts')} on file for ${list(localStates)}. Check each city, county or school district people live or work in is covered.`, { label: 'Open local taxes', to: '/payroll/tax-tables?tab=local' })
        : warning('local', 'Local taxes', `People live or work in ${list(localStates)}, where cities, counties or school districts tax wages. No local tax account is on file.`, { label: 'Open local taxes', to: '/payroll/tax-tables?tab=local' }),
    );
  }
  sections.push({ key: 'states', title: 'State and local taxes', checks: stateChecks });

  /* ---- Filing and deposits ---------------------------------------------- */
  const providers = await db.providerConnection.findMany({ where: { tenantId, active: true }, select: { kind: true, provider: true, name: true, environment: true, lastTestOk: true } });
  const filing = providers.find((p) => p.kind === 'EMBEDDED_PAYROLL') ?? providers.find((p) => p.kind === 'TAX_FILING');
  const filingChecks: GoLiveCheck[] = [];
  if (filing) {
    filingChecks.push(
      filing.environment === 'PRODUCTION'
        ? done('filing', 'Filing returns and paying deposits', `${filing.name} ${filing.kind === 'EMBEDDED_PAYROLL' ? 'pays deposits and files returns' : 'e-files returns'} for you.`, { label: 'Open integrations', to: '/integrations' })
        : warning('filing', 'Filing returns and paying deposits', `${filing.name} is connected in sandbox — nothing real is filed until it goes live.`, { label: 'Open integrations', to: '/integrations' }),
    );
  } else {
    filingChecks.push(info('filing', 'Filing returns and paying deposits', 'No filing service is connected, so you pay each deposit (EFTPS and the state portals) and file each return yourself, from the forms on the tax desk. Connecting one in Integrations files them for you.', { label: 'Open the tax desk', to: '/payroll/taxes' }));
  }
  sections.push({ key: 'filing', title: 'Filing and deposits', checks: filingChecks });

  /* ---- Paying people ------------------------------------------------------ */
  const profile = await bankingProfile(db as PrismaClient);
  const paying: GoLiveCheck[] = [];
  const toBanking = { label: 'Open payroll banking', to: '/payroll/banking?tab=setup' };
  if (usesOurAch(profile)) {
    const gaps = originationGaps(profile);
    paying.push(
      gaps.length === 0
        ? done('ach', 'Your bank’s ACH details', `Files go to your bank as ${profile.companyName}, company ID ${profile.companyId}.`, toBanking)
        : missing('ach', 'Your bank’s ACH details', `Paychecks go out over your own ACH, and the bank still needs ${list(gaps)}.`, toBanking),
    );
    const funding = profile.fundingAccountId ? await db.employerBankAccount.findFirst({ where: { id: profile.fundingAccountId, tenantId } }) : null;
    const toAccounts = { label: 'Open bank accounts', to: '/payroll/banking?tab=accounts' };
    const bank = profile.immediateDestinationName?.trim() || 'your bank';
    if (ownAccount(profile) && profile.fileFormat === 'UNBALANCED') {
      paying.push(done('funding', 'Company account at the bank', `Paychecks are drawn on your account at ${bank}; the bank books the offset. Nothing is pulled ahead of payday.`, toBanking));
    } else {
      const what = ownAccount(profile) ? 'Offset account' : 'Funding account';
      const why = ownAccount(profile) ? 'A balanced file debits it for the paychecks’ total.' : 'Payroll is pulled from it a banking day ahead.';
      paying.push(
        funding?.status === 'VERIFIED'
          ? done('funding', what, `${funding.label} (${funding.bankName ?? 'bank'}), verified. ${why}`, toAccounts)
          : missing('funding', what, funding ? `${funding.label} isn’t verified yet — the micro-deposits or bank letter haven’t been confirmed.` : `No account is chosen. ${why}`, toAccounts),
      );
    }
    paying.push(
      profile.kybStatus === 'APPROVED'
        ? done('kyb', 'Bank approval to send payroll', 'Your bank approved the company to originate ACH.', toBanking)
        : missing('kyb', 'Bank approval to send payroll', profile.kybStatus === 'PENDING' ? 'Your bank is still reviewing the company to originate ACH.' : profile.kybStatus === 'REJECTED' ? 'Your bank declined the ACH application — see the note on the setup tab.' : 'Your bank hasn’t approved the company to originate ACH yet.', toBanking),
    );
    paying.push(
      profile.perRunLimitCents || profile.perDayLimitCents
        ? done('limits', 'Payroll limits', 'A per-run or per-day limit stops a payroll bigger than expected from going out.', toBanking)
        : warning('limits', 'Payroll limits', 'No per-run or per-day limit is set. A limit holds an unusually large payroll for a second look before money moves.', toBanking),
    );
  } else {
    const payout = providers.find((p) => p.kind === 'PAYOUT');
    const rail = env.PAYROLL_DISBURSEMENT_PROVIDER;
    if (payout) paying.push(done('payouts', 'How paychecks go out', `${payout.name} sends direct deposits.`, { label: 'Open integrations', to: '/integrations' }));
    else if (rail === 'WISE' || rail === 'BRANCH') paying.push(done('payouts', 'How paychecks go out', `${rail === 'WISE' ? 'Wise' : 'Branch'} sends direct deposits.`, toBanking));
    else if (rail === 'CHECK') paying.push(warning('payouts', 'How paychecks go out', 'Everyone is paid by paper check. Direct deposit needs your own ACH or a payout service.', toBanking));
    else paying.push(missing('payouts', 'How paychecks go out', 'Payouts are simulated: a run marked paid moves no money. Set up your own ACH on Payroll banking, or connect a payout service in Integrations.', toBanking));
  }
  sections.push({ key: 'paying', title: 'Paying people', checks: paying });

  /* ---- Schedules and people --------------------------------------------- */
  const peopleChecks: GoLiveCheck[] = [];
  const schedules = await db.payrollSchedule.findMany({ where: { tenantId, deletedAt: null, isActive: true }, select: { id: true, name: true, isDefault: true } });
  const dflt = schedules.find((s) => s.isDefault);
  peopleChecks.push(
    schedules.length === 0
      ? missing('schedules', 'Pay schedules', 'No pay schedule is set up, so there are no pay periods or paydays.', { label: 'Open pay schedules', to: '/payroll/schedules' })
      : dflt
        ? done('schedules', 'Pay schedules', `${plural(schedules.length, 'schedule', 'schedules')}; ${dflt.name} is the company default, so new hires are always on one.`, { label: 'Open pay schedules', to: '/payroll/schedules' })
        : warning('schedules', 'Pay schedules', `${plural(schedules.length, 'schedule', 'schedules')}, but no company default — a new hire no rule covers lands on none and isn’t paid.`, { label: 'Open pay schedules', to: '/payroll/schedules' }),
  );
  const unscheduled = await unscheduledWithTime(db, ymd(new Date(now.getTime() - 14 * DAY)), ymd(now), null);
  peopleChecks.push(
    unscheduled.length === 0
      ? done('unscheduled', 'Everyone with hours is on a schedule', 'Nobody with approved time in the last two weeks is left off a pay schedule.')
      : missing('unscheduled', 'Everyone with hours is on a schedule', `${plural(unscheduled.length, 'person has', 'people have')} approved time in the last two weeks and no pay schedule — no run would pay them (${list(unscheduled.slice(0, 3).map((u) => u.name))}${unscheduled.length > 3 ? ' …' : ''}).`, { label: 'Open pay schedules', to: '/payroll/schedules' }),
  );
  // The per-person readiness (the /payroll/readiness flags, same people, same
  // rules): W-4 or TIN, tax state, payout, and a schedule by the one
  // membership rule (lib/payScheduleMembership).
  const staff = await db.associate.findMany({
    where: { AND: [{ tenantId }, PAY_RUN_POPULATION_WHERE] },
    select: { id: true, employmentType: true, state: true, tinEncrypted: true, w4Submission: { select: { id: true } }, payoutMethods: { where: { isPrimary: true }, take: 1, select: { branchCardId: true, accountNumberEnc: true } } },
  });
  const membership = await scheduleMembershipFor(db, staff.map((a) => a.id), ymd(now));
  const notReady = staff.filter((a) => {
    const w4 = a.employmentType === 'W2_EMPLOYEE' ? !!a.w4Submission : !!a.tinEncrypted;
    const p = a.payoutMethods[0];
    const payout = !!p && (p.branchCardId !== null || p.accountNumberEnc !== null);
    return !(w4 && isStateTaxSupported(a.state) && payout && membership.get(a.id));
  }).length;
  peopleChecks.push(
    staff.length === 0
      ? info('people', 'People ready to be paid', 'Nobody is on the roster yet.')
      : notReady === 0
        ? done('people', 'People ready to be paid', `All ${staff.length} have a W-4 (or W-9), a supported tax state, a way to be paid and a schedule.`, { label: 'Open readiness', to: '/payroll/readiness' })
        : warning('people', 'People ready to be paid', `${plural(notReady, 'person is', 'people are')} missing a W-4 or W-9, a tax state, a way to be paid or a schedule. A run withholds wrong or can’t pay them.`, { label: 'Open readiness', to: '/payroll/readiness' }),
  );
  sections.push({ key: 'people', title: 'Schedules and people', checks: peopleChecks });

  /* ---- Controls ---------------------------------------------------------- */
  const controls: GoLiveCheck[] = [];
  const policy = await loadApprovalPolicy(db as PrismaClient, tenantId);
  controls.push(
    policy.payrollReviewRequired
      ? done('review', 'Pre-payroll review', 'Every run is reviewed and signed before money moves.', { label: 'Open approval settings', to: '/admin/branding' })
      : warning('review', 'Pre-payroll review', 'Runs can be paid without the pre-payroll review an accountant signs. Turn it on to catch a wrong run before it pays.', { label: 'Open approval settings', to: '/admin/branding' }),
  );
  const approvers = await db.user.count({ where: { tenantId, status: 'ACTIVE', deletedAt: null, role: { in: rolesHolding('process:payroll') } } });
  controls.push(
    approvers >= 2
      ? done('two-people', 'Two people can approve payroll', `${approvers} people can run and approve payroll, so the second-person checks always have someone to decide.`, { label: 'Open users', to: '/admin/users' })
      : missing('two-people', 'Two people can approve payroll', `Only ${approvers} ${approvers === 1 ? 'person' : 'people'} can run payroll. The review, funding limits and bank changes each need a second person.`, { label: 'Open users', to: '/admin/users' }),
  );
  sections.push({ key: 'controls', title: 'Controls', checks: controls });

  /* ---- Books ------------------------------------------------------------- */
  const books: GoLiveCheck[] = [];
  const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const gaps = await postingGaps(db, lastMonth).catch(() => []);
  books.push(
    gaps.length === 0
      ? done('posting', 'Payroll posts to the books', 'Every run, payout and tax deposit last month is in the general ledger.', { label: 'Open the books', to: '/books' })
      : warning('posting', 'Payroll posts to the books', `${plural(gaps.length, 'item', 'items')} from last month ${gaps.length === 1 ? 'isn’t' : 'aren’t'} in the books yet. Posting the history brings them in.`, { label: 'Post the history', to: '/books/receivables' }),
  );
  const qbo = await db.qboCompanyConnection.findFirst({ where: { tenantId }, select: { status: true, companyName: true } });
  books.push(
    qbo?.status === 'CONNECTED'
      ? done('quickbooks', 'QuickBooks', `Connected${qbo.companyName ? ` to ${qbo.companyName}` : ''}: payroll goes over as summary entries.`, { label: 'Open QuickBooks sync', to: '/books/quickbooks' })
      : qbo
        ? warning('quickbooks', 'QuickBooks', `The connection is ${qbo.status.toLowerCase().replace(/_/g, ' ')}, so payroll isn’t reaching QuickBooks.`, { label: 'Open QuickBooks sync', to: '/books/quickbooks' })
        : info('quickbooks', 'QuickBooks', 'Not connected. The books here are complete on their own; connect QuickBooks if your accountant works there.', { label: 'Open QuickBooks sync', to: '/books/quickbooks' }),
  );
  sections.push({ key: 'books', title: 'Books', checks: books });

  const all = sections.flatMap((s) => s.checks);
  const m = all.filter((c) => c.status === 'MISSING').length;
  return {
    ready: m === 0,
    missing: m,
    warnings: all.filter((c) => c.status === 'WARNING').length,
    done: all.filter((c) => c.status === 'DONE').length,
    total: all.length,
    states,
    sections,
    generatedAt: now.toISOString(),
  };
}
