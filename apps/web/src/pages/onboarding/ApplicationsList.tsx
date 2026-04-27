import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  BarChart3,
  ClipboardList,
  LayoutTemplate,
  MailPlus,
  MailWarning,
  MessageCircle,
  Plus,
  Search,
  Send,
  Users,
  X,
} from 'lucide-react';
import type { ApplicationStatus, ApplicationSummary } from '@alto-people/shared';
import {
  bulkResendInvite,
  listApplications,
  resendInvite,
} from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ProgressBar } from '@/components/ProgressBar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { toast } from 'sonner';
import { BulkInviteDialog } from './BulkInviteDialog';
import { NewApplicationDialog } from './NewApplicationDialog';
import { NudgeDialog } from './NudgeDialog';
import { cn } from '@/lib/cn';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

const STATUS_VARIANT: Record<
  string,
  'success' | 'pending' | 'destructive' | 'default'
> = {
  DRAFT: 'default',
  SUBMITTED: 'pending',
  IN_REVIEW: 'pending',
  APPROVED: 'success',
  REJECTED: 'destructive',
};

const TRACK_LABEL: Record<string, string> = {
  STANDARD: 'Standard',
  J1: 'J-1',
  CLIENT_SPECIFIC: 'Client-specific',
};

const STATUS_FILTERS: Array<{ value: ApplicationStatus | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'SUBMITTED', label: 'Submitted' },
  { value: 'IN_REVIEW', label: 'In review' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
];

const STALE_DAYS = 7;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function isStale(a: ApplicationSummary, now: number): boolean {
  if (a.status === 'APPROVED' || a.status === 'REJECTED') return false;
  if (a.percentComplete === 100) return false;
  const invitedMs = new Date(a.invitedAt).getTime();
  return now - invitedMs > STALE_DAYS * ONE_DAY_MS;
}

function daysSince(iso: string, now: number): number {
  return Math.floor((now - new Date(iso).getTime()) / ONE_DAY_MS);
}

