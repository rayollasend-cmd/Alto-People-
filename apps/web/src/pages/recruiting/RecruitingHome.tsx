import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Award,
  Briefcase,
  CheckCircle2,
  FileText,
  Kanban,
  Link2,
  Plus,
  Rows3,
  UserPlus,
  Users,
} from 'lucide-react';
import type { Candidate, CandidateStage } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import {
  advanceCandidate,
  createCandidate,
  hireCandidate,
  listCandidates,
} from '@/lib/recruitingApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { CandidateBoard } from './CandidateBoard';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Input,
  PageHeader,
  Skeleton,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';

const STAGES: CandidateStage[] = [
  'APPLIED',
  'SCREENING',
  'INTERVIEW',
  'OFFER',
  'HIRED',
  'WITHDRAWN',
  'REJECTED',
];

const STAGE_VARIANT: Record<
  CandidateStage,
  'default' | 'success' | 'pending' | 'destructive' | 'accent' | 'outline'
> = {
  APPLIED: 'default',
  SCREENING: 'pending',
  INTERVIEW: 'accent',
  OFFER: 'accent',
  HIRED: 'success',
  WITHDRAWN: 'outline',
  REJECTED: 'destructive',
};

const NEXT_STAGE: Partial<Record<CandidateStage, CandidateStage>> = {
  APPLIED: 'SCREENING',
  SCREENING: 'INTERVIEW',
  INTERVIEW: 'OFFER',
};

type DialogState =
  | { kind: 'reject'; candidate: Candidate }
  | { kind: 'withdraw'; candidate: Candidate }
  | { kind: 'hire'; candidate: Candidate }
  | null;

type ViewMode = 'list' | 'board';
const VIEW_STORAGE_KEY = 'alto.recruiting.view';

function readViewMode(): ViewMode {
  if (typeof window === 'undefined') return 'board';
  try {
    const v = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return v === 'list' ? 'list' : 'board';
  } catch {
    return 'board';
  }
}

function writeViewMode(v: ViewMode) {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, v);
  } catch {
    /* persistence is best-effort */
  }
}

