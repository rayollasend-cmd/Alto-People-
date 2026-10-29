import { useEffect, useState, type ReactNode } from 'react';
import { nextInQueue, prevInQueue } from '@/lib/queueNext';
import { withReturn } from '@/lib/returnPath';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { Avatar } from '@/components/ui/Avatar';
import { associatePhotoUrl } from '@/lib/photoUrl';
import { Lock, MessageCircle, Plus, Tag, Timer } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  addComment,
  CATEGORY_LABELS,
  fileCase,
  getCase,
  getCaseSummary,
  listCaseQueue,
  listCaseStaff,
  listMyCases,
  STATUS_LABELS,
  triageCase,
  type CaseCategory,
  type CaseDetail,
  type CasePriority,
  type CaseStaffRow,
  type CaseStatus,
  type CaseSummary,
  type MyCaseRow,
  type QueueCaseRow,
} from '@/lib/hrCases123Api';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { statusTone } from '@/lib/status';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Input,
  SegmentedControl,
  type SegmentedControlOption,
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { QueryError } from '@/components/ui/QueryError';
import { FilterChip } from '@/components/ui/FilterBar';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import type { PageAction } from '@/components/ui/PageHeader';
import { urlBoolean, useUrlFilters, useUrlParam, useUrlState } from '@/lib/useUrlState';
import { Label } from '@/components/ui/Label';
import { ListTemplate } from '@/components/templates';
import { fmtDate, fmtDateTime, ymdLocal } from '@/lib/format';
import { SlaChip, SlaTargetsDialog } from './SlaTargetsDialog';
import { OnBehalfCaseDrawer } from './OnBehalfCaseDrawer';
import '@/lib/i18n/en/hrc';

// Deliberate departures from the shared vocabulary: an OPEN case is unclaimed
// work awaiting triage (amber, not the vocabulary's actionable gold — gold is
// reserved here for IN_PROGRESS, actively being worked). WAITING_ASSOCIATE is
// domain-only. RESOLVED / CLOSED come from the shared status vocabulary.
const CASE_STATUS_TONES = {
  OPEN: 'pending',
  IN_PROGRESS: 'accent',
  WAITING_ASSOCIATE: 'pending',
} as const;

const PRIORITY_VARIANT: Record<
  CasePriority,
  'outline' | 'pending' | 'accent' | 'destructive'
> = {
  LOW: 'outline',
  MEDIUM: 'pending',
  HIGH: 'accent',
  URGENT: 'destructive',
};

const PRIORITY_LABELS: Record<CasePriority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

// Associate-facing display labels keyed off the API enums. The admin queue
// (and CSV export) keeps using the static English *_LABELS maps.
const caseStatusLabel = (
  t: ReturnType<typeof useI18n>['t'],
  s: CaseStatus,
): string => t(('hrc.status.' + s) as MessageKey);

const caseCategoryLabel = (
  t: ReturnType<typeof useI18n>['t'],
  c: CaseCategory,
): string => t(('hrc.category.' + c) as MessageKey);

const casePriorityLabel = (
  t: ReturnType<typeof useI18n>['t'],
  p: CasePriority,
): string => t(('hrc.priority.' + p) as MessageKey);

const TABS = ['mine', 'queue'] as const;
type Tab = (typeof TABS)[number];
/** The queue's status filter: every case still being worked (the default), one status, or all. */
type StatusFilter = 'OPEN_ALL' | CaseStatus | 'ALL';
const STATUS_FILTERS: readonly StatusFilter[] = ['OPEN_ALL', 'ALL', ...(Object.keys(STATUS_LABELS) as CaseStatus[])];
const CATEGORY_FILTERS: readonly (CaseCategory | 'ALL')[] = ['ALL', ...(Object.keys(CATEGORY_LABELS) as CaseCategory[])];
const SLA_FILTERS = ['', 'breached'] as const;
const FILTER_KEYS = ['status', 'category', 'mine', 'sla', 'unassigned'] as const;

/** "4 h", "1.5 d" — the median first reply. */
function fmtReplyHours(h: number): string {
  if (h < 48) return `${h.toLocaleString('en-US', { maximumFractionDigits: 1 })} h`;
  return `${(h / 24).toLocaleString('en-US', { maximumFractionDigits: 1 })} d`;
}

