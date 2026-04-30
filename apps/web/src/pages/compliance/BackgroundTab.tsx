import { useCallback, useEffect, useState } from 'react';
import { Plus, ShieldCheck } from 'lucide-react';
import type { BackgroundCheck, BgCheckStatus } from '@alto-people/shared';
import {
  initiateBackgroundCheck,
  listBackgroundChecks,
  updateBackgroundCheck,
} from '@/lib/complianceApi';
import { ApiError } from '@/lib/api';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Drawer,
  DrawerBody,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  Input,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';

const TRANSITION_OPTIONS: BgCheckStatus[] = [
  'IN_PROGRESS',
  'NEEDS_REVIEW',
  'PASSED',
  'FAILED',
];

function statusVariant(s: BgCheckStatus): 'default' | 'pending' | 'success' | 'destructive' | 'accent' {
  switch (s) {
    case 'PASSED':
      return 'success';
    case 'FAILED':
      return 'destructive';
    case 'IN_PROGRESS':
    case 'NEEDS_REVIEW':
      return 'pending';
    case 'INITIATED':
      return 'default';
  }
}

function transitionVariant(
  s: BgCheckStatus,
): 'primary' | 'outline' | 'destructive' {
  if (s === 'PASSED') return 'primary';
  if (s === 'FAILED') return 'destructive';
  return 'outline';
}

