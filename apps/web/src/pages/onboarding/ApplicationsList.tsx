import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList, Plus } from 'lucide-react';
import type { ApplicationSummary } from '@alto-people/shared';
import { listApplications } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { ProgressBar } from '@/components/ProgressBar';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';
import { NewApplicationDialog } from './NewApplicationDialog';
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

export function ApplicationsList() {
  const { can } = useAuth();
  const canManage = can('manage:onboarding');
  const [items, setItems] = useState<ApplicationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCreate, setOpenCreate] = useState(false);

  const refresh = useCallback(() => {
    setError(null);
    listApplications()
      .then((res) => setItems(res.applications))
      .catch((err) =>
        setError(err instanceof ApiError ? err.message : 'Failed to load.')
      );
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
            Onboarding
          </h1>
          <p className="text-silver">
            Active applications and their checklist progress.
          </p>
        </div>
        {canManage && (
          <Button onClick={() => setOpenCreate(true)}>
            <Plus className="h-4 w-4" />
            New application
          </Button>
        )}
      </header>

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
          title="No active applications"
          description={
            canManage
              ? 'Click "New application" to invite the first associate.'
              : 'When HR creates an onboarding application, it\'ll show up here with live checklist progress.'
          }
          action={
            canManage ? (
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
        onCreated={refresh}
      />

      {items && items.length > 0 && (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Applicant</TableHead>
                <TableHead className="hidden md:table-cell">Client</TableHead>
                <TableHead className="hidden lg:table-cell">Track</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-56">Progress</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((a) => (
                <TableRow key={a.id} className="cursor-pointer">
                  <TableCell>
                    <Link
                      to={`/onboarding/applications/${a.id}`}
                      className="text-gold hover:text-gold-bright underline-offset-4 hover:underline font-medium"
                    >
                      {a.associateName}
                    </Link>
                    {a.position && (
                      <div className="text-xs text-silver mt-0.5">{a.position}</div>
                    )}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-silver">
                    {a.clientName}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-silver">
                    {TRACK_LABEL[a.onboardingTrack] ?? a.onboardingTrack}
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
                      <ProgressBar percent={a.percentComplete} hideLabel className="flex-1" />
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
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

// Re-export so the existing import path keeps working if anything points
// at this file directly.
export { Skeleton };
