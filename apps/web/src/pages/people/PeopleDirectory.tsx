import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Briefcase,
  Building2,
  Check,
  Download,
  ExternalLink,
  FileText,
  Mail,
  Pencil,
  Phone,
  Plus,
  Search,
  Send,
  Upload,
  Users,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import type {
  DirectoryEntry,
  DirectoryStatus,
  DocumentKind,
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
  rejectDocument,
  uploadAdminDocument,
  verifyDocument,
} from '@/lib/documentsApi';
import { nudgeApplicant } from '@/lib/onboardingApi';
import { patchAssociateProfile } from '@/lib/orgApi';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  ConfirmDialog,
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
  Field,
  Input,
  Label,
  PageHeader,
  Select,
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
  const queryClient = useQueryClient();
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

  // Clients change rarely; cache for a long time so the filter dropdown
  // is instant on revisit. Failures are silent — the dropdown just shows
  // "All clients" without specific options.
  const { data: clients = [] as ClientListItem[] } = useQuery({
    queryKey: ['clients', 'list'],
    queryFn: async () => (await listClients()).clients,
    staleTime: 5 * 60_000,
  });

  // keepPreviousData makes filter/search changes show the old rows
  // (faded by isFetching) until the new ones arrive instead of flashing
  // a skeleton — much smoother on slow connections.
  const { data: rows, error: rowsError } = useQuery({
    queryKey: ['directory', filters],
    queryFn: async () => (await listDirectory(filters)).associates,
    placeholderData: keepPreviousData,
  });
  const error = rowsError
    ? rowsError instanceof ApiError
      ? rowsError.message
      : 'Failed to load.'
    : null;

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
          <DirectoryDrawer
            associate={target}
            onClose={() => setTarget(null)}
            onAssociateChange={(patch) => {
              const updated = { ...target, ...patch };
              setTarget(updated);
              queryClient.setQueryData<DirectoryEntry[]>(
                ['directory', filters],
                (old) =>
                  old ? old.map((r) => (r.id === updated.id ? updated : r)) : old,
              );
            }}
          />
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
  onAssociateChange,
}: {
  associate: DirectoryEntry;
  onClose: () => void;
  onAssociateChange: (patch: Partial<DirectoryEntry>) => void;
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
            <ProfileTab associate={a} onAssociateChange={onAssociateChange} />
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

function ProfileTab({
  associate: a,
  onAssociateChange,
}: {
  associate: DirectoryEntry;
  onAssociateChange: (patch: Partial<DirectoryEntry>) => void;
}) {
  return (
    <div className="space-y-4">
      <Section title="Contact">
        <InfoRow
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
        <PhoneField
          associate={a}
          onSaved={(phone) => onAssociateChange({ phone })}
        />
      </Section>

      <Section title="Workplace">
        <InfoRow
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
        <InfoRow
          icon={<Briefcase className="h-3.5 w-3.5" />}
          label="Position"
          value={a.position ?? '—'}
        />
        <InfoRow label="Start date" value={a.startDate ?? '—'} />
        {a.status === 'PENDING' && a.onboardingPercent !== null && (
          <InfoRow
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

      {a.status === 'PENDING' && a.applicationId && (
        <PendingActions
          applicationId={a.applicationId}
          associateName={`${a.firstName} ${a.lastName}`}
        />
      )}

      <Section title="Org assignment">
        <InfoRow label="Manager" value={a.managerName ?? '—'} />
        <InfoRow label="Department" value={a.departmentName ?? '—'} />
        <InfoRow label="Job profile" value={a.jobProfileTitle ?? '—'} />
      </Section>

      <Section title="On record">
        <InfoRow
          label="In Alto HR since"
          value={new Date(a.createdAt).toLocaleDateString()}
        />
      </Section>
    </div>
  );
}

function PhoneField({
  associate: a,
  onSaved,
}: {
  associate: DirectoryEntry;
  onSaved: (phone: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.phone ?? '');
  const [saving, setSaving] = useState(false);

  // Reset the draft whenever the canonical phone changes (e.g. another
  // tab on this row saved it). Avoids stale text staying in the input.
  useEffect(() => {
    if (!editing) setDraft(a.phone ?? '');
  }, [a.phone, editing]);

  async function save() {
    if (saving) return;
    const trimmed = draft.trim();
    const next = trimmed.length === 0 ? null : trimmed;
    if (next === a.phone) {
      setEditing(false);
      return;
    }
    if (next !== null && next.length < 7) {
      toast.error('Phone must be at least 7 characters');
      return;
    }
    setSaving(true);
    try {
      const r = await patchAssociateProfile(a.id, { phone: next });
      onSaved(r.phone);
      toast.success('Phone updated');
      setEditing(false);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not save.';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="flex items-start gap-3 text-sm">
        <div className="w-32 text-silver text-xs flex items-center gap-1.5 pt-2">
          <Phone className="h-3.5 w-3.5" />
          <span>Phone</span>
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-1">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="555 555 0123"
            className="h-8 text-sm"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void save();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setDraft(a.phone ?? '');
                setEditing(false);
              }
            }}
          />
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            aria-label="Save phone"
            className="grid place-items-center h-8 w-8 rounded text-silver hover:text-white hover:bg-navy-secondary/60 disabled:opacity-40"
          >
            <Check className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(a.phone ?? '');
              setEditing(false);
            }}
            disabled={saving}
            aria-label="Cancel"
            className="grid place-items-center h-8 w-8 rounded text-silver hover:text-white hover:bg-navy-secondary/60 disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <InfoRow
      icon={<Phone className="h-3.5 w-3.5" />}
      label="Phone"
      value={
        <div className="flex items-center gap-2 group">
          <span className="flex-1 min-w-0">
            {a.phone ? (
              <a href={`tel:${a.phone}`} className="hover:text-white">
                {a.phone}
              </a>
            ) : (
              '—'
            )}
          </span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            aria-label="Edit phone"
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 grid place-items-center h-9 w-9 rounded text-silver hover:text-white hover:bg-navy-secondary/60 transition-opacity"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        </div>
      }
    />
  );
}

