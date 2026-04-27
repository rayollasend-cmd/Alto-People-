import { useEffect, useState } from 'react';
import { Lock, MessageCircle, Plus, Tag } from 'lucide-react';
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
  Input,
  PageHeader,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

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

  const refresh = () => {
    if (tab === 'mine') {
      setMine(null);
      listMyCases()
        .then((r) => setMine(r.cases))
        .catch(() => setMine([]));
    } else {
      setQueue(null);
      listCaseQueue({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
      })
        .then((r) => setQueue(r.cases))
        .catch(() => setQueue([]));
      getCaseSummary()
        .then(setSummary)
        .catch(() => setSummary(null));
    }
  };
  useEffect(() => {
    refresh();
  }, [tab, statusFilter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="HR cases"
        subtitle="Ask HR a question, dispute a paycheck, raise a concern. HR triages and replies right here."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'HR cases' }]}
      />

      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={tab === 'mine' ? 'primary' : 'ghost'}
            onClick={() => setTab('mine')}
          >
            My cases
          </Button>
          {canManage && (
            <Button
              size="sm"
              variant={tab === 'queue' ? 'primary' : 'ghost'}
              onClick={() => setTab('queue')}
            >
              Queue
              {summary && summary.openTotal > 0 && (
                <Badge variant="destructive" className="ml-2">
                  {summary.openTotal}
                </Badge>
              )}
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          {canManage && tab === 'queue' && (
            <select
              className="text-xs bg-midnight border border-navy-secondary rounded p-1.5 text-white"
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
            </select>
          )}
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New case
          </Button>
        </div>
      </div>

      {tab === 'mine' ? (
        <Card>
          <CardContent className="p-0">
            {mine === null ? (
              <div className="p-6">
                <SkeletonRows count={3} />
              </div>
            ) : mine.length === 0 ? (
              <EmptyState
                icon={MessageCircle}
                title="No cases yet"
                description="Have a question or concern? File a new case — HR will reply here."
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
                        {new Date(c.updatedAt).toLocaleDateString()}
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
            {queue === null ? (
              <div className="p-6">
                <SkeletonRows count={4} />
              </div>
            ) : queue.length === 0 ? (
              <EmptyState
                icon={MessageCircle}
                title="Queue is empty"
                description="Nothing pending. Nice."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subject</TableHead>
                    <TableHead>Associate</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Priority</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Updated</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {queue.map((c) => (
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
                      </TableCell>
                      <TableCell>
                        <div className="text-sm">{c.associateName}</div>
                        <div className="text-xs text-silver">
                          {c.associateEmail}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-silver">
                        {CATEGORY_LABELS[c.category]}
                      </TableCell>
                      <TableCell>
                        <Badge variant={PRIORITY_VARIANT[c.priority]}>
                          {c.priority}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[c.status]}>
                          {STATUS_LABELS[c.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-silver">
                        {new Date(c.updatedAt).toLocaleDateString()}
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
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
          <select
            className="mt-1 w-full bg-midnight border border-navy-secondary rounded p-2 text-white text-sm"
            value={category}
            onChange={(e) => setCategory(e.target.value as CaseCategory)}
          >
            {(Object.keys(CATEGORY_LABELS) as CaseCategory[]).map((k) => (
              <option key={k} value={k}>
                {CATEGORY_LABELS[k]}
              </option>
            ))}
          </select>
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
          <textarea
            className="mt-1 w-full h-40 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's going on, when did it happen, what would resolution look like…"
          />
        </div>
        <div>
          <Label>Priority</Label>
          <select
            className="mt-1 w-full bg-midnight border border-navy-secondary rounded p-2 text-white text-sm"
            value={priority}
            onChange={(e) => setPriority(e.target.value as CasePriority)}
          >
            <option value="LOW">Low</option>
            <option value="MEDIUM">Medium</option>
            <option value="HIGH">High</option>
            <option value="URGENT">Urgent</option>
          </select>
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
  const [reply, setReply] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    setData(null);
    getCase(caseId)
      .then(setData)
      .catch(() => setData(null));
  };
  useEffect(() => {
    refresh();
  }, [caseId]);

  const sendReply = async () => {
    if (!reply.trim()) return;
    setBusy(true);
    try {
      await addComment(caseId, reply.trim(), internal);
      setReply('');
      setInternal(false);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{data?.subject ?? 'Loading…'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {!data ? (
          <SkeletonRows count={3} />
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={STATUS_VARIANT[data.status]}>
                {STATUS_LABELS[data.status]}
              </Badge>
              <Badge variant={PRIORITY_VARIANT[data.priority]}>
                {data.priority}
              </Badge>
              <Badge variant="outline">{CATEGORY_LABELS[data.category]}</Badge>
              {data.assignedToEmail && (
                <span className="text-xs text-silver">
                  Assigned to {data.assignedToEmail}
                </span>
              )}
            </div>
            <div className="text-xs text-silver">
              Filed by {data.associateName} ·{' '}
              {new Date(data.createdAt).toLocaleString()}
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
                          ? 'border-amber-700 bg-amber-950/20'
                          : 'border-navy-secondary'
                      }`}
                    >
                      <div className="flex items-center gap-2 text-xs text-silver mb-1">
                        {c.internalNote && (
                          <Lock className="h-3 w-3 text-amber-400" />
                        )}
                        <span>{c.authorEmail ?? c.authorName ?? 'Unknown'}</span>
                        <span>· {new Date(c.createdAt).toLocaleString()}</span>
                        {c.internalNote && (
                          <span className="text-amber-400">internal</span>
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
                <textarea
                  className="w-full h-24 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
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
  const [resolution, setResolution] = useState(detail.resolution ?? '');

  return (
    <div className="space-y-2 p-3 rounded border border-navy-secondary">
      <div className="text-xs uppercase tracking-wider text-silver">Triage</div>
      <div className="flex gap-2 flex-wrap">
        <select
          className="text-xs bg-midnight border border-navy-secondary rounded p-1.5 text-white"
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
              toast.error(err instanceof ApiError ? err.message : 'Failed.');
            }
          }}
        >
          {(Object.keys(STATUS_LABELS) as CaseStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
        <select
          className="text-xs bg-midnight border border-navy-secondary rounded p-1.5 text-white"
          value={detail.priority}
          onChange={async (e) => {
            try {
              await triageCase(detail.id, {
                priority: e.target.value as CasePriority,
              });
              onChange();
            } catch (err) {
              toast.error(err instanceof ApiError ? err.message : 'Failed.');
            }
          }}
        >
          <option value="LOW">Low</option>
          <option value="MEDIUM">Medium</option>
          <option value="HIGH">High</option>
          <option value="URGENT">Urgent</option>
        </select>
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
                toast.error(err instanceof ApiError ? err.message : 'Failed.');
              }
            }
          }}
        />
      )}
    </div>
  );
}