export function ApplicationsList() {
  const { can } = useAuth();
  const canManage = can('manage:onboarding');
  const [searchParams, setSearchParams] = useSearchParams();

  const status = (searchParams.get('status') as ApplicationStatus | 'ALL' | null) ?? 'ALL';
  const urlQ = searchParams.get('q') ?? '';
  const [qInput, setQInput] = useState(urlQ);

  // Debounce search input → URL → server fetch.
  useEffect(() => {
    const handle = setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      if (qInput.trim()) next.set('q', qInput.trim());
      else next.delete('q');
      setSearchParams(next, { replace: true });
    }, 250);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qInput]);

  const setStatus = (s: ApplicationStatus | 'ALL') => {
    const next = new URLSearchParams(searchParams);
    if (s === 'ALL') next.delete('status');
    else next.set('status', s);
    setSearchParams(next, { replace: true });
  };

  // Counts strip pulls the *unfiltered* set so the chip counts don't change
  // as the user filters. Cheap second fetch — both queries hit the same
  // tenant scope and Postgres caches the heavy join in <50ms.
  const [items, setItems] = useState<ApplicationSummary[] | null>(null);
  const [allItems, setAllItems] = useState<ApplicationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCreate, setOpenCreate] = useState(false);
  const [openBulkInvite, setOpenBulkInvite] = useState(false);
  const [resendingIds, setResendingIds] = useState<Set<string>>(new Set());
  const [bulkResending, setBulkResending] = useState(false);

  // Bulk-select state. The set holds applicationIds; "select all" applies
  // to the *currently visible* (filtered) rows so it never spans pages
  // worth of work the user can't see.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Single-row nudge dialog (one applicant at a time — bulk nudge is
  // intentionally not a thing because the body is per-recipient).
  const [nudgeTarget, setNudgeTarget] = useState<ApplicationSummary | null>(null);

  const refresh = useCallback(() => {
    setError(null);
    listApplications({ status, q: urlQ })
      .then((res) => setItems(res.applications))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Failed to load.')
      );
  }, [status, urlQ]);

  // Refresh the unfiltered roll-up only when status/q would change what's
  // visible. The unfiltered set itself is a single fetch on mount + when
  // an action invalidates it (resend / create).
  const refreshAll = useCallback(() => {
    listApplications({})
      .then((res) => setAllItems(res.applications))
      .catch(() => setAllItems([]));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const now = Date.now();
  const stats = useMemo(() => {
    const src = allItems ?? [];
    const byStatus: Record<string, number> = {};
    for (const a of src) {
      byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
    }
    const inFlight = src.filter(
      (a) => a.status !== 'APPROVED' && a.status !== 'REJECTED'
    );
    const stale = src.filter((a) => isStale(a, now));
    // Phase 60 — apps where the most recent invite/nudge email bounced
    // (provider returned FAILED). Excludes APPROVED/REJECTED apps where
    // the associate already finished — bounce wouldn't matter anymore.
    const bounced = src.filter(
      (a) =>
        a.lastInviteDelivery?.status === 'FAILED' &&
        a.status !== 'APPROVED' &&
        a.status !== 'REJECTED'
    );
    const avgPercent =
      inFlight.length === 0
        ? 0
        : Math.round(
            inFlight.reduce((acc, a) => acc + a.percentComplete, 0) /
              inFlight.length
          );
    return {
      total: src.length,
      byStatus,
      inFlight: inFlight.length,
      stale: stale.length,
      bounced: bounced.length,
      bouncedSamples: bounced.slice(0, 3),
      staleSamples: stale.slice(0, 3),
      avgPercent,
    };
  }, [allItems, now]);

  const onResend = async (a: ApplicationSummary) => {
    if (resendingIds.has(a.id)) return;
    const next = new Set(resendingIds);
    next.add(a.id);
    setResendingIds(next);
    try {
      const res = await resendInvite(a.id);
      if (res.inviteUrl) {
        await navigator.clipboard.writeText(res.inviteUrl).catch(() => {});
        toast.success('Fresh invite link copied');
      } else {
        toast.success('Invite re-sent');
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'user_already_active') {
        toast.message('Already accepted', {
          description: `${a.associateName} has already set their password.`,
        });
      } else {
        toast.error('Resend failed');
      }
    } finally {
      const after = new Set(resendingIds);
      after.delete(a.id);
      setResendingIds(after);
    }
  };

  // Drop selections that are no longer in the visible set (e.g. user
  // changed the status filter). Stops the toolbar from showing a count
  // for rows that aren't on screen.
  useEffect(() => {
    if (!items) return;
    const visibleIds = new Set(items.map((a) => a.id));
    setSelected((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (visibleIds.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [items]);

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allVisibleSelected =
    !!items && items.length > 0 && items.every((a) => selected.has(a.id));

  const toggleAllVisible = () => {
    if (!items) return;
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev);
        for (const a of items) next.delete(a.id);
        return next;
      }
      const next = new Set(prev);
      for (const a of items) next.add(a.id);
      return next;
    });
  };

  const onBulkResend = async () => {
    if (selected.size === 0 || bulkResending) return;
    const ids = Array.from(selected);
    setBulkResending(true);
    try {
      const res = await bulkResendInvite({ applicationIds: ids });
      if (res.failed === 0) {
        toast.success(`Re-sent ${res.succeeded} invite${res.succeeded === 1 ? '' : 's'}`);
      } else if (res.succeeded === 0) {
        toast.error(`All ${res.failed} resends failed`);
      } else {
        // Pull the first failure as the description so HR sees actionable info.
        const firstFail = res.results.find((r) => !r.ok);
        toast.message(`Re-sent ${res.succeeded}, ${res.failed} failed`, {
          description: firstFail
            ? `e.g. ${firstFail.errorCode}: ${firstFail.errorMessage}`
            : undefined,
        });
      }
      setSelected(new Set());
      refresh();
      refreshAll();
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Bulk resend failed';
      toast.error('Could not bulk resend', { description: msg });
    } finally {
      setBulkResending(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
            Onboarding
          </h1>
          <p className="text-silver">
            Active applications and their checklist progress.
          </p>
        </div>
        {canManage && (
          <div className="flex items-center gap-2">
            <Link to="/onboarding/analytics">
              <Button variant="ghost">
                <BarChart3 className="h-4 w-4" />
                Analytics
              </Button>
            </Link>
            <Link to="/onboarding/templates">
              <Button variant="ghost">
                <LayoutTemplate className="h-4 w-4" />
                Templates
              </Button>
            </Link>
            <Button variant="secondary" onClick={() => setOpenBulkInvite(true)}>
              <Users className="h-4 w-4" />
              Bulk invite
            </Button>
            <Button onClick={() => setOpenCreate(true)}>
              <Plus className="h-4 w-4" />
              New application
            </Button>
          </div>
        )}
      </header>

      {/* KPI strip — always visible (empty-zero state is fine). */}
      {canManage && allItems && allItems.length > 0 && (
        <div className="mb-5 flex flex-wrap gap-x-6 gap-y-2 px-4 py-3 rounded-md border border-navy-secondary bg-navy-secondary/30">
          <Kpi label="Total" value={String(stats.total)} />
          <Kpi label="In flight" value={String(stats.inFlight)} />
          <Kpi
            label="Avg. complete"
            value={`${stats.avgPercent}%`}
            tone={
              stats.avgPercent >= 75
                ? 'text-success'
                : stats.avgPercent >= 50
                  ? 'text-warning'
                  : 'text-silver'
            }
          />
          <Kpi
            label={`Stuck > ${STALE_DAYS}d`}
            value={String(stats.stale)}
            tone={stats.stale > 0 ? 'text-alert' : 'text-success'}
          />
          <Kpi
            label="Email bounced"
            value={String(stats.bounced)}
            tone={stats.bounced > 0 ? 'text-alert' : 'text-silver'}
          />
          <Kpi
            label="Approved"
            value={String(stats.byStatus.APPROVED ?? 0)}
            tone="text-success"
          />
        </div>
      )}

      {/* Email-bounce banner — fires when at least one in-flight invite/nudge
          came back FAILED from the provider. Distinct from the stale banner
          (which is just "old"); a bounce is *actionable* (fix the email). */}
      {canManage && stats.bounced > 0 && (
        <div className="mb-4 flex items-start gap-2 p-3 rounded-md border border-alert/40 bg-alert/[0.07] text-sm">
          <MailWarning className="h-4 w-4 text-alert mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-white">
              {stats.bounced} invite{stats.bounced === 1 ? '' : 's'} bounced —
              recipient never received the email
            </div>
            <div className="text-silver text-xs mt-0.5">
              {stats.bouncedSamples.map((a, i) => (
                <span key={a.id}>
                  {i > 0 && ' · '}
                  <Link
                    to={`/onboarding/applications/${a.id}`}
                    className="text-gold hover:text-gold-bright"
                  >
                    {a.associateName}
                  </Link>
                </span>
              ))}
              {stats.bounced > stats.bouncedSamples.length && (
                <span className="text-silver/60">
                  {' '}+ {stats.bounced - stats.bouncedSamples.length} more
                </span>
              )}
              <span className="text-silver/60 ml-2">
                · Open the application to see the provider error and fix the
                email address.
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Stale-application banner — only when there's something to nudge about. */}
      {canManage && stats.stale > 0 && (
        <div className="mb-4 flex items-start gap-2 p-3 rounded-md border border-alert/40 bg-alert/[0.07] text-sm">
          <AlertTriangle className="h-4 w-4 text-alert mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-white">
              {stats.stale} application{stats.stale === 1 ? '' : 's'} stuck for more
              than {STALE_DAYS} days
            </div>
            <div className="text-silver text-xs mt-0.5">
              {stats.staleSamples.map((a, i) => (
                <span key={a.id}>
                  {i > 0 && ' · '}
                  <Link
                    to={`/onboarding/applications/${a.id}`}
                    className="text-gold hover:text-gold-bright"
                  >
                    {a.associateName}
                  </Link>{' '}
                  <span className="text-silver/60 tabular-nums">
                    ({daysSince(a.invitedAt, now)}d)
                  </span>
                </span>
              ))}
              {stats.stale > stats.staleSamples.length && (
                <span className="text-silver/60">
                  {' '}+ {stats.stale - stats.staleSamples.length} more
                </span>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setStatus('SUBMITTED')}
            className="shrink-0"
          >
            Review
          </Button>
        </div>
      )}

      {/* Filter row: search input + status pills */}
      {canManage && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px] max-w-xs">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-silver/60 pointer-events-none" />
            <Input
              type="search"
              placeholder="Search by name or email…"
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              className="pl-8 pr-8"
            />
            {qInput && (
              <button
                type="button"
                onClick={() => setQInput('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-silver/60 hover:text-white"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_FILTERS.map((f) => {
              const count =
                f.value === 'ALL'
                  ? stats.total
                  : (stats.byStatus[f.value] ?? 0);
              const active = status === f.value;
              return (
                <button
                  key={f.value}
                  type="button"
                  onClick={() => setStatus(f.value)}
                  className={cn(
                    'px-2.5 py-1 rounded-md text-xs border transition-colors inline-flex items-center gap-1.5',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
                    active
                      ? 'border-gold text-gold bg-gold/10'
                      : 'border-navy-secondary text-silver hover:text-white hover:border-silver/40'
                  )}
                >
                  {f.label}
                  {allItems && (
                    <span className="text-[10px] tabular-nums text-silver/60">
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <span className="ml-auto text-[10px] text-silver/60 tabular-nums">
            {items ? `${items.length} shown` : ''}
          </span>
        </div>
      )}

      {error && (
        <div
          className="mb-4 p-3 rounded-md border border-alert/40 bg-alert/10 text-alert text-sm"
          role="alert"
        >
          {error}
        </div>
      )}

      {!items && !error && (
        <Card>
          <div className="p-2">
            <SkeletonRows count={5} rowHeight="h-14" />
          </div>
        </Card>
      )}

      {items && items.length === 0 && (
        <EmptyState
          icon={ClipboardList}
          title={
            urlQ || status !== 'ALL'
              ? 'No applications match this filter'
              : 'No active applications'
          }
          description={
            urlQ || status !== 'ALL'
              ? 'Clear the filter to see all applications.'
              : canManage
                ? 'Click "New application" to invite the first associate.'
                : "When HR creates an onboarding application, it'll show up here with live checklist progress."
          }
          action={
            urlQ || status !== 'ALL' ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setQInput('');
                  setStatus('ALL');
                }}
              >
                Clear filters
              </Button>
            ) : canManage ? (
              <Button onClick={() => setOpenCreate(true)}>
                <Plus className="h-4 w-4" />
                New application
              </Button>
            ) : undefined
          }
        />
      )}

      <NewApplicationDialog
        open={openCreate}
        onOpenChange={setOpenCreate}
        onCreated={() => {
          refresh();
          refreshAll();
        }}
      />

      <BulkInviteDialog
        open={openBulkInvite}
        onOpenChange={setOpenBulkInvite}
        onCreated={() => {
          refresh();
          refreshAll();
        }}
      />

      <NudgeDialog
        open={!!nudgeTarget}
        onOpenChange={(v) => !v && setNudgeTarget(null)}
        applicationId={nudgeTarget?.id ?? null}
        associateName={nudgeTarget?.associateName ?? ''}
      />

      {/* Bulk-actions toolbar — only visible when at least one row is selected.
          Sits above the table so it doesn't shift row layout when it appears. */}
      {canManage && selected.size > 0 && (
        <div className="mb-3 flex items-center gap-3 px-3 py-2 rounded-md border border-gold/40 bg-gold/[0.06] text-sm">
          <span className="text-white font-medium">
            {selected.size} selected
          </span>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="secondary"
            onClick={onBulkResend}
            loading={bulkResending}
          >
            <MailPlus className="h-4 w-4" />
            Resend invite
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </div>
      )}

      {items && items.length > 0 && (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {canManage && (
                  <TableHead className="w-8 px-3 no-print">
                    <input
                      type="checkbox"
                      checked={allVisibleSelected}
                      onChange={toggleAllVisible}
                      aria-label={
                        allVisibleSelected ? 'Deselect all' : 'Select all visible'
                      }
                      className="h-3.5 w-3.5 rounded border-navy-secondary bg-navy text-gold focus:ring-gold focus:ring-offset-0 cursor-pointer"
                    />
                  </TableHead>
                )}
                <TableHead>Applicant</TableHead>
                <TableHead className="hidden md:table-cell">Client</TableHead>
                <TableHead className="hidden lg:table-cell">Track</TableHead>
                <TableHead className="hidden md:table-cell">Invited</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-56">Progress</TableHead>
                {canManage && <TableHead className="w-24" aria-label="Actions" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((a) => {
                const stale = isStale(a, now);
                const isSelected = selected.has(a.id);
                return (
                  <TableRow
                    key={a.id}
                    className={cn(isSelected && 'bg-gold/[0.04]')}
                  >
                    {canManage && (
                      <TableCell className="px-3 no-print">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleOne(a.id)}
                          aria-label={
                            isSelected
                              ? `Deselect ${a.associateName}`
                              : `Select ${a.associateName}`
                          }
                          className="h-3.5 w-3.5 rounded border-navy-secondary bg-navy text-gold focus:ring-gold focus:ring-offset-0 cursor-pointer"
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="flex items-start gap-2">
                        {a.lastInviteDelivery?.status === 'FAILED' ? (
                          <MailWarning
                            className="h-3.5 w-3.5 text-alert mt-1 shrink-0"
                            aria-label="Email bounced"
                            // Title fallback for keyboard nav / no-tooltip envs.
                            // Covers HR users who can't easily mouse-hover.
                            data-tip={
                              a.lastInviteDelivery.failureReason ?? 'Email bounced'
                            }
                          />
                        ) : (
                          stale && (
                            <AlertTriangle
                              className="h-3.5 w-3.5 text-alert mt-1 shrink-0"
                              aria-label="Stuck"
                            />
                          )
                        )}
                        <div className="min-w-0">
                          <Link
                            to={`/onboarding/applications/${a.id}`}
                            className="text-gold hover:text-gold-bright underline-offset-4 hover:underline font-medium"
                          >
                            {a.associateName}
                          </Link>
                          {a.position && (
                            <div className="text-xs text-silver mt-0.5">
                              {a.position}
                            </div>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-silver">
                      {a.clientName}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-silver">
                      {TRACK_LABEL[a.onboardingTrack] ?? a.onboardingTrack}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs text-silver tabular-nums">
                      {daysSince(a.invitedAt, now)}d ago
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={STATUS_VARIANT[a.status] ?? 'default'}
                        data-status={a.status}
                      >
                        {STATUS_LABEL[a.status] ?? a.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <ProgressBar
                          percent={a.percentComplete}
                          hideLabel
                          className="flex-1"
                        />
                        <span
                          className={cn(
                            'text-xs tabular-nums w-9 text-right',
                            a.percentComplete === 100
                              ? 'text-success font-medium'
                              : a.percentComplete >= 50
                                ? 'text-gold'
                                : 'text-silver'
                          )}
                        >
                          {a.percentComplete}%
                        </span>
                      </div>
                    </TableCell>
                    {canManage && (
                      <TableCell className="text-right whitespace-nowrap no-print">
                        <div className="flex items-center justify-end gap-0.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setNudgeTarget(a)}
                            title="Send nudge email"
                            disabled={a.status === 'APPROVED' || a.status === 'REJECTED'}
                          >
                            <MessageCircle className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onResend(a)}
                            loading={resendingIds.has(a.id)}
                            title="Resend invite"
                          >
                            <Send className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  tone = 'text-white',
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="min-w-[6rem]">
      <div className="text-[10px] uppercase tracking-wider text-silver">{label}</div>
      <div className={cn('text-xl font-semibold tabular-nums', tone)}>{value}</div>
    </div>
  );
}

// Re-export so the existing import path keeps working if anything points at this file.
export { Skeleton };
