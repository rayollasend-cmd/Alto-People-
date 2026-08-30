import { useEffect, useRef, useState } from 'react';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { AlertCircle, Calendar, Clock, Download, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import {
  getExpirations,
  type ExpirationItem,
  type ExpirationsResponse,
} from '@/lib/expirations113Api';
import { grantAssociateQual } from '@/lib/qualApi';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import { usePersistentState } from '@/lib/usePersistentState';
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
  SegmentedControl,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { SearchInput } from '@/components/ui/FilterBar';
import { Label } from '@/components/ui/Label';
import { fmtDate, ymdLocal } from '@/lib/format';

/**
 * Phase 113 — Expiration dashboard.
 *
 * Three buckets stacked: expired (urgent — block deployment),
 * due soon (next N days), due later (informational, capped at 365).
 * Toggle between certs only / all qualifications.
 *
 * Click a row to renew the qualification — upserts AssociateQualification
 * with new acquiredAt + expiresAt. Manage:scheduling required.
 */
export function ExpirationsHome() {
  const { user } = useAuth();
  const canRenew = user
    ? hasCapability(user.role, 'manage:scheduling')
    : false;
  const [data, setData] = useState<ExpirationsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [days, setDays] = usePersistentState<30 | 60 | 90>(
    'alto:list.expirations.days.v1',
    60,
    (v): v is 30 | 60 | 90 => v === 30 || v === 60 || v === 90,
  );
  const [filter, setFilter] = usePersistentState<'all' | 'cert'>(
    'alto:list.expirations.type.v1',
    'all',
    (v): v is 'all' | 'cert' => v === 'all' || v === 'cert',
  );
  const [search, setSearch] = useState('');
  const [renewTarget, setRenewTarget] = useState<ExpirationItem | null>(null);

  // Keeps the previous buckets on screen while a filter flip refetches —
  // no full-skeleton flash. The sequence guard drops out-of-order responses
  // from rapid toggling.
  const reqSeq = useRef(0);
  const refresh = () => {
    const seq = ++reqSeq.current;
    setLoadError(null);
    getExpirations({
      days,
      isCert: filter === 'cert' ? true : undefined,
    })
      .then((d) => {
        if (seq === reqSeq.current) setData(d);
      })
      .catch(() => {
        if (seq === reqSeq.current) setLoadError('Failed to load expirations.');
      });
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, filter]);

  const q = search.trim().toLowerCase();
  const matches = (i: ExpirationItem) =>
    !q ||
    i.associateName.toLowerCase().includes(q) ||
    i.associateEmail.toLowerCase().includes(q) ||
    i.qualificationName.toLowerCase().includes(q) ||
    i.qualificationCode.toLowerCase().includes(q);
  const expired = data ? data.expired.filter(matches) : [];
  const dueSoon = data ? data.dueSoon.filter(matches) : [];
  const dueLater = data ? data.dueLater.filter(matches) : [];

  const onExportCsv = () => {
    if (!data) return;
    const bucketRows = (bucket: string, items: ExpirationItem[]) =>
      items.map((i) => [
        bucket,
        i.associateName,
        i.associateEmail,
        i.qualificationName,
        i.qualificationCode,
        i.isCert ? 'Yes' : 'No',
        fmtDate(i.expiresAt),
        i.daysUntilExpiry,
      ]);
    downloadCsv(`expirations-${ymdLocal()}.csv`, [
      ['Bucket', 'Associate', 'Email', 'Qualification', 'Code', 'Cert', 'Expires', 'Days until expiry'],
      ...bucketRows('Expired', expired),
      ...bucketRows(`Due in ${data.days} days`, dueSoon),
      ...bucketRows('Due later (within 1 year)', dueLater),
    ]);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Expirations"
        subtitle="Qualifications and certifications expiring soon — chase renewals before they lapse."
        breadcrumbs={[{ label: 'Expirations' }]}
      />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-silver">Within:</span>
        <SegmentedControl
          ariaLabel="Expiry window"
          value={days}
          onChange={(v) => setDays(v)}
          options={[
            { value: 30 as const, label: '30d' },
            { value: 60 as const, label: '60d' },
            { value: 90 as const, label: '90d' },
          ]}
        />
        <span className="ml-4 text-silver">Type:</span>
        <SegmentedControl
          ariaLabel="Qualification type"
          value={filter}
          onChange={(v) => setFilter(v)}
          options={[
            { value: 'all' as const, label: 'All' },
            { value: 'cert' as const, label: 'Certs only' },
          ]}
        />
        <SearchInput
          className="w-64"
          wrapperClassName="ml-auto"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search associate or qualification…"
          aria-label="Search expirations"
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={onExportCsv}
          disabled={!data}
        >
          <Download className="mr-2 h-4 w-4" /> Export CSV
        </Button>
      </div>

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
      ) : data === null ? (
        <Card><CardContent><SkeletonRows count={5} /></CardContent></Card>
      ) : (
        <div className="space-y-4">
          <Bucket
            title="Expired"
            icon={AlertCircle}
            accent="text-alert"
            count={q ? expired.length : data.counts.expired}
            items={expired}
            emptyHint={q ? 'No matches.' : 'Nothing expired.'}
            canRenew={canRenew}
            onRenew={setRenewTarget}
          />
          <Bucket
            title={`Due in next ${data.days} days`}
            icon={ShieldAlert}
            accent="text-warning"
            count={q ? dueSoon.length : data.counts.dueSoon}
            items={dueSoon}
            emptyHint={q ? 'No matches.' : 'Nothing due soon.'}
            canRenew={canRenew}
            onRenew={setRenewTarget}
          />
          <Bucket
            title="Due later (within 1 year)"
            icon={Calendar}
            accent="text-gold"
            count={q ? dueLater.length : data.counts.dueLater}
            items={dueLater}
            emptyHint={q ? 'No matches.' : 'Nothing further out.'}
            canRenew={canRenew}
            onRenew={setRenewTarget}
          />
        </div>
      )}

      {renewTarget && (
        <RenewDrawer
          item={renewTarget}
          onClose={() => setRenewTarget(null)}
          onSaved={() => {
            setRenewTarget(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function Bucket({
  title,
  icon: Icon,
  accent,
  count,
  items,
  emptyHint,
  canRenew,
  onRenew,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  accent: string;
  count: number;
  items: ExpirationItem[];
  emptyHint: string;
  canRenew: boolean;
  onRenew: (item: ExpirationItem) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const truncated = !showAll && items.length > 100;
  const shown = truncated ? items.slice(0, 100) : items;
  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-4 pt-4 pb-2 flex items-center gap-2">
          <Icon className={`h-4 w-4 ${accent}`} />
          <div className="text-sm uppercase tracking-wider text-silver">
            {title}
          </div>
          <Badge variant="outline">{count}</Badge>
        </div>
        {items.length === 0 ? (
          <EmptyState icon={Clock} title="" description={emptyHint} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Associate</TableHead>
                <TableHead className="hidden md:table-cell">Email</TableHead>
                <TableHead>Qualification</TableHead>
                <TableHead className="hidden lg:table-cell">Code</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>In</TableHead>
                {canRenew && <TableHead className="text-right">Action</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((i) => (
                <TableRow
                  key={i.id}
                  className={canRenew ? 'cursor-pointer' : ''}
                  onClick={canRenew ? () => onRenew(i) : undefined}
                >
                  <TableCell className="font-medium text-white">
                    <AssociateLink associateId={i.associateId}>{i.associateName}</AssociateLink>
                    <div className="text-xs2 text-silver/70 md:hidden">{i.associateEmail}</div>
                  </TableCell>
                  <TableCell className="text-silver text-xs hidden md:table-cell">{i.associateEmail}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {i.qualificationName}
                      {i.isCert && <Badge variant="accent">cert</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs hidden lg:table-cell">{i.qualificationCode}</TableCell>
                  <TableCell>{fmtDate(i.expiresAt)}</TableCell>
                  <TableCell>
                    {i.daysUntilExpiry < 0 ? (
                      <span className="text-alert">{-i.daysUntilExpiry}d ago</span>
                    ) : i.daysUntilExpiry < 30 ? (
                      <span className="text-warning">{i.daysUntilExpiry}d</span>
                    ) : (
                      <span className="text-silver">{i.daysUntilExpiry}d</span>
                    )}
                  </TableCell>
                  {canRenew && (
                    <TableCell
                      className="text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onRenew(i)}
                      >
                        Renew
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {items.length > 100 && (
          <div className="px-4 py-2 flex items-center gap-3 text-xs text-silver border-t border-navy-secondary">
            <span>
              {truncated
                ? `Showing 100 of ${items.length}`
                : `Showing all ${items.length}`}
            </span>
            <Button
              type="button"
              size="xs"
              variant="secondary"
              onClick={() => setShowAll((v) => !v)}
            >
              {truncated ? 'Show all' : 'Show first 100'}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RenewDrawer({
  item,
  onClose,
  onSaved,
}: {
  item: ExpirationItem;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Local-timezone defaults — toISOString() is UTC and pre-fills tomorrow's
  // date for evening users west of UTC.
  const today = ymdLocal();
  // Default new expiry to one year from today — typical cert renewal cycle.
  const oneYearOut = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return ymdLocal(d);
  })();
  const [acquiredAt, setAcquiredAt] = useState(today);
  const [expiresAt, setExpiresAt] = useState(oneYearOut);
  const [evidenceKey, setEvidenceKey] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!expiresAt) {
      toast.error('New expiration date is required.');
      return;
    }
    if (expiresAt <= acquiredAt) {
      toast.error('Expiration must be after acquired date.');
      return;
    }
    setBusy(true);
    try {
      await grantAssociateQual(item.associateId, {
        qualificationId: item.qualificationId,
        acquiredAt,
        expiresAt,
        evidenceKey: evidenceKey.trim() || null,
      });
      toast.success('Renewed.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Renew {item.qualificationName}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm">
          <div className="text-silver">For</div>
          <div className="font-medium text-white">
            <AssociateLink associateId={item.associateId}>{item.associateName}</AssociateLink>
          </div>
          <div className="text-xs text-silver">{item.associateEmail}</div>
        </div>
        <div className="text-sm border-t border-navy-secondary pt-3">
          <div className="text-silver">Currently expires</div>
          <div className="text-white">
            {fmtDate(item.expiresAt)}
            {item.daysUntilExpiry < 0 ? (
              <span className="text-alert ml-2">
                ({-item.daysUntilExpiry}d ago)
              </span>
            ) : (
              <span className="text-silver ml-2">
                (in {item.daysUntilExpiry}d)
              </span>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 pt-3 border-t border-navy-secondary">
          <div>
            <Label>Acquired (renewal date)</Label>
            <Input
              type="date"
              className="mt-1"
              value={acquiredAt}
              onChange={(e) => setAcquiredAt(e.target.value)}
            />
          </div>
          <div>
            <Label>New expiration</Label>
            <Input
              type="date"
              className="mt-1"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label>Evidence reference (optional)</Label>
          <Input
            className="mt-1"
            value={evidenceKey}
            onChange={(e) => setEvidenceKey(e.target.value)}
            placeholder="Document key, certificate number, file path…"
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={busy}>
          {busy ? 'Marking…' : 'Mark renewed'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
