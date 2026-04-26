import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardList } from 'lucide-react';
import type { ApplicationSummary } from '@alto-people/shared';
import { listApplications } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { ProgressBar } from '@/components/ProgressBar';
import { Badge } from '@/components/ui/Badge';
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
  const [items, setItems] = useState<ApplicationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listApplications()
      .then((res) => {
        if (!cancelled) setItems(res.applications);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Failed to load.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
          Onboarding
        </h1>
        <p className="text-silver">
          Active applications and their checklist progress.
        </p>
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
          description="When HR creates an onboarding application, it'll show up here with live checklist progress."
        />
      )}

      {items && items.length > 0 && (
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Applicant</TableHead>
                <TableHead className="hidden md:table-cell">Client</TableHead>
                <TableHead className="hidden lg:table-cell">Track</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-48">Progress</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <Link
                      to={`/onboarding/applications/${a.id}`}
                      className="text-gold hover:text-gold-bright underline-offset-4 hover:underline"
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
                    <Badge variant={STATUS_VARIANT[a.status] ?? 'default'}>
                      {STATUS_LABEL[a.status] ?? a.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <ProgressBar percent={a.percentComplete} hideLabel />
                    <div className="text-xs text-silver mt-1 tabular-nums">
                      {a.percentComplete}%
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