export function RecruitingHome() {
  const { can } = useAuth();
  const canManage = can('manage:recruiting');
  const [view, setView] = useState<ViewMode>(() => readViewMode());
  const [filter, setFilter] = useState<CandidateStage | 'ALL'>('APPLIED');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [allCandidates, setAllCandidates] = useState<Candidate[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);

  const setViewPersisted = useCallback((v: ViewMode) => {
    setView(v);
    writeViewMode(v);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listCandidates(filter === 'ALL' ? {} : { stage: filter });
      setCandidates(res.candidates);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, [filter]);

  // KPI strip wants stage counts independent of the active filter.
  const refreshKpis = useCallback(async () => {
    try {
      const res = await listCandidates({});
      setAllCandidates(res.candidates);
    } catch {
      /* best-effort */
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refreshKpis();
  }, [refreshKpis]);

  const advance = async (c: Candidate, target: CandidateStage) => {
    if (pendingId) return;
    setPendingId(c.id);
    try {
      await advanceCandidate(c.id, { stage: target });
      await Promise.all([refresh(), refreshKpis()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Advance failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onConfirmReject = async (reason: string) => {
    if (!dialog || dialog.kind !== 'reject') return;
    setPendingId(dialog.candidate.id);
    try {
      await advanceCandidate(dialog.candidate.id, {
        stage: 'REJECTED',
        rejectedReason: reason,
      });
      setDialog(null);
      await Promise.all([refresh(), refreshKpis()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reject failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onConfirmWithdraw = async (reason: string) => {
    if (!dialog || dialog.kind !== 'withdraw') return;
    setPendingId(dialog.candidate.id);
    try {
      await advanceCandidate(dialog.candidate.id, {
        stage: 'WITHDRAWN',
        withdrawnReason: reason,
      });
      setDialog(null);
      await Promise.all([refresh(), refreshKpis()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Withdraw failed.');
    } finally {
      setPendingId(null);
    }
  };

  const onConfirmHire = async () => {
    if (!dialog || dialog.kind !== 'hire') return;
    setPendingId(dialog.candidate.id);
    try {
      await hireCandidate(dialog.candidate.id);
      setDialog(null);
      await Promise.all([refresh(), refreshKpis()]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Hire failed.');
    } finally {
      setPendingId(null);
    }
  };

  const kpis = useMemo(() => {
    if (!allCandidates) return null;
    const inFunnel = allCandidates.filter(
      (c) => c.stage !== 'HIRED' && c.stage !== 'REJECTED' && c.stage !== 'WITHDRAWN',
    ).length;
    const interviewing = allCandidates.filter((c) => c.stage === 'INTERVIEW').length;
    const outstandingOffers = allCandidates.filter((c) => c.stage === 'OFFER').length;
    const hiredThisMonth = allCandidates.filter((c) => {
      if (c.stage !== 'HIRED') return false;
      const d = new Date(c.createdAt);
      const now = new Date();
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length;
    return { inFunnel, interviewing, outstandingOffers, hiredThisMonth };
  }, [allCandidates]);

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        title="Recruiting"
        subtitle={
          canManage
            ? 'Manage candidates from application through hire.'
            : 'Read-only view of the candidate pipeline.'
        }
        primaryAction={
          canManage ? (
            <Button onClick={() => setShowCreate(true)}>
              <Plus className="h-4 w-4" />
              New candidate
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <KpiCard
          icon={Users}
          label="In funnel"
          value={kpis ? String(kpis.inFunnel) : null}
          tone="default"
        />
        <KpiCard
          icon={Briefcase}
          label="Interviewing"
          value={kpis ? String(kpis.interviewing) : null}
          tone="warning"
        />
        <KpiCard
          icon={Award}
          label="Open offers"
          value={kpis ? String(kpis.outstandingOffers) : null}
          tone="default"
        />
        <KpiCard
          icon={CheckCircle2}
          label="Hired this month"
          value={kpis ? String(kpis.hiredThisMonth) : null}
          tone="success"
        />
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <CardTitle className="text-base">Candidates</CardTitle>
              <ViewToggle value={view} onChange={setViewPersisted} />
            </div>
            {view === 'list' && (
              <div className="flex flex-wrap gap-2">
                {(['ALL', ...STAGES] as Array<CandidateStage | 'ALL'>).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setFilter(s)}
                    className={cn(
                      'px-3 py-1.5 rounded text-xs uppercase tracking-wider border transition',
                      filter === s
                        ? 'border-gold text-gold bg-gold/10'
                        : 'border-navy-secondary text-silver hover:text-white',
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {error && (
            <p role="alert" className="text-sm text-alert mb-3">
              {error}
            </p>
          )}
          {view === 'board' && (
            <>
              {!allCandidates && <SkeletonRows count={5} rowHeight="h-24" />}
              {allCandidates && (
                <CandidateBoard
                  candidates={allCandidates}
                  pendingId={pendingId}
                  onAdvance={(c, target) => advance(c, target)}
                  onRequestReject={(c) => setDialog({ kind: 'reject', candidate: c })}
                  onRequestWithdraw={(c) => setDialog({ kind: 'withdraw', candidate: c })}
                  onRequestHire={(c) => setDialog({ kind: 'hire', candidate: c })}
                />
              )}
            </>
          )}
          {view === 'list' && !candidates && <SkeletonRows count={5} rowHeight="h-12" />}
          {view === 'list' && candidates && candidates.length === 0 && (
            <EmptyState
              icon={UserPlus}
              title="No candidates match this filter"
              description={
                canManage
                  ? 'Add a candidate or switch to a different stage.'
                  : 'Switch to a different stage to see more candidates.'
              }
              action={
                canManage ? (
                  <Button onClick={() => setShowCreate(true)}>
                    <Plus className="h-4 w-4" />
                    New candidate
                  </Button>
                ) : undefined
              }
            />
          )}
          {view === 'list' && candidates && candidates.length > 0 && (
            <>
              {/* Desktop: dense 6-col table. Hidden below lg because the
                  combined width (Name + Email + Position + Source + Stage
                  + Actions) becomes illegible at iPad-portrait widths. */}
              <div className="hidden lg:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Email</TableHead>
                      <TableHead>Position</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Stage</TableHead>
                      {canManage && (
                        <TableHead className="text-right">Actions</TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {candidates.map((c) => (
                      <TableRow key={c.id} className="group">
                        <TableCell className="font-medium">
                          <CandidateNameCell c={c} />
                        </TableCell>
                        <TableCell className="text-silver">{c.email}</TableCell>
                        <TableCell className="text-silver">
                          {c.position ?? '—'}
                        </TableCell>
                        <TableCell className="text-silver">
                          {c.source ?? '—'}
                        </TableCell>
                        <TableCell>
                          <Badge variant={STAGE_VARIANT[c.stage]}>{c.stage}</Badge>
                          {c.rejectedReason && (
                            <div className="text-[10px] mt-1 text-alert">
                              {c.rejectedReason}
                            </div>
                          )}
                          {c.withdrawnReason && (
                            <div className="text-[10px] mt-1 text-silver">
                              {c.withdrawnReason}
                            </div>
                          )}
                        </TableCell>
                        {canManage && (
                          <TableCell className="text-right whitespace-nowrap">
                            <CandidateActions
                              c={c}
                              pendingId={pendingId}
                              onAdvance={advance}
                              onRequest={(kind) =>
                                setDialog({ kind, candidate: c })
                              }
                            />
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Mobile / iPad portrait: card stack. Same data, vertical
                  layout, action buttons always visible (no hover gating). */}
              <ul className="lg:hidden space-y-2">
                {candidates.map((c) => (
                  <li
                    key={c.id}
                    className="rounded-md border border-navy-secondary bg-navy/40 p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <CandidateNameCell c={c} />
                      <Badge
                        variant={STAGE_VARIANT[c.stage]}
                        className="shrink-0"
                      >
                        {c.stage}
                      </Badge>
                    </div>
                    <div className="mt-1.5 ml-[2.4rem] text-[12px] text-silver/80 truncate">
                      {c.email}
                    </div>
                    {(c.position || c.source) && (
                      <div className="mt-0.5 ml-[2.4rem] text-[11px] text-silver/70 truncate">
                        {c.position ?? '—'}
                        <span className="mx-1.5 text-silver/40">·</span>
                        {c.source ?? 'manual'}
                      </div>
                    )}
                    {c.rejectedReason && (
                      <div className="mt-2 ml-[2.4rem] text-[11px] text-alert/90">
                        {c.rejectedReason}
                      </div>
                    )}
                    {c.withdrawnReason && (
                      <div className="mt-2 ml-[2.4rem] text-[11px] text-silver/70">
                        {c.withdrawnReason}
                      </div>
                    )}
                    {canManage && (
                      <div className="mt-3 flex flex-wrap gap-2 ml-[2.4rem]">
                        <CandidateActions
                          c={c}
                          pendingId={pendingId}
                          onAdvance={advance}
                          onRequest={(kind) =>
                            setDialog({ kind, candidate: c })
                          }
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </CardContent>
      </Card>

      <CreateCandidateDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        onCreated={() => {
          setShowCreate(false);
          refresh();
          refreshKpis();
        }}
      />

      <ConfirmDialog
        open={dialog?.kind === 'reject'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={
          dialog?.kind === 'reject'
            ? `Reject ${dialog.candidate.firstName} ${dialog.candidate.lastName}?`
            : 'Reject candidate'
        }
        description="The associate's record stays — but they'll be marked as rejected with the reason below for the audit trail."
        confirmLabel="Reject candidate"
        destructive
        requireReason
        reasonPlaceholder="e.g., Not a fit for the role at this time."
        busy={pendingId !== null}
        onConfirm={onConfirmReject}
      />

      <ConfirmDialog
        open={dialog?.kind === 'withdraw'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={
          dialog?.kind === 'withdraw'
            ? `Withdraw ${dialog.candidate.firstName} ${dialog.candidate.lastName}?`
            : 'Withdraw candidate'
        }
        description="Use this when the candidate has dropped out of the process on their own."
        confirmLabel="Mark withdrawn"
        requireReason
        reasonPlaceholder="e.g., Accepted another offer."
        busy={pendingId !== null}
        onConfirm={onConfirmWithdraw}
      />

      <ConfirmDialog
        open={dialog?.kind === 'hire'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={
          dialog?.kind === 'hire'
            ? `Hire ${dialog.candidate.firstName} ${dialog.candidate.lastName}?`
            : 'Hire candidate'
        }
        description="An Associate record will be created and onboarding can begin from there."
        confirmLabel="Confirm hire"
        busy={pendingId !== null}
        onConfirm={onConfirmHire}
      />
    </div>
  );
}

function CandidateNameCell({ c }: { c: Candidate }) {
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <Avatar
        name={`${c.firstName} ${c.lastName}`}
        email={c.email}
        size="sm"
      />
      <span className="truncate">
        {c.firstName} {c.lastName}
      </span>
      {c.resumeUrl && (
        <a
          href={c.resumeUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Resume"
          aria-label="Open resume in a new tab"
          className="text-silver/70 hover:text-gold transition-colors shrink-0"
        >
          <FileText className="h-3.5 w-3.5" />
        </a>
      )}
      {c.linkedinUrl && (
        <a
          href={c.linkedinUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="LinkedIn"
          aria-label="Open LinkedIn profile in a new tab"
          className="text-silver/70 hover:text-gold transition-colors shrink-0"
        >
          <Link2 className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  );
}

function CandidateActions({
  c,
  pendingId,
  onAdvance,
  onRequest,
}: {
  c: Candidate;
  pendingId: string | null;
  onAdvance: (c: Candidate, target: CandidateStage) => void;
  onRequest: (kind: 'reject' | 'withdraw' | 'hire') => void;
}) {
  const next = NEXT_STAGE[c.stage];
  const isClosed =
    c.stage === 'HIRED' || c.stage === 'REJECTED' || c.stage === 'WITHDRAWN';
  const isPending = pendingId === c.id;
  return (
    <div className="inline-flex flex-wrap gap-1.5">
      {next && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onAdvance(c, next)}
          loading={isPending}
          disabled={isPending}
        >
          {next}
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
      )}
      {c.stage === 'OFFER' && (
        <Button
          size="sm"
          variant="primary"
          onClick={() => onRequest('hire')}
          disabled={isPending}
        >
          Hire
        </Button>
      )}
      {!isClosed && (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onRequest('withdraw')}
            disabled={isPending}
          >
            Withdraw
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-alert hover:text-alert hover:bg-alert/10"
            onClick={() => onRequest('reject')}
            disabled={isPending}
          >
            Reject
          </Button>
        </>
      )}
    </div>
  );
}

interface KpiCardProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | null;
  tone: 'success' | 'warning' | 'default' | 'silver';
}

const TONE_TEXT: Record<KpiCardProps['tone'], string> = {
  success: 'text-success',
  warning: 'text-warning',
  default: 'text-gold',
  silver: 'text-silver',
};

function KpiCard({ icon: Icon, label, value, tone }: KpiCardProps) {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between mb-1">
        <div className="text-[10px] uppercase tracking-wider text-silver">{label}</div>
        <Icon className="h-3.5 w-3.5 text-silver/60" />
      </div>
      {value === null ? (
        <Skeleton className="h-9 w-12 mt-1" />
      ) : (
        <div className={cn('text-3xl font-display tabular-nums', TONE_TEXT[tone])}>
          {value}
        </div>
      )}
    </Card>
  );
}

interface CreateCandidateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}

function CreateCandidateDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateCandidateDialogProps) {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [position, setPosition] = useState('');
  const [source, setSource] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clear the form whenever the dialog re-opens.
  useEffect(() => {
    if (open) {
      setFirstName('');
      setLastName('');
      setEmail('');
      setPhone('');
      setPosition('');
      setSource('');
      setError(null);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      await createCandidate({
        firstName,
        lastName,
        email,
        phone: phone || undefined,
        position: position || undefined,
        source: source || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Create failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New candidate</DialogTitle>
          <DialogDescription>
            They&apos;ll start in APPLIED. You can advance them through the funnel from
            the table.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Field label="First name" required>
              <Input
                required
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
              />
            </Field>
            <Field label="Last name" required>
              <Input
                required
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
              />
            </Field>
            <Field label="Email" required>
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
            <Field label="Phone">
              <Input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </Field>
            <Field label="Position">
              <Input
                value={position}
                onChange={(e) => setPosition(e.target.value)}
              />
            </Field>
            <Field label="Source">
              <Input
                placeholder="referral / careers-page / indeed"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
            </Field>
          </div>
          {error && (
            <p role="alert" className="text-sm text-alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" loading={submitting} disabled={submitting}>
              Save as APPLIED
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-[11px] uppercase tracking-wider text-silver mb-1">
        {label}
        {required && <span className="text-alert"> *</span>}
      </span>
      {children}
    </label>
  );
}

function ViewToggle({
  value,
  onChange,
}: {
  value: ViewMode;
  onChange: (v: ViewMode) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Switch between board and list view"
      className="inline-flex items-center rounded-md border border-navy-secondary p-0.5"
    >
      <ToggleButton
        active={value === 'board'}
        onClick={() => onChange('board')}
        label="Board"
        icon={Kanban}
      />
      <ToggleButton
        active={value === 'list'}
        onClick={() => onChange('list')}
        label="List"
        icon={Rows3}
      />
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  label,
  icon: Icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[11px] uppercase tracking-wider transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
        active ? 'bg-gold/15 text-gold' : 'text-silver/70 hover:text-white',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}