export function HrCasesHome() {
  const { user, can } = useAuth();
  const { t } = useI18n();
  // The case desk (the API's rule, lib/hrCaseScope): HR — view:hr-admin AND
  // manage:onboarding — works every case; process:payroll (Finance) works
  // the PAYROLL desk. The recruiter and the workforce manager hold
  // manage:onboarding for the onboarding desk only: they file and follow
  // their own cases, never the queue (PEOPLE-5).
  const hrDesk = !!user && can('view:hr-admin') && can('manage:onboarding');
  const canManage = !!user && (hrDesk || can('process:payroll'));
  const payrollDeskOnly = !!user && !hrDesk && can('process:payroll');
  // Filters live in the URL (?status=, ?category=, ?mine=1, ?sla=breached,
  // ?unassigned=1), so the Inbox's ?sla=breached link lands filtered and a
  // filtered queue can be shared.
  const [statusFilter, setStatusFilter] = useUrlParam<StatusFilter>('status', 'OPEN_ALL', STATUS_FILTERS);
  const [categoryFilter, setCategoryFilter] = useUrlParam<CaseCategory | 'ALL'>('category', 'ALL', CATEGORY_FILTERS);
  const [assignedToMe, setAssignedToMe] = useUrlState('mine', false, urlBoolean);
  const [sla, setSla] = useUrlParam<(typeof SLA_FILTERS)[number]>('sla', '', SLA_FILTERS);
  const [unassignedOnly, setUnassignedOnly] = useUrlState('unassigned', false, urlBoolean);
  const breachedOnly = canManage && sla === 'breached';
  const { active: activeFilters, clear: clearFilters } = useUrlFilters(FILTER_KEYS);
  // Desk staff without an associate record have no "mine" — land on the
  // queue instead of an empty tab; a deep link to past-SLA cases does too.
  const [tabParam, setTab] = useUrlParam<Tab>('tab', canManage && (!user?.associateId || breachedOnly) ? 'queue' : 'mine', TABS, { history: 'push' });
  const tab: Tab = canManage ? tabParam : 'mine';
  const [showNew, setShowNew] = useState(false);
  // HR opens a case for someone who called or walked in (HR walk 13).
  // The whole-desk role only — Finance works the payroll desk, it doesn't file.
  const canFileOnBehalf = hrDesk;
  const [showOnBehalf, setShowOnBehalf] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showSla, setShowSla] = useState(false);

  // Notification deep-link: ?case=<id> opens that case's drawer directly
  // (the drawer fetches by id, so no list lookup is needed and the server
  // enforces visibility). Consumed once — same pattern as ?associateId=
  // on People — so back/refresh don't re-open a drawer the user closed.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const caseParam = searchParams.get('case');
    if (!caseParam) return;
    setOpenId(caseParam);
    const next = new URLSearchParams(searchParams);
    next.delete('case');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  // ?new=1 — other desks' "Open an HR case" links: open the New case form
  // (the person's own, or the desk's for-someone form when they have no
  // record of their own). Consumed once, like ?case=.
  useEffect(() => {
    if (searchParams.get('new') !== '1') return;
    if (user?.associateId) setShowNew(true);
    else if (canFileOnBehalf) setShowOnBehalf(true);
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, user?.associateId, canFileOnBehalf]);

  // Each tab reads its own list; a tab or filter change is a new key and
  // shows the skeleton, while a refetch after a mutation (drawer close,
  // new case) keeps the current rows on screen so the list never
  // collapses and throws away the reader's scroll position.
  const mineQuery = useQuery({
    queryKey: ['hrCases', 'mine'],
    queryFn: () => listMyCases(),
    enabled: tab === 'mine',
  });
  // Paged on the server: "Show more" reads on instead of the queue
  // silently stopping at the first hundred.
  const queueQuery = useInfiniteQuery({
    queryKey: ['hrCases', 'queue', { status: statusFilter, category: categoryFilter, assignedToMe, breachedOnly, unassignedOnly }],
    queryFn: ({ pageParam }) =>
      listCaseQueue(
        {
          status: breachedOnly || statusFilter === 'ALL' || statusFilter === 'OPEN_ALL' ? undefined : statusFilter,
          state: !breachedOnly && statusFilter === 'OPEN_ALL' ? 'open' : undefined,
          category: categoryFilter === 'ALL' ? undefined : categoryFilter,
          assignedToMe: assignedToMe || undefined,
          sla: breachedOnly ? 'breached' : undefined,
          unassigned: unassignedOnly || undefined,
        },
        pageParam,
      ),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.hasMore ? all.length : undefined),
    enabled: tab !== 'mine',
  });
  const mine: MyCaseRow[] | null = mineQuery.data?.cases ?? null;
  const queue: QueueCaseRow[] | null = queueQuery.data ? queueQuery.data.pages.flatMap((p) => p.cases) : null;
  const queueTotal = queueQuery.data?.pages[0]?.total ?? null;
  // The drawer's previous / next walk the list as filtered (the filters are the URL's).
  const visibleQueue = queue ?? [];
  const refresh = (_opts?: { soft?: boolean }) => {
    void (tab === 'mine' ? mineQuery.refetch() : queueQuery.refetch());
  };
  // Filter-independent KPI summary — read once and re-read explicitly
  // after mutations, never on tab/filter clicks.
  const summaryQuery = useQuery({
    queryKey: ['hrCases', 'summary'],
    queryFn: () => getCaseSummary(),
    enabled: canManage,
  });
  const summary: CaseSummary | null =
    canManage && !summaryQuery.isError ? (summaryQuery.data ?? null) : null;
  const refreshSummary = () => void summaryQuery.refetch();

  // The queue segment only exists for HR; building the option list up front
  // keeps the conditional out of the JSX and the generic parameter explicit
  // (inference would otherwise narrow to 'mine').
  const tabOptions: SegmentedControlOption<Tab>[] = [
    { value: 'mine', label: t('hrc.tabMine') },
    { value: 'queue', label: 'Queue', count: summary?.openTotal },
  ];

  // One "New case": the desk files for someone (or, for desk staff with an
  // associate record, for themselves from My cases); an associate files their own.
  const actions: PageAction[] = [];
  if (canFileOnBehalf) {
    actions.push({
      key: 'on-behalf',
      label: user?.associateId ? t('hrc.onBehalf.button') : t('hrc.newCase'),
      icon: Plus,
      primary: !user?.associateId || tab === 'queue',
      onSelect: () => setShowOnBehalf(true),
    });
  }
  if (user?.associateId) {
    actions.push({ key: 'new', label: t('hrc.newCase'), icon: Plus, primary: !canFileOnBehalf || tab === 'mine', onSelect: () => setShowNew(true) });
  }
  if (canManage) {
    actions.push({ key: 'sla', label: 'SLA targets', icon: Timer, overflow: true, onSelect: () => setShowSla(true) });
  }

  const onlyOpen = () => {
    clearFilters();
  };
  const firstReply = summary?.firstReply;

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate title={t('hrc.title')} subtitle={t('hrc.subtitle')} actions={actions}>
      {canManage && (
        // Only desk staff have two views; an associate's one-option switch said nothing.
        <SegmentedControl<Tab> ariaLabel={t('hrc.viewAria')} value={tab} onChange={setTab} options={tabOptions} />
      )}

      {canManage && tab === 'queue' && summary && (
        // A desk that has never had a case gets the empty state below, not four zeros.
        <MetricStrip label={t('hrc.desk.strip')} empty={summary.openTotal === 0 && (summary.firstReply?.filed ?? 0) === 0 && (summary.byStatus?.RESOLVED ?? 0) + (summary.byStatus?.CLOSED ?? 0) === 0}>
          <MetricCard
            label={t('hrc.desk.open')}
            value={summary.openTotal}
            hint={t('hrc.desk.openHint')}
            onClick={onlyOpen}
            selected={activeFilters === 0}
          />
          <MetricCard
            label={t('hrc.desk.pastSla')}
            value={summary.sla?.breached ?? 0}
            hint={(summary.sla?.atRisk ?? 0) > 0 ? t('hrc.desk.pastSlaSoon', { n: summary.sla.atRisk.toLocaleString() }) : t('hrc.desk.pastSlaHint')}
            tone={(summary.sla?.breached ?? 0) > 0 ? 'alert' : 'default'}
            onClick={() => setSla(breachedOnly ? '' : 'breached')}
            selected={breachedOnly}
          />
          <MetricCard
            label={t('hrc.desk.unassigned')}
            value={summary.unassigned ?? 0}
            hint={t('hrc.desk.unassignedHint')}
            tone={(summary.unassigned ?? 0) > 0 ? 'warning' : 'default'}
            onClick={() => setUnassignedOnly(!unassignedOnly)}
            selected={unassignedOnly}
          />
          <MetricCard
            label={t('hrc.desk.medianReply')}
            value={firstReply && firstReply.medianHours !== null ? fmtReplyHours(firstReply.medianHours) : '—'}
            hint={firstReply ? t('hrc.desk.medianReplyHint', { days: firstReply.days, replied: firstReply.replied.toLocaleString(), filed: firstReply.filed.toLocaleString() }) : undefined}
            nothing={!firstReply || firstReply.medianHours === null ? t('hrc.desk.noReplies') : undefined}
          />
        </MetricStrip>
      )}

      {tab === 'mine' ? (
        <Card>
          <CardContent className="p-0">
            {mineQuery.error ? (
              <div className="p-4">
                <QueryError what={t('hrc.tabMine').toLowerCase()} query={mineQuery} />
              </div>
            ) : mine === null ? (
              <div className="p-6">
                <SkeletonRows count={3} />
              </div>
            ) : mine.length === 0 ? (
              <EmptyState
                icon={MessageCircle}
                title={t('hrc.emptyTitle')}
                description={t('hrc.emptyDesc')}
              />
            ) : (
              <div className="divide-y divide-navy-secondary">
                {mine.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setOpenId(c.id)}
                    className="w-full p-4 text-left hover:bg-navy-tertiary transition flex items-start gap-3"
                  >
                    <Tag className="h-4 w-4 text-silver mt-1" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-white">
                        {c.subject}
                      </div>
                      <div className="text-xs text-silver mt-0.5">
                        {caseCategoryLabel(t, c.category)} ·{' '}
                        {fmtDate(c.updatedAt)}
                        {c.commentCount > 0 &&
                          ` · ${t('hrc.replyCount', { count: c.commentCount })}`}
                      </div>
                    </div>
                    <Badge variant={statusTone(c.status, { overrides: CASE_STATUS_TONES })}>
                      {caseStatusLabel(t, c.status)}
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : queueQuery.error ? (
        <QueryError what={t('hrc.load.queue')} query={queueQuery} />
      ) : (
        <>
          <DataGrid<QueueCaseRow>
            id="hr-cases"
            caption="HR case queue"
            noun={{ one: 'case', many: 'cases' }}
            rows={queue}
            loading={queue === null}
            rowKey={(c) => c.id}
            search={{ placeholder: 'Subject or person…' }}
            urlKey="cases"
            total={queueTotal ?? undefined}
            exportCsv={{ filename: `hr-cases-queue-${ymdLocal()}` }}
            activeFilters={activeFilters}
            onClearFilters={clearFilters}
            filters={
              <>
                <Select
                  size="sm"
                  aria-label={t('hrc.filter.status')}
                  value={breachedOnly ? 'OPEN_ALL' : statusFilter}
                  disabled={breachedOnly}
                  onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                >
                  <option value="OPEN_ALL">{t('hrc.filter.openCases')}</option>
                  <option value="ALL">{t('hrc.filter.allStatuses')}</option>
                  {(Object.keys(STATUS_LABELS) as CaseStatus[]).map((st) => (
                    <option key={st} value={st}>
                      {caseStatusLabel(t, st)}
                    </option>
                  ))}
                </Select>
                {/* Finance's queue is PAYROLL-only server-side; the filter
                    would be a row of dead options. */}
                {!payrollDeskOnly && (
                  <Select
                    size="sm"
                    aria-label={t('hrc.filter.category')}
                    value={categoryFilter}
                    onChange={(e) => setCategoryFilter(e.target.value as CaseCategory | 'ALL')}
                  >
                    <option value="ALL">{t('hrc.filter.allCategories')}</option>
                    {(Object.keys(CATEGORY_LABELS) as CaseCategory[]).map((k) => (
                      <option key={k} value={k}>
                        {CATEGORY_LABELS[k]}
                      </option>
                    ))}
                  </Select>
                )}
                <FilterChip active={assignedToMe} onClick={() => setAssignedToMe(!assignedToMe)}>
                  Assigned to me
                </FilterChip>
                <FilterChip active={breachedOnly} onClick={() => setSla(breachedOnly ? '' : 'breached')} count={summary?.sla?.breached || undefined}>
                  Past SLA
                </FilterChip>
              </>
            }
            empty={{
              icon: MessageCircle,
              title: 'No open cases',
              description: 'Questions, paycheck disputes and concerns people file land here.',
              action: canFileOnBehalf ? (
                <Button size="sm" variant="outline" onClick={() => setShowOnBehalf(true)}>
                  <Plus className="mr-2 h-4 w-4" /> {user?.associateId ? t('hrc.onBehalf.button') : t('hrc.newCase')}
                </Button>
              ) : undefined,
            }}
            onRowClick={(c) => setOpenId(c.id)}
            rowActionLabel={(c) => `Open case ${c.subject}`}
            columns={[
              {
                key: 'subject',
                header: 'Subject',
                accessor: (c) => c.subject,
                sortable: true,
                primary: true,
                cell: (c) => (
                  <>
                    <div className="font-medium text-white">{c.subject}</div>
                    {(c.channel || c.commentCount > 0) && (
                      <div className="flex items-center gap-1.5 text-xs text-silver">
                        {c.channel && (
                          <Badge size="sm" variant="outline" title={c.filedByEmail ? `Taken by ${c.filedByEmail}` : undefined}>
                            {t(`hrc.channel.${c.channel}` as MessageKey)}
                          </Badge>
                        )}
                        {c.commentCount > 0 && <span>{c.commentCount === 1 ? '1 reply' : `${c.commentCount} replies`}</span>}
                      </div>
                    )}
                  </>
                ),
              },
              {
                key: 'associate',
                header: 'Associate',
                accessor: (c) => `${c.associateName} ${c.associateEmail}`,
                csv: (c) => c.associateName,
                sortable: true,
                cardMeta: true,
                cell: (c) => (
                  <div className="flex items-center gap-2">
                    <Avatar src={associatePhotoUrl(c.associateId)} name={c.associateName} email={c.associateEmail} size="sm" />
                    <div className="min-w-0">
                      <div className="text-sm">
                        <AssociateLink associateId={c.associateId}>{c.associateName}</AssociateLink>
                      </div>
                      <div className="text-xs text-silver">{c.associateEmail}</div>
                    </div>
                  </div>
                ),
              },
              { key: 'category', header: 'Category', accessor: (c) => CATEGORY_LABELS[c.category], sortable: true, cardMeta: true, className: 'text-sm text-silver' },
              {
                key: 'priority',
                header: 'Priority',
                accessor: (c) => PRIORITY_LABELS[c.priority],
                sortable: true,
                cell: (c) => <Badge variant={PRIORITY_VARIANT[c.priority]}>{PRIORITY_LABELS[c.priority]}</Badge>,
              },
              {
                key: 'status',
                header: 'Status',
                accessor: (c) => caseStatusLabel(t, c.status),
                sortable: true,
                cell: (c) => <Badge variant={statusTone(c.status, { overrides: CASE_STATUS_TONES })}>{caseStatusLabel(t, c.status)}</Badge>,
              },
              { key: 'owner', header: 'Assigned to', accessor: (c) => c.assignedToEmail ?? '', sortable: true, defaultHidden: true, className: 'text-xs text-silver', cell: (c) => c.assignedToEmail ?? 'Nobody yet' },
              {
                key: 'sla',
                header: 'SLA',
                // Overdue first when sorted ascending: minutes left, paused/done last.
                accessor: (c) => c.sla?.minutesLeft ?? Number.MAX_SAFE_INTEGER,
                csv: (c) => c.sla?.dueAt ?? '',
                sortable: true,
                searchable: false,
                cell: (c) => (c.sla ? <SlaChip sla={c.sla} /> : null),
              },
              { key: 'updated', header: 'Updated', accessor: (c) => c.updatedAt, csv: (c) => fmtDate(c.updatedAt), sortable: true, searchable: false, className: 'text-xs text-silver', cell: (c) => fmtDate(c.updatedAt) },
            ]}
          />
          {queue && queueQuery.hasNextPage && (
            <div className="flex items-center justify-center gap-3 text-xs text-ink-muted">
              <span>
                Showing {queue.length}
                {queueTotal !== null ? ` of ${queueTotal}` : ''}
              </span>
              <Button size="sm" variant="outline" onClick={() => void queueQuery.fetchNextPage()} loading={queueQuery.isFetchingNextPage}>
                Show more
              </Button>
            </div>
          )}
        </>
      )}

      {canManage && <SlaTargetsDialog open={showSla} canManage={hrDesk && can('manage:org')} onClose={() => setShowSla(false)} />}
      {showOnBehalf && (
        <OnBehalfCaseDrawer
          onClose={() => setShowOnBehalf(false)}
          onSaved={(id) => {
            setShowOnBehalf(false);
            setTab('queue');
            setOpenId(id);
            refresh({ soft: true });
            refreshSummary();
          }}
        />
      )}
      {showNew && (
        <NewCaseDrawer
          onClose={() => setShowNew(false)}
          onSaved={(id) => {
            setShowNew(false);
            setOpenId(id);
            refresh({ soft: true });
            if (canManage) refreshSummary();
          }}
        />
      )}
      {openId && (
        <CaseDetailDrawer
          caseId={openId}
          canManage={canManage}
          // Work the queue from inside the drawer: previous / next case in
          // the list as filtered, instead of close → find → open per case.
          onPrev={() => {
            const p = prevInQueue(visibleQueue, openId);
            if (p) setOpenId(p.id);
          }}
          onNext={() => {
            const n = nextInQueue(visibleQueue, openId);
            if (n) setOpenId(n.id);
          }}
          onClose={() => {
            setOpenId(null);
            // Soft — keep the list rendered (no skeleton, no scroll loss)
            // while the post-triage truth refetches behind it.
            refresh({ soft: true });
            if (canManage) refreshSummary();
          }}
        />
      )}
    </ListTemplate>
  );
}

function NewCaseDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const { t } = useI18n();
  const [category, setCategory] = useState<CaseCategory>('BENEFITS');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<CasePriority>('MEDIUM');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!subject.trim() || !description.trim()) {
      toast.error(t('hrc.validationRequired'));
      return;
    }
    setSaving(true);
    try {
      const r = await fileCase({
        category,
        subject: subject.trim(),
        description: description.trim(),
        priority,
      });
      toast.success(t('hrc.caseFiled'));
      onSaved(r.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('hrc.fileFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer
      open={true}
      onOpenChange={(o) => !o && onClose()}
      // A grievance narrative is slow to retype — guard Esc/overlay/swipe
      // dismissals once anything has been typed.
      confirmDiscard={() => subject.trim().length > 0 || description.trim().length > 0}
    >
      <DrawerHeader>
        <DrawerTitle>{t('hrc.newCaseTitle')}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>{t('hrc.categoryLabel')}</Label>
          <Select
            className="mt-1"
            value={category}
            onChange={(e) => setCategory(e.target.value as CaseCategory)}
          >
            {(Object.keys(CATEGORY_LABELS) as CaseCategory[]).map((k) => (
              <option key={k} value={k}>
                {caseCategoryLabel(t, k)}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>{t('hrc.subjectLabel')}</Label>
          <Input
            className="mt-1"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={t('hrc.subjectPlaceholder')}
          />
        </div>
        <div>
          <Label>{t('hrc.descriptionLabel')}</Label>
          <Textarea
            className="mt-1 h-40"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('hrc.descriptionPlaceholder')}
          />
        </div>
        <div>
          <Label>{t('hrc.priorityLabel')}</Label>
          <Select
            className="mt-1"
            value={priority}
            onChange={(e) => setPriority(e.target.value as CasePriority)}
          >
            <option value="LOW">{t('hrc.priority.LOW')}</option>
            <option value="MEDIUM">{t('hrc.priority.MEDIUM')}</option>
            <option value="HIGH">{t('hrc.priority.HIGH')}</option>
            <option value="URGENT">{t('hrc.priority.URGENT')}</option>
          </Select>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('hrc.cancel')}
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? t('hrc.filing') : t('hrc.fileCase')}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

// Case bodies render as plain text, but time disputes auto-attach an
// app path ("Open the entry: /time-attendance?entry=…"). Make ONLY
// app-internal paths (whitespace-preceded, leading '/') clickable — this
// is deliberately not a general URL linkifier: bodies are associate-typed
// free text and external links would be a phishing surface.
const INTERNAL_PATH_RE = /(^|\s)(\/[a-z][\w-]*(?:\/[\w-]+)*(?:\?[\w=&-]+)?)/g;

function LinkifiedBody({ text, returnTo }: { text: string; returnTo?: string }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  INTERNAL_PATH_RE.lastIndex = 0;
  for (
    let m = INTERNAL_PATH_RE.exec(text);
    m !== null;
    m = INTERNAL_PATH_RE.exec(text)
  ) {
    const start = m.index + m[1].length;
    if (start > last) nodes.push(text.slice(last, start));
    nodes.push(
      <Link
        key={start}
        // Fix the punch, come straight back to the case to close it.
        to={withReturn(m[2], returnTo)}
        className="text-gold hover:underline underline-offset-4"
      >
        {m[2]}
      </Link>,
    );
    last = start + m[2].length;
  }
  if (last === 0) return <>{text}</>;
  if (last < text.length) nodes.push(text.slice(last));
  return <>{nodes}</>;
}

function CaseDetailDrawer({
  caseId,
  canManage,
  onClose,
  onPrev,
  onNext,
}: {
  caseId: string;
  canManage: boolean;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const { t } = useI18n();
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);

  // Keeps the current case rendered while refetching — refresh fires after
  // every reply/triage action, and blanking to a skeleton each time lost
  // the reader's place (and flashed the whole drawer).
  const caseQuery = useQuery({
    queryKey: ['hrCases', 'case', caseId],
    queryFn: () => getCase(caseId),
  });
  const data: CaseDetail | null = caseQuery.data ?? null;
  const loadError = caseQuery.error
    ? caseQuery.error instanceof ApiError
      ? caseQuery.error.message
      : t('hrc.loadCaseFailed')
    : null;
  const refresh = () => void caseQuery.refetch();

  // Posts the typed reply without refreshing — shared by the Reply button
  // and TriageBlock's "Send & close" path (which triages before refetching).
  const postReply = async (): Promise<boolean> => {
    if (!reply.trim()) return true;
    try {
      await addComment(caseId, reply.trim(), internal);
      toast.success(internal ? 'Internal note added.' : t('hrc.replySent'));
      setReply('');
      setInternal(false);
      return true;
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('hrc.replyFailed'));
      return false;
    }
  };

  const sendReply = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    if (await postReply()) refresh();
    setBusy(false);
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{data?.subject ?? t('hrc.caseDetails')}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {loadError ? (
          <ErrorBanner
            action={
              <Button size="sm" variant="secondary" onClick={() => refresh()}>
                {t('hrc.retry')}
              </Button>
            }
          >
            {loadError}
          </ErrorBanner>
        ) : !data ? (
          <SkeletonRows count={3} />
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={statusTone(data.status, { overrides: CASE_STATUS_TONES })}>
                {caseStatusLabel(t, data.status)}
              </Badge>
              <Badge variant={PRIORITY_VARIANT[data.priority]}>
                {casePriorityLabel(t, data.priority)}
              </Badge>
              {canManage && data.sla && <SlaChip sla={data.sla} />}
              {canManage && data.sla?.dueAt && (
                <span className="text-xs text-ink-muted">Due {fmtDateTime(data.sla.dueAt)}</span>
              )}
              <Badge variant="outline">{caseCategoryLabel(t, data.category)}</Badge>
              {data.assignedToEmail && (
                <span className="text-xs text-silver">
                  {t('hrc.assignedTo', { email: data.assignedToEmail })}
                </span>
              )}
            </div>
            <div className="text-xs text-silver">
              {t('hrc.filedBy', { name: data.associateName })} ·{' '}
              {fmtDateTime(data.createdAt)}
            </div>
            <div className="text-sm text-white whitespace-pre-wrap p-3 rounded border border-navy-secondary bg-midnight">
              <LinkifiedBody text={data.description} returnTo={`/hr-cases?case=${caseId}`} />
            </div>

            {canManage && (
              <TriageBlock
                detail={data}
                onChange={refresh}
                hasDraftReply={reply.trim().length > 0}
                sendDraftReply={postReply}
              />
            )}

            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wider text-silver">
                {t('hrc.conversation')}
              </div>
              {data.comments.length === 0 ? (
                <div className="text-sm text-silver">{t('hrc.noReplies')}</div>
              ) : (
                <div className="space-y-2">
                  {data.comments.map((c) => (
                    <div
                      key={c.id}
                      className={`p-3 rounded border ${
                        c.internalNote
                          ? 'border-warning bg-warning/20'
                          : 'border-navy-secondary'
                      }`}
                    >
                      <div className="flex items-center gap-2 text-xs text-silver mb-1">
                        {c.internalNote && (
                          <Lock className="h-3 w-3 text-warning" />
                        )}
                        <Avatar src={c.authorPhotoUrl} name={c.authorName} email={c.authorEmail} size="xs" />
                        <span>{c.authorEmail ?? c.authorName ?? t('hrc.unknownAuthor')}</span>
                        <span>· {fmtDateTime(c.createdAt)}</span>
                        {c.internalNote && (
                          <span className="text-warning">{t('hrc.internal')}</span>
                        )}
                      </div>
                      <div className="text-sm text-white whitespace-pre-wrap">
                        <LinkifiedBody text={c.body} returnTo={`/hr-cases?case=${caseId}`} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Always rendered — unmounting the composer on CLOSED silently
                threw away any typed reply. Closed cases keep it disabled
                with the text intact. */}
            <div className="space-y-2 pt-2 border-t border-navy-secondary">
              <Label>{t('hrc.replyLabel')}</Label>
              <Textarea
                className="h-24"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                disabled={data.status === 'CLOSED'}
              />
              <div className="flex items-center justify-between">
                {data.status === 'CLOSED' ? (
                  <span className="text-xs text-silver">
                    {t('hrc.closedNotice')}
                  </span>
                ) : canManage ? (
                  <label className="flex items-center gap-2 text-xs text-silver">
                    <input
                      type="checkbox"
                      checked={internal}
                      onChange={(e) => setInternal(e.target.checked)}
                    />
                    Internal note (hidden from associate)
                  </label>
                ) : (
                  <span />
                )}
                <Button
                  onClick={sendReply}
                  disabled={data.status === 'CLOSED' || busy || !reply.trim()}
                >
                  {busy ? t('hrc.sending') : t('hrc.replyButton')}
                </Button>
              </div>
            </div>
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        {onPrev && (
          <Button variant="ghost" onClick={onPrev}>
            ← Previous
          </Button>
        )}
        {onNext && (
          <Button variant="ghost" onClick={onNext}>
            Next case →
          </Button>
        )}
        <Button onClick={onClose}>{t('hrc.close')}</Button>
      </DrawerFooter>
    </Drawer>
  );
}

function TriageBlock({
  detail,
  onChange,
  hasDraftReply,
  sendDraftReply,
}: {
  detail: CaseDetail;
  onChange: () => void;
  /** The parent composer holds unsent reply text. */
  hasDraftReply: boolean;
  /** Posts the parent composer's draft; resolves false on failure. */
  sendDraftReply: () => Promise<boolean>;
}) {
  const { user } = useAuth();
  const { t } = useI18n();
  const [resolution, setResolution] = useState(detail.resolution ?? '');
  const [claiming, setClaiming] = useState(false);
  // Cross-department routing: everyone who can work a desk. Finance can
  // only take PAYROLL cases, so they're hidden as targets on the rest.
  const staffQuery = useQuery({ queryKey: ['hrCases', 'staff'], queryFn: () => listCaseStaff() });
  const staff: CaseStaffRow[] = staffQuery.data?.staff ?? [];
  const routable = staff.filter(
    (s) => detail.category === 'PAYROLL' || s.desk === 'all',
  );
  // Closing with an unsent reply typed below — intercepted behind a
  // three-way choice instead of stranding the text in a disabled composer.
  const [closeIntent, setCloseIntent] = useState(false);
  const [closeBusy, setCloseBusy] = useState(false);
  const assignedToMe =
    user !== null && detail.assignedToEmail === user.email;

  // Debounced autosave for the resolution summary — it used to save only
  // on blur, so any triage action's refresh could unmount the field and
  // drop the text. Fires without onChange(): the local field stays the
  // source of truth and the next refresh picks the value up.
  useEffect(() => {
    const next = resolution.trim() || null;
    if (detail.status !== 'RESOLVED' || next === (detail.resolution ?? null)) return;
    const t = setTimeout(() => {
      triageCase(detail.id, { resolution: next }).catch(() => {
        // Silent — the blur handler below retries with a visible error.
      });
    }, 600);
    return () => clearTimeout(t);
  }, [resolution, detail.id, detail.resolution, detail.status]);

  const finishClose = async (sendFirst: boolean) => {
    setCloseBusy(true);
    try {
      if (sendFirst && !(await sendDraftReply())) return; // keep the dialog up
      await triageCase(detail.id, { status: 'CLOSED' });
      setCloseIntent(false);
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not close the case.');
    } finally {
      setCloseBusy(false);
    }
  };

  const claim = async () => {
    if (!user) return;
    setClaiming(true);
    try {
      await triageCase(detail.id, { assignedToId: user.id });
      toast.success('Case assigned to you.');
      onChange();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not assign the case.');
    } finally {
      setClaiming(false);
    }
  };

  return (
    <div className="space-y-2 p-3 rounded border border-navy-secondary">
      <div className="text-xs uppercase tracking-wider text-silver">{t('hrc.triage')}</div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-silver">
          {detail.assignedToEmail
            ? `Assigned to ${assignedToMe ? 'you' : detail.assignedToEmail}`
            : 'Unassigned'}
        </span>
        {!assignedToMe && (
          <Button size="xs" variant="secondary" loading={claiming} onClick={claim}>
            Assign to me
          </Button>
        )}
        {routable.length > 0 && (
          <Select
            size="sm"
            aria-label={t('hrc.routeTo')}
            value=""
            onChange={async (e) => {
              const target = routable.find((s) => s.userId === e.target.value);
              if (!target) return;
              try {
                await triageCase(detail.id, { assignedToId: target.userId });
                toast.success(`Routed to ${target.name}.`);
                onChange();
              } catch (err) {
                toast.error(
                  err instanceof ApiError ? err.message : 'Could not route the case.',
                );
              }
            }}
          >
            <option value="" disabled>
              Route to…
            </option>
            {routable.map((s) => (
              <option key={s.userId} value={s.userId}>
                {s.name}
                {s.desk === 'payroll' ? ' — Finance' : ''}
              </option>
            ))}
          </Select>
        )}
      </div>
      <div className="flex gap-2 flex-wrap">
        <Select
          size="sm"
          value={detail.status}
          onChange={async (e) => {
            const nextStatus = e.target.value as CaseStatus;
            if (nextStatus === 'CLOSED' && hasDraftReply) {
              // The controlled Select snaps back to detail.status on the
              // next render, so cancelling costs nothing.
              setCloseIntent(true);
              return;
            }
            try {
              await triageCase(detail.id, {
                status: nextStatus,
                ...(nextStatus === 'RESOLVED'
                  ? { resolution: resolution.trim() || null }
                  : {}),
              });
              onChange();
            } catch (err) {
              toast.error(
                err instanceof ApiError ? err.message : 'Could not update the status.',
              );
            }
          }}
        >
          {(Object.keys(STATUS_LABELS) as CaseStatus[]).map((s) => (
            <option key={s} value={s}>
              {caseStatusLabel(t, s)}
            </option>
          ))}
        </Select>
        <Select
          size="sm"
          value={detail.priority}
          onChange={async (e) => {
            try {
              await triageCase(detail.id, {
                priority: e.target.value as CasePriority,
              });
              onChange();
            } catch (err) {
              toast.error(
                err instanceof ApiError ? err.message : 'Could not update the priority.',
              );
            }
          }}
        >
          <option value="LOW">{t('hrc.priority.LOW')}</option>
          <option value="MEDIUM">{t('hrc.priority.MEDIUM')}</option>
          <option value="HIGH">{t('hrc.priority.HIGH')}</option>
          <option value="URGENT">{t('hrc.priority.URGENT')}</option>
        </Select>
      </div>
      {detail.status === 'RESOLVED' && (
        <Input
          className="mt-1"
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          placeholder={t('hrc.resolutionSummary')}
          onBlur={async () => {
            if (resolution.trim() !== (detail.resolution ?? '')) {
              try {
                await triageCase(detail.id, { resolution: resolution.trim() || null });
                onChange();
              } catch (err) {
                toast.error(
                  err instanceof ApiError ? err.message : 'Could not save the resolution.',
                );
              }
            }
          }}
        />
      )}
      <Dialog
        open={closeIntent}
        onOpenChange={(o) => {
          if (!o && !closeBusy) setCloseIntent(false);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('hrc.sendReplyFirst')}</DialogTitle>
            <DialogDescription>
              There's an unsent reply typed below. Closing the case disables
              the composer, so decide what happens to it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setCloseIntent(false)}
              disabled={closeBusy}
            >
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={() => void finishClose(false)}
              disabled={closeBusy}
            >
              Close without sending
            </Button>
            <Button onClick={() => void finishClose(true)} disabled={closeBusy}>
              Send &amp; close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
