import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, Download, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  createHoliday,
  deleteHoliday,
  importUsFederal,
  listHolidays,
  updateHoliday,
  type HolidayRow,
  type HolidayType,
} from '@/lib/holiday117Api';
import { useClients } from '@/lib/useClients';
import type { ClientListItem } from '@alto-people/shared';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
import { fmtDate, parseYmd, ymdLocal } from '@/lib/format';
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
  FilterChip,
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

const TYPE_VARIANT: Record<
  HolidayType,
  'success' | 'info' | 'outline' | 'accent'
> = {
  FEDERAL: 'info',
  STATE: 'accent',
  COMPANY: 'success',
  CLIENT_SPECIFIC: 'outline',
};

const TYPE_LABELS: Record<HolidayType, string> = {
  FEDERAL: 'Federal',
  STATE: 'State',
  COMPANY: 'Company',
  CLIENT_SPECIFIC: 'Client-specific',
};

const TYPE_FILTERS: { key: HolidayType | 'ALL'; label: string }[] = [
  { key: 'ALL', label: 'All types' },
  { key: 'FEDERAL', label: 'Federal' },
  { key: 'STATE', label: 'State' },
  { key: 'COMPANY', label: 'Company' },
  { key: 'CLIENT_SPECIFIC', label: 'Client-specific' },
];

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const US_STATES: { code: string; name: string }[] = [
  { code: 'AL', name: 'Alabama' },
  { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },
  { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'DE', name: 'Delaware' },
  { code: 'FL', name: 'Florida' },
  { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },
  { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },
  { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },
  { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },
  { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'WY', name: 'Wyoming' },
];

function StateSelect({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: string;
  onChange: (code: string) => void;
}) {
  return (
    <Select
      id={id}
      className="mt-1"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">Select a state…</option>
      {US_STATES.map((s) => (
        <option key={s.code} value={s.code}>
          {s.name}
        </option>
      ))}
    </Select>
  );
}

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_OPTIONS = [
  CURRENT_YEAR - 1,
  CURRENT_YEAR,
  CURRENT_YEAR + 1,
  CURRENT_YEAR + 2,
  CURRENT_YEAR + 3,
];

