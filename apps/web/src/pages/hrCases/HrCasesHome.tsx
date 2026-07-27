import { useEffect, useMemo, useState } from 'react';
import { Download, Lock, MessageCircle, Plus, Tag } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  addComment,
  CATEGORY_LABELS,
  fileCase,
  getCase,
  getCaseSummary,
  listCaseQueue,
  listMyCases,
  STATUS_LABELS,
  triageCase,
  type CaseCategory,
  type CaseDetail,
  type CasePriority,
  type CaseStatus,
  type CaseSummary,
  type MyCaseRow,
  type QueueCaseRow,
} from '@/lib/hrCases123Api';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Input,
  PageHeader,
  SearchInput,
  SegmentedControl,
  type SegmentedControlOption,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { downloadCsv } from '@/lib/csv';
import { fmtDate, fmtDateTime, ymdLocal } from '@/lib/format';

const STATUS_VARIANT: Record<
  CaseStatus,
  'pending' | 'accent' | 'success' | 'outline'
> = {
  OPEN: 'pending',
  IN_PROGRESS: 'accent',
  WAITING_ASSOCIATE: 'pending',
  RESOLVED: 'success',
  CLOSED: 'outline',
};

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

export function HrCasesHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:onboarding') : false;
  const [tab, setTab] = useState<'mine' | 'queue'>('mine');
  const [mine, setMine] = useState<MyCaseRow[] | null>(null);
  const [queue, setQueue] = useState<QueueCaseRow[] | null>(null);
  const [summary, setSummary] = useState<CaseSummary | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<CaseStatus | 'ALL'>('OPEN');
  const [categoryFilter, setCategoryFilter] = useState<CaseCategory | 'ALL'>(
    'ALL',
  );
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [search, setSearch] = useState('');
  const [mineError, setMineError] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);

  const refresh = () => {
    if (tab === 'mine') {
      setMine(null);
      setMineError(null);
      listMyCases()
        .then((r) => setMine(r.cases))
        .catch((err) =>
          setMineError(
            err instanceof ApiError ? err.message : 'Failed to load your cases.',
          ),
        );
    } else {
      setQueue(null);
      setQueueError(null);
      listCaseQueue({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
        category: categoryFilter === 'ALL' ? undefined : categoryFilter,
        assignedToMe: assignedToMe || undefined,
      })
        .then((r) => setQueue(r.cases))
        .catch((err) =>
          setQueueError(
            err instanceof ApiError ? err.message : 'Failed to load the queue.',
          ),
        );
    }
  };
  // Filter-independent KPI summary — fetched once on mount and re-fetched
  // explicitly after mutations, never on tab/filter clicks.
  const refreshSummary = () => {
    getCaseSummary()
      .then(setSummary)
      .catch(() => setSummary(null));
  };
  useEffect(() => {
    refresh();
  }, [tab, statusFilter, categoryFilter, assignedToMe]);
  useEffect(() => {
    if (canManage) refreshSummary();
  }, [canManage]);

  const visibleQueue = useMemo(() => {
    const rows = queue ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (c) =>
        c.subject.toLowerCase().includes(q) ||
        c.associateName.toLowerCase().includes(q) ||
        c.associateEmail.toLowerCase().includes(q),
    );
  }, [queue, search]);

  // The queue segment only exists for HR; building the option list up front
  // keeps the conditional out of the JSX and the generic parameter explicit
  // (inference would otherwise narrow to 'mine').
  const tabOptions: SegmentedControlOption<'mine' | 'queue'>[] = [
    { value: 'mine', label: 'My cases' },
  ];
  if (canManage) {
    tabOptions.push({
      value: 'queue',
      label: (
        <>
          Queue
          {summary && summary.openTotal > 0 && (
            <Badge variant="destructive" className="ml-2">
              {summary.openTotal}
            </Badge>
          )}
        </>
      ),
    });
  }

  const exportQueueCsv = () => {
    downloadCsv(`hr-cases-queue-${ymdLocal()}.csv`, [
      [
        'Subject',
        'Associate',
        'Email',
        'Category',
        'Priority',
        'Status',
        'Assigned to',
        'Replies',
        'Created',
        'Updated',
      ],
      ...visibleQueue.map((c) => [
        c.subject,
        c.associateName,
        c.associateEmail,
        CATEGORY_LABELS[c.category],
        PRIORITY_LABELS[c.priority],
        STATUS_LABELS[c.status],
        c.assignedToEmail ?? '',
        c.commentCount,
        fmtDate(c.createdAt),
        fmtDate(c.updatedAt),
      ]),
    ]);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="HR cases"
        subtitle="Ask HR a question, dispute a paycheck, raise a concern. HR triages and replies right here."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'HR cases' }]}
      />

      <div className="flex items-center justify-between">
        <SegmentedControl<'mine' | 'queue'>
          ariaLabel="Case view"
          value={tab}
          onChange={setTab}
          options={tabOptions}
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {canManage && tab === 'queue' && (
            <>
              <SearchInput
                aria-label="Search subject or associate"
                className="h-8 w-52 text-xs"
                placeholder="Search subject/associate"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Select
                size="sm"
                aria-label="Filter by status"
                value={statusFilter}
                onChange={(e) =>
                  setStatusFilter(e.target.value as CaseStatus | 'ALL')
                }
              >
                <option value="ALL">All statuses</option>
                {(Object.keys(STATUS_LABELS) as CaseStatus[]).map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </Select>
              <Select
                size="sm"
                aria-label="Filter by category"
                value={categoryFilter}
                onChange={(e) =>
                  setCategoryFilter(e.target.value as CaseCategory | 'ALL')
                }
              >
                <option value="ALL">All categories</option>
                {(Object.keys(CATEGORY_LABELS) as CaseCategory[]).map((k) => (
                  <option key={k} value={k}>
                    {CATEGORY_LABELS[k]}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                variant={assignedToMe ? 'primary' : 'secondary'}
                aria-pressed={assignedToMe}
                onClick={() => setAssignedToMe((v) => !v)}
              >
                Assigned to me
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={exportQueueCsv}
                disabled={visibleQueue.length === 0}
              >
                <Download className="mr-2 h-4 w-4" /> Export CSV
              </Button>
            </>
          )}
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New case
          </Button>
        </div>
      </div>

      {tab === 'mine' ? (
        <Card>
          <CardContent className="p-0">
            {mineError ? (
              <div className="p-6">
                <ErrorBanner
                  action={
                    <Button size="sm" variant="secondary" onClick={refresh}>
                      Retry
                    </Button>
                  }
                >
                  {mineError}
                </ErrorBanner>
              </div>
            ) : mine === null ? (
              <div className="p-6">
                <SkeletonRows count={3} />
              </div>
            ) : mine.length === 0 ? (
              <EmptyState
                icon={MessageCircle}
                title="No cases yet"
                description="Have a question or concern? File a new case — HR will reply here."
                action={
                  <Button onClick={() => setShowNew(true)}>
                    <Plus className="mr-2 h-4 w-4" /> File a case
                  </Button>
                }
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
                        {CATEGORY_LABELS[c.category]} ·{' '}
                        {fmtDate(c.updatedAt)}
                        {c.commentCount > 0 && ` · ${c.commentCount} replies`}
                      </div>
                    </div>
                    <Badge variant={STATUS_VARIANT[c.status]}>
                      {STATUS_LABELS[c.status]}
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            {queueError ? (
              <div className="p-6">
                <ErrorBanner
                  action={
                    <Button size="sm" variant="secondary" onClick={refresh}>
                      Retry
                    </Button>
                  }
                >
                  {queueError}
                </ErrorBanner>
              </div>
            ) : queue === null ? (
              <div className="p-6">
                <SkeletonRows count={4} />
              </div>
            ) : visibleQueue.length === 0 ? (
              <EmptyState
                icon={MessageCircle}
                title={
                  search.trim() ? 'No matching cases' : 'Queue is empty'
                }
                description={
                  search.trim()
                    ? 'No cases match your search.'
                    : 'Nothing pending. Nice.'
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subject</TableHead>
                    <TableHead className="hidden md:table-cell">Associate</TableHead>
                    <TableHead className="hidden md:table-cell">Category</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden lg:table-cell">Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleQueue.map((c) => (
                    <TableRow
                      key={c.id}
                      className="cursor-pointer"
                      onClick={() => setOpenId(c.id)}
                    >
                      <TableCell>
                        <div className="font-medium text-white">{c.subject}</div>
                        {c.commentCount > 0 && (
                          <div className="text-xs text-silver">
                            {c.commentCount} replies
                          </div>
                        )}
                        <div className="text-xs2 text-silver/70 md:hidden">
                          {c.associateName} · {CATEGORY_LABELS[c.category]}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div className="text-sm">{c.associateName}</div>
                        <div className="text-xs text-silver">
                          {c.associateEmail}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-silver">
                        {CATEGORY_LABELS[c.category]}
                      </TableCell>
                      <TableCell>
                        <Badge variant={PRIORITY_VARIANT[c.priority]}>
                          {PRIORITY_LABELS[c.priority]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[c.status]}>
                          {STATUS_LABELS[c.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-xs text-silver">
                        {fmtDate(c.updatedAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {showNew && (
        <NewCaseDrawer
          onClose={() => setShowNew(false)}
          onSaved={(id) => {
            setShowNew(false);
            setOpenId(id);
            refresh();
            if (canManage) refreshSummary();
          }}
        />
      )}
      {openId && (
        <CaseDetailDrawer
          caseId={openId}
          canManage={canManage}
          onClose={() => {
            setOpenId(null);
            refresh();
            if (canManage) refreshSummary();
          }}
        />
      )}
    </div>
  );
}

function NewCaseDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const [category, setCategory] = useState<CaseCategory>('BENEFITS');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<CasePriority>('MEDIUM');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!subject.trim() || !description.trim()) {
      toast.error('Subject and description required.');
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
      toast.success('Case filed.');
      onSaved(r.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not file the case.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New HR case</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Category</Label>
          <Select
            className="mt-1"
            value={category}
            onChange={(e) => setCategory(e.target.value as CaseCategory)}
          >
            {(Object.keys(CATEGORY_LABELS) as CaseCategory[]).map((k) => (
              <option key={k} value={k}>
                {CATEGORY_LABELS[k]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>Subject</Label>
          <Input
            className="mt-1"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="One-line summary"
          />
        </div>
        <div>
          <Label>Description</Label>
          <Textarea
            className="mt-1 h-40"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's going on, when did it happen, what would resolution look like…"
          />
        </div>
        <div>
          <Label>Priority</Label>
          <Select
            className="mt-1"
            value={priority}
            onChange={(e) => setPriority(e.target.value as CasePriority)}
          >
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
            <option value="URGENT">Urgent</option>
          </Select>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Filing…' : 'File case'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function CaseDetailDrawer({
  caseId,
  canManage,
  onClose,
}: {
  caseId: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const [data, setData] = useState<CaseDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    setData(null);
    setLoadError(null);
    getCase(caseId)
      .then(setData)
      .catch((err) =>
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load case.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, [caseId]);

  const sendReply = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    try {
      await addComment(caseId, reply.trim(), internal);
      toast.success(internal ? 'Internal note added.' : 'Reply sent.');
      setReply('');
      setInternal(false);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the reply.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{data?.subject ?? 'Case details'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {loadError ? (
          <ErrorBanner
            action={
              <Button size="sm" variant="secondary" onClick={refresh}>
                Retry
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
              <Badge variant={STATUS_VARIANT[data.status]}>
                {STATUS_LABELS[data.status]}
              </Badge>
              <Badge variant={PRIORITY_VARIANT[data.priority]}>
                {PRIORITY_LABELS[data.priority]}
              </Badge>
              <Badge variant="outline">{CATEGORY_LABELS[data.category]}</Badge>
              {data.assignedToEmail && (
                <span className="text-xs text-silver">
                  Assigned to {data.assignedToEmail}
                </span>
              )}
            </div>
            <div className="text-xs text-silver">
              Filed by {data.associateName} · {fmtDateTime(data.createdAt)}
            </div>
            <div className="text-sm text-white whitespace-pre-wrap p-3 rounded border border-navy-secondary bg-midnight">
              {data.description}
            </div>

            {canManage && (
              <TriageBlock detail={data} onChange={refresh} />
            )}

            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wider text-silver">
                Conversation
              </div>
              {data.comments.length === 0 ? (
                <div className="text-sm text-silver">No replies yet.</div>
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
                        <span>{c.authorEmail ?? c.authorName ?? 'Unknown'}</span>
                        <span>· {fmtDateTime(c.createdAt)}</span>
                        {c.internalNote && (
                          <span className="text-warning">Internal</span>
                        )}
                      </div>
                      <div className="text-sm text-white whitespace-pre-wrap">
                        {c.body}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {data.status !== 'CLOSED' && (
              <div className="space-y-2 pt-2 border-t border-navy-secondary">
                <Label>Reply</Label>
                <Textarea
                  className="h-24"
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                />
                <div className="flex items-center justify-between">
                  {canManage ? (
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
                  <Button onClick={sendReply} disabled={busy || !reply.trim()}>
                    {busy ? 'Sending…' : 'Reply'}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}

function TriageBlock({
  detail,
  onChange,
}: {
  detail: CaseDetail;
  onChange: () => void;
}) {
  const { user } = useAuth();
  const [resolution, setResolution] = useState(detail.resolution ?? '');
  const [claiming, setClaiming] = useState(false);
  const assignedToMe =
    user !== null && detail.assignedToEmail === user.email;

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
      <div className="text-xs uppercase tracking-wider text-silver">Triage</div>
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
      </div>
      <div className="flex gap-2 flex-wrap">
        <Select
          size="sm"
          value={detail.status}
          onChange={async (e) => {
            try {
              await triageCase(detail.id, {
                status: e.target.value as CaseStatus,
                ...(e.target.value === 'RESOLVED'
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
              {STATUS_LABELS[s]}
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
          <option value="LOW">Low</option>
          <option value="MEDIUM">Medium</option>
          <option value="HIGH">High</option>
          <option value="URGENT">Urgent</option>
        </Select>
      </div>
      {detail.status === 'RESOLVED' && (
        <Input
          className="mt-1"
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          placeholder="Resolution summary"
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
    </div>
  );
}
