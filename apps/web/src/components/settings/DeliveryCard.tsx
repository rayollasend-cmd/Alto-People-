import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Moon, ShieldCheck } from '@/components/ui/icons';
import { toast } from 'sonner';
import { DEFAULT_QUIET_HOURS, SUMMARY_HOUR } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { getDeliveryPrefs, hhmmToMinutes, minutesToHhmm, patchDeliveryPrefs, type DeliveryMode, type DeliverySettings } from '@/lib/accessApi';
import { Badge } from '@/components/ui/Badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { SettingsSwitch } from './SettingsSwitch';
import { useI18n, type MessageKey } from '@/lib/i18n';
import '@/lib/i18n/en/settings';

/**
 * Access pack — WHEN things reach you. Quiet hours in your own time zone
 * (nothing buzzes; what arrived waits for the morning), how much email, and
 * per phone channel, as it happens or once an hour together. Urgent safety,
 * security and pay notices never wait.
 *
 * Owner, 2026-11-02: people were bombarded (27,059 emails in 30 days for
 * 250 people, 99% of them repeating a bell row). Email is now a choice of
 * five, the role's default marked: the office gets one summary each
 * morning, the floor only what needs them. Quiet hours are on for everyone
 * from 9 PM to 7 AM until they say otherwise. The values shown are the
 * effective ones — the role's defaults until the person chooses.
 *
 * Everything here applies the moment it changes and says so in a toast
 * (F500 polish, 2026-10-26: one save model).
 */

/** Email, in the order a person reads them: the quiet options first. */
const EMAIL_MODES: Array<{ mode: DeliveryMode; label: MessageKey; hint: MessageKey }> = [
  { mode: 'IMPORTANT', label: 'settings.delivery.modeImportant', hint: 'settings.delivery.modeImportantHint' },
  { mode: 'DAILY', label: 'settings.delivery.modeDaily', hint: 'settings.delivery.modeDailyHint' },
  { mode: 'REALTIME', label: 'settings.delivery.modeRealtime', hint: 'settings.delivery.modeRealtimeHint' },
  { mode: 'DIGEST', label: 'settings.delivery.modeDigest', hint: 'settings.delivery.modeDigestHint' },
  { mode: 'OFF', label: 'settings.delivery.modeOff', hint: 'settings.delivery.modeOffHint' },
];

/** The phone channels keep their two speeds. */
const PHONE_CHANNELS: Array<{ key: 'deliveryPush' | 'deliverySms'; label: MessageKey }> = [
  { key: 'deliveryPush', label: 'settings.delivery.push' },
  { key: 'deliverySms', label: 'settings.delivery.sms' },
];

/** "7 AM" in the person's language — the hour the morning summary leaves. */
function summaryTime(lang: string): string {
  const at = new Date(2026, 0, 1, SUMMARY_HOUR, 0, 0);
  try {
    return new Intl.DateTimeFormat(lang, { hour: 'numeric', minute: '2-digit' }).format(at);
  } catch {
    return `${SUMMARY_HOUR}:00`;
  }
}

