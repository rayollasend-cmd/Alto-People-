import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Moon } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { getDeliveryPrefs, hhmmToMinutes, minutesToHhmm, patchDeliveryPrefs, type DeliveryMode, type DeliveryPrefs } from '@/lib/accessApi';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { SettingsSwitch } from './SettingsSwitch';

/**
 * Access pack — WHEN things reach you. Quiet hours in your own time zone
 * (nothing buzzes; what arrived waits for the morning as one message), and
 * per channel, as it happens or once an hour together. Security, formal
 * notices, safety and pay never wait.
 *
 * Everything here applies the moment it changes and says so in a toast
 * (F500 polish, 2026-10-26: one save model — this card had its own "Save
 * quiet hours" button mid-page while its selects saved at once).
 */

const CHANNELS: Array<{ key: 'deliveryEmail' | 'deliveryPush' | 'deliverySms'; label: string }> = [
  { key: 'deliveryEmail', label: 'Email' },
  { key: 'deliveryPush', label: 'Push' },
  { key: 'deliverySms', label: 'WhatsApp / SMS' },
];

export function DeliveryCard() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me', 'notification-delivery'], queryFn: getDeliveryPrefs });
  const [quietOn, setQuietOn] = useState(false);
  const [start, setStart] = useState('22:00');
  const [end, setEnd] = useState('07:00');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setQuietOn(q.data.quietHoursStart !== null);
    if (q.data.quietHoursStart !== null) setStart(minutesToHhmm(q.data.quietHoursStart));
    if (q.data.quietHoursEnd !== null) setEnd(minutesToHhmm(q.data.quietHoursEnd));
  }, [q.data]);

  const apply = async (patch: Partial<Omit<DeliveryPrefs, 'timezone'>>, ok = 'Saved.') => {
    setSaving(true);
    try {
      const saved = await patchDeliveryPrefs(patch);
      qc.setQueryData(['me', 'notification-delivery'], saved);
      toast.success(ok);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };
  const turnQuiet = (on: boolean) => {
    setQuietOn(on);
    if (!on) return void apply({ quietHoursStart: null, quietHoursEnd: null }, 'Quiet hours off.');
    const s = hhmmToMinutes(start);
    const e = hhmmToMinutes(end);
    if (s === null || e === null) return;
    void apply({ quietHoursStart: s, quietHoursEnd: e }, 'Quiet hours on.');
  };
  // A time saves when the field is left, if it changed.
  const saveTime = (which: 'start' | 'end') => {
    const s = hhmmToMinutes(start);
    const e = hhmmToMinutes(end);
    if (s === null || e === null) {
      toast.error('Use a time like 22:00.');
      return;
    }
    const savedValue = which === 'start' ? q.data?.quietHoursStart : q.data?.quietHoursEnd;
    if ((which === 'start' ? s : e) === savedValue) return;
    void apply({ quietHoursStart: s, quietHoursEnd: e }, 'Quiet hours saved.');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Moon className="h-4 w-4 text-gold" />
          When things reach you
        </CardTitle>
        <CardDescription>
          Quiet hours hold routine email, push and messages until the morning; a digest sends them together once an hour. Account security, formal HR notices, safety and pay always arrive at once.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!q.data ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-3/4" />
          </div>
        ) : (
          <>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <span id="quiet-hours-label" className="text-sm text-ink">
                  Quiet hours
                  <span className="block text-xs text-ink-muted">In {q.data.timezone ?? 'your device’s time zone'}</span>
                </span>
                <SettingsSwitch checked={quietOn} disabled={saving} onCheckedChange={turnQuiet} aria-labelledby="quiet-hours-label" />
              </div>
              {quietOn && (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="From">{(p) => <Input {...p} type="time" className="w-32" value={start} disabled={saving} onChange={(e) => setStart(e.target.value)} onBlur={() => saveTime('start')} />}</Field>
                  <Field label="Until">{(p) => <Input {...p} type="time" className="w-32" value={end} disabled={saving} onChange={(e) => setEnd(e.target.value)} onBlur={() => saveTime('end')} />}</Field>
                </div>
              )}
            </div>
            <ul className="divide-y divide-line">
              {CHANNELS.map((c) => (
                <li key={c.key} className="flex items-center justify-between gap-4 py-2">
                  <span className="text-sm text-ink">{c.label}</span>
                  <Select
                    size="sm"
                    className="w-44"
                    aria-label={`${c.label} delivery`}
                    value={q.data![c.key]}
                    disabled={saving}
                    onChange={(e) => void apply({ [c.key]: e.target.value as DeliveryMode })}
                  >
                    <option value="REALTIME">As it happens</option>
                    <option value="DIGEST">Once an hour, together</option>
                  </Select>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
