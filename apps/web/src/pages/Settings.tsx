import { useEffect, useRef, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { OutOfOfficeCard } from '@/components/OutOfOfficeCard';
import { DeliveryCard } from '@/components/settings/DeliveryCard';
import { DevicesCard } from '@/components/settings/DevicesCard';
import { PhonesCard } from '@/components/settings/PhonesCard';
import { WhatsAppCard } from '@/components/WhatsAppCard';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AtSign, Bell, Camera, CheckCircle2, ChevronDown, ChevronUp, Clock, Copy, Download, Fingerprint, History, KeyRound, Languages, Lock, LogOut, RefreshCw, ShieldAlert, ShieldCheck, Smartphone, Upload, User as UserIcon, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { MFA_RECOVERY_CODE_COUNT, type MfaEnrollStartResponse } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { QR_COLORS } from '@/lib/qrColors';
import { useAuth, useRoleLabel, useTerm } from '@/lib/auth';
import { termizeText } from '@/lib/modules';
import { useConfirm } from '@/lib/confirm';
import {
  changePassword,
  confirmMfaEnrollment,
  disableMfa,
  downloadDataExport,
  getLoginHistory,
  getMfaStatus,
  getNotificationPreferences,
  patchNotificationPreference,
  regenerateMfaCodes,
  requestEmailChange,
  revokeOtherSessions,
  startMfaEnrollment,
  updateLanguage,
  updateTimezone,
  type LoginEvent,
} from '@/lib/settingsApi';
import { deleteProfilePhoto, uploadProfilePhoto } from '@/lib/selfApi';
import { PhotoCropDialog } from '@/components/PhotoCropDialog';
import { Link } from 'react-router-dom';
import { getPushStatus, subscribeToPush, unsubscribeFromPush } from '@/lib/push';
import { fmtDate, fmtDateTime, fmtTimeZone } from '@/lib/format';
import {
  listPasskeys,
  passkeysSupported,
  registerPasskey,
  removePasskey,
  type PasskeySummary,
} from '@/lib/webauthn';
import {
  EMAIL_LANGUAGES,
  EMAIL_LANGUAGE_LABELS,
  SUPPORTED_TIMEZONES,
  TIMEZONE_LABELS,
  type EmailLanguage,
  type NotificationPreferenceEntry,
  type SupportedTimezone,
} from '@/lib/roles';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { isLang, useI18n, type MessageKey, type Translate } from '@/lib/i18n';
import { Input } from '@/components/ui/Input';
import { Label, FormHint } from '@/components/ui/Label';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { cn } from '@/lib/cn';
import { DataGrid } from '@/components/ui/DataGrid';

/**
 * Phase 39 — self-service account settings. Cards: profile (display
 * name), profile photo, password, recent sign-in activity. The password
 * change route bumps tokenVersion server side and re-issues a cookie;
 * the cookie swap is invisible to the user.
 */
export function Settings() {
  const roleLabel = useRoleLabel();
  const { user } = useAuth();
  // Which sections are unfolded on a phone (desktop shows them all).
  const [open, setOpen] = useState<Set<SectionKey>>(() => new Set<SectionKey>(['profile']));
  const toggle = (k: SectionKey) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const jump = (k: SectionKey, smooth = true) => {
    setOpen((prev) => new Set(prev).add(k));
    // The section is in the URL (#notifications), so a link from the bell
    // or another page lands on it open — and Back returns to it (F500 G5).
    try {
      if (window.location.hash !== `#${k}`) window.history.replaceState(window.history.state, '', `#${k}`);
    } catch {
      /* no history in this environment */
    }
    // After the fold opens, so the section's height is real.
    requestAnimationFrame(() => document.getElementById(`settings-${k}`)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }));
  };
  // Arriving at /settings#notifications (or #settings-notifications): open it and go there.
  useEffect(() => {
    const k = sectionFromHash(typeof window === 'undefined' ? '' : window.location.hash);
    if (k) jump(k, false);
  }, []);
  // Which section is on screen, for the nav's current link (scroll-spy).
  const [active, setActive] = useState<SectionKey>(() => sectionFromHash(typeof window === 'undefined' ? '' : window.location.hash) ?? 'profile');
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const seen = new Map<SectionKey, number>();
    const io = new IntersectionObserver(
      (items) => {
        for (const it of items) {
          const k = it.target.id.replace('settings-', '') as SectionKey;
          seen.set(k, it.isIntersecting ? it.intersectionRatio : 0);
        }
        const top = SECTION_KEYS.find((k) => (seen.get(k) ?? 0) > 0);
        if (top) setActive(top);
      },
      { rootMargin: '-80px 0px -50% 0px', threshold: [0, 0.01] },
    );
    for (const k of SECTION_KEYS) {
      const el = document.getElementById(`settings-${k}`);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, []);
  const { t } = useI18n();

  return (
    // One readable column (F500 G5): half-width cards beside empty space at 1440 read as gaps.
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title={t('settingsPage.title')}
        subtitle={
          user
            ? t('settingsPage.signedInAs', { email: user.email, role: roleLabel(user.role) })
            : t('settingsPage.signInToManage')
        }
        breadcrumbs={[
          { label: t('tabs.home'), to: '/' },
          { label: t('settingsPage.crumbSettings') },
        ]}
        secondaryActions={
          user?.associateId ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/me">{t('settingsPage.profileAndDocs')}</Link>
            </Button>
          ) : undefined
        }
      />

      {/* Five sections instead of one long column of cards (floor walk 26:
          the page was twelve phone screens tall). A sticky row of links
          jumps between them; on a phone each section folds, and only
          Profile starts open. */}
      <SettingsNav active={active} onJump={jump} hasAssociate={!!user?.associateId} />

      <SettingsSection id="profile" title={t('settings.sec.profile')} icon={UserIcon} open={open.has('profile')} onToggle={toggle}>
        {/* One home for personal data (F500 G5): an associate's name, photo,
            phone and address live on My profile; this page keeps sign-in,
            notifications, devices, language and time zone. */}
        {user?.associateId && <ProfileOnMeCard />}
        {/* A staff account's photo (HR, recruiters, managers have no associate). */}
        {!user?.associateId && <ProfilePhotoCard />}
        <EmailCard />
        <TimezoneCard />
        <LanguageCard />
        <OutOfOfficeCard />
      </SettingsSection>

      <SettingsSection id="notifications" title={t('settings.sec.notifications')} icon={Bell} open={open.has('notifications')} onToggle={toggle}>
        <NotificationsCard />
        <DeliveryCard />
        {user?.associateId && <WhatsAppCard />}
      </SettingsSection>

      <SettingsSection id="security" title={t('settings.sec.security')} icon={Lock} open={open.has('security')} onToggle={toggle}>
        <PasswordCard />
        <PasskeysCard />
        <MfaCard />
      </SettingsSection>

      <SettingsSection id="devices" title={t('settings.sec.devices')} icon={Smartphone} open={open.has('devices')} onToggle={toggle} wide>
        <DevicesCard />
        {/* Phones with the native app: notifications, the Face ID lock, remove a phone. */}
        <PhonesCard />
        <SessionsCard />
        <LoginHistoryCard />
      </SettingsSection>

      <SettingsSection id="data" title={t('settings.sec.data')} icon={Download} open={open.has('data')} onToggle={toggle}>
        <DataExportCard />
      </SettingsSection>
    </div>
  );
}

