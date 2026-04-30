import { useEffect, useState } from 'react';
import { Coins, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import {
  cancelEquityGrant,
  createEquityGrant,
  exerciseEquityGrant,
  getEquityGrant,
  getEquitySummary,
  grantEquityGrant,
  listEquityGrants,
  listMyEquity,
  type EquityGrant,
  type EquityGrantDetail,
  type EquityGrantStatus,
  type EquityGrantType,
  type EquitySummary,
  type MyEquityGrant,
} from '@/lib/equity129Api';
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

const GRANT_TYPE_LABELS: Record<EquityGrantType, string> = {
  RSU: 'RSU',
  NSO: 'NSO option',
  ISO: 'ISO option',
  PHANTOM: 'Phantom',
  PERFORMANCE_RSU: 'PSU',
};

const STATUS_VARIANT: Record<
  EquityGrantStatus,
  'pending' | 'success' | 'destructive' | 'accent' | 'outline'
> = {
  PROPOSED: 'pending',
  GRANTED: 'success',
  CANCELLED: 'destructive',
  EXERCISED: 'accent',
  EXPIRED: 'outline',
};

export function EquityHome() {
  const { user } = useAuth();
  const canManageComp = user ? hasCapability(user.role, 'manage:comp') : false;
  const [tab, setTab] = useState<'mine' | 'admin'>('mine');
  const [mine, setMine] = useState<MyEquityGrant[] | null>(null);
  const [admin, setAdmin] = useState<EquityGrant[] | null>(null);
  const [summary, setSummary] = useState<EquitySummary | null>(null);
  const [statusFilter, setStatusFilter] = useState<EquityGrantStatus | 'ALL'>(
    'GRANTED',
  );
  const [showNew, setShowNew] = useState(false);
  const [openMine, setOpenMine] = useState<MyEquityGrant | null>(null);
  const [openAdminId, setOpenAdminId] = useState<string | null>(null);

  const refresh = () => {
    if (tab === 'mine') {
      setMine(null);
      listMyEquity()
        .then((r) => setMine(r.grants))
        .catch(() => setMine([]));
    } else {
      setAdmin(null);
      listEquityGrants(statusFilter === 'ALL' ? undefined : statusFilter)
        .then((r) => setAdmin(r.grants))
        .catch(() => setAdmin([]));
      getEquitySummary()
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
        title="Equity"
        subtitle="Stock and option grants. Vesting tranches generated at grant time — cliff plus monthly until fully vested."
        breadcrumbs={[{ label: 'Total rewards' }, { label: 'Equity' }]}
      />

      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={tab === 'mine' ? 'primary' : 'ghost'}
            onClick={() => setTab('mine')}
          >
            My grants
          </Button>
          {canManageComp && (
            <Button
              size="sm"
              variant={tab === 'admin' ? 'primary' : 'ghost'}
              onClick={() => setTab('admin')}
            >
              All grants
              {summary && summary.proposedCount > 0 && (
                <Badge variant="pending" className="ml-2">
                  {summary.proposedCount}
                </Badge>
              )}
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          {canManageComp && tab === 'admin' && (
            <select
              className="text-xs bg-midnight border border-navy-secondary rounded p-1.5 text-white"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as EquityGrantStatus | 'ALL')
              }
            >
              <option value="ALL">All statuses</option>
              <option value="PROPOSED">Proposed</option>
              <option value="GRANTED">Granted</option>
              <option value="CANCELLED">Cancelled</option>
              <option value="EXERCISED">Exercised</option>
              <option value="EXPIRED">Expired</option>
            </select>
          )}
          {canManageComp && (
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> New grant
            </Button>
          )}
        </div>
      </div>

      {tab === 'admin' && summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SummaryCard label="Proposed" value={summary.proposedCount} />
          <SummaryCard
            label="Active recipients"
            value={summary.activeRecipients}
          />
          <SummaryCard
            label="Shares granted"
            value={summary.sharesGranted.toLocaleString()}
          />
          <SummaryCard
            label="Shares vested"
            value={summary.sharesVested.toLocaleString()}
          />
        </div>
      )}

      {tab === 'mine' ? (
        <Card>
          <CardContent className="p-0">
            {mine === null ? (
              <div className="p-6">
                <SkeletonRows count={3} />
              </div>
            ) : mine.length === 0 ? (
              <EmptyState
                icon={Coins}
                title="No equity grants"
                description="Once HR issues you a grant, you'll see it here."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Type</TableHead>
                    <TableHead>Total</TableHead>
                    <TableHead>Vested</TableHead>
                    <TableHead>Unvested</TableHead>
                    <TableHead>Strike</TableHead>
                    <TableHead>Grant date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {mine.map((g) => (
                    <TableRow
                      key={g.id}
                      className="cursor-pointer"
                      onClick={() => setOpenMine(g)}
                    >
                      <TableCell className="font-medium text-white">
                        {GRANT_TYPE_LABELS[g.grantType]}
                      </TableCell>
                      <TableCell className="text-sm">
                        {g.totalShares.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-sm text-green-300">
                        {g.vestedShares.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-sm text-silver">
                        {g.unvestedShares.toLocaleString()}
                      </TableCell>
                      <TableCell className="text-sm">
                        {g.strikePrice
                          ? `${g.currency} ${g.strikePrice}`
                          : '—'}
                      </TableCell>
                      <TableCell className="text-xs text-silver">
                        {g.grantDate}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            {admin === null ? (
              <div className="p-6">
                <SkeletonRows count={4} />
              </div>
            ) : admin.length === 0 ? (
              <EmptyState
                icon={Coins}
                title="No grants"
                description="Nothing matches this filter."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Associate</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Shares</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Grant date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {admin.map((g) => (
                    <TableRow
                      key={g.id}
                      className="cursor-pointer"
                      onClick={() => setOpenAdminId(g.id)}
                    >
                      <TableCell>
                        <div className="font-medium text-white">
                          {g.associateName ?? '—'}
                        </div>
                        <div className="text-xs text-silver">
                          {g.associateEmail ?? ''}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {GRANT_TYPE_LABELS[g.grantType]}
                      </TableCell>
                      <TableCell className="text-sm">
                        {g.totalShares.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[g.status]}>
                          {g.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs text-silver">
                        {g.grantDate}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {showNew && canManageComp && (
        <NewGrantDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {openMine && (
        <MyDetailDrawer row={openMine} onClose={() => setOpenMine(null)} />
      )}
      {openAdminId && (
        <AdminDetailDrawer
          id={openAdminId}
          onClose={() => setOpenAdminId(null)}
          onSaved={() => {
            setOpenAdminId(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <Card>
      <CardContent className="p-3">
        <div className="text-xs uppercase tracking-wider text-silver">
          {label}
        </div>
        <div className="text-xl font-semibold text-white mt-1">{value}</div>
      </CardContent>
    </Card>
  );
}

function NewGrantDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [associateId, setAssociateId] = useState('');
  const [grantType, setGrantType] = useState<EquityGrantType>('RSU');
  const [totalShares, setTotalShares] = useState('');
  const [strikePrice, setStrikePrice] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const [grantDate, setGrantDate] = useState(today);
  const [vestingStartDate, setVestingStartDate] = useState(today);
  const [cliffMonths, setCliffMonths] = useState('12');
  const [vestingMonths, setVestingMonths] = useState('48');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const isOption = grantType === 'NSO' || grantType === 'ISO';

  const submit = async () => {
    if (!associateId.trim() || !totalShares) {
      toast.error('Associate ID and total shares required.');
      return;
    }
    if (isOption && !strikePrice) {
      toast.error('Options require a strike price.');
      return;
    }
    setBusy(true);
    try {
      await createEquityGrant({
        associateId: associateId.trim(),
        grantType,
        totalShares: parseInt(totalShares, 10),
        strikePrice: isOption ? parseFloat(strikePrice) : null,
        grantDate,
        vestingStartDate,
        cliffMonths: parseInt(cliffMonths, 10),
        vestingMonths: parseInt(vestingMonths, 10),
        notes: notes.trim() || null,
      });
      toast.success('Grant created (PROPOSED).');
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
        <DrawerTitle>New equity grant</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Associate ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={associateId}
            onChange={(e) => setAssociateId(e.target.value)}
            placeholder="UUID from /clients/:id team list"
          />
        </div>
        <div>
          <Label>Type</Label>
          <select
            className="w-full mt-1 bg-midnight border border-navy-secondary rounded p-2 text-white"
            value={grantType}
            onChange={(e) => setGrantType(e.target.value as EquityGrantType)}
          >
            {(Object.keys(GRANT_TYPE_LABELS) as EquityGrantType[]).map((k) => (
              <option key={k} value={k}>
                {GRANT_TYPE_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label>Total shares</Label>
          <Input
            type="number"
            min="1"
            className="mt-1"
            value={totalShares}
            onChange={(e) => setTotalShares(e.target.value)}
          />
        </div>
        {isOption && (
          <div>
            <Label>Strike price (USD)</Label>
            <Input
              type="number"
              min="0"
              step="0.0001"
              className="mt-1"
              value={strikePrice}
              onChange={(e) => setStrikePrice(e.target.value)}
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Grant date</Label>
            <Input
              type="date"
              className="mt-1"
              value={grantDate}
              onChange={(e) => setGrantDate(e.target.value)}
            />
          </div>
          <div>
            <Label>Vesting start</Label>
            <Input
              type="date"
              className="mt-1"
              value={vestingStartDate}
              onChange={(e) => setVestingStartDate(e.target.value)}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Cliff (months)</Label>
            <Input
              type="number"
              min="0"
              max="120"
              className="mt-1"
              value={cliffMonths}
              onChange={(e) => setCliffMonths(e.target.value)}
            />
          </div>
          <div>
            <Label>Vesting total (months)</Label>
            <Input
              type="number"
              min="1"
              max="120"
              className="mt-1"
              value={vestingMonths}
              onChange={(e) => setVestingMonths(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label>Notes</Label>
          <textarea
            className="w-full mt-1 h-20 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Internal context — board approval ref, retention rationale, etc."
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={busy}>
          {busy ? 'Creating…' : 'Create as PROPOSED'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function MyDetailDrawer({
  row,
  onClose,
}: {
  row: MyEquityGrant;
  onClose: () => void;
}) {
  const pctVested =
    row.totalShares > 0
      ? Math.round((row.vestedShares / row.totalShares) * 100)
      : 0;
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>
          {GRANT_TYPE_LABELS[row.grantType]} · {row.totalShares.toLocaleString()}{' '}
          shares
        </DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge variant={STATUS_VARIANT[row.status]}>{row.status}</Badge>
          <span className="text-sm text-silver">
            Granted {row.grantDate} · Vesting from {row.vestingStartDate}
          </span>
        </div>

        <Card>
          <CardContent className="p-4">
            <div className="flex justify-between items-baseline mb-2">
              <span className="text-sm text-silver">Vested</span>
              <span className="text-2xl font-semibold text-green-300">
                {row.vestedShares.toLocaleString()}
              </span>
            </div>
            <div className="w-full bg-navy-secondary rounded-full h-2 overflow-hidden">
              <div
                className="bg-green-500 h-full transition-all"
                style={{ width: `${pctVested}%` }}
              />
            </div>
            <div className="flex justify-between text-xs mt-2 text-silver">
              <span>{pctVested}% vested</span>
              <span>
                {row.unvestedShares.toLocaleString()} remaining
              </span>
            </div>
          </CardContent>
        </Card>

        {row.strikePrice && (
          <div className="text-sm">
            <span className="text-silver">Strike price: </span>
            <span className="text-white font-semibold">
              {row.currency} {row.strikePrice}
            </span>
            {row.expirationDate && (
              <span className="text-silver ml-3">
                Expires {row.expirationDate}
              </span>
            )}
          </div>
        )}

        <div>
          <div className="text-sm font-medium mb-2">Upcoming vesting</div>
          {row.upcomingTranches.length === 0 ? (
            <div className="text-xs text-silver italic">
              Fully vested — no future tranches.
            </div>
          ) : (
            <div className="space-y-1">
              {row.upcomingTranches.map((t) => (
                <div
                  key={t.vestDate}
                  className="flex justify-between text-sm border-b border-navy-secondary pb-1"
                >
                  <span className="text-silver">{t.vestDate}</span>
                  <span className="text-white">
                    +{t.shares.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="text-xs text-silver pt-2 border-t border-navy-secondary">
          Schedule: {row.cliffMonths}-month cliff, {row.vestingMonths} months
          total.
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}

function AdminDetailDrawer({
  id,
  onClose,
  onSaved,
}: {
  id: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [grant, setGrant] = useState<EquityGrantDetail | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getEquityGrant(id)
      .then((r) => setGrant(r.grant))
      .catch(() => setGrant(null));
  }, [id]);

  const act = async (
    fn: () => Promise<{ ok: true }>,
    successMessage: string,
  ) => {
    setBusy(true);
    try {
      await fn();
      toast.success(successMessage);
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
        <DrawerTitle>
          {grant
            ? `${grant.associateName} · ${GRANT_TYPE_LABELS[grant.grantType]}`
            : 'Loading…'}
        </DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {!grant ? (
          <SkeletonRows count={3} />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Badge variant={STATUS_VARIANT[grant.status]}>
                {grant.status}
              </Badge>
              <span className="text-sm text-silver">
                {grant.totalShares.toLocaleString()} total ·{' '}
                {grant.vestedShares.toLocaleString()} vested
              </span>
            </div>
            <div className="text-xs text-silver">
              Granted {grant.grantDate} · Vesting starts{' '}
              {grant.vestingStartDate} · {grant.cliffMonths}-mo cliff ·{' '}
              {grant.vestingMonths} mo total
              {grant.grantedByEmail && ` · by ${grant.grantedByEmail}`}
            </div>
            {grant.strikePrice && (
              <div className="text-sm">
                Strike: {grant.currency} {grant.strikePrice}
                {grant.expirationDate && ` · expires ${grant.expirationDate}`}
              </div>
            )}
            {grant.notes && (
              <div className="text-sm text-silver italic p-3 rounded border border-navy-secondary">
                {grant.notes}
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {grant.status === 'PROPOSED' && (
                <Button
                  size="sm"
                  onClick={() =>
                    act(() => grantEquityGrant(grant.id), 'Granted.')
                  }
                  disabled={busy}
                >
                  Mark granted
                </Button>
              )}
              {(grant.status === 'PROPOSED' ||
                grant.status === 'GRANTED') && (
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() =>
                    act(() => cancelEquityGrant(grant.id), 'Cancelled.')
                  }
                  disabled={busy}
                >
                  Cancel
                </Button>
              )}
              {grant.status === 'GRANTED' &&
                (grant.grantType === 'NSO' || grant.grantType === 'ISO') && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() =>
                      act(
                        () => exerciseEquityGrant(grant.id),
                        'Marked exercised.',
                      )
                    }
                    disabled={busy}
                  >
                    Mark exercised
                  </Button>
                )}
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Vesting schedule</div>
              <div className="max-h-64 overflow-y-auto border border-navy-secondary rounded">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Shares</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Vested</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {grant.events.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell className="text-xs">{e.vestDate}</TableCell>
                        <TableCell className="text-sm">
                          {e.shares.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-xs text-silver">
                          {e.isCliff ? 'Cliff' : 'Monthly'}
                        </TableCell>
                        <TableCell>
                          {e.vested ? (
                            <Badge variant="success">vested</Badge>
                          ) : (
                            <span className="text-silver text-xs">—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}