function PendingActions({
  applicationId,
  associateName,
}: {
  applicationId: string;
  associateName: string;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function sendNudge() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await nudgeApplicant(applicationId, {
        subject: 'Reminder: finish your onboarding',
        body:
          `Hi ${associateName.split(' ')[0]},\n\n` +
          'This is a friendly reminder to finish the remaining onboarding ' +
          "steps so we can get you set up. Sign back into your Alto account to pick up where you left off — it should only take a few minutes.\n\n" +
          'Thanks,\nAlto HR',
      });
      setOpen(false);
      toast.success(
        r.emailSent ? `Nudge sent to ${r.recipientEmail}` : 'Nudge logged',
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : 'Could not send.';
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Onboarding">
      <div className="flex flex-wrap gap-2">
        <Link
          to={`/onboarding/applications/${applicationId}`}
          className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded bg-navy-secondary/60 text-silver hover:text-white border border-navy-secondary"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          Open application
        </Link>
        <Button
          variant="ghost"
          onClick={() => setOpen(true)}
          className="text-xs"
        >
          <Send className="h-3.5 w-3.5 mr-1" />
          Send nudge
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Send onboarding nudge?"
        description={`Emails ${associateName} a reminder to finish their open onboarding tasks.`}
        confirmLabel={busy ? 'Sending…' : 'Send nudge'}
        busy={busy}
        onConfirm={sendNudge}
      />
    </Section>
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
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = useState(false);

  const { data: records, error: recordsError } = useQuery({
    queryKey: ['comp-records', a.id],
    // Newest first — server sorts ASC by effectiveFrom; we flip for display.
    queryFn: async () => [...(await listRecords(a.id)).records].reverse(),
  });
  const error = recordsError
    ? recordsError instanceof ApiError
      ? recordsError.message
      : 'Failed to load.'
    : null;

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
          void queryClient.invalidateQueries({
            queryKey: ['comp-records', a.id],
          });
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
            <Field
              label={`Amount${payType === 'HOURLY' ? ' / hour' : ' / year'}`}
            >
              {(p) => (
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder={payType === 'HOURLY' ? '24.50' : '65000'}
                  {...p}
                />
              )}
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Effective from">
              {(p) => (
                <Input
                  type="date"
                  value={effectiveFrom}
                  onChange={(e) => setEffectiveFrom(e.target.value)}
                  {...p}
                />
              )}
            </Field>
            <Field label="Reason">
              {(p) => (
                <Select
                  value={reason}
                  onChange={(e) =>
                    setReason(e.target.value as CompChangeReason)
                  }
                  {...p}
                >
                  <option value="HIRE">Hire</option>
                  <option value="MERIT">Merit</option>
                  <option value="PROMOTION">Promotion</option>
                  <option value="MARKET_ADJUSTMENT">Market adjustment</option>
                  <option value="CORRECTION">Correction</option>
                  <option value="OTHER">Other</option>
                </Select>
              )}
            </Field>
          </div>

          <Field label="Notes (optional)">
            {(p) => (
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                maxLength={500}
                className="w-full px-3 py-2 rounded-md bg-navy-secondary/40 border border-navy-secondary focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold text-white text-sm"
                placeholder="Context for the change (visible in history)"
                {...p}
              />
            )}
          </Field>

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
  BACKGROUND_CHECK_RESULT: 'Background check result',
  DRUG_TEST_RESULT: 'Drug test result',
  I9_VERIFICATION_RESULT: 'I-9 verification result',
  OTHER: 'Other',
};

// HR-curated result kinds available in the upload dialog. Associate-uploaded
// kinds (ID, SSN_CARD, etc.) are intentionally excluded — those come from
// the onboarding flow, not from HR.
const HR_UPLOAD_KINDS: ReadonlyArray<DocumentKind> = [
  'BACKGROUND_CHECK_RESULT',
  'DRUG_TEST_RESULT',
  'I9_VERIFICATION_RESULT',
  'OFFER_LETTER',
  'POLICY',
  'OTHER',
];

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
  const queryClient = useQueryClient();
  const [actingId, setActingId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<DocumentRecord | null>(null);
  const [showUpload, setShowUpload] = useState(false);

  const { data: docs, error: docsError } = useQuery({
    queryKey: ['associate-docs', associateId],
    queryFn: async () => (await listAdminDocuments({ associateId })).documents,
  });
  const error = docsError
    ? docsError instanceof ApiError
      ? docsError.message
      : 'Failed to load.'
    : null;

  function replaceDoc(updated: DocumentRecord) {
    queryClient.setQueryData<DocumentRecord[]>(
      ['associate-docs', associateId],
      (old) =>
        old ? old.map((d) => (d.id === updated.id ? updated : d)) : old,
    );
  }

  function prependDoc(created: DocumentRecord) {
    queryClient.setQueryData<DocumentRecord[]>(
      ['associate-docs', associateId],
      (old) => (old ? [created, ...old] : [created]),
    );
  }

  async function handleVerify(d: DocumentRecord) {
    if (actingId) return;
    setActingId(d.id);
    try {
      const updated = await verifyDocument(d.id);
      replaceDoc(updated);
      toast.success('Document verified');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not verify.');
    } finally {
      setActingId(null);
    }
  }

  async function handleReject(reason: string) {
    if (!rejectTarget || actingId) return;
    const id = rejectTarget.id;
    setActingId(id);
    try {
      const updated = await rejectDocument(id, { reason });
      replaceDoc(updated);
      toast.success('Document rejected');
      setRejectTarget(null);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not reject.');
    } finally {
      setActingId(null);
    }
  }

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

  const uploadButton = (
    <Button size="sm" variant="outline" onClick={() => setShowUpload(true)}>
      <Upload className="h-3.5 w-3.5" />
      Upload result
    </Button>
  );

  if (docs.length === 0) {
    return (
      <>
        <div className="flex items-center justify-end mb-3">{uploadButton}</div>
        <EmptyState
          icon={FileText}
          title="No documents on file"
          description="Upload background-check, drug-test, or E-Verify result PDFs here. Associate-submitted documents will also appear in this list."
        />
        <UploadResultDialog
          open={showUpload}
          onOpenChange={setShowUpload}
          associateId={associateId}
          onUploaded={prependDoc}
        />
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between mb-3">
        <div className="text-[10px] uppercase tracking-widest text-silver/80">
          {docs.length} document{docs.length === 1 ? '' : 's'}
        </div>
        {uploadButton}
      </div>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Document</TableHead>
            <TableHead className="w-28">Status</TableHead>
            <TableHead className="hidden sm:table-cell">Uploaded</TableHead>
            <TableHead className="text-right">Actions</TableHead>
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
                {d.status === 'REJECTED' && d.rejectionReason && (
                  <div className="text-[10px] text-alert mt-0.5 truncate max-w-[220px]">
                    {d.rejectionReason}
                  </div>
                )}
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
                <div className="flex justify-end items-center gap-1">
                  {d.status === 'UPLOADED' && (
                    <>
                      <button
                        type="button"
                        onClick={() => void handleVerify(d)}
                        disabled={actingId === d.id}
                        aria-label={`Verify ${d.filename}`}
                        title="Verify"
                        className="grid place-items-center h-8 w-8 rounded text-success hover:bg-navy-secondary/60 disabled:opacity-40"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setRejectTarget(d)}
                        disabled={actingId === d.id}
                        aria-label={`Reject ${d.filename}`}
                        title="Reject"
                        className="grid place-items-center h-8 w-8 rounded text-alert hover:bg-navy-secondary/60 disabled:opacity-40"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </>
                  )}
                  <a
                    href={downloadDocumentUrl(d.id)}
                    download
                    className="grid place-items-center h-8 w-8 rounded text-silver hover:text-white hover:bg-navy-secondary/60"
                    aria-label={`Download ${d.filename}`}
                    title="Download"
                  >
                    <Download className="h-4 w-4" />
                  </a>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={rejectTarget !== null}
        onOpenChange={(o) => !o && setRejectTarget(null)}
        title="Reject document"
        description={
          rejectTarget
            ? `${DOCUMENT_KIND_LABEL[rejectTarget.kind] ?? rejectTarget.kind} — ${rejectTarget.filename}`
            : ''
        }
        requireReason
        reasonLabel="Reason for rejection"
        reasonPlaceholder="What's missing or wrong with this document?"
        confirmLabel={actingId === rejectTarget?.id ? 'Rejecting…' : 'Reject'}
        destructive
        busy={actingId === rejectTarget?.id}
        onConfirm={handleReject}
      />

      <UploadResultDialog
        open={showUpload}
        onOpenChange={setShowUpload}
        associateId={associateId}
        onUploaded={prependDoc}
      />
    </>
  );
}

function UploadResultDialog({
  open,
  onOpenChange,
  associateId,
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  associateId: string;
  onUploaded: (doc: DocumentRecord) => void;
}) {
  const [kind, setKind] = useState<DocumentKind>('BACKGROUND_CHECK_RESULT');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset when the dialog reopens so a previous selection doesn't linger.
  useEffect(() => {
    if (open) {
      setKind('BACKGROUND_CHECK_RESULT');
      setFile(null);
      setBusy(false);
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file || busy) return;
    setBusy(true);
    try {
      const created = await uploadAdminDocument(file, kind, associateId);
      onUploaded(created);
      toast.success('Result uploaded');
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload result document</DialogTitle>
          <DialogDescription>
            Attach a PDF or image (background-check report, drug-test result,
            E-Verify confirmation, etc.) to this associate&apos;s profile.
            The document is marked verified on upload.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Field label="Document type">
            {(p) => (
              <Select
                value={kind}
                onChange={(e) => setKind(e.target.value as DocumentKind)}
                {...p}
              >
                {HR_UPLOAD_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {DOCUMENT_KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="File" hint="PDF, PNG, JPEG, or WebP. Max 10 MB.">
            {(p) => (
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,image/png,image/jpeg,image/webp"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-xs text-silver file:mr-3 file:rounded-md file:border-0 file:bg-navy-secondary file:px-3 file:py-2 file:text-xs file:font-medium file:text-white hover:file:bg-navy-secondary/80"
                {...p}
              />
            )}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={!file}>
              <Upload className="h-4 w-4" />
              Upload
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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

function InfoRow({
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
