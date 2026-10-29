import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Camera, Check, Copy, Phone, Share2, ShieldAlert, Siren, X } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { cn } from '@/lib/cn';
import { hapticConfirm } from '@/lib/haptics';
import { fmtDayShort } from '@/lib/format';
import {
  driverOk,
  getDriverProfile,
  getPreTrip,
  navigationUrl,
  raiseSos,
  reportIncident,
  setDriverNavApp,
  shareTrip,
  submitPreTrip,
  uploadTransportPhoto,
  type CredentialKey, type CredentialStatus,
  type GeoPoint,
  type NavApp,
  type PreTripAnswer,
  type RideRun,
  type TransportIncidentKind,
} from '@/lib/transportApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import '@/lib/i18n/en/drive';

/**
 * The driver as a worker, and the road's safety net — the pieces DriverHome
 * hands the driver beside their runs:
 *
 *   CredentialBanner  a lapsed licence, said plainly (drive mode's banner;
 *                     the clock and the pay live in driver/DriveHeader and
 *                     driver/EarningsSheet)
 *   useNavApp / navigate   the next stop, turn by turn, in the app they like
 *   PreTripDialog     the walk around the van before a run leaves
 *   SafetyDialog      911, alert transportation (with where the van is),
 *                     share the trip, report an incident, pick a map app
 *   OkPrompt          "Everything OK?" when the van sat still or drifted
 *   IncidentDialog    the structured accident / incident report
 */

const errMsg = (err: unknown) => (err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err));

/* ----- Navigation ------------------------------------------------------------ */

export function useNavApp(): { app: NavApp; set: (app: NavApp) => Promise<void> } {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['transport', 'driver', 'profile'], queryFn: getDriverProfile, staleTime: 5 * 60_000, retry: false });
  return {
    // Tolerate a thin answer: Google Maps until the driver picks.
    app: q.data?.profile?.navApp ?? 'GOOGLE',
    set: async (app) => {
      await setDriverNavApp(app);
      await queryClient.invalidateQueries({ queryKey: ['transport', 'driver', 'profile'] });
    },
  };
}

export function navigateTo(app: NavApp, to: { point?: GeoPoint | null; address: string }): string {
  return navigationUrl(app, to);
}

