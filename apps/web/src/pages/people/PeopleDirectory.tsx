import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Briefcase,
  Building2,
  Mail,
  Phone,
  Search,
  Users,
  X,
} from 'lucide-react';
import type { DirectoryEntry, DirectoryStatus } from '@alto-people/shared';
import { listDirectory, type DirectoryFilters } from '@/lib/directoryApi';
import { listClients } from '@/lib/clientsApi';
import type { ClientListItem } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import {
  Avatar,
  Badge,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerDescription,
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
  Button,
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
        <Card className="overflow-hidden">
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
                      {r.status === 'PENDING' && r.onboardingPercent !== null && (
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
                        <span className="truncate">{r.workplaceClientName}</span>
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
                    {r.managerName ?? <span className="text-silver/40">—</span>}
                  </TableCell>
                  <TableCell className="hidden xl:table-cell text-silver text-xs tabular-nums">
                    {r.startDate ?? <span className="text-silver/40">—</span>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Drawer
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        width="max-w-lg"
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
  return (
    <>
      <DrawerHeader>
        <div className="flex items-center gap-3">
          <Avatar name={`${a.firstName} ${a.lastName}`} email={a.email} size="md" />
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
        <div className="space-y-4">
          {/* Contact */}
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

          <Section title="Compensation">
            <Field
              label="Pay rate"
              value={fmtPay(a.payAmount, a.payType, a.payCurrency)}
            />
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
