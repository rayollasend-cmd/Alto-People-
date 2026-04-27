import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  BarChart3,
  ClipboardList,
  LayoutGrid,
  LayoutTemplate,
  List,
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
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import {
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/Drawer';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { ViewToggle, useViewMode } from '@/components/ui/ViewToggle';
import { toast } from 'sonner';
import { ApplicationDetailBody } from './ApplicationDetail';
import { BulkInviteDialog } from './BulkInviteDialog';
import { NewApplicationDialog } from './NewApplicationDialog';
import { NudgeDialog } from './NudgeDialog';
import { cn } from '@/lib/cn';

const VIEW_OPTIONS = ['table', 'cards'] as const;
type ApplicationsView = (typeof VIEW_OPTIONS)[number];

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

  // Phase 72 — slide-over detail drawer. Click a row → keep the list mounted
  // and show ApplicationDetailBody in the drawer. Direct URL still routes to
  // the standalone page.
  const [drawerTarget, setDrawerTarget] = useState<ApplicationSummary | null>(null);

  // Phase 72 — table / cards view toggle, persisted per-user.
  const [view, setView] = useViewMode<ApplicationsView>('applications', 'table', VIEW_OPTIONS);

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
      <PageHeader
        title="Onboarding"
        subtitle="Active applications and their checklist progress."
        secondaryActions={
          canManage ? (
            <>
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
            </>
          ) : undefined
        }
        primaryAction={
          canManage ? (
            <Button onClick={() => setOpenCreate(true)}>
              <Plus className="h-4 w-4" />
              New application
            </Button>
          ) : undefined
        }
      />

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
          <span className="ml-auto text-[10px] text-silver/80 tabular-nums">
            {items ? `${items.length} shown` : ''}
          </span>
          <ViewToggle<ApplicationsView>
            value={view}
            onChange={setView}
            options={[
              { value: 'table', label: 'Table', icon: List },
              { value: 'cards', label: 'Cards', icon: LayoutGrid },
            ]}
          />
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

      {items && items.length > 0 && view === 'table' && (
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
                    onClick={(e) => {
                      // Don't intercept clicks on the inner controls (checkbox,
                      // links, action buttons). Ignore selection drags too.
                      const target = e.target as HTMLElement;
                      if (target.closest('button, a, input, [data-no-row-click]')) return;
                      if (window.getSelection()?.toString()) return;
                      setDrawerTarget(a);
                    }}
                    className={cn(
                      'group cursor-pointer',
                      isSelected && 'bg-gold/[0.04]'
                    )}
                  >
                    {canManage && (
                      <TableCell className="px-3 no-print">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleOne(a.id)}
                          onClick={(e) => e.stopPropagation()}
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
                      <div className="flex items-center gap-2.5">
                        <div className="relative">
                          <Avatar name={a.associateName} size="sm" />
                          {(a.lastInviteDelivery?.status === 'FAILED' || stale) && (
                            <span
                              className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full bg-alert border-2 border-navy grid place-items-center"
                              aria-label={
                                a.lastInviteDelivery?.status === 'FAILED'
                                  ? 'Email bounced'
                                  : 'Stuck'
                              }
                              title={
                                a.lastInviteDelivery?.status === 'FAILED'
                                  ? a.lastInviteDelivery.failureReason ?? 'Email bounced'
                                  : 'Stuck'
                              }
                            >
                              {a.lastInviteDelivery?.status === 'FAILED' ? (
                                <MailWarning className="h-2 w-2 text-white" aria-hidden="true" />
                              ) : (
                                <AlertTriangle className="h-2 w-2 text-white" aria-hidden="true" />
                              )}
                            </span>
                          )}
                        </div>
                        <div className="min-w-0">
                          <span className="text-white group-hover:text-gold-bright font-medium transition-colors">
                            {a.associateName}
                          </span>
                          {a.position && (
                            <div className="text-xs text-silver mt-0.5 truncate">
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
                        <div
                          className="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
                          data-no-row-click
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              setNudgeTarget(a);
                            }}
                            title="Send nudge email"
                            disabled={a.status === 'APPROVED' || a.status === 'REJECTED'}
                          >
                            <MessageCircle className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              onResend(a);
                            }}
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

      {items && items.length > 0 && view === 'cards' && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {items.map((a) => {
            const stale = isStale(a, now);
            const isSelected = selected.has(a.id);
            return (
              <ApplicationCard
                key={a.id}
                a={a}
                stale={stale}
                isSelected={isSelected}
                canManage={canManage}
                onOpen={() => setDrawerTarget(a)}
                onToggleSelect={() => toggleOne(a.id)}
                onNudge={() => setNudgeTarget(a)}
                onResend={() => onResend(a)}
                resending={resendingIds.has(a.id)}
              />
            );
          })}
        </div>
      )}

      <Drawer
        open={!!drawerTarget}
        onOpenChange={(o) => {
          if (!o) {
            setDrawerTarget(null);
            // Refresh in case the drawer mutated (skip task / resend).
            refresh();
            refreshAll();
          }
        }}
        width="max-w-2xl"
      >
        {drawerTarget && (
          <>
            <DrawerHeader>
              <DrawerTitle>{drawerTarget.associateName}</DrawerTitle>
              <DrawerDescription>
                {drawerTarget.clientName}
                {drawerTarget.position ? ` · ${drawerTarget.position}` : ''}
              </DrawerDescription>
            </DrawerHeader>
            <DrawerBody>
              <ApplicationDetailBody applicationId={drawerTarget.id} mode="drawer" />
            </DrawerBody>
          </>
        )}
      </Drawer>
    </div>
  );
}