function NavAppPicker() {
  const { t } = useI18n();
  const { app, set } = useNavApp();
  return (
    <Field label={t('drive.navWith')}>
      {(p) => (
        <Select
          {...p}
          value={app}
          onChange={(e) =>
            void set(e.target.value as NavApp).catch((err) => toast.error(errMsg(err)))
          }
        >
          {(['GOOGLE', 'APPLE', 'WAZE'] as const).map((a) => (
            <option key={a} value={a}>
              {t(`drive.nav.${a}` as MessageKey)}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

/* ----- Credentials ------------------------------------------------------------ */

export function CredentialBanner({ credentials }: { credentials: CredentialStatus | null | undefined }) {
  const { t } = useI18n();
  if (!credentials) return null;
  const DOC = { licence: 'drive.docLicence', dot: 'drive.docDot', training: 'drive.docTraining', mvr: 'drive.docMvr' } as const;
  const doc = (k: CredentialKey) => t(DOC[k]);
  const lines = [
    ...credentials.problems.map((p) =>
      p.expired && p.expiresAt
        ? { tone: 'alert' as const, text: t('drive.credExpired', { doc: doc(p.key), date: fmtDayShort(p.expiresAt, { year: true }) }) }
        : { tone: 'warning' as const, text: t('drive.credMissing', { doc: doc(p.key) }) },
    ),
    ...credentials.dueSoon.map((d) => ({ tone: 'warning' as const, text: t('drive.credSoon', { doc: doc(d.key), date: fmtDayShort(d.expiresAt, { year: true }) }) })),
  ];
  if (credentials.ok && credentials.dueSoon.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {lines.map((l) => (
        <p
          key={l.text}
          role="status"
          className={cn(
            'rounded-lg border px-3.5 py-2.5 text-sm',
            l.tone === 'alert' ? 'border-alert/40 bg-alert/10 text-alert' : 'border-warning/40 bg-warning/10 text-warning',
          )}
        >
          {l.text}
        </p>
      ))}
    </div>
  );
}

/* ----- The pre-trip check ------------------------------------------------------ */

/**
 * The walk around the van. `startsRun`: opened because Start was refused
 * for want of a check — a pass then starts the run ("Done — start the
 * run"). From drive mode's Pre-trip step it only records the check; Start
 * run is the next step.
 */
export function PreTripDialog({ run, onPassed, onClose, startsRun = true }: { run: RideRun; onPassed: () => void; onClose: () => void; startsRun?: boolean }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ['transport', 'driver', 'pretrip', run.id], queryFn: () => getPreTrip(run.id) });
  const [answers, setAnswers] = useState<Record<string, boolean>>({});
  const [odometer, setOdometer] = useState('');
  const [notes, setNotes] = useState('');
  const [photoKey, setPhotoKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const items = q.data?.items ?? [];
  const complete = items.length > 0 && items.every((i) => i.key in answers);
  // One check per van per day: already passed (on this run or another of the van's today).
  const alreadyDone = q.data?.done === true;
  const label = (key: string, fallback: string) => {
    const k = `drive.check.${key}` as MessageKey;
    const s = t(k);
    return s === k ? fallback : s;
  };
  const submit = async () => {
    setBusy(true);
    try {
      const body: { items: PreTripAnswer[]; odometerMiles?: number | null; notes?: string | null; photoKey?: string | null } = {
        items: items.map((i) => ({ key: i.key, ok: answers[i.key]! })),
        odometerMiles: odometer ? Math.round(Number(odometer)) : null,
        notes: notes.trim() || null,
        photoKey,
      };
      const r = await submitPreTrip(run.id, body);
      await queryClient.invalidateQueries({ queryKey: ['transport', 'driver'] });
      if (r.passed) {
        hapticConfirm();
        toast.success(t('drive.preTripPassed'));
        onPassed();
      } else {
        toast.error(t('drive.preTripFailed', { items: r.failedSafety.map((f) => label(f.key, f.label)).join(', ') }));
        onClose();
      }
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  const addPhoto = async (file: File | undefined) => {
    if (!file) return;
    try {
      const { key } = await uploadTransportPhoto(file);
      setPhotoKey(key);
      toast.success(t('drive.preTripPhotoAdded'));
    } catch (err) {
      toast.error(errMsg(err));
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('drive.preTrip')}</DialogTitle>
          <DialogDescription>{t('drive.preTripBody', { van: run.van.name })}</DialogDescription>
        </DialogHeader>
        {q.isError ? (
          <QueryError what="the checklist" query={q} />
        ) : q.isLoading ? (
          <Skeleton className="h-64" />
        ) : alreadyDone ? (
          <p role="status" className="flex items-center gap-2 text-base text-positive-800">
            <Check className="h-4 w-4 shrink-0" aria-hidden="true" />
            {t('drive.preTripDoneToday', { van: run.van.name })}
          </p>
        ) : (
          <div className="space-y-4">
            <ul className="divide-y divide-navy-secondary/60">
              {items.map((i) => (
                <li key={i.key} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 text-sm text-ink">
                    {label(i.key, i.label)}
                    {i.safety && <span className="ml-1.5 text-2xs uppercase tracking-wider text-silver">· {t('drive.safetyItem')}</span>}
                  </span>
                  <SegmentedControl<'ok' | 'fail' | ''>
                    ariaLabel={label(i.key, i.label)}
                    value={i.key in answers ? (answers[i.key] ? 'ok' : 'fail') : ''}
                    onChange={(v) => setAnswers((a) => ({ ...a, [i.key]: v === 'ok' }))}
                    options={[
                      { value: 'ok', label: t('drive.preTripOk') },
                      { value: 'fail', label: t('drive.preTripFail') },
                    ]}
                  />
                </li>
              ))}
            </ul>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t('drive.preTripOdometer')}>
                {(p) => <Input {...p} type="number" inputMode="numeric" min={0} value={odometer} onChange={(e) => setOdometer(e.target.value)} />}
              </Field>
              <div className="flex items-end">
                <input ref={fileRef} type="file" accept="image/*" capture="environment" className="sr-only" onChange={(e) => void addPhoto(e.target.files?.[0])} />
                <Button type="button" variant="secondary" size="sm" onClick={() => fileRef.current?.click()}>
                  {photoKey ? <Check className="h-3.5 w-3.5" /> : <Camera className="h-3.5 w-3.5" />}
                  {photoKey ? t('drive.preTripPhotoAdded') : t('drive.preTripPhoto')}
                </Button>
              </div>
            </div>
            <Field label={t('drive.preTripNotes')}>
              {(p) => <Textarea {...p} rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />}
            </Field>
          </div>
        )}
        <DialogFooter>
          {alreadyDone ? (
            <Button onClick={onPassed}>{startsRun ? t('drive.start') : t('drive.preTripSubmitOnly')}</Button>
          ) : (
            <Button onClick={() => void submit()} loading={busy} disabled={busy || !complete}>
              {startsRun ? t('drive.preTripSubmit') : t('drive.preTripSubmitOnly')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ----- Safety ------------------------------------------------------------------- */

function currentPosition(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 5_000, maximumAge: 30_000 },
    );
  });
}

export function SafetyDialog({ run, onClose, onIncident }: { run: RideRun | null; onClose: () => void; onIncident: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'sos' | 'share' | null>(null);
  const safety = run?.safety;
  const alert = async () => {
    if (!run) return;
    setBusy('sos');
    try {
      const at = await currentPosition();
      await raiseSos(run.id, { note: note.trim() || null, ...(at ?? {}) });
      hapticConfirm();
      toast.success(t('drive.alertSent'));
      setNote('');
      await queryClient.invalidateQueries({ queryKey: ['transport', 'driver'] });
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(null);
    }
  };
  const share = async () => {
    if (!run) return;
    setBusy('share');
    try {
      const { url } = await shareTrip(run.id);
      const nav = navigator as Navigator & { share?: (d: { url: string; title?: string }) => Promise<void> };
      if (nav.share) await nav.share({ url, title: run.van.name }).catch(() => undefined);
      else await navigator.clipboard?.writeText(url);
      toast.success(t('drive.shareCopied'));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-sky" aria-hidden="true" />
            {t('drive.safety')}
          </DialogTitle>
          <DialogDescription>{t('drive.safetyBody')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Button asChild variant="destructive" className="w-full">
            <a href="tel:911">
              <Phone className="h-4 w-4" />
              {t('drive.call911')}
            </a>
          </Button>
          {run && (
            <div className="space-y-2 rounded-lg border border-navy-secondary p-3">
              {safety?.sosAt ? (
                <p role="status" className={cn('text-sm', safety.sosAckAt ? 'text-success' : 'text-warning')}>
                  {safety.sosAckAt ? t('drive.alertAcked') : t('drive.alertWaiting')}
                </p>
              ) : null}
              <Field label={t('drive.alertNote')}>
                {(p) => <Input {...p} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />}
              </Field>
              <Button className="w-full" variant="secondary" onClick={() => void alert()} loading={busy === 'sos'} disabled={busy !== null}>
                <Siren className="h-4 w-4" />
                {t('drive.alertDesk')}
              </Button>
            </div>
          )}
          <div className="flex flex-wrap gap-2 coarse:gap-3">
            {run && (
              <Button variant="secondary" size="sm" onClick={() => void share()} loading={busy === 'share'} disabled={busy !== null}>
                {typeof navigator !== 'undefined' && 'share' in navigator ? <Share2 className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                {t('drive.shareTrip')}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={onIncident}>
              <AlertTriangle className="h-3.5 w-3.5" />
              {t('drive.incident')}
            </Button>
          </div>
          <NavAppPicker />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "Everything OK?" — the van sat still off its plan, or drifted off its way. */
export function OkPrompt({ run, onHelp }: { run: RideRun; onHelp: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (!run.safety?.promptedAt) return null;
  const ok = async () => {
    setBusy(true);
    try {
      await driverOk(run.id);
      hapticConfirm();
      await queryClient.invalidateQueries({ queryKey: ['transport', 'driver'] });
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="alert" className="mb-3 rounded-lg border border-caution-300 bg-caution-50 p-3">
      <p className="text-base font-medium text-caution-800">{t('drive.okPrompt')}</p>
      <div className="mt-2 flex flex-wrap gap-2 coarse:gap-3">
        <Button size="sm" onClick={() => void ok()} loading={busy} disabled={busy}>
          <Check className="h-3.5 w-3.5" />
          {t('drive.imOk')}
        </Button>
        <Button size="sm" variant="secondary" onClick={onHelp}>
          <ShieldAlert className="h-3.5 w-3.5" />
          {t('drive.needHelp')}
        </Button>
      </div>
    </div>
  );
}

/* ----- The incident report ------------------------------------------------------ */

const KINDS: TransportIncidentKind[] = ['COLLISION', 'INJURY', 'BREAKDOWN', 'NEAR_MISS', 'PROPERTY_DAMAGE', 'OTHER'];

export function IncidentDialog({ run, onClose }: { run: RideRun | null; onClose: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<TransportIncidentKind>('COLLISION');
  const [description, setDescription] = useState('');
  const [injured, setInjured] = useState<string[]>([]);
  const [anyInjury, setAnyInjury] = useState(false);
  const [party, setParty] = useState({ name: '', plate: '', insurer: '', phone: '' });
  const [police, setPolice] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const riders = run ? run.rides.filter((r) => r.status === 'BOARDED' || r.status === 'COMPLETED' || r.status === 'SCHEDULED') : [];
  const addPhotos = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files).slice(0, 12 - photos.length)) {
      try {
        const { key } = await uploadTransportPhoto(f);
        setPhotos((p) => [...p, key]);
      } catch (err) {
        toast.error(errMsg(err));
      }
    }
  };
  const send = async () => {
    setBusy(true);
    try {
      const at = await currentPosition();
      await reportIncident({
        kind,
        runId: run?.id ?? null,
        description: description.trim(),
        injuries: anyInjury || kind === 'INJURY',
        injuredAssociateIds: injured,
        parties: party.name.trim() ? [{ name: party.name.trim(), plate: party.plate.trim() || null, insurer: party.insurer.trim() || null, phone: party.phone.trim() || null }] : [],
        policeReportNumber: police.trim() || null,
        photoKeys: photos,
        ...(at ?? {}),
      });
      hapticConfirm();
      toast.success(t('drive.incidentSent'));
      await queryClient.invalidateQueries({ queryKey: ['transport'] });
      onClose();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('drive.incident')}</DialogTitle>
          <DialogDescription>{t('drive.incidentBody')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label={t('drive.incidentKind')} required>
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as TransportIncidentKind)}>
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`drive.incidentKind.${k}` as MessageKey)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('drive.incidentDesc')} required>
            {(p) => <Textarea {...p} rows={4} maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <label className="flex items-center gap-2 text-sm text-ink coarse:min-h-11">
            <input type="checkbox" className="h-4 w-4 coarse:h-6 coarse:w-6" checked={anyInjury || kind === 'INJURY'} onChange={(e) => setAnyInjury(e.target.checked)} />
            {t('drive.incidentInjured')}
          </label>
          {(anyInjury || kind === 'INJURY') && riders.length > 0 && (
            <fieldset>
              <legend className="mb-1 text-xs font-medium text-silver">{t('drive.incidentWho')}</legend>
              <div className="flex flex-wrap gap-1.5">
                {riders.map((r) => {
                  const on = injured.includes(r.rider.associateId);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setInjured((x) => (on ? x.filter((id) => id !== r.rider.associateId) : [...x, r.rider.associateId]))}
                      className={cn(
                        'rounded-full border px-3 py-1 text-xs coarse:min-h-11',
                        on ? 'border-alert bg-alert/15 text-alert' : 'border-navy-secondary text-silver hover:text-ink',
                      )}
                    >
                      {r.rider.name}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          )}
          <fieldset className="space-y-2">
            <legend className="text-xs font-medium text-silver">{t('drive.incidentParty')}</legend>
            <div className="grid grid-cols-2 gap-2">
              <Input aria-label={t('drive.incidentPartyName')} placeholder={t('drive.incidentPartyName')} value={party.name} onChange={(e) => setParty({ ...party, name: e.target.value })} maxLength={120} />
              <Input aria-label={t('drive.incidentPartyPlate')} placeholder={t('drive.incidentPartyPlate')} value={party.plate} onChange={(e) => setParty({ ...party, plate: e.target.value.toUpperCase() })} maxLength={20} />
              <Input aria-label={t('drive.incidentPartyInsurer')} placeholder={t('drive.incidentPartyInsurer')} value={party.insurer} onChange={(e) => setParty({ ...party, insurer: e.target.value })} maxLength={120} />
              <Input aria-label={t('drive.incidentPartyPhone')} placeholder={t('drive.incidentPartyPhone')} type="tel" value={party.phone} onChange={(e) => setParty({ ...party, phone: e.target.value })} maxLength={40} />
            </div>
          </fieldset>
          <Field label={t('drive.incidentPolice')}>
            {(p) => <Input {...p} value={police} onChange={(e) => setPolice(e.target.value)} maxLength={60} />}
          </Field>
          <div>
            <input ref={fileRef} type="file" accept="image/*" multiple className="sr-only" onChange={(e) => void addPhotos(e.target.files)} />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={() => fileRef.current?.click()} disabled={photos.length >= 12}>
                <Camera className="h-3.5 w-3.5" />
                {t('drive.incidentPhotos')}
              </Button>
              {photos.map((k) => (
                <Badge key={k} variant="outline" withDot={false}>
                  <Camera className="h-3 w-3" aria-hidden="true" />
                  <button type="button" aria-label={t('drive.undo')} onClick={() => setPhotos((p) => p.filter((x) => x !== k))}>
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => void send()} loading={busy} disabled={busy || description.trim().length < 10}>
            {t('drive.incidentSend')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
