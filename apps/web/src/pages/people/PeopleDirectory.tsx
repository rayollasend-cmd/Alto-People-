import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Briefcase,
  Building2,
  Download,
  FileText,
  Mail,
  Phone,
  Plus,
  Search,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  DirectoryEntry,
  DirectoryStatus,
  DocumentRecord,
} from '@alto-people/shared';
import { listDirectory, type DirectoryFilters } from '@/lib/directoryApi';
import { listClients } from '@/lib/clientsApi';
import type { ClientListItem } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import {
  type CompChangeReason,
  type CompRecord,
  type PayType,
  createRecord,
  listRecords,
} from '@/lib/compApi';
import {
  downloadDocumentUrl,
  listAdminDocuments,
} from '@/lib/documentsApi';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
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
  Label,
  PageHeader,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { cn } from '@/lib/cn';

const STATUS_VARIANT: Record<
  DirectoryStatus,
  'success' | 'pending' | 'default'
> = {
  ACTIVE: 'success',
  PENDING: 'pending',
  INACTIVE: 'default',
};

const STATUS_LABEL: Record<DirectoryStatus, string> = {
  ACTIVE: 'Active',
  PENDING: 'Pending',
  INACTIVE: 'Inactive',
};

const EMPLOYMENT_LABEL: Record<string, string> = {
  W2_EMPLOYEE: 'W-2',
  CONTRACTOR_1099_INDIVIDUAL: '1099 Individual',
  CONTRACTOR_1099_BUSINESS: '1099 Business',
};

const PAY_TYPE_SUFFIX: Record<string, string> = {
  HOURLY: '/ hr',
  SALARY: '/ yr',
  COMMISSION: ' commission',
  PIECEWORK: ' / piece',
};

function fmtPay(amount: string | null, type: string | null, currency: string | null): string {
  if (!amount) return '—';
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  const ccy = currency ?? 'USD';
  const formatted = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: ccy,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
  return `${formatted}${type ? PAY_TYPE_SUFFIX[type] ?? '' : ''}`;
}

/**
 * Phase add-on — People directory.
 *
 * One-stop list of every associate Alto HR knows about. Each row carries the
 * "is this person showing up?" answers HR needs at a glance: status, current
 * workplace, pay rate, employment type, manager. Click a row to see the
 * full profile drawer with contact info, onboarding %, and links into the
 * detail pages (org structure, agreements, documents, comp history).
 */
