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
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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

const STATUS_OPTIONS: BgCheckStatus[] = [
  'INITIATED',
  'IN_PROGRESS',
  'PASSED',
  'FAILED',
  'NEEDS_REVIEW',
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

export function BackgroundTab({ canManage }: { canManage: boolean }) {
  const [checks, setChecks] = useState<BackgroundCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [showInitiate, setShowInitiate] = useState(false);

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
      await refresh();
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
              <TableHead>Provider</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Initiated</TableHead>
              <TableHead>Completed</TableHead>
              {canManage && <TableHead>Update</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {checks.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.associateName}</TableCell>
                <TableCell className="text-silver">{c.provider}</TableCell>
                <TableCell>
                  <Badge variant={statusVariant(c.status)}>{c.status}</Badge>
                </TableCell>
                <TableCell className="text-silver tabular-nums">
                  {new Date(c.initiatedAt).toLocaleDateString()}
                </TableCell>
                <TableCell className="text-silver tabular-nums">
                  {c.completedAt ? new Date(c.completedAt).toLocaleDateString() : '—'}
                </TableCell>
                {canManage && (
                  <TableCell>
                    <select
                      value={c.status}
                      disabled={pendingId === c.id}
                      onChange={(e) =>
                        updateStatus(c.id, e.target.value as BgCheckStatus)
                      }
                      className="text-xs bg-navy-secondary/60 border border-navy-secondary rounded px-2 py-1 focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold disabled:opacity-50"
                    >
                      {STATUS_OPTIONS.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </TableCell>
                )}
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
    </section>
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
