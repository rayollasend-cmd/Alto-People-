import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Download, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  createHoliday,
  deleteHoliday,
  importUsFederalHolidays2026,
  listHolidays,
  type HolidayRow,
  type HolidayType,
} from '@/lib/holiday117Api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
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
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

const TYPE_VARIANT: Record<
  HolidayType,
  'success' | 'pending' | 'outline' | 'accent'
> = {
  FEDERAL: 'pending',
  STATE: 'accent',
  COMPANY: 'success',
  CLIENT_SPECIFIC: 'outline',
};

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

export function HolidaysHome() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canManage = user ? hasCapability(user.role, 'manage:scheduling') : false;
  const [year, setYear] = useState(new Date().getFullYear());
  const [rows, setRows] = useState<HolidayRow[] | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setRows(null);
    listHolidays({ year })
      .then((r) => setRows(r.holidays))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, [year]);

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

  return (
    <div className="space-y-5">
      <PageHeader
        title="Holiday calendar"
        subtitle="Federal, state, company, and client-specific holidays. Pay multipliers and shift planning use this list."
        breadcrumbs={[{ label: 'Time & Pay' }, { label: 'Holidays' }]}
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setYear((y) => y - 1)}>
            ← {year - 1}
          </Button>
          <div className="text-lg font-semibold text-white px-2">{year}</div>
          <Button size="sm" variant="ghost" onClick={() => setYear((y) => y + 1)}>
            {year + 1} →
          </Button>
        </div>
        {canManage && (
          <div className="flex gap-2">
            {year === 2026 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  try {
                    const r = await importUsFederalHolidays2026();
                    toast.success(
                      `Imported ${r.inserted}, skipped ${r.skipped} duplicates.`,
                    );
                    refresh();
                  } catch (err) {
                    toast.error(err instanceof ApiError ? err.message : 'Failed.');
                  }
                }}
              >
                <Download className="mr-1 h-3 w-3" /> Import US federal
              </Button>
            )}
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> New holiday
            </Button>
          </div>
        )}
      </div>

      {grouped === null ? (
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
                canManage
                  ? 'Add company holidays manually or import the US federal calendar.'
                  : 'Ask HR to set up the calendar for this year.'
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
                        className="px-4 py-3 flex items-center gap-3 group"
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
                                ? `STATE — ${h.state}`
                                : h.type}
                            </Badge>
                            {h.scope === 'client' && h.clientName && (
                              <span>· {h.clientName}</span>
                            )}
                            {!h.paid && (
                              <span className="text-amber-400">Unpaid</span>
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
                            onClick={async () => {
                              if (!(await confirm({ title: `Delete ${h.name}?`, destructive: true }))) return;
                              try {
                                await deleteHoliday(h.id);
                                refresh();
                              } catch (err) {
                                toast.error(
                                  err instanceof ApiError
                                    ? err.message
                                    : 'Failed.',
                                );
                              }
                            }}
                            className="opacity-60 group-hover:opacity-100 text-silver hover:text-destructive transition"
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
          defaultYear={year}
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewHolidayDrawer({
  defaultYear,
  onClose,
  onSaved,
}: {
  defaultYear: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [date, setDate] = useState(`${defaultYear}-01-01`);
  const [type, setType] = useState<HolidayType>('COMPANY');
  const [state, setState] = useState('');
  const [clientId, setClientId] = useState('');
  const [paid, setPaid] = useState(true);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) {
      toast.error('Name required.');
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
        state: type === 'STATE' ? state.trim().toUpperCase() : null,
        paid,
        notes: notes.trim() || null,
      });
      toast.success('Holiday created.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
            <Label>Type</Label>
            <select
              className="mt-1 w-full bg-midnight border border-navy-secondary rounded p-2 text-white text-sm"
              value={type}
              onChange={(e) => setType(e.target.value as HolidayType)}
            >
              <option value="COMPANY">Company-wide</option>
              <option value="FEDERAL">Federal</option>
              <option value="STATE">State</option>
              <option value="CLIENT_SPECIFIC">Client-specific</option>
            </select>
          </div>
        </div>
        {type === 'STATE' && (
          <div>
            <Label>State (2-letter)</Label>
            <Input
              className="mt-1 uppercase"
              maxLength={2}
              value={state}
              onChange={(e) => setState(e.target.value)}
              placeholder="CA"
            />
          </div>
        )}
        {type === 'CLIENT_SPECIFIC' && (
          <div>
            <Label>Client ID</Label>
            <Input
              className="mt-1 font-mono text-xs"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
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
          <textarea
            className="mt-1 w-full h-20 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