export function BackgroundTab({ canManage }: { canManage: boolean }) {
  const [checks, setChecks] = useState<BackgroundCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showInitiate, setShowInitiate] = useState(false);
  const [drawerTarget, setDrawerTarget] = useState<BackgroundCheck | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listBackgroundChecks();
      setChecks(res.checks);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load.');
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const updateStatus = async (id: string, status: BgCheckStatus) => {
    setPendingId(id);
    try {
      await updateBackgroundCheck(id, { status });
      const fresh = await listBackgroundChecks();
      setChecks(fresh.checks);
      setDrawerTarget((prev) =>
        prev ? fresh.checks.find((c) => c.id === prev.id) ?? null : null,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Update failed.');
    } finally {
      setPendingId(null);
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-base font-medium text-white">Background checks</h2>
        {canManage && (
          <Button onClick={() => setShowInitiate(true)} size="sm">
            <Plus className="h-4 w-4" />
            Initiate check
          </Button>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-alert mb-3">
          {error}
        </p>
      )}
      {!checks && <SkeletonRows count={4} rowHeight="h-12" />}
      {checks && checks.length === 0 && (
        <EmptyState
          icon={ShieldCheck}
          title="No background checks yet"
          description={
            canManage
              ? 'New hires should run through onboarding, which initiates a check automatically. Manual initiation is here for back-fills.'
              : 'Background checks will appear here once they are initiated.'
          }
          action={
            canManage ? (
              <Button onClick={() => setShowInitiate(true)} size="sm">
                <Plus className="h-4 w-4" />
                Initiate check
              </Button>
            ) : undefined
          }
        />
      )}
      {checks && checks.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Associate</TableHead>
              <TableHead className="hidden sm:table-cell">Provider</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden md:table-cell">Initiated</TableHead>
              <TableHead className="hidden lg:table-cell">Completed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {checks.map((c) => (
              <TableRow
                key={c.id}
                className="group cursor-pointer"
                onClick={(ev) => {
                  const target = ev.target as HTMLElement;
                  if (target.closest('button, a, input, [data-no-row-click]')) return;
                  if (window.getSelection()?.toString()) return;
                  setDrawerTarget(c);
                }}
              >
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2.5">
                    <Avatar name={c.associateName} size="sm" />
                    <div className="min-w-0">
                      <div className="truncate">{c.associateName}</div>
                      {/* Phone-only secondary line replacing the hidden cells. */}
                      <div className="sm:hidden text-[11px] text-silver/70 truncate">
                        {c.provider} · initiated {new Date(c.initiatedAt).toLocaleDateString()}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="hidden sm:table-cell text-silver">{c.provider}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
                </TableCell>
                <TableCell className="hidden md:table-cell text-silver tabular-nums">
                  {new Date(c.initiatedAt).toLocaleDateString()}
                </TableCell>
                <TableCell className="hidden lg:table-cell text-silver tabular-nums">
                  {c.completedAt ? new Date(c.completedAt).toLocaleDateString() : '—'}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <InitiateCheckDialog
        open={showInitiate}
        onOpenChange={setShowInitiate}
        onCreated={() => {
          setShowInitiate(false);
          refresh();
        }}
        onError={setError}
      />

      <Drawer
        open={!!drawerTarget}
        onOpenChange={(o) => !o && setDrawerTarget(null)}
        width="max-w-lg"
      >
        {drawerTarget && (
          <BackgroundCheckDetailPanel
            check={drawerTarget}
            canManage={canManage}
            pending={pendingId === drawerTarget.id}
            onTransition={(status) => updateStatus(drawerTarget.id, status)}
          />
        )}
      </Drawer>
    </section>
  );
}

function BackgroundCheckDetailPanel({
  check,
  canManage,
  pending,
  onTransition,
}: {
  check: BackgroundCheck;
  canManage: boolean;
  pending: boolean;
  onTransition: (status: BgCheckStatus) => void;
}) {
  const initiated = new Date(check.initiatedAt);
  const ageDays = Math.max(
    0,
    Math.floor((Date.now() - initiated.getTime()) / (1000 * 60 * 60 * 24)),
  );
  const finalized = check.status === 'PASSED' || check.status === 'FAILED';
  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar name={check.associateName} size="md" />
          <div className="min-w-0">
            <DrawerTitle className="truncate">{check.associateName}</DrawerTitle>
            <DrawerDescription>{check.provider}</DrawerDescription>
          </div>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <div className="flex items-center gap-3 mb-5">
          <Badge variant={statusVariant(check.status)}>{check.status}</Badge>
          {!finalized && (
            <span className="text-xs text-silver tabular-nums">
              {ageDays}d open
            </span>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
          <DetailRow label="Initiated">
            {new Date(check.initiatedAt).toLocaleString()}
          </DetailRow>
          <DetailRow label="Completed">
            {check.completedAt ? new Date(check.completedAt).toLocaleString() : '—'}
          </DetailRow>
          <DetailRow label="Provider">{check.provider}</DetailRow>
          <DetailRow label="External ref">{check.externalId ?? '—'}</DetailRow>
        </dl>

        {finalized && (
          <p className="mt-5 text-xs text-silver">
            This check is finalized. Use a transition below if the result needs
            to be revised.
          </p>
        )}
      </DrawerBody>
      {canManage && (
        <DrawerFooter className="flex-wrap">
          {TRANSITION_OPTIONS.filter((s) => s !== check.status).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={transitionVariant(s)}
              onClick={() => onTransition(s)}
              disabled={pending}
              loading={pending}
            >
              {labelFor(s)}
            </Button>
          ))}
        </DrawerFooter>
      )}
    </>
  );
}

function labelFor(s: BgCheckStatus): string {
  switch (s) {
    case 'IN_PROGRESS':
      return 'Mark in progress';
    case 'NEEDS_REVIEW':
      return 'Needs review';
    case 'PASSED':
      return 'Mark passed';
    case 'FAILED':
      return 'Mark failed';
    case 'INITIATED':
      return 'Reopen';
  }
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-widest text-silver/80">{label}</dt>
      <dd className="text-white text-sm mt-0.5 tabular-nums break-all">{children}</dd>
    </div>
  );
}

interface InitiateCheckDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  onError: (msg: string) => void;
}

function InitiateCheckDialog({
  open,
  onOpenChange,
  onCreated,
  onError,
}: InitiateCheckDialogProps) {
  const [associateId, setAssociateId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) setAssociateId('');
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = associateId.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await initiateBackgroundCheck({ associateId: trimmed, provider: 'alto-stub' });
      onCreated();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Initiate failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Initiate background check</DialogTitle>
          <DialogDescription>
            Manual initiation is reserved for back-fills. New hires get a check
            automatically when they reach the BACKGROUND_CHECK onboarding task.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <label className="grid gap-1">
            <span className="text-[11px] uppercase tracking-wider text-silver">
              Associate ID
            </span>
            <Input
              autoFocus
              required
              placeholder="00000000-0000-4000-8000-000000000000"
              value={associateId}
              onChange={(e) => setAssociateId(e.target.value)}
            />
          </label>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              loading={busy}
              disabled={busy || !associateId.trim()}
            >
              Initiate check
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