interface ApplicationCardProps {
  a: ApplicationSummary;
  stale: boolean;
  isSelected: boolean;
  canManage: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onNudge: () => void;
  onResend: () => void;
  resending: boolean;
}

function ApplicationCard({
  a,
  stale,
  isSelected,
  canManage,
  onOpen,
  onToggleSelect,
  onNudge,
  onResend,
  resending,
}: ApplicationCardProps) {
  const bounced = a.lastInviteDelivery?.status === 'FAILED';
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest('button, a, input, [data-no-row-click]')) return;
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'group relative flex flex-col gap-3 rounded-lg border bg-navy p-4 cursor-pointer transition-colors',
        'hover:border-gold/40',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
        isSelected ? 'border-gold/60 bg-gold/[0.04]' : 'border-navy-secondary'
      )}
    >
      <div className="flex items-start gap-3">
        {canManage && (
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            onClick={(e) => e.stopPropagation()}
            aria-label={isSelected ? `Deselect ${a.associateName}` : `Select ${a.associateName}`}
            className="mt-1 h-3.5 w-3.5 rounded border-navy-secondary bg-navy text-gold focus:ring-gold focus:ring-offset-0 cursor-pointer"
          />
        )}
        <Avatar name={a.associateName} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="font-medium text-white group-hover:text-gold-bright transition-colors truncate">
              {a.associateName}
            </span>
            {bounced && (
              <span title={a.lastInviteDelivery?.failureReason ?? 'Email bounced'}>
                <MailWarning
                  className="h-3.5 w-3.5 text-alert shrink-0"
                  aria-label="Email bounced"
                />
              </span>
            )}
            {!bounced && stale && (
              <AlertTriangle
                className="h-3.5 w-3.5 text-alert shrink-0"
                aria-label="Stuck"
              />
            )}
          </div>
          <div className="text-xs text-silver mt-0.5 truncate">
            {a.clientName}
            {a.position ? ` · ${a.position}` : ''}
          </div>
        </div>
        <Badge
          variant={STATUS_VARIANT[a.status] ?? 'default'}
          data-status={a.status}
          className="shrink-0"
        >
          {STATUS_LABEL[a.status] ?? a.status}
        </Badge>
      </div>

      <div>
        <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-silver/80 mb-1">
          <span>Progress</span>
          <span
            className={cn(
              'tabular-nums',
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
        <ProgressBar percent={a.percentComplete} hideLabel />
      </div>

      <div className="flex items-center justify-between text-[10px] text-silver/80">
        <span>{TRACK_LABEL[a.onboardingTrack] ?? a.onboardingTrack} track</span>
        <span className="tabular-nums">
          Invited {daysSince(a.invitedAt, Date.now())}d ago
        </span>
      </div>

      {canManage && (
        <div
          className="flex items-center gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
          data-no-row-click
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onNudge();
            }}
            disabled={a.status === 'APPROVED' || a.status === 'REJECTED'}
            title="Send nudge email"
          >
            <MessageCircle className="h-3.5 w-3.5" />
            Nudge
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => {
              e.stopPropagation();
              onResend();
            }}
            loading={resending}
            title="Resend invite"
          >
            <Send className="h-3.5 w-3.5" />
            Resend
          </Button>
        </div>
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