export function DeliveryCard() {
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me', 'notification-delivery'], queryFn: getDeliveryPrefs });
  const [quietOn, setQuietOn] = useState(true);
  const [start, setStart] = useState(minutesToHhmm(DEFAULT_QUIET_HOURS.start));
  const [end, setEnd] = useState(minutesToHhmm(DEFAULT_QUIET_HOURS.end));
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setQuietOn(q.data.quietHoursStart !== null);
    if (q.data.quietHoursStart !== null) setStart(minutesToHhmm(q.data.quietHoursStart));
    if (q.data.quietHoursEnd !== null) setEnd(minutesToHhmm(q.data.quietHoursEnd));
  }, [q.data]);

  const apply = async (patch: Partial<DeliverySettings>, ok = t('settings.delivery.saved')) => {
    setSaving(true);
    try {
      const saved = await patchDeliveryPrefs(patch);
      qc.setQueryData(['me', 'notification-delivery'], saved);
      toast.success(ok);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('settings.delivery.saveFailed'));
    } finally {
      setSaving(false);
    }
  };
  const turnQuiet = (on: boolean) => {
    setQuietOn(on);
    if (!on) return void apply({ quietHoursStart: null, quietHoursEnd: null }, t('settings.delivery.quietOff'));
    const s = hhmmToMinutes(start);
    const e = hhmmToMinutes(end);
    if (s === null || e === null) return;
    void apply({ quietHoursStart: s, quietHoursEnd: e }, t('settings.delivery.quietOn'));
  };
  // A time saves when the field is left, if it changed.
  const saveTime = (which: 'start' | 'end') => {
    const s = hhmmToMinutes(start);
    const e = hhmmToMinutes(end);
    if (s === null || e === null) {
      toast.error(t('settings.delivery.timeFormat'));
      return;
    }
    const savedValue = which === 'start' ? q.data?.quietHoursStart : q.data?.quietHoursEnd;
    if ((which === 'start' ? s : e) === savedValue) return;
    void apply({ quietHoursStart: s, quietHoursEnd: e }, t('settings.delivery.quietSaved'));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Moon className="h-4 w-4 text-gold" />
          {t('settings.delivery.title')}
        </CardTitle>
        <CardDescription>{t('settings.delivery.desc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!q.data ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-3/4" />
          </div>
        ) : (
          <>
            <fieldset className="space-y-2" disabled={saving}>
              <legend className="mb-2 text-sm font-medium text-ink">{t('settings.delivery.email')}</legend>
              {EMAIL_MODES.map((o) => {
                const on = q.data!.deliveryEmail === o.mode;
                const recommended = q.data!.defaults?.deliveryEmail === o.mode;
                const hintId = `delivery-email-${o.mode}-hint`;
                return (
                  <label
                    key={o.mode}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors',
                      on ? 'border-gold/50 bg-gold/10' : 'border-line hover:border-silver/40',
                    )}
                  >
                    <input
                      type="radio"
                      name="delivery-email"
                      value={o.mode}
                      checked={on}
                      aria-describedby={hintId}
                      onChange={() => void apply({ deliveryEmail: o.mode })}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-gold"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink">
                        {t(o.label)}
                        {recommended && (
                          <Badge variant="accent" size="sm">
                            {t('settings.delivery.recommended')}
                          </Badge>
                        )}
                      </span>
                      <span id={hintId} className="mt-0.5 block text-xs text-ink-muted">
                        {o.mode === 'DAILY' ? t(o.hint, { time: summaryTime(lang) }) : t(o.hint)}
                      </span>
                    </span>
                  </label>
                );
              })}
            </fieldset>

            <ul className="divide-y divide-line">
              {PHONE_CHANNELS.map((c) => (
                <li key={c.key} className="flex items-center justify-between gap-4 py-2">
                  <span className="text-sm text-ink">{t(c.label)}</span>
                  <Select
                    size="sm"
                    className="w-44"
                    aria-label={t('settings.delivery.channelAria', { channel: t(c.label) })}
                    value={q.data![c.key]}
                    disabled={saving}
                    onChange={(e) => void apply({ [c.key]: e.target.value as DeliveryMode })}
                  >
                    <option value="REALTIME">{t('settings.delivery.realtime')}</option>
                    <option value="DIGEST">{t('settings.delivery.digest')}</option>
                  </Select>
                </li>
              ))}
            </ul>

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <span id="quiet-hours-label" className="text-sm text-ink">
                  {t('settings.delivery.quiet')}
                  <span className="block text-xs text-ink-muted">
                    {q.data.timezone ? t('settings.delivery.inZone', { zone: q.data.timezone }) : t('settings.delivery.deviceZone')}
                  </span>
                </span>
                <SettingsSwitch checked={quietOn} disabled={saving} onCheckedChange={turnQuiet} aria-labelledby="quiet-hours-label" />
              </div>
              {quietOn && (
                <div className="flex flex-wrap items-end gap-3">
                  <Field label={t('settings.delivery.from')}>{(p) => <Input {...p} type="time" className="w-32" value={start} disabled={saving} onChange={(e) => setStart(e.target.value)} onBlur={() => saveTime('start')} />}</Field>
                  <Field label={t('settings.delivery.until')}>{(p) => <Input {...p} type="time" className="w-32" value={end} disabled={saving} onChange={(e) => setEnd(e.target.value)} onBlur={() => saveTime('end')} />}</Field>
                </div>
              )}
            </div>

            <p className="flex items-start gap-2 text-xs text-ink-muted">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gold" aria-hidden="true" />
              {t('settings.delivery.alwaysThrough')}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