export function PeopleDirectory() {
  const [rows, setRows] = useState<DirectoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clients, setClients] = useState<ClientListItem[]>([]);
  const [filters, setFilters] = useState<DirectoryFilters>({});
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<DirectoryEntry | null>(null);

  // Debounce the search input. We search server-side to keep the row math
  // (status derivation, comp lookup) honest with paging in the future.
  useEffect(() => {
    const id = setTimeout(() => {
      setFilters((f) => {
        const trimmed = search.trim();
        if ((f.q ?? '') === trimmed) return f;
        return { ...f, q: trimmed || undefined };
      });
    }, 250);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    listClients()
      .then((r) => setClients(r.clients))
      .catch(() => {
        // Non-fatal — directory still renders without the client filter.
      });
  }, []);

  useEffect(() => {
    setRows(null);
    setError(null);
    listDirectory(filters)
      .then((r) => setRows(r.associates))
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Failed to load.'));
  }, [filters]);

  const stats = useMemo(() => {
    if (!rows) return null;
    const byStatus: Record<DirectoryStatus, number> = {
      ACTIVE: 0,
      PENDING: 0,
      INACTIVE: 0,
    };
    for (const r of rows) byStatus[r.status] += 1;
    return { total: rows.length, ...byStatus };
  }, [rows]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="People directory"
        subtitle="Every associate Alto HR knows about — active, pending onboarding, and inactive — with workplace, pay, and contact in one row."
        breadcrumbs={[{ label: 'Workforce' }, { label: 'People' }]}
      />

      {/* KPI strip */}
      {stats && (
        <Card>
          <CardContent className="flex flex-wrap gap-x-6 gap-y-2 py-3">
            <Kpi label="Total" value={stats.total} />
            <Kpi label="Active" value={stats.ACTIVE} tone="text-success" />
            <Kpi
              label="Pending onboarding"
              value={stats.PENDING}
              tone={stats.PENDING > 0 ? 'text-warning' : 'text-silver'}
            />
            <Kpi label="Inactive" value={stats.INACTIVE} tone="text-silver" />
          </CardContent>
        </Card>
      )}

      {/* Filter row */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 py-3">
          <div className="flex-1 min-w-[220px]">
            <label className="text-[10px] uppercase tracking-wider text-silver">
              Search
            </label>
            <div className="relative mt-1">
              <Search className="h-3.5 w-3.5 text-silver/50 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Name or email"
                className="pl-8 pr-8"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-silver/60 hover:text-white"
                  aria-label="Clear search"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
          <FilterPicker
            label="Status"
            value={filters.status ?? ''}
            onChange={(v) =>
              setFilters((f) => ({
                ...f,
                status: (v || undefined) as DirectoryStatus | undefined,
              }))
            }
            options={[
              { value: '', label: 'All' },
              { value: 'ACTIVE', label: 'Active' },
              { value: 'PENDING', label: 'Pending' },
              { value: 'INACTIVE', label: 'Inactive' },
            ]}
          />
          <FilterPicker
            label="Workplace"
            value={filters.clientId ?? ''}
            onChange={(v) =>
              setFilters((f) => ({ ...f, clientId: v || undefined }))
            }
            options={[
              { value: '', label: 'All' },
              ...clients.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
          <FilterPicker
            label="Employment type"
            value={filters.employmentType ?? ''}
            onChange={(v) =>
              setFilters((f) => ({
                ...f,
                employmentType: (v || undefined) as DirectoryFilters['employmentType'],
              }))
            }
            options={[
              { value: '', label: 'All' },
              { value: 'W2_EMPLOYEE', label: 'W-2' },
              { value: 'CONTRACTOR_1099_INDIVIDUAL', label: '1099 Individual' },
              { value: 'CONTRACTOR_1099_BUSINESS', label: '1099 Business' },
            ]}
          />
        </CardContent>
      </Card>

      {error && (
        <div className="text-sm text-alert" role="alert">
          {error}
        </div>
      )}

      {!rows && !error && <SkeletonRows count={8} rowHeight="h-14" />}

      {rows && rows.length === 0 && (
        <EmptyState
          icon={Users}
          title={
            filters.q || filters.status || filters.clientId || filters.employmentType
              ? 'No associates match these filters'
              : 'No associates yet'
          }
          description={
            filters.q || filters.status || filters.clientId || filters.employmentType
              ? 'Loosen a filter or clear the search.'
              : 'Once you invite associates through onboarding they show up here.'
          }
        />
      )}

      {rows && rows.length > 0 && (
        <>
          {/* md+ : columnar table. Columns reveal progressively as
              viewport widens (md: Position, lg: Type + Pay, xl: Manager
              + Start). */}
          <Card className="overflow-hidden hidden md:block">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Associate</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead>Workplace</TableHead>
                  <TableHead className="hidden md:table-cell">Position</TableHead>
                  <TableHead className="hidden lg:table-cell w-24">Type</TableHead>
                  <TableHead className="hidden lg:table-cell">Pay rate</TableHead>
                  <TableHead className="hidden xl:table-cell">Manager</TableHead>
                  <TableHead className="hidden xl:table-cell w-24">Start</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer"
                    onClick={() => setTarget(r)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2.5">
                        <Avatar
                          src={r.photoUrl}
                          name={`${r.firstName} ${r.lastName}`}
                          email={r.email}
                          size="sm"
                        />
                        <div className="min-w-0">
                          <div className="font-medium text-white truncate">
                            {r.firstName} {r.lastName}
                          </div>
                          <div className="text-xs text-silver truncate">
                            {r.email}
                          </div>
                        </div>
                        {r.j1Status && (
                          <Badge variant="default" className="ml-1 text-[10px]">
                            J-1
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant={STATUS_VARIANT[r.status]}>
                          {STATUS_LABEL[r.status]}
                        </Badge>
                        {r.status === 'PENDING' &&
                          r.onboardingPercent !== null && (
                            <span className="text-[10px] tabular-nums text-silver">
                              {r.onboardingPercent}%
                            </span>
                          )}
                      </div>
                    </TableCell>
                    <TableCell className="text-silver">
                      {r.workplaceClientId && r.workplaceClientName ? (
                        <Link
                          to={`/clients/${r.workplaceClientId}`}
                          onClick={(e) => e.stopPropagation()}
                          className="hover:text-white inline-flex items-center gap-1.5"
                        >
                          <Building2 className="h-3.5 w-3.5" />
                          <span className="truncate">
                            {r.workplaceClientName}
                          </span>
                        </Link>
                      ) : (
                        <span className="text-silver/40">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-silver">
                      {r.position ?? <span className="text-silver/40">—</span>}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-silver">
                      {EMPLOYMENT_LABEL[r.employmentType] ?? r.employmentType}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-silver tabular-nums">
                      {fmtPay(r.payAmount, r.payType, r.payCurrency)}
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-silver">
                      {r.managerName ?? (
                        <span className="text-silver/40">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-silver text-xs tabular-nums">
                      {r.startDate ?? <span className="text-silver/40">—</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {/* Phone: card stack. Tap card → drawer (same as table click). */}
          <ul className="md:hidden space-y-2">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setTarget(r)}
                  className="w-full text-left rounded-md border border-navy-secondary bg-navy/40 p-3 hover:border-silver/40 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                >
                  <div className="flex items-start gap-2.5">
                    <Avatar
                      src={r.photoUrl}
                      name={`${r.firstName} ${r.lastName}`}
                      email={r.email}
                      size="sm"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-medium text-white truncate">
                          {r.firstName} {r.lastName}
                        </div>
                        <Badge
                          variant={STATUS_VARIANT[r.status]}
                          className="shrink-0"
                        >
                          {STATUS_LABEL[r.status]}
                        </Badge>
                      </div>
                      <div className="text-xs text-silver truncate">
                        {r.email}
                      </div>
                      {(r.workplaceClientName || r.position) && (
                        <div className="mt-1 text-[11px] text-silver/80 truncate">
                          {r.workplaceClientName && (
                            <span className="inline-flex items-center gap-1">
                              <Building2 className="h-3 w-3" />
                              {r.workplaceClientName}
                            </span>
                          )}
                          {r.workplaceClientName && r.position && (
                            <span className="mx-1.5 text-silver/40">·</span>
                          )}
                          {r.position}
                        </div>
                      )}
                      {r.status === 'PENDING' &&
                        r.onboardingPercent !== null && (
                          <div className="mt-1 text-[10px] tabular-nums text-silver">
                            Onboarding {r.onboardingPercent}%
                          </div>
                        )}
                      {r.j1Status && (
                        <Badge
                          variant="default"
                          className="mt-1.5 text-[10px]"
                        >
                          J-1
                        </Badge>
                      )}
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <Drawer
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        width="max-w-2xl"
      >
        {target && (
          <DirectoryDrawer associate={target} onClose={() => setTarget(null)} />
        )}
      </Drawer>
    </div>
  );
}

function Kpi({
  label,
  value,
  tone = 'text-white',
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div className="min-w-[7rem]">
      <div className="text-[10px] uppercase tracking-wider text-silver">{label}</div>
      <div className={cn('text-2xl font-semibold tabular-nums', tone)}>{value}</div>
    </div>
  );
}

function FilterPicker({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="min-w-[150px]">
      <label className="text-[10px] uppercase tracking-wider text-silver">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full h-10 px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function DirectoryDrawer({
  associate: a,
  onClose,
}: {
  associate: DirectoryEntry;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'profile' | 'compensation' | 'documents'>(
    'profile',
  );
  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar src={a.photoUrl} name={`${a.firstName} ${a.lastName}`} email={a.email} size="md" />
          <div className="min-w-0">
            <DrawerTitle className="truncate">
              {a.firstName} {a.lastName}
            </DrawerTitle>
            <DrawerDescription className="truncate flex items-center gap-2">
              <Badge variant={STATUS_VARIANT[a.status]} className="text-[10px]">
                {STATUS_LABEL[a.status]}
              </Badge>
              <span>{EMPLOYMENT_LABEL[a.employmentType] ?? a.employmentType}</span>
              {a.j1Status && <Badge variant="default">J-1</Badge>}
            </DrawerDescription>
          </div>
        </div>
      </DrawerHeader>
      <DrawerBody>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="profile">Profile</TabsTrigger>
            <TabsTrigger value="compensation">Compensation</TabsTrigger>
            <TabsTrigger value="documents">Documents</TabsTrigger>
          </TabsList>

          <TabsContent value="profile">
            <ProfileTab associate={a} />
          </TabsContent>
          <TabsContent value="compensation">
            <CompensationTab associate={a} />
          </TabsContent>
          <TabsContent value="documents">
            <DocumentsTab associateId={a.id} />
          </TabsContent>
        </Tabs>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Link
          to={`/org`}
          className="text-xs px-3 py-2 rounded bg-navy-secondary/60 text-silver hover:text-white border border-navy-secondary"
        >
          Edit org assignment
        </Link>
      </DrawerFooter>
    </>
  );
}

function ProfileTab({ associate: a }: { associate: DirectoryEntry }) {
  return (
    <div className="space-y-4">
      <Section title="Contact">
        <Field
          icon={<Mail className="h-3.5 w-3.5" />}
          label="Email"
          value={
            <a
              href={`mailto:${a.email}`}
              className="text-gold hover:text-gold-bright"
            >
              {a.email}
            </a>
          }
        />
        <Field
          icon={<Phone className="h-3.5 w-3.5" />}
          label="Phone"
          value={
            a.phone ? (
              <a href={`tel:${a.phone}`} className="hover:text-white">
                {a.phone}
              </a>
            ) : (
              '—'
            )
          }
        />
      </Section>

      <Section title="Workplace">
        <Field
          icon={<Building2 className="h-3.5 w-3.5" />}
          label="Client"
          value={
            a.workplaceClientId && a.workplaceClientName ? (
              <Link
                to={`/clients/${a.workplaceClientId}`}
                className="text-gold hover:text-gold-bright"
              >
                {a.workplaceClientName}
              </Link>
            ) : (
              '—'
            )
          }
        />
        <Field
          icon={<Briefcase className="h-3.5 w-3.5" />}
          label="Position"
          value={a.position ?? '—'}
        />
        <Field label="Start date" value={a.startDate ?? '—'} />
        {a.status === 'PENDING' && a.onboardingPercent !== null && (
          <Field
            label="Onboarding"
            value={
              <div className="flex items-center gap-2">
                <div className="flex-1 h-2 rounded bg-navy-secondary/60 overflow-hidden max-w-[160px]">
                  <div
                    className="h-full bg-warning"
                    style={{ width: `${a.onboardingPercent}%` }}
                  />
                </div>
                <span className="text-xs tabular-nums text-silver">
                  {a.onboardingPercent}%
                </span>
              </div>
            }
          />
        )}
      </Section>

      <Section title="Org assignment">
        <Field label="Manager" value={a.managerName ?? '—'} />
        <Field label="Department" value={a.departmentName ?? '—'} />
        <Field label="Job profile" value={a.jobProfileTitle ?? '—'} />
      </Section>

      <Section title="On record">
        <Field
          label="In Alto HR since"
          value={new Date(a.createdAt).toLocaleDateString()}
        />
      </Section>
    </div>
  );
}

const REASON_LABEL: Record<CompChangeReason, string> = {
  HIRE: 'Hire',
  MERIT: 'Merit',
  PROMOTION: 'Promotion',
  MARKET_ADJUSTMENT: 'Market adjustment',
  CORRECTION: 'Correction',
  OTHER: 'Other',
};

function CompensationTab({ associate: a }: { associate: DirectoryEntry }) {
  const [records, setRecords] = useState<CompRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setRecords(null);
    setError(null);
    listRecords(a.id)
      .then((r) => {
        if (cancelled) return;
        // Newest first — server sorts ASC by effectiveFrom; we flip for display.
        setRecords([...r.records].reverse());
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Failed to load.');
      });
    return () => {
      cancelled = true;
    };
  }, [a.id, reloadTick]);

  const current = records?.find((r) => r.effectiveTo === null) ?? null;

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-silver">
                Current rate
              </div>
              <div className="text-3xl font-semibold tabular-nums text-white mt-1">
                {current
                  ? fmtPay(current.amount, current.payType, current.currency)
                  : fmtPay(a.payAmount, a.payType, a.payCurrency)}
              </div>
              {current && (
                <div className="text-[11px] text-silver mt-1">
                  {REASON_LABEL[current.reason]} · effective{' '}
                  {new Date(current.effectiveFrom).toLocaleDateString()}
                </div>
              )}
            </div>
            <Button onClick={() => setEditOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />
              Set new rate
            </Button>
          </div>
        </CardContent>
      </Card>

      <div>
        <div className="text-[10px] uppercase tracking-widest text-silver/80 mb-2 border-b border-navy-secondary pb-1">
          History
        </div>
        {error && (
          <div className="text-sm text-alert" role="alert">
            {error}
          </div>
        )}
        {!records && !error && <SkeletonRows count={3} rowHeight="h-9" />}
        {records && records.length === 0 && !error && (
          <div className="text-sm text-silver py-4">
            No compensation records yet.
          </div>
        )}
        {records && records.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Effective</TableHead>
                <TableHead>Rate</TableHead>
                <TableHead>Reason</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-silver text-xs tabular-nums whitespace-nowrap">
                    {new Date(r.effectiveFrom).toLocaleDateString()}
                    {r.effectiveTo && (
                      <>
                        {' – '}
                        {new Date(r.effectiveTo).toLocaleDateString()}
                      </>
                    )}
                  </TableCell>
                  <TableCell className="text-white tabular-nums">
                    {fmtPay(r.amount, r.payType, r.currency)}
                  </TableCell>
                  <TableCell className="text-silver text-xs">
                    {REASON_LABEL[r.reason]}
                    {r.notes && (
                      <span className="block text-[10px] text-silver/60 truncate max-w-[180px]">
                        {r.notes}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <NewRateDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        associate={a}
        currentRecord={current}
        onSaved={() => {
          setEditOpen(false);
          setReloadTick((n) => n + 1);
        }}
      />
    </div>
  );
}

function NewRateDialog({
  open,
  onOpenChange,
  associate: a,
  currentRecord,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  associate: DirectoryEntry;
  currentRecord: CompRecord | null;
  onSaved: () => void;
}) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const initialPayType: PayType =
    (currentRecord?.payType as PayType | undefined) ??
    (a.payType === 'SALARY' ? 'SALARY' : 'HOURLY');

  const [payType, setPayType] = useState<PayType>(initialPayType);
  const [amount, setAmount] = useState<string>(
    currentRecord?.amount ?? a.payAmount ?? '',
  );
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [reason, setReason] = useState<CompChangeReason>('MERIT');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Reset whenever dialog opens for a different associate or current rate
  // changes — prevents stale form values bleeding across rows.
  useEffect(() => {
    if (!open) return;
    setPayType(initialPayType);
    setAmount(currentRecord?.amount ?? a.payAmount ?? '');
    setEffectiveFrom(today);
    setReason('MERIT');
    setNotes('');
    setSubmitting(false);
  }, [open, a.id, currentRecord?.id, initialPayType, today, currentRecord, a.payAmount]);

  const amountNum = Number(amount);
  const valid =
    Number.isFinite(amountNum) && amountNum > 0 && effectiveFrom.length === 10;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      await createRecord(a.id, {
        payType,
        amount: amountNum,
        reason,
        notes: notes.trim() || undefined,
        effectiveFrom,
      });
      toast.success('Rate updated');
      onSaved();
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not save.';
      toast.error(msg);
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set new rate</DialogTitle>
          <DialogDescription>
            {a.firstName} {a.lastName}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Pay type</Label>
              <div className="mt-1 flex gap-2">
                <PayTypeOption
                  active={payType === 'HOURLY'}
                  onClick={() => setPayType('HOURLY')}
                  label="Hourly"
                />
                <PayTypeOption
                  active={payType === 'SALARY'}
                  onClick={() => setPayType('SALARY')}
                  label="Salary"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="rate-amount">
                Amount{payType === 'HOURLY' ? ' / hour' : ' / year'}
              </Label>
              <Input
                id="rate-amount"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder={payType === 'HOURLY' ? '24.50' : '65000'}
                required
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="rate-effective">Effective from</Label>
              <Input
                id="rate-effective"
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
                required
              />
            </div>
            <div>
              <Label htmlFor="rate-reason">Reason</Label>
              <select
                id="rate-reason"
                value={reason}
                onChange={(e) =>
                  setReason(e.target.value as CompChangeReason)
                }
                className="mt-1 w-full h-10 px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
              >
                <option value="HIRE">Hire</option>
                <option value="MERIT">Merit</option>
                <option value="PROMOTION">Promotion</option>
                <option value="MARKET_ADJUSTMENT">Market adjustment</option>
                <option value="CORRECTION">Correction</option>
                <option value="OTHER">Other</option>
              </select>
            </div>
          </div>

          <div>
            <Label htmlFor="rate-notes">Notes (optional)</Label>
            <textarea
              id="rate-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={500}
              className="mt-1 w-full px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
              placeholder="Context for the change (visible in history)"
            />
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!valid || submitting}>
              {submitting ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PayTypeOption({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex-1 h-10 rounded-md border text-sm transition-colors',
        active
          ? 'border-gold bg-gold/10 text-white'
          : 'border-navy-secondary bg-navy-secondary/40 text-silver hover:text-white',
      )}
      aria-pressed={active}
    >
      {label}
    </button>
  );
}

const DOCUMENT_KIND_LABEL: Record<string, string> = {
  ID: 'ID',
  SSN_CARD: 'SSN card',
  I9_SUPPORTING: 'I-9 supporting',
  W4_PDF: 'W-4',
  OFFER_LETTER: 'Offer letter',
  POLICY: 'Policy',
  HOUSING_AGREEMENT: 'Housing agreement',
  TRANSPORT_AGREEMENT: 'Transport agreement',
  J1_DS2019: 'DS-2019',
  J1_VISA: 'J-1 visa',
  SIGNED_AGREEMENT: 'Signed agreement',
  OTHER: 'Other',
};

const DOC_STATUS_VARIANT: Record<
  DocumentRecord['status'],
  'success' | 'pending' | 'default'
> = {
  VERIFIED: 'success',
  UPLOADED: 'pending',
  REJECTED: 'default',
  EXPIRED: 'default',
};

function DocumentsTab({ associateId }: { associateId: string }) {
  const [docs, setDocs] = useState<DocumentRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDocs(null);
    setError(null);
    listAdminDocuments({ associateId })
      .then((r) => {
        if (cancelled) return;
        setDocs(r.documents);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Failed to load.');
      });
    return () => {
      cancelled = true;
    };
  }, [associateId]);

  if (error) {
    return (
      <div className="text-sm text-alert" role="alert">
        {error}
      </div>
    );
  }
  if (!docs) {
    return <SkeletonRows count={3} rowHeight="h-9" />;
  }
  if (docs.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="No documents on file"
        description="Documents the associate uploads or HR verifies will appear here."
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Document</TableHead>
          <TableHead className="w-28">Status</TableHead>
          <TableHead className="hidden sm:table-cell">Uploaded</TableHead>
          <TableHead className="w-12" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {docs.map((d) => (
          <TableRow key={d.id}>
            <TableCell>
              <div className="font-medium text-white text-sm">
                {DOCUMENT_KIND_LABEL[d.kind] ?? d.kind}
              </div>
              <div className="text-[10px] text-silver truncate max-w-[220px]">
                {d.filename}
              </div>
            </TableCell>
            <TableCell>
              <Badge variant={DOC_STATUS_VARIANT[d.status]}>
                {d.status.charAt(0) + d.status.slice(1).toLowerCase()}
              </Badge>
            </TableCell>
            <TableCell className="hidden sm:table-cell text-xs text-silver tabular-nums">
              {new Date(d.createdAt).toLocaleDateString()}
            </TableCell>
            <TableCell>
              <a
                href={downloadDocumentUrl(d.id)}
                download
                className="inline-grid place-items-center h-8 w-8 rounded text-silver hover:text-white hover:bg-navy-secondary/60"
                aria-label={`Download ${d.filename}`}
              >
                <Download className="h-4 w-4" />
              </a>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-silver/80 mb-2 border-b border-navy-secondary pb-1">
        {title}
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Field({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <div className="w-32 text-silver text-xs flex items-center gap-1.5 pt-0.5">
        {icon}
        <span>{label}</span>
      </div>
      <div className="flex-1 min-w-0 text-white">{value}</div>
    </div>
  );
}
