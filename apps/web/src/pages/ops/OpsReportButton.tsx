import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, FileBarChart2, Mail } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ApiError } from '@/lib/api';
import {
  emailOpsReport,
  listOpsReportRecipients,
  opsReportUrl,
  type OpsReportPreset,
} from '@/lib/opsApi';
import { fmtDayKey, opsToday, shiftDayKey } from './opsTime';

/**
 * The Store Operations Report — the document a store manager takes into
 * planning. One store (or every store), yesterday / last week / any range,
 * as a download or emailed to the store's own portal accounts with a note.
 * The API renders the same PDF either way; this dialog only decides whom
 * and when.
 */

export type ReportStore = { id: string; name: string };

/** yesterday | last-week (the completed Sat–Fri org week) | last-7 → day keys. */
export function reportRange(preset: OpsReportPreset, today: string): { from: string; to: string } | null {
  const yesterday = shiftDayKey(today, -1);
  if (preset === 'yesterday') return { from: yesterday, to: yesterday };
  if (preset === 'last-7') return { from: shiftDayKey(yesterday, -6), to: yesterday };
  if (preset === 'last-week') {
    const weekday = new Date(`${today}T12:00:00.000Z`).getUTCDay();
    const back = (weekday + 7 - 5) % 7 || 7;
    const to = shiftDayKey(today, -back);
    return { from: shiftDayKey(to, -6), to };
  }
  return null;
}

const PRESETS: { value: OpsReportPreset; label: string }[] = [
  { value: 'last-week', label: 'Last week (Sat–Fri)' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last-7', label: 'Last 7 days' },
  { value: 'custom', label: 'Custom range' },
];

export function OpsReportButton({
  stores,
  storeId,
  size = 'sm',
}: {
  stores: ReportStore[];
  /** The board's current store filter, preselected. */
  storeId?: string;
  size?: 'xs' | 'sm';
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" size={size} onClick={() => setOpen(true)}>
        <FileBarChart2 className="mr-1.5 h-4 w-4" aria-hidden="true" />
        Store report
      </Button>
      {open && <OpsReportDialog stores={stores} initialStoreId={storeId ?? ''} onClose={() => setOpen(false)} />}
    </>
  );
}

function OpsReportDialog({
  stores,
  initialStoreId,
  onClose,
}: {
  stores: ReportStore[];
  initialStoreId: string;
  onClose: () => void;
}) {
  const today = opsToday();
  const [storeId, setStoreId] = useState(initialStoreId);
  const [preset, setPreset] = useState<OpsReportPreset>('last-week');
  const initial = reportRange('last-week', today)!;
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [extraEmail, setExtraEmail] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const r = reportRange(preset, today);
    if (r) {
      setFrom(r.from);
      setTo(r.to);
    }
  }, [preset, today]);

  const recipientsQuery = useQuery({
    queryKey: ['ops', 'report', 'recipients', storeId],
    queryFn: () => listOpsReportRecipients({ locationId: storeId || undefined }),
  });
  const recipients = useMemo(() => recipientsQuery.data?.recipients ?? [], [recipientsQuery.data]);
  // Every store account is ticked by default; the market account is not.
  useEffect(() => {
    setChosen(new Set(recipients.filter((r) => r.scope === 'store').map((r) => r.userId)));
  }, [recipients]);

  const storeName = stores.find((s) => s.id === storeId)?.name ?? null;
  const rangeOk = /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to) && from <= to;
  const href = rangeOk ? opsReportUrl({ locationId: storeId || undefined, from, to }) : '#';
  const extra = extraEmail.trim();
  const canEmail = rangeOk && (chosen.size > 0 || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(extra)) && !sending;

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!canEmail) return;
    setSending(true);
    try {
      const res = await emailOpsReport({
        locationId: storeId || undefined,
        from,
        to,
        recipientUserIds: [...chosen],
        extraEmails: extra ? [extra] : undefined,
        note: note.trim() || undefined,
      });
      toast.success(`Report sent to ${res.sent} recipient${res.sent === 1 ? '' : 's'}.`, { description: res.filename });
      onClose();
    } catch (err) {
      toast.error('Could not send the report.', { description: err instanceof ApiError ? err.message : undefined });
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Store Operations Report</DialogTitle>
          <DialogDescription>
            The figures against the prior period, food safety, production, exceptions, photos and a plan for next week — as a PDF, downloaded or emailed to the store.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={send} className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Store">
              {(p) => (
                <Select value={storeId} onChange={(e) => setStoreId(e.target.value)} {...p}>
                  <option value="">Every store</option>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Period">
              {(p) => (
                <Select value={preset} onChange={(e) => setPreset(e.target.value as OpsReportPreset)} {...p}>
                  {PRESETS.map((x) => (
                    <option key={x.value} value={x.value}>
                      {x.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {preset === 'custom' && (
              <>
                <Field label="From">
                  {(p) => <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} {...p} />}
                </Field>
                <Field label="To">
                  {(p) => <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} {...p} />}
                </Field>
              </>
            )}
          </div>
          <p className="text-xs text-silver/80" data-testid="report-range">
            {storeName ?? 'Every store'} · {rangeOk ? (from === to ? fmtDayKey(from) : `${fmtDayKey(from)} – ${fmtDayKey(to)}`) : 'pick both dates'}
          </p>

          <fieldset className="space-y-2">
            <legend className="text-xs font-medium uppercase tracking-wider text-silver/70">Email to</legend>
            {recipientsQuery.isPending ? (
              <p className="text-xs text-silver/70">Loading the store’s accounts…</p>
            ) : recipients.length === 0 ? (
              <p className="text-xs text-silver/70">
                {storeId ? 'This store has no portal account yet — add an address below.' : 'Pick a store to see its accounts, or add an address below.'}
              </p>
            ) : (
              <ul className="space-y-1.5">
                {recipients.map((r) => (
                  <li key={r.userId}>
                    <label className="flex items-center gap-2 text-sm text-white">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-gold"
                        checked={chosen.has(r.userId)}
                        onChange={(e) =>
                          setChosen((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(r.userId);
                            else next.delete(r.userId);
                            return next;
                          })
                        }
                      />
                      <span>{r.name}</span>
                      <span className="text-xs text-silver/70">
                        {r.email} · {r.scope === 'store' ? 'store' : 'market'}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <Field label="Another address" hint="Optional — someone without a portal account.">
              {(p) => (
                <Input type="email" value={extraEmail} onChange={(e) => setExtraEmail(e.target.value)} placeholder="name@store.com" {...p} />
              )}
            </Field>
            <Field label="Note" hint="A line at the top of the email, in your words.">
              {(p) => <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Here is last week — let’s talk Tuesday." {...p} />}
            </Field>
          </fieldset>

          <DialogFooter className="gap-2">
            <Button asChild variant="outline" disabled={!rangeOk}>
              <a href={href} download data-testid="report-download">
                <Download className="mr-1.5 h-4 w-4" aria-hidden="true" />
                Download PDF
              </a>
            </Button>
            <Button type="submit" disabled={!canEmail} loading={sending}>
              <Mail className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Email report
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
