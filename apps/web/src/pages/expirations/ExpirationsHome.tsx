import { useEffect, useState } from 'react';
import { AlertCircle, Calendar, Clock, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  getExpirations,
  type ExpirationItem,
  type ExpirationsResponse,
} from '@/lib/expirations113Api';
import { grantAssociateQual } from '@/lib/qualApi';
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
  const [days, setDays] = useState<30 | 60 | 90>(60);
  const [filter, setFilter] = useState<'all' | 'cert'>('all');
  const [renewTarget, setRenewTarget] = useState<ExpirationItem | null>(null);

  const refresh = () => {
    setData(null);
    getExpirations({
      days,
      isCert: filter === 'cert' ? true : undefined,
    })
      .then(setData)
      .catch(() => setData(null));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, filter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Expirations"
        subtitle="Qualifications and certifications expiring soon — chase renewals before they lapse."
        breadcrumbs={[{ label: 'Expirations' }]}
      />
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-silver">Within:</span>
        {[30, 60, 90].map((d) => (
          <button
            key={d}
            onClick={() => setDays(d as 30 | 60 | 90)}
            className={`px-3 py-1 rounded-full border transition ${
              days === d
                ? 'bg-cyan-600 border-cyan-500 text-white'
                : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
            }`}
          >
            {d}d
          </button>
        ))}
        <span className="ml-4 text-silver">Type:</span>
        <button
          onClick={() => setFilter('all')}
          className={`px-3 py-1 rounded-full border transition ${
            filter === 'all'
              ? 'bg-cyan-600 border-cyan-500 text-white'
              : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
          }`}
        >
          All
        </button>
        <button
          onClick={() => setFilter('cert')}
          className={`px-3 py-1 rounded-full border transition ${
            filter === 'cert'
              ? 'bg-cyan-600 border-cyan-500 text-white'
              : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
          }`}
        >
          Certs only
        </button>
      </div>

      {data === null ? (
        <Card><CardContent><SkeletonRows count={5} /></CardContent></Card>
      ) : (
        <div className="space-y-4">
          <Bucket
            title="Expired"
            icon={AlertCircle}
            accent="text-rose-400"
            count={data.counts.expired}
            items={data.expired}
            emptyHint="Nothing expired."
            canRenew={canRenew}
            onRenew={setRenewTarget}
          />
          <Bucket
            title={`Due in next ${data.days} days`}
            icon={ShieldAlert}
            accent="text-amber-400"
            count={data.counts.dueSoon}
            items={data.dueSoon}
            emptyHint="Nothing due soon."
            canRenew={canRenew}
            onRenew={setRenewTarget}
          />
          <Bucket
            title="Due later (within 1 year)"
            icon={Calendar}
            accent="text-cyan-400"
            count={data.counts.dueLater}
            items={data.dueLater}
            emptyHint="Nothing further out."
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
                <TableHead>Email</TableHead>
                <TableHead>Qualification</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>In</TableHead>
                {canRenew && <TableHead className="text-right">Action</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.slice(0, 100).map((i) => (
                <TableRow
                  key={i.id}
                  className={canRenew ? 'cursor-pointer' : ''}
                  onClick={canRenew ? () => onRenew(i) : undefined}
                >
                  <TableCell className="font-medium text-white">
                    {i.associateName}
                  </TableCell>
                  <TableCell className="text-silver text-xs">{i.associateEmail}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {i.qualificationName}
                      {i.isCert && <Badge variant="accent">cert</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{i.qualificationCode}</TableCell>
                  <TableCell>{new Date(i.expiresAt).toLocaleDateString()}</TableCell>
                  <TableCell>
                    {i.daysUntilExpiry < 0 ? (
                      <span className="text-rose-400">{-i.daysUntilExpiry}d ago</span>
                    ) : i.daysUntilExpiry < 30 ? (
                      <span className="text-amber-400">{i.daysUntilExpiry}d</span>
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
  const today = new Date().toISOString().slice(0, 10);
  // Default new expiry to one year from today — typical cert renewal cycle.
  const oneYearOut = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
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
          <div className="font-medium text-white">{item.associateName}</div>
          <div className="text-xs text-silver">{item.associateEmail}</div>
        </div>
        <div className="text-sm border-t border-navy-secondary pt-3">
          <div className="text-silver">Currently expires</div>
          <div className="text-white">
            {new Date(item.expiresAt).toLocaleDateString()}
            {item.daysUntilExpiry < 0 ? (
              <span className="text-rose-400 ml-2">
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