type SectionKey = 'profile' | 'notifications' | 'security' | 'devices' | 'data';
const SECTION_KEYS: SectionKey[] = ['profile', 'notifications', 'security', 'devices', 'data'];
/** "#notifications" or "#settings-notifications" → the section. */
function sectionFromHash(hash: string): SectionKey | null {
  const k = hash.replace(/^#/, '').replace(/^settings-/, '') as SectionKey;
  return SECTION_KEYS.includes(k) ? k : null;
}
const SECTION_LABEL: Record<SectionKey, MessageKey> = {
  profile: 'settings.sec.profile',
  notifications: 'settings.sec.notifications',
  security: 'settings.sec.security',
  devices: 'settings.sec.devices',
  data: 'settings.sec.data',
};

/** The in-page section links, sticky under the top bar while the page scrolls. */
function SettingsNav({ active, onJump }: { active: SectionKey; onJump: (k: SectionKey) => void; hasAssociate: boolean }) {
  const { t } = useI18n();
  return (
    <nav
      aria-label={t('settings.sec.nav')}
      className="sticky top-0 z-10 -mx-4 overflow-x-auto border-b border-line bg-surface/95 px-4 py-2 backdrop-blur print:hidden"
    >
      <ul className="flex gap-1.5">
        {SECTION_KEYS.map((k) => (
          <li key={k}>
            <a
              href={`#${k}`}
              onClick={(e) => {
                e.preventDefault();
                onJump(k);
              }}
              // The section on screen, by scroll — not every section a phone has unfolded.
              aria-current={active === k ? 'location' : undefined}
              className={cn(
                'inline-flex whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-ink-muted hover:bg-surface-raised hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent coarse:min-h-11 coarse:items-center',
                active === k && 'bg-surface-raised font-medium text-ink',
              )}
            >
              {t(SECTION_LABEL[k])}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * One section: a heading, and its cards in two columns on a wide screen.
 * Below `md` it folds behind its heading — the fold control hides from
 * `md` up, where every section is always open.
 */
function SettingsSection({
  id,
  title,
  icon,
  open,
  onToggle,
  wide = false,
  children,
}: {
  id: SectionKey;
  title: string;
  icon: LucideIcon;
  open: boolean;
  onToggle: (k: SectionKey) => void;
  /** Wide tables (sessions, sign-in history): one column. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section id={`settings-${id}`} aria-labelledby={`settings-${id}-title`} className="scroll-mt-16">
      <div className="flex items-center justify-between gap-3">
        <SectionTitle id={`settings-${id}-title`} icon={icon} title={title} className="mb-0" />
        <Button
          variant="ghost"
          size="sm"
          className="md:hidden"
          aria-expanded={open}
          aria-controls={`settings-${id}-body`}
          onClick={() => onToggle(id)}
        >
          {open ? t('settings.sec.hide') : t('settings.sec.show')}
          {open ? <ChevronUp className="h-4 w-4" aria-hidden="true" /> : <ChevronDown className="h-4 w-4" aria-hidden="true" />}
        </Button>
      </div>
      <div
        id={`settings-${id}-body`}
        // One column: paired cards of unequal height left gaps at 1440 (F500 G5).
        className={cn('mt-3 gap-6', open ? 'grid' : 'hidden md:grid', 'grid-cols-1', !wide && 'max-w-3xl', '[&>*]:min-w-0 items-start')}
      >
        {children}
      </div>
    </section>
  );
}

function DataExportCard() {
  const { t } = useI18n();
  const [submitting, setSubmitting] = useState(false);

  const onDownload = async () => {
    setSubmitting(true);
    try {
      await downloadDataExport();
      toast.success(t('settingsPage.export.downloading'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settingsPage.export.failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="h-4 w-4 text-gold" />
          {t('settingsPage.export.title')}
        </CardTitle>
        <CardDescription>
          {t('settingsPage.export.desc')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex justify-end">
          <Button onClick={onDownload} loading={submitting} variant="ghost">
            {t('settingsPage.export.button')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Passkeys — Face ID / Touch ID / Windows Hello sign-in. Registration and
 * removal only; the sign-in leg lives on the login page. Hidden entirely
 * on browsers without WebAuthn (old in-app webviews) rather than showing
 * a card that can only apologize.
 */
function PasskeysCard() {
  const { t } = useI18n();
  const [passkeys, setPasskeys] = useState<PasskeySummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = passkeysSupported();

  const passkeysQuery = useQuery({
    queryKey: ['PasskeysCard', 'passkeys', supported],
    queryFn: () => listPasskeys(),
    enabled: Boolean(supported),
  });
  useEffect(() => {
    const rows = passkeysQuery.data;
    if (rows === undefined) return;
    setPasskeys(rows);
  }, [passkeysQuery.data]);
  useEffect(() => {
    if (!passkeysQuery.isError) return;
    setPasskeys([]);
  }, [passkeysQuery.isError, passkeysQuery.error]);

  if (!supported) return null;

  const onAdd = async () => {
    setBusy(true);
    try {
      const created = await registerPasskey();
      setPasskeys((cur) => [...(cur ?? []), created]);
      toast.success(t('settingsPage.passkeys.added'));
    } catch (err) {
      // NotAllowedError = the user closed the system sheet; not an error
      // worth a red toast.
      if (err instanceof Error && err.name === 'NotAllowedError') return;
      toast.error(err instanceof Error ? err.message : t('settingsPage.passkeys.addFailed'));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async (p: PasskeySummary) => {
    setBusy(true);
    try {
      await removePasskey(p.id);
      setPasskeys((cur) => (cur ?? []).filter((x) => x.id !== p.id));
      toast.success(t('settingsPage.passkeys.removed'));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settingsPage.passkeys.removeFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Fingerprint className="h-4 w-4 text-gold" />
          {t('settingsPage.passkeys.title')}
        </CardTitle>
        <CardDescription>
          {t('settingsPage.passkeys.desc')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {passkeys === null ? (
          <Skeleton className="h-10" />
        ) : passkeys.length === 0 ? (
          <EmptyState size="sm" title={t('settingsPage.passkeys.empty')} />
        ) : (
          <ul className="space-y-2">
            {passkeys.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-md border border-navy-secondary px-3 py-2 text-sm"
              >
                <div className="min-w-0">
                  <div className="text-white truncate">
                    {p.deviceName ?? t('settingsPage.passkeys.fallbackName')}
                  </div>
                  <div className="text-xs text-silver/70">
                    {t('settingsPage.passkeys.addedOn', { date: fmtDate(p.createdAt) })}
                    {p.lastUsedAt ? ` · ${t('settingsPage.passkeys.lastUsed', { date: fmtDate(p.lastUsedAt) })}` : ''}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-alert hover:text-alert"
                  onClick={() => void onRemove(p)}
                  disabled={busy}
                >
                  {t('settingsPage.remove')}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button onClick={() => void onAdd()} loading={busy} disabled={busy}>
          <Fingerprint className="h-4 w-4" />
          {t('settingsPage.passkeys.add')}
        </Button>
      </CardContent>
    </Card>
  );
}

function MfaCard() {
  const { user, refreshUser } = useAuth();
  const { t } = useI18n();
  const [enroll, setEnroll] = useState<MfaEnrollStartResponse | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [showDisable, setShowDisable] = useState(false);
  const [showRegenerate, setShowRegenerate] = useState(false);
  const [regeneratePassword, setRegeneratePassword] = useState('');
  const [regeneratedCodes, setRegeneratedCodes] = useState<string[] | null>(null);
  // Brief celebration ribbon shown right after the user flips MFA on.
  // Auto-clears after a few seconds so the regular "two-step sign-in is on"
  // state takes over for the rest of the session.
  const [justEnabled, setJustEnabled] = useState(false);
  const queryClient = useQueryClient();

  const enabled = user?.mfaEnabled ?? false;

  // Pull the recovery-code count when the user is enrolled. This drives the
  // "X of 8 remaining" indicator. Cache invalidates after regenerate so the
  // new count (8 again) shows up without a page refresh.
  const remainingQuery = useQuery({
    queryKey: ['mfa', 'status'],
    queryFn: async () => (await getMfaStatus()).remainingRecoveryCodes,
    enabled,
  });
  const remaining: number | null = enabled
    ? (remainingQuery.data ?? null)
    : null;

  useEffect(() => {
    if (regeneratedCodes) {
      void queryClient.invalidateQueries({ queryKey: ['mfa', 'status'] });
    }
  }, [regeneratedCodes, queryClient]);

  const onEnable = async () => {
    setBusy(true);
    try {
      const res = await startMfaEnrollment();
      setEnroll(res);
      setAcknowledged(false);
      setCode('');
      // Lazy-load qrcode (~50 KB) — only fires when a user enrolls in MFA.
      const { default: QRCode } = await import('qrcode');
      const dataUrl = await QRCode.toDataURL(res.provisioningUri, {
        margin: 1,
        width: 192,
        color: QR_COLORS,
      });
      setQrDataUrl(dataUrl);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('settingsPage.mfa.startFailed'));
    } finally {
      setBusy(false);
    }
  };

  const onConfirm = async () => {
    if (!/^\d{6}$/.test(code)) {
      toast.error(t('settingsPage.mfa.enterCode'));
      return;
    }
    setBusy(true);
    try {
      await confirmMfaEnrollment({ code });
      setEnroll(null);
      setQrDataUrl(null);
      setCode('');
      setAcknowledged(false);
      setJustEnabled(true);
      window.setTimeout(() => setJustEnabled(false), 4000);
      await refreshUser();
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      if (apiErr?.code === 'invalid_code') {
        toast.error(t('settingsPage.mfa.badCode'));
      } else if (apiErr?.code === 'no_pending_enrollment') {
        toast.error(t('settingsPage.mfa.enrollExpired'));
        setEnroll(null);
        setQrDataUrl(null);
      } else {
        toast.error(apiErr?.message ?? t('settingsPage.mfa.confirmFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const onCancel = () => {
    setEnroll(null);
    setQrDataUrl(null);
    setCode('');
    setAcknowledged(false);
  };

  const onDisable = async () => {
    if (disablePassword.length < 1) {
      toast.error(t('settingsPage.enterCurrentPassword'));
      return;
    }
    setBusy(true);
    try {
      await disableMfa({ currentPassword: disablePassword });
      toast.success(t('settingsPage.mfa.offToast'));
      setShowDisable(false);
      setDisablePassword('');
      setRegeneratedCodes(null);
      await refreshUser();
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      if (apiErr?.code === 'invalid_credentials') {
        toast.error(t('settingsPage.wrongPassword'));
      } else {
        toast.error(apiErr?.message ?? t('settingsPage.mfa.disableFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const onRegenerate = async () => {
    if (regeneratePassword.length < 1) {
      toast.error(t('settingsPage.enterCurrentPassword'));
      return;
    }
    setBusy(true);
    try {
      const res = await regenerateMfaCodes({ currentPassword: regeneratePassword });
      setRegeneratedCodes(res.recoveryCodes);
      setShowRegenerate(false);
      setRegeneratePassword('');
      toast.success(t('settingsPage.mfa.regenerated'));
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      if (apiErr?.code === 'invalid_credentials') {
        toast.error(t('settingsPage.wrongPassword'));
      } else if (apiErr?.code === 'mfa_not_enrolled') {
        toast.error(t('settingsPage.mfa.notOn'));
      } else {
        toast.error(apiErr?.message ?? t('settingsPage.mfa.regenerateFailed'));
      }
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string, copiedMessage: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(copiedMessage);
    } catch {
      toast.error(t('settingsPage.mfa.copyFailed'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-gold" />
          {t('settingsPage.mfa.title')}
        </CardTitle>
        <CardDescription>
          {enabled
            ? t('settingsPage.mfa.descOn')
            : t('settingsPage.mfa.descOff')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {enroll ? (
          <div className="space-y-4">
            <div className="rounded-md border border-gold/40 bg-gold/10 px-3 py-2 text-xs text-white">
              <strong className="text-gold">{t('settingsPage.mfa.saveCodesFirst')}</strong>{' '}
              {t('settingsPage.mfa.saveCodesFirstBody')}
            </div>
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="shrink-0">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt={t('settingsPage.mfa.qrAlt')}
                    className="rounded-md border border-navy-secondary bg-white p-2"
                    width={192}
                    height={192}
                  />
                ) : (
                  <Skeleton className="h-48 w-48" />
                )}
              </div>
              <div className="flex-1 space-y-3">
                <div>
                  <Label>{t('settingsPage.mfa.manualSecret')}</Label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-md bg-navy-secondary/60 px-3 py-2 font-mono text-xs text-white break-all">
                      {enroll.secret}
                    </code>
                    <Button
                      variant="ghost"
                      aria-label={t('settingsPage.mfa.copySecret')}
                      onClick={() => copy(enroll.secret, t('settingsPage.mfa.secretCopied'))}
                      type="button"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <FormHint>
                    {t('settingsPage.mfa.scanHint')}
                  </FormHint>
                </div>
                <div>
                  <Label>{t('settingsPage.mfa.recoveryCodes')}</Label>
                  <ul className="grid grid-cols-2 gap-1.5 rounded-md bg-navy-secondary/60 p-3 font-mono text-xs text-white">
                    {enroll.recoveryCodes.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                  <div className="flex items-center justify-between mt-1.5">
                    <FormHint>{t('settingsPage.mfa.printHint')}</FormHint>
                    <Button
                      variant="ghost"
                      onClick={() => copy(enroll.recoveryCodes.join('\n'), t('settingsPage.mfa.codesCopied'))}
                      type="button"
                    >
                      <Copy className="mr-1.5 h-3.5 w-3.5" />
                      {t('settingsPage.mfa.copyAll')}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
            <label className="flex items-start gap-2 text-sm text-white">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>{t('settingsPage.mfa.ackSaved')}</span>
            </label>
            <div>
              <Label htmlFor="mfa-code" required>
                {t('settingsPage.mfa.codeLabel')}
              </Label>
              <Input
                id="mfa-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="123456"
                className="font-mono tracking-widest text-center"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onCancel} disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={onConfirm}
                loading={busy}
                disabled={!acknowledged || code.length !== 6}
              >
                {t('settingsPage.mfa.turnOn')}
              </Button>
            </div>
          </div>
        ) : enabled ? (
          <div className="space-y-3">
            {justEnabled && (
              <div
                className="relative overflow-hidden rounded-lg border-l-2 border-l-success/70 bg-gradient-to-br from-success/[0.12] via-navy-secondary/40 to-navy-secondary/40 p-5 md:p-6"
                role="status"
                style={{ animation: 'mfa-celebrate-in 0.45s cubic-bezier(.34,1.56,.64,1) both' }}
              >
                <style>{`@keyframes mfa-celebrate-in {
                  0% { transform: scale(0.96); opacity: 0; }
                  60% { transform: scale(1.01); opacity: 1; }
                  100% { transform: scale(1); opacity: 1; }
                }`}</style>
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute -top-12 -right-12 h-40 w-40 rounded-full glow [--glow:rgb(var(--color-success)/0.2)]"
                />
                <div className="relative flex items-center gap-4">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-success/20 border border-success/40">
                    <ShieldCheck className="h-6 w-6 text-success" />
                  </div>
                  <div>
                    <div className="text-2xs uppercase tracking-widest text-success">
                      {t('settingsPage.mfa.protected')}
                    </div>
                    <div className="text-2xl md:text-3xl text-white leading-tight">
                      {t('settingsPage.mfa.isOn')}
                    </div>
                    <div className="text-sm text-silver mt-0.5">
                      {t('settingsPage.mfa.celebrate')}
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-white">
                <CheckCircle2 className="h-4 w-4 text-success" />
                {t('settingsPage.mfa.isOn')}
              </div>
              {remaining !== null && (
                <span
                  className={`text-xs ${
                    remaining <= 2 ? 'text-warning' : 'text-silver'
                  }`}
                >
                  {t('settingsPage.mfa.remaining', { remaining, total: MFA_RECOVERY_CODE_COUNT })}
                </span>
              )}
            </div>
            {regeneratedCodes && (
              <div className="space-y-2 rounded-md border border-gold/40 bg-gold/10 p-3">
                <div className="text-xs text-white">
                  <strong className="text-gold">{t('settingsPage.mfa.saveNow')}</strong>{' '}
                  {t('settingsPage.mfa.saveNowBody')}
                </div>
                <ul className="grid grid-cols-2 gap-1.5 rounded-md bg-navy-secondary/60 p-3 font-mono text-xs text-white">
                  {regeneratedCodes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                <div className="flex items-center justify-between">
                  <FormHint>{t('settingsPage.mfa.printHint')}</FormHint>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      onClick={() => copy(regeneratedCodes.join('\n'), t('settingsPage.mfa.codesCopied'))}
                      type="button"
                    >
                      <Copy className="mr-1.5 h-3.5 w-3.5" />
                      {t('settingsPage.mfa.copyAll')}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setRegeneratedCodes(null)}
                      type="button"
                    >
                      {t('settingsPage.mfa.savedThem')}
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {showDisable ? (
              <div className="space-y-3 rounded-md border border-navy-secondary bg-navy-secondary/30 p-3">
                <div>
                  <Label htmlFor="mfa-disable-pw" required>
                    {t('settingsPage.currentPassword')}
                  </Label>
                  <Input
                    id="mfa-disable-pw"
                    type="password"
                    autoComplete="current-password"
                    value={disablePassword}
                    onChange={(e) => setDisablePassword(e.target.value)}
                  />
                  <FormHint>
                    {t('settingsPage.mfa.disableHint')}
                  </FormHint>
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setShowDisable(false);
                      setDisablePassword('');
                    }}
                    disabled={busy}
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button onClick={onDisable} loading={busy}>
                    {t('settingsPage.mfa.turnOff')}
                  </Button>
                </div>
              </div>
            ) : showRegenerate ? (
              <div className="space-y-3 rounded-md border border-navy-secondary bg-navy-secondary/30 p-3">
                <div>
                  <Label htmlFor="mfa-regen-pw" required>
                    {t('settingsPage.currentPassword')}
                  </Label>
                  <Input
                    id="mfa-regen-pw"
                    type="password"
                    autoComplete="current-password"
                    value={regeneratePassword}
                    onChange={(e) => setRegeneratePassword(e.target.value)}
                  />
                  <FormHint>
                    {t('settingsPage.mfa.regenerateHint')}
                  </FormHint>
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      setShowRegenerate(false);
                      setRegeneratePassword('');
                    }}
                    disabled={busy}
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button onClick={onRegenerate} loading={busy}>
                    {t('settingsPage.mfa.regenerate')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setShowRegenerate(true);
                    setRegeneratedCodes(null);
                  }}
                >
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                  {t('settingsPage.mfa.regenerate')}
                </Button>
                <Button variant="ghost" onClick={() => setShowDisable(true)}>
                  {t('settingsPage.mfa.turnOff')}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex justify-end">
            <Button onClick={onEnable} loading={busy}>
              {t('settingsPage.mfa.setUp')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmailCard() {
  const { user } = useAuth();
  const { t } = useI18n();
  const [newEmail, setNewEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const submit = async () => {
    const target = newEmail.trim().toLowerCase();
    if (!target) {
      toast.error(t('settingsPage.email.enterNew'));
      return;
    }
    if (target === user?.email.toLowerCase()) {
      toast.error(t('settingsPage.email.alreadyYours'));
      return;
    }
    if (currentPassword.length < 12) {
      toast.error(t('settingsPage.email.enterPassword'));
      return;
    }
    setSubmitting(true);
    try {
      await requestEmailChange({ newEmail: target, currentPassword });
      setSentTo(target);
      setNewEmail('');
      setCurrentPassword('');
      toast.success(t('settingsPage.email.sentToast', { email: target }));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      if (code === 'invalid_credentials') {
        toast.error(t('settingsPage.wrongPassword'));
      } else if (code === 'email_in_use') {
        toast.error(t('settingsPage.email.inUse'));
      } else if (code === 'same_email') {
        toast.error(t('settingsPage.email.alreadyYours'));
      } else {
        toast.error(t('settingsPage.email.requestFailed'), {
          description: err instanceof Error ? err.message : t('common.wentWrong'),
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <AtSign className="h-4 w-4 text-gold" />
          {t('settingsPage.email.title')}
        </CardTitle>
        <CardDescription>
          {t('settingsPage.email.currentLabel')} <span className="text-white">{user?.email}</span>.{' '}
          {t('settingsPage.email.desc')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sentTo && (
          <div className="mb-4 rounded-md border border-gold/40 bg-gold/10 px-3 py-2 text-xs text-white">
            {t('settingsPage.email.sentPrefix')} <span className="font-mono">{sentTo}</span>.{' '}
            {t('settingsPage.email.sentBody')}
          </div>
        )}
        <div className="space-y-3">
          <Field label={t('settingsPage.email.newEmail')} required>
            {(p) => (
              <Input
                type="email"
                autoComplete="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                maxLength={254}
                placeholder="you@new-address.com"
                {...p}
              />
            )}
          </Field>
          <Field
            label={t('settingsPage.currentPassword')}
            required
            hint={t('settingsPage.email.passwordHint')}
          >
            {(p) => (
              <Input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                {...p}
              />
            )}
          </Field>
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            onClick={submit}
            loading={submitting}
            disabled={!newEmail || !currentPassword}
          >
            {t('settingsPage.email.send')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

type PushRowStatus =
  | 'loading'
  | 'unsupported'
  | 'denied'
  | 'subscribed'
  | 'available';

function NotificationsCard() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const term = useTerm();
  const { user } = useAuth();
  const isPortal = user?.role === 'CLIENT_PORTAL';
  // `${category}:${channel}` — each switch spins on its own, not both.
  const [pending, setPending] = useState<string | null>(null);

  // Push subscription state for this device. Settings is the recovery
  // path for users who dismissed the dashboard's one-time enable card
  // (that dismissal writes a permanent localStorage flag).
  const [pushStatus, setPushStatus] = useState<PushRowStatus>('loading');
  const [pushBusy, setPushBusy] = useState(false);

  const pushStatusQuery = useQuery({
    queryKey: ['NotificationsCard', 'pushStatus'],
    queryFn: () => getPushStatus(),
  });
  useEffect(() => {
    const s = pushStatusQuery.data;
    if (s === undefined) return;
    setPushStatus(s);
  }, [pushStatusQuery.data]);

  const onEnablePush = async () => {
    setPushBusy(true);
    try {
      await subscribeToPush();
      setPushStatus('subscribed');
      toast.success(t('settingsPage.notif.pushOnToast'));
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : t('settingsPage.notif.pushEnableFailed'),
      );
      // Permission may have just been denied — re-read the real state.
      getPushStatus().then(setPushStatus);
    } finally {
      setPushBusy(false);
    }
  };

  const onDisablePush = async () => {
    setPushBusy(true);
    try {
      await unsubscribeFromPush();
      setPushStatus('available');
      toast.success(t('settingsPage.notif.pushOffToast'));
    } finally {
      setPushBusy(false);
    }
  };

  const { data: entries, error: entriesError } = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: async () => (await getNotificationPreferences()).entries,
  });
  const error = entriesError
    ? entriesError instanceof Error
      ? entriesError.message
      : t('settingsPage.notif.loadFailed')
    : null;

  const setEntries = (
    updater: (
      prev: NotificationPreferenceEntry[] | null,
    ) => NotificationPreferenceEntry[] | null,
  ) => {
    queryClient.setQueryData<NotificationPreferenceEntry[]>(
      ['notification-preferences'],
      (old) => updater(old ?? null) ?? old,
    );
  };

  /**
   * One handler, either channel. Muting a category used to stop the email
   * and leave the bell ringing, so the switch turned off half of what it
   * claimed to; the bell is now its own switch and its own server flag.
   */
  const onToggle = async (
    entry: NotificationPreferenceEntry,
    channel: 'emailEnabled' | 'inAppEnabled',
  ) => {
    if (entry.mandatory) return;
    setPending(`${entry.category}:${channel}`);
    const next = !entry[channel];
    // Optimistic update — reverts on failure.
    setEntries((prev) =>
      prev
        ? prev.map((e) =>
            e.category === entry.category ? { ...e, [channel]: next } : e,
          )
        : prev,
    );
    try {
      await patchNotificationPreference(entry.category, { [channel]: next });
    } catch (err) {
      setEntries((prev) =>
        prev
          ? prev.map((e) =>
              e.category === entry.category
                ? { ...e, [channel]: entry[channel] }
                : e,
            )
          : prev,
      );
      toast.error(err instanceof ApiError ? err.message : t('settingsPage.updateFailed'));
    } finally {
      setPending(null);
    }
  };

  const channelToggle = (
    e: NotificationPreferenceEntry,
    channel: 'emailEnabled' | 'inAppEnabled',
    label: string,
  ) => (
    <label
      className={`inline-flex w-11 flex-col items-center gap-1 ${
        e.mandatory ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'
      }`}
    >
      <input
        type="checkbox"
        className="sr-only peer"
        checked={e[channel]}
        disabled={e.mandatory || pending === `${e.category}:${channel}`}
        aria-label={t('settingsPage.notif.toggleAria', { channel: label, category: e.label })}
        onChange={() => onToggle(e, channel)}
      />
      <div className="w-11 h-6 bg-navy-secondary peer-focus-visible:ring-2 peer-focus-visible:ring-gold rounded-full peer peer-checked:bg-gold/80 transition relative after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition peer-checked:after:translate-x-5" />
    </label>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-gold" />
          {t('settingsPage.notif.title')}
        </CardTitle>
        <CardDescription>
          {t('settingsPage.notif.desc')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <ErrorBanner>{error}</ErrorBanner>
        ) : !entries ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-3/4" />
          </div>
        ) : (
          <>
          {/* One header row names the columns (it repeated over all 14 rows). */}
          <div className="flex items-end justify-end gap-3 border-b border-navy-secondary pb-1.5 text-2xs font-medium uppercase tracking-wide text-silver" data-testid="notif-columns">
            <span className="w-11 text-center">{t('settingsPage.notif.bell')}</span>
            <span className="w-11 text-center">{t('settingsPage.notif.email')}</span>
          </div>
          <ul className="divide-y divide-navy-secondary">
            {entries.map((e) => (
              <li
                key={e.category}
                className="flex items-start justify-between gap-4 py-3"
              >
                <div className="flex-1">
                  <div className="text-sm text-white flex items-center gap-2">
                    {e.label}
                    {e.mandatory && (
                      <span className="inline-flex items-center gap-1 text-xs text-silver">
                        <Lock className="h-3 w-3" />
                        {t('settingsPage.notif.required')}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-silver mt-0.5">{termizeText(e.description, term)}</div>
                </div>
                <span className="flex shrink-0 items-start gap-3">
                  {channelToggle(e, 'inAppEnabled', t('settingsPage.notif.bell'))}
                  {channelToggle(e, 'emailEnabled', t('settingsPage.notif.email'))}
                </span>
              </li>
            ))}
          </ul>
          </>
        )}

        {/* Push — device-level, separate from the per-category email
            toggles above. */}
        <div className="mt-4 pt-4 border-t border-navy-secondary flex items-start justify-between gap-4 flex-wrap">
          <div className="flex-1 min-w-48">
            <div className="text-sm text-white flex items-center gap-2">
              <Smartphone className="h-3.5 w-3.5 text-gold" />
              {t('settingsPage.notif.pushTitle')}
              {pushStatus === 'subscribed' && (
                <span className="inline-flex items-center gap-1 text-xs text-success">
                  <CheckCircle2 className="h-3 w-3" />
                  {t('settingsPage.notif.pushOn')}
                </span>
              )}
            </div>
            <div className="text-xs text-silver mt-0.5">
              {pushStatus === 'subscribed'
                ? isPortal
                  ? t('settingsPage.notif.pushSubscribedPortal')
                  : t('settingsPage.notif.pushSubscribed')
                : pushStatus === 'available'
                  ? isPortal
                    ? t('settingsPage.notif.pushAvailablePortal')
                    : t('settingsPage.notif.pushAvailable')
                  : pushStatus === 'denied'
                    ? t('settingsPage.notif.pushDenied')
                    : pushStatus === 'unsupported'
                      ? t('settingsPage.notif.pushUnsupported')
                      : t('settingsPage.notif.pushChecking')}
            </div>
          </div>
          {pushStatus === 'subscribed' && (
            <Button variant="ghost" onClick={onDisablePush} loading={pushBusy}>
              {t('settingsPage.notif.disable')}
            </Button>
          )}
          {pushStatus === 'available' && (
            <Button onClick={onEnablePush} loading={pushBusy}>
              {t('settingsPage.notif.enable')}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function TimezoneCard() {
  const { user, refreshUser } = useAuth();
  const { t } = useI18n();
  const [tz, setTz] = useState<SupportedTimezone | ''>(
    (user?.timezone as SupportedTimezone | undefined) ?? '',
  );
  const [submitting, setSubmitting] = useState(false);
  const browserTz =
    typeof Intl !== 'undefined'
      ? Intl.DateTimeFormat().resolvedOptions().timeZone
      : 'UTC';

  const dirty = (user?.timezone ?? '') !== tz;

  const submit = async () => {
    setSubmitting(true);
    try {
      await updateTimezone(tz === '' ? null : tz);
      toast.success(
        tz === ''
          ? t('settingsPage.tz.cleared')
          : t('settingsPage.tz.updated'),
      );
      await refreshUser();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('settingsPage.updateFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-gold" />
          {t('settingsPage.tz.title')}
        </CardTitle>
        <CardDescription>
          {t('settingsPage.tz.desc', { tz: fmtTimeZone(browserTz) })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('settingsPage.tz.label')} className="flex-1 min-w-[240px]">
            {(p) => (
              <Select
                value={tz}
                onChange={(e) => setTz(e.target.value as SupportedTimezone | '')}
                {...p}
              >
                <option value="">{t('settingsPage.tz.followDevice', { tz: fmtTimeZone(browserTz) })}</option>
                {SUPPORTED_TIMEZONES.map((z) => (
                  <option key={z} value={z}>
                    {TIMEZONE_LABELS[z]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button onClick={submit} loading={submitting} disabled={!dirty}>
            {t('settingsPage.tz.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function LanguageCard() {
  const { user, refreshUser } = useAuth();
  const { setLang, t } = useI18n();
  const [language, setLanguage] = useState<EmailLanguage | ''>(user?.language ?? '');
  const [submitting, setSubmitting] = useState(false);
  const dirty = (user?.language ?? '') !== language;

  const submit = async () => {
    setSubmitting(true);
    try {
      await updateLanguage(language === '' ? null : language);
      // The UI follows the choice (Brief 2-1b: Turkish is a UI language too, English where a string is not yet translated).
      if (isLang(language)) setLang(language);
      if (language === '') setLang('en');
      toast.success(language === '' ? t('settingsPage.lang.cleared') : t('settingsPage.lang.updated'));
      await refreshUser();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('settingsPage.updateFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Languages className="h-4 w-4 text-gold" />
          {t('common.language')}
        </CardTitle>
        <CardDescription>
          {t('settingsPage.lang.desc')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('settingsPage.lang.label')} className="flex-1 min-w-[240px]">
            {(p) => (
              <Select
                value={language}
                onChange={(e) => setLanguage(e.target.value as EmailLanguage | '')}
                {...p}
              >
                <option value="">{t('settingsPage.lang.englishDefault')}</option>
                {EMAIL_LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {EMAIL_LANGUAGE_LABELS[l]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button onClick={submit} loading={submitting} disabled={!dirty}>
            {t('settingsPage.lang.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SessionsCard() {
  const { t } = useI18n();
  const confirm = useConfirm();
  const [submitting, setSubmitting] = useState(false);

  const onRevoke = async () => {
    if (
      !(await confirm({
        title: t('settingsPage.sessions.confirmTitle'),
        description: t('settingsPage.sessions.confirmDesc'),
        destructive: true,
      }))
    ) {
      return;
    }
    setSubmitting(true);
    try {
      await revokeOtherSessions();
      toast.success(t('settingsPage.sessions.revoked'));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('settingsPage.sessions.revokeFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LogOut className="h-4 w-4 text-gold" />
          {t('settingsPage.sessions.title')}
        </CardTitle>
        <CardDescription>
          {t('settingsPage.sessions.desc')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex justify-end">
          <Button onClick={onRevoke} loading={submitting} variant="ghost">
            {t('settingsPage.sessions.button')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** For an associate: where their name, photo, phone and address are kept now — read here, edited on My profile. */
function ProfileOnMeCard() {
  const { user } = useAuth();
  const { t } = useI18n();
  return (
    <Card data-testid="settings-profile-on-me">
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-ink">{[user?.firstName, user?.lastName].filter(Boolean).join(' ') || user?.email}</div>
          <p className="text-sm text-ink-muted">{t('settingsPage.profile.onMe')}</p>
        </div>
        <Button asChild variant="secondary" size="sm">
          <Link to="/me">{t('settingsPage.profile.openMe')}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

/** The profile photo uploader — Settings for a staff account, My profile for an associate. */
export function ProfilePhotoCard() {
  const { user, refreshUser } = useAuth();
  const { t } = useI18n();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  // Picked file awaiting the crop step — the upload happens on the
  // cropped result, never the raw file (see PhotoCropDialog).
  const [cropFile, setCropFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const onPick = () => fileRef.current?.click();

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) {
      toast.error(t('settingsPage.photo.tooBig'));
      return;
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast.error(t('settingsPage.photo.badType'));
      return;
    }
    setCropFile(file);
  };

  const onCropped = async (blob: Blob) => {
    setCropFile(null);
    setBusy('upload');
    try {
      await uploadProfilePhoto(
        new File([blob], 'photo.jpg', { type: 'image/jpeg' }),
      );
      toast.success(t('settingsPage.photo.updated'));
      await refreshUser();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('settingsPage.photo.uploadFailed'));
    } finally {
      setBusy(null);
    }
  };

  const onRemove = async () => {
    if (!(await confirm({ title: t('settingsPage.photo.removeConfirm'), destructive: true }))) return;
    setBusy('remove');
    try {
      await deleteProfilePhoto();
      toast.success(t('settingsPage.photo.removed'));
      await refreshUser();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('settingsPage.photo.removeFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Camera className="h-4 w-4 text-gold" />
          {t('settingsPage.photo.title')}
        </CardTitle>
        <CardDescription>
          {t(user?.role === 'CLIENT_PORTAL' ? 'settingsPage.photo.descPortal' : 'settingsPage.photo.desc')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4">
          <Avatar
            src={user?.photoUrl ?? null}
            name={
              user?.firstName && user.lastName
                ? `${user.firstName} ${user.lastName}`
                : user?.email ?? ''
            }
            email={user?.email ?? ''}
            size="2xl"
            ringed
          />
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onPick} disabled={busy !== null}>
              <Upload className="mr-2 h-4 w-4" />
              {user?.photoUrl ? t('settingsPage.photo.replace') : t('settingsPage.photo.upload')}
            </Button>
            {user?.photoUrl && (
              <Button
                variant="ghost"
                onClick={onRemove}
                disabled={busy !== null}
              >
                {t('settingsPage.remove')}
              </Button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/heic,image/heif"
              onChange={onFile}
              className="hidden"
            />
          </div>
        </div>
      </CardContent>
      {cropFile && (
        <PhotoCropDialog
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onCropped={(blob) => void onCropped(blob)}
        />
      )}
    </Card>
  );
}

function PasswordCard() {
  const { t } = useI18n();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirmPassword, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (newPassword !== confirmPassword) {
      toast.error(t('settingsPage.password.mustMatch'));
      return;
    }
    if (newPassword.length < 12) {
      toast.error(t('settingsPage.password.tooShort'));
      return;
    }
    if (newPassword === currentPassword) {
      toast.error(t('settingsPage.password.mustDiffer'));
      return;
    }
    setSubmitting(true);
    try {
      await changePassword({ currentPassword, newPassword });
      toast.success(t('settingsPage.password.updated'), {
        description: t('settingsPage.password.othersSignedOut'),
      });
      setCurrent('');
      setNew('');
      setConfirm('');
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      if (code === 'invalid_credentials') {
        toast.error(t('settingsPage.wrongPassword'));
      } else if (code === 'invalid_body') {
        toast.error(t('settingsPage.password.requirements'));
      } else {
        toast.error(t('settingsPage.password.changeFailed'), {
          description: err instanceof Error ? err.message : t('common.wentWrong'),
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-gold" />
          {t('settingsPage.password.title')}
        </CardTitle>
        <CardDescription>
          {t('settingsPage.password.desc')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <Field label={t('settingsPage.currentPassword')} required>
            {(p) => (
              <Input
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrent(e.target.value)}
                {...p}
              />
            )}
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label={t('settingsPage.password.new')} required hint={t('settingsPage.password.newHint')}>
              {(p) => (
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNew(e.target.value)}
                  minLength={12}
                  {...p}
                />
              )}
            </Field>
            <Field
              label={t('settingsPage.password.confirm')}
              required
              error={
                confirmPassword && newPassword !== confirmPassword
                  ? t('settingsPage.password.noMatch')
                  : undefined
              }
            >
              {(p) => (
                <Input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirm(e.target.value)}
                  minLength={12}
                  {...p}
                />
              )}
            </Field>
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            onClick={submit}
            loading={submitting}
            disabled={!currentPassword || !newPassword || !confirmPassword}
          >
            {t('settingsPage.password.change')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const ACTION_LABEL: Record<LoginEvent['action'], MessageKey> = {
  'auth.login': 'settingsPage.history.action.login',
  'auth.logout': 'settingsPage.history.action.logout',
  'auth.password_changed': 'settingsPage.history.action.passwordChanged',
  'auth.password_reset_completed': 'settingsPage.history.action.passwordReset',
  'auth.sessions_revoked': 'settingsPage.history.action.sessionsRevoked',
};

function shortenAgent(ua: string | null, t: Translate): string {
  if (!ua) return t('settingsPage.history.unknownDevice');
  // Crude UA → "Chrome on Windows" sniff. Good enough for the bell view;
  // a real "active sessions" feature would parse the full UA.
  const browser =
    /Edg\//i.test(ua)
      ? 'Edge'
      : /Chrome\//i.test(ua)
        ? 'Chrome'
        : /Firefox\//i.test(ua)
          ? 'Firefox'
          : /Safari\//i.test(ua) && !/Chrome\//i.test(ua)
            ? 'Safari'
            : t('settingsPage.history.browser');
  const os =
    /Windows/i.test(ua)
      ? 'Windows'
      : /Macintosh|Mac OS X/i.test(ua)
        ? 'macOS'
        : /iPhone|iPad/i.test(ua)
          ? 'iOS'
          : /Android/i.test(ua)
            ? 'Android'
            : /Linux/i.test(ua)
              ? 'Linux'
              : t('settingsPage.history.unknownOs');
  return t('settingsPage.history.browserOnOs', { browser, os });
}

const LOGIN_HISTORY_PREVIEW = 5;

function LoginHistoryCard() {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const { data: events, error: eventsError } = useQuery({
    queryKey: ['login-history'],
    queryFn: async () => (await getLoginHistory()).events,
  });
  const error = eventsError
    ? eventsError instanceof Error
      ? eventsError.message
      : t('settingsPage.history.loadFailed')
    : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-4 w-4 text-gold" />
          {t('settingsPage.history.title')}
        </CardTitle>
        <CardDescription>
          {t('settingsPage.history.desc')}{' '}
          <span className="inline-flex items-center gap-1 text-warning">
            <ShieldAlert className="h-3 w-3" />
            {t('settingsPage.history.descWarn')}
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <ErrorBanner>{error}</ErrorBanner>
        ) : !events ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-3/4" />
          </div>
        ) : events.length === 0 ? (
          <EmptyState size="sm" title={t('settingsPage.history.empty')} />
        ) : (
          <>
            <DataGrid<(typeof events)[number]>
              id="login-history"
              caption={t('settingsPage.history.caption')}
              rows={expanded ? events : events.slice(0, LOGIN_HISTORY_PREVIEW)}
              rowKey={(ev) => ev.id}
              search={false}
              urlState={false}
              exportCsv={false}
              columnChooser={false}
              columns={[
                { key: 'event', header: t('settingsPage.history.colEvent'), accessor: (ev) => t(ACTION_LABEL[ev.action]), sortable: true, primary: true, className: 'text-white' },
                { key: 'when', header: t('settingsPage.history.colWhen'), accessor: (ev) => ev.at, sortable: true, searchable: false, cardMeta: true, className: 'text-silver', cell: (ev) => fmtDateTime(ev.at) },
                { key: 'device', header: t('settingsPage.history.colDevice'), accessor: (ev) => shortenAgent(ev.userAgent, t), sortable: true, cardMeta: true, className: 'text-silver' },
                { key: 'ip', header: 'IP', accessor: (ev) => ev.ip, sortable: true, className: 'text-silver font-mono text-xs', cell: (ev) => ev.ip ?? '—' },
              ]}
            />
            {events.length > LOGIN_HISTORY_PREVIEW && (
              <div className="mt-3 flex justify-center">
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="inline-flex items-center gap-1.5 text-xs text-silver hover:text-gold-bright transition-colors"
                  aria-expanded={expanded}
                >
                  {expanded ? (
                    <>
                      <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('settingsPage.history.showFewer')}
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('settingsPage.history.showAll', { count: events.length })}
                    </>
                  )}
                </button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