export function HolidaysHome() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canManage = user ? hasCapability(user.role, 'manage:scheduling') : false;
  // Client-bound roles (SHIFT_SUPERVISOR) can't list clients — /clients
  // 403s for them. Seed the chips/drawers with their one client so the
  // filter and CLIENT_SPECIFIC holidays still work.
  const boundedClient = useMemo(
    () =>
      user?.clientId
        ? { id: user.clientId, name: user.clientName ?? 'Your client' }
        : null,
    [user?.clientId, user?.clientName],
  );
  const [year, setYear] = useState(CURRENT_YEAR);
  const [typeFilter, setTypeFilter] = useState<HolidayType | 'ALL'>('ALL');
  const [clientFilter, setClientFilter] = useState<string>('ALL');
  const [rows, setRows] = useState<HolidayRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Best-effort client list for the filter chips — a failure (or a role
  // without client access) just leaves the chips hidden. Client-bound
  // viewers are seeded with their one client and never fetch (the
  // endpoint would 403). Served from the app-wide react-query cache.
  const { clients: fetchedClients } = useClients({ enabled: !boundedClient });
  const clients = useMemo<Array<Pick<ClientListItem, 'id' | 'name'>>>(
    () => (boundedClient ? [boundedClient] : fetchedClients),
    [boundedClient, fetchedClients],
  );
  const [showNew, setShowNew] = useState(false);
  const [editing, setEditing] = useState<HolidayRow | null>(null);
  const [importing, setImporting] = useState(false);

  const refresh = useCallback(() => {
    setRows(null);
    setError(null);
    listHolidays({
      year,
      type: typeFilter === 'ALL' ? undefined : typeFilter,
      clientId: clientFilter === 'ALL' ? undefined : clientFilter,
    })
      .then((r) => setRows(r.holidays))
      .catch((err) =>
        setError(
          err instanceof ApiError ? err.message : 'Could not load holidays.',
        ),
      );
  }, [year, typeFilter, clientFilter]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // One POST — the server computes floating holidays (MLK Day,
  // Thanksgiving, …) and skips rows already present.
  const importFederal = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const res = await importUsFederal({ year });
      toast.success(
        `Imported ${res.inserted}, skipped ${res.skipped} already present.`,
      );
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Import failed.');
    } finally {
      setImporting(false);
    }
  };

  const grouped = useMemo(() => {
    if (!rows) return null;
    const byMonth: Record<number, HolidayRow[]> = {};
    for (const h of rows) {
      const m = parseInt(h.date.slice(5, 7), 10) - 1;
      if (!byMonth[m]) byMonth[m] = [];
      byMonth[m].push(h);
    }
    return byMonth;
  }, [rows]);

  const stats = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    const paid = rows.filter((h) => h.paid).length;
    const weekend = rows.filter((h) => {
      const d = parseYmd(h.date);
      return d !== null && (d.getDay() === 0 || d.getDay() === 6);
    }).length;
    return { total: rows.length, paid, weekend };
  }, [rows]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Holiday calendar"
        subtitle="Federal, state, company, and client-specific holidays. Pay multipliers and shift planning use this list."
        breadcrumbs={[{ label: 'Time & Pay' }, { label: 'Holidays' }]}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Select
            value={String(year)}
            onChange={(e) => setYear(Number(e.target.value))}
            aria-label="Calendar year"
            className="w-auto"
          >
            {YEAR_OPTIONS.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
          {stats && (
            <span className="text-xs text-silver tabular-nums">
              {stats.total} holiday{stats.total === 1 ? '' : 's'} · {stats.paid}{' '}
              paid · {stats.weekend} fall on a weekend
            </span>
          )}
        </div>
        {canManage && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={importing}
              onClick={importFederal}
            >
              <Download className="mr-1 h-3 w-3" />
              {importing ? 'Importing…' : `Import US federal holidays ${year}`}
            </Button>
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> New holiday
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <div className="flex flex-wrap gap-1.5">
          {TYPE_FILTERS.map((f) => (
            <FilterChip
              key={f.key}
              active={typeFilter === f.key}
              onClick={() => setTypeFilter(f.key)}
            >
              {f.label}
            </FilterChip>
          ))}
        </div>
        {clients.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <FilterChip
              active={clientFilter === 'ALL'}
              onClick={() => setClientFilter('ALL')}
            >
              All clients
            </FilterChip>
            {clients.map((c) => (
              <FilterChip
                key={c.id}
                active={clientFilter === c.id}
                onClick={() => setClientFilter(c.id)}
              >
                {c.name}
              </FilterChip>
            ))}
          </div>
        )}
      </div>

      {error ? (
        <Card>
          <CardContent className="p-6">
            <ErrorBanner
              action={
                <Button size="sm" variant="secondary" onClick={refresh}>
                  Retry
                </Button>
              }
            >
              {error}
            </ErrorBanner>
          </CardContent>
        </Card>
      ) : grouped === null ? (
        <Card>
          <CardContent className="p-6">
            <SkeletonRows count={4} />
          </CardContent>
        </Card>
      ) : Object.keys(grouped).length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={CalendarDays}
              title={`No holidays for ${year}`}
              description={
                typeFilter !== 'ALL' || clientFilter !== 'ALL'
                  ? 'Nothing matches the current filters.'
                  : canManage
                    ? 'Add company holidays manually or import the US federal calendar.'
                    : 'Ask HR to set up the calendar for this year.'
              }
              action={
                canManage && typeFilter === 'ALL' && clientFilter === 'ALL' ? (
                  <Button onClick={() => setShowNew(true)}>
                    <Plus className="mr-2 h-4 w-4" /> New holiday
                  </Button>
                ) : undefined
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {MONTH_NAMES.map((name, idx) => {
            const items = grouped[idx];
            if (!items || items.length === 0) return null;
            return (
              <Card key={idx}>
                <CardContent className="p-0">
                  <div className="px-4 py-2 border-b border-navy-secondary text-sm uppercase tracking-wider text-silver">
                    {name}
                  </div>
                  <div className="divide-y divide-navy-secondary">
                    {items.map((h) => (
                      <div
                        key={h.id}
                        className={`px-4 py-3 flex items-center gap-3 group ${
                          canManage
                            ? 'cursor-pointer hover:bg-navy-secondary/30 transition-colors'
                            : ''
                        }`}
                        onClick={canManage ? () => setEditing(h) : undefined}
                      >
                        <div className="text-2xl font-bold text-white tabular-nums w-10 text-center">
                          {parseInt(h.date.slice(8, 10), 10)}
                        </div>
                        <div className="flex-1">
                          <div className="text-sm font-medium text-white">
                            {h.name}
                          </div>
                          <div className="text-xs text-silver flex items-center gap-2 mt-0.5">
                            <Badge variant={TYPE_VARIANT[h.type]}>
                              {h.type === 'STATE' && h.state
                                ? `State — ${h.state}`
                                : TYPE_LABELS[h.type]}
                            </Badge>
                            {h.scope === 'client' && h.clientName && (
                              <span>· {h.clientName}</span>
                            )}
                            {!h.paid && (
                              <span className="text-warning">Unpaid</span>
                            )}
                          </div>
                          {h.notes && (
                            <div className="text-xs text-silver mt-1 italic">
                              {h.notes}
                            </div>
                          )}
                        </div>
                        {canManage && (
                          <button
                            aria-label={`Delete ${h.name}`}
                            onClick={async (e) => {
                              e.stopPropagation();
                              if (!(await confirm({ title: `Delete ${h.name}?`, destructive: true }))) return;
                              try {
                                await deleteHoliday(h.id);
                                toast.success(`Deleted ${h.name}.`);
                                refresh();
                              } catch (err) {
                                toast.error(
                                  err instanceof ApiError
                                    ? err.message
                                    : 'Could not delete the holiday.',
                                );
                              }
                            }}
                            className="opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 text-silver hover:text-alert transition"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {showNew && (
        <NewHolidayDrawer
          shownYear={year}
          clients={clients}
          boundedClient={boundedClient}
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}

      {editing && (
        <EditHolidayDrawer
          holiday={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewHolidayDrawer({
  shownYear,
  clients,
  boundedClient,
  onClose,
  onSaved,
}: {
  shownYear: number;
  clients: Array<Pick<ClientListItem, 'id' | 'name'>>;
  /** Client-bound roles: CLIENT_SPECIFIC holidays are pinned to this client. */
  boundedClient?: { id: string; name: string } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  // Sensible default: today when the shown year is the current one,
  // otherwise Jan 1 of the shown year.
  const [date, setDate] = useState(() => {
    const today = ymdLocal();
    return today.slice(0, 4) === String(shownYear)
      ? today
      : `${shownYear}-01-01`;
  });
  const [type, setType] = useState<HolidayType>('COMPANY');
  const [state, setState] = useState('');
  const [clientId, setClientId] = useState(boundedClient?.id ?? '');
  const [paid, setPaid] = useState(true);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      toast.error('Name required.');
      return;
    }
    if (type === 'STATE' && !state) {
      toast.error('Pick a state.');
      return;
    }
    setSaving(true);
    try {
      await createHoliday({
        clientId:
          type === 'CLIENT_SPECIFIC' ? clientId.trim() || null : null,
        name: name.trim(),
        date,
        type,
        state: type === 'STATE' ? state : null,
        paid,
        notes: notes.trim() || null,
      });
      toast.success('Holiday created.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not create the holiday.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New holiday</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input
            className="mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Independence Day"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Date</Label>
            <Input
              type="date"
              className="mt-1"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="holiday-type">Type</Label>
            <Select
              id="holiday-type"
              className="mt-1"
              value={type}
              onChange={(e) => setType(e.target.value as HolidayType)}
            >
              <option value="COMPANY">Company-wide</option>
              <option value="FEDERAL">Federal</option>
              <option value="STATE">State</option>
              <option value="CLIENT_SPECIFIC">Client-specific</option>
            </Select>
          </div>
        </div>
        {type === 'STATE' && (
          <div>
            <Label htmlFor="holiday-state">State</Label>
            <StateSelect id="holiday-state" value={state} onChange={setState} />
          </div>
        )}
        {type === 'CLIENT_SPECIFIC' && (
          <div>
            <Label htmlFor="holiday-client">Client</Label>
            {boundedClient ? (
              // Client-bound role — pinned to their client (no org-wide option).
              <div
                id="holiday-client"
                className="mt-1 flex h-10 items-center rounded-md border border-navy-secondary bg-navy-secondary/20 px-3 text-sm text-white"
              >
                {boundedClient.name}
              </div>
            ) : (
              <Select
                id="holiday-client"
                className="mt-1"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              >
                {/* clientId is optional server-side — blank stores NULL, i.e.
                    the holiday applies org-wide despite the CLIENT_SPECIFIC type. */}
                <option value="">Org-wide (no client)</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={paid}
            onChange={(e) => setPaid(e.target.checked)}
          />
          <Label>Paid holiday</Label>
        </div>
        <div>
          <Label>Notes</Label>
          <Textarea
            className="mt-1 h-20"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} loading={saving}>
          Save
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function EditHolidayDrawer({
  holiday,
  onClose,
  onSaved,
}: {
  holiday: HolidayRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(holiday.name);
  const [state, setState] = useState(holiday.state ?? '');
  const [paid, setPaid] = useState(holiday.paid);
  const [notes, setNotes] = useState(holiday.notes ?? '');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      toast.error('Name required.');
      return;
    }
    if (holiday.type === 'STATE' && !state) {
      toast.error('Pick a state.');
      return;
    }
    setSaving(true);
    try {
      await updateHoliday(holiday.id, {
        name: name.trim(),
        paid,
        notes: notes.trim() || null,
        ...(holiday.type === 'STATE' ? { state } : {}),
      });
      toast.success('Holiday updated.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update the holiday.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Edit holiday</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input
            className="mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {/* Date and type are immutable — delete and recreate to change them. */}
        <div className="text-xs text-silver">
          {fmtDate(parseYmd(holiday.date))} ·{' '}
          <Badge variant={TYPE_VARIANT[holiday.type]}>
            {TYPE_LABELS[holiday.type]}
          </Badge>
          {holiday.scope === 'client' && holiday.clientName && (
            <span> · {holiday.clientName}</span>
          )}
        </div>
        {holiday.type === 'STATE' && (
          <div>
            <Label htmlFor="edit-holiday-state">State</Label>
            <StateSelect
              id="edit-holiday-state"
              value={state}
              onChange={setState}
            />
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            id="edit-holiday-paid"
            type="checkbox"
            checked={paid}
            onChange={(e) => setPaid(e.target.checked)}
          />
          <Label htmlFor="edit-holiday-paid">Paid holiday</Label>
        </div>
        <div>
          <Label>Notes</Label>
          <Textarea
            className="mt-1 h-20"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} loading={saving}>
          Save
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
