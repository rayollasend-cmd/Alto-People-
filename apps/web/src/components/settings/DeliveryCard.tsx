import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Moon } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { getDeliveryPrefs, hhmmToMinutes, minutesToHhmm, patchDeliveryPrefs, type DeliveryMode, type DeliveryPrefs } from '@/lib/accessApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Access pack — WHEN things reach you. Quiet hours in your own time zone
 * (nothing buzzes; what arrived waits for the morning as one message), and
 * per channel, as it happens or once an hour together. Security, formal
 * notices, safety and pay never wait.
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

  const apply = async (patch: Partial<Omit<DeliveryPrefs, 'timezone'>>) => {
    setSaving(true);
    try {
      const saved = await patchDeliveryPrefs(patch);
      qc.setQueryData(['me', 'notification-delivery'], saved);
      toast.success('Saved.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };
  const saveQuiet = () => {
    if (!quietOn) return apply({ quietHoursStart: null, quietHoursEnd: null });
    const s = hhmmToMinutes(start);
    const e = hhmmToMinutes(end);
    if (s === null || e === null) {
      toast.error('Use a time like 22:00.');
      return;
    }
    return apply({ quietHoursStart: s, quietHoursEnd: e });
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
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={quietOn} onChange={(e) => setQuietOn(e.target.checked)} />
                Quiet hours
                <span className="text-xs text-ink-muted">({q.data.timezone ?? 'your device’s time zone'})</span>
              </label>
              <div className="flex flex-wrap items-end gap-3">
                <Field label="From">{(p) => <Input {...p} type="time" className="w-32" value={start} disabled={!quietOn} onChange={(e) => setStart(e.target.value)} />}</Field>
                <Field label="Until">{(p) => <Input {...p} type="time" className="w-32" value={end} disabled={!quietOn} onChange={(e) => setEnd(e.target.value)} />}</Field>
                <Button size="sm" variant="secondary" loading={saving} onClick={() => void saveQuiet()}>Save quiet hours</Button>
              </div>
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
