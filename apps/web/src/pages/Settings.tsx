import { useEffect, useRef, useState } from 'react';
import { AtSign, Bell, Camera, CheckCircle2, Clock, Copy, Download, History, KeyRound, Lock, LogOut, RefreshCw, ShieldAlert, ShieldCheck, Upload, User as UserIcon } from 'lucide-react';
import { toast } from 'sonner';
import QRCode from 'qrcode';
import { MFA_RECOVERY_CODE_COUNT, type MfaEnrollStartResponse } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
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
  updateProfile,
  updateTimezone,
  type LoginEvent,
} from '@/lib/settingsApi';
import { deleteProfilePhoto, uploadProfilePhoto } from '@/lib/selfApi';
import {
  ROLE_LABELS,
  SUPPORTED_TIMEZONES,
  TIMEZONE_LABELS,
  type NotificationCategory,
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
import { Input } from '@/components/ui/Input';
import { Label, FormHint } from '@/components/ui/Label';
import { PageHeader } from '@/components/ui/PageHeader';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/Table';

/**
 * Phase 39 — self-service account settings. Cards: profile (display
 * name), profile photo, password, recent sign-in activity. The password
 * change route bumps tokenVersion server side and re-issues a cookie;
 * the cookie swap is invisible to the user.
 */
export function Settings() {
  const { user } = useAuth();

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <PageHeader
        title="Account settings"
        subtitle={
          user
            ? `Signed in as ${user.email} · ${ROLE_LABELS[user.role]}`
            : 'Sign in to manage your account.'
        }
        breadcrumbs={[
          { label: 'Home', to: '/' },
          { label: 'Settings' },
        ]}
      />

      {user?.associateId && <ProfileCard />}
      {user?.associateId && <ProfilePhotoCard />}
      <EmailCard />
      <TimezoneCard />
      <NotificationsCard />
      <PasswordCard />
      <MfaCard />
      <SessionsCard />
      <LoginHistoryCard />
      <DataExportCard />
    </div>
  );
}

function DataExportCard() {
  const [submitting, setSubmitting] = useState(false);

  const onDownload = async () => {
    setSubmitting(true);
    try {
      await downloadDataExport();
      toast.success('Your data export is downloading.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not download your data.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="h-4 w-4 text-gold" />
          Download your data
        </CardTitle>
        <CardDescription>
          Bundle your profile, login history, notification preferences,
          time entries, paystubs, and document records into a ZIP archive.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex justify-end">
          <Button onClick={onDownload} loading={submitting} variant="ghost">
            Download my data
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function MfaCard() {
  const { user, refreshUser } = useAuth();
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
  const [remaining, setRemaining] = useState<number | null>(null);

  const enabled = user?.mfaEnabled ?? false;

  // Pull the recovery-code count when the user is enrolled. This drives the
  // "X of 8 remaining" indicator and re-fetches after regenerate so the new
  // count (8 again) shows up without a page refresh.
  useEffect(() => {
    if (!enabled) {
      setRemaining(null);
      return;
    }
    let cancelled = false;
    getMfaStatus()
      .then((s) => {
        if (!cancelled) setRemaining(s.remainingRecoveryCodes);
      })
      .catch(() => {
        if (!cancelled) setRemaining(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, regeneratedCodes]);

  const onEnable = async () => {
    setBusy(true);
    try {
      const res = await startMfaEnrollment();
      setEnroll(res);
      setAcknowledged(false);
      setCode('');
      const dataUrl = await QRCode.toDataURL(res.provisioningUri, {
        margin: 1,
        width: 192,
        color: { dark: '#0f172a', light: '#ffffff' },
      });
      setQrDataUrl(dataUrl);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not start enrollment.');
    } finally {
      setBusy(false);
    }
  };

  const onConfirm = async () => {
    if (!/^\d{6}$/.test(code)) {
      toast.error('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    try {
      await confirmMfaEnrollment({ code });
      toast.success('Two-step sign-in is on.');
      setEnroll(null);
      setQrDataUrl(null);
      setCode('');
      setAcknowledged(false);
      await refreshUser();
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      if (apiErr?.code === 'invalid_code') {
        toast.error('That code is incorrect or expired.');
      } else if (apiErr?.code === 'no_pending_enrollment') {
        toast.error('Enrollment expired — start again.');
        setEnroll(null);
        setQrDataUrl(null);
      } else {
        toast.error(apiErr?.message ?? 'Could not confirm enrollment.');
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
      toast.error('Enter your current password.');
      return;
    }
    setBusy(true);
    try {
      await disableMfa({ currentPassword: disablePassword });
      toast.success('Two-step sign-in is off.');
      setShowDisable(false);
      setDisablePassword('');
      setRegeneratedCodes(null);
      await refreshUser();
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      if (apiErr?.code === 'invalid_credentials') {
        toast.error('Current password is incorrect.');
      } else {
        toast.error(apiErr?.message ?? 'Could not disable.');
      }
    } finally {
      setBusy(false);
    }
  };

  const onRegenerate = async () => {
    if (regeneratePassword.length < 1) {
      toast.error('Enter your current password.');
      return;
    }
    setBusy(true);
    try {
      const res = await regenerateMfaCodes({ currentPassword: regeneratePassword });
      setRegeneratedCodes(res.recoveryCodes);
      setShowRegenerate(false);
      setRegeneratePassword('');
      toast.success('Recovery codes regenerated.');
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : null;
      if (apiErr?.code === 'invalid_credentials') {
        toast.error('Current password is incorrect.');
      } else if (apiErr?.code === 'mfa_not_enrolled') {
        toast.error('Two-step sign-in is not turned on.');
      } else {
        toast.error(apiErr?.message ?? 'Could not regenerate codes.');
      }
    } finally {
      setBusy(false);
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied.`);
    } catch {
      toast.error('Copy failed — select and copy manually.');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-gold" />
          Two-step sign-in
        </CardTitle>
        <CardDescription>
          {enabled
            ? 'Adds a 6-digit code from your phone on top of your password. Already on for this account.'
            : 'Adds a 6-digit code from your phone on top of your password. We strongly recommend turning this on.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {enroll ? (
          <div className="space-y-4">
            <div className="rounded-md border border-gold/40 bg-gold/10 px-3 py-2 text-xs text-white">
              <strong className="text-gold">Save your recovery codes first.</strong>{' '}
              They are the only way to sign in if you lose your phone. Each code
              works once.
            </div>
            <div className="flex flex-col sm:flex-row gap-4">
              <div className="shrink-0">
                {qrDataUrl ? (
                  <img
                    src={qrDataUrl}
                    alt="Scan with your authenticator app"
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
                  <Label>Manual entry secret</Label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-md bg-navy-secondary/60 px-3 py-2 font-mono text-xs text-white break-all">
                      {enroll.secret}
                    </code>
                    <Button
                      variant="ghost"
                      onClick={() => copy(enroll.secret, 'Secret')}
                      type="button"
                    >
                      <Copy className="h-4 w-4" />
                    </Button>
                  </div>
                  <FormHint>
                    Scan the QR with Google Authenticator, 1Password, Authy, or
                    similar. Or paste the secret if your app supports manual
                    entry.
                  </FormHint>
                </div>
                <div>
                  <Label>Recovery codes</Label>
                  <ul className="grid grid-cols-2 gap-1.5 rounded-md bg-navy-secondary/60 p-3 font-mono text-xs text-white">
                    {enroll.recoveryCodes.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                  <div className="flex items-center justify-between mt-1.5">
                    <FormHint>Print or store in a password manager.</FormHint>
                    <Button
                      variant="ghost"
                      onClick={() => copy(enroll.recoveryCodes.join('\n'), 'Codes')}
                      type="button"
                    >
                      <Copy className="mr-1.5 h-3.5 w-3.5" />
                      Copy all
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
              <span>I've saved my recovery codes somewhere safe.</span>
            </label>
            <div>
              <Label htmlFor="mfa-code" required>
                6-digit code from your authenticator app
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
                Cancel
              </Button>
              <Button
                onClick={onConfirm}
                loading={busy}
                disabled={!acknowledged || code.length !== 6}
              >
                Turn on two-step sign-in
              </Button>
            </div>
          </div>
        ) : enabled ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm text-white">
                <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                Two-step sign-in is on.
              </div>
              {remaining !== null && (
                <span
                  className={`text-xs ${
                    remaining <= 2 ? 'text-amber-300' : 'text-silver'
                  }`}
                >
                  {remaining} of {MFA_RECOVERY_CODE_COUNT} recovery codes remaining
                </span>
              )}
            </div>
            {regeneratedCodes && (
              <div className="space-y-2 rounded-md border border-gold/40 bg-gold/10 p-3">
                <div className="text-xs text-white">
                  <strong className="text-gold">Save these codes now.</strong>{' '}
                  Your previous codes have been invalidated. Each new code works
                  once.
                </div>
                <ul className="grid grid-cols-2 gap-1.5 rounded-md bg-navy-secondary/60 p-3 font-mono text-xs text-white">
                  {regeneratedCodes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
                <div className="flex items-center justify-between">
                  <FormHint>Print or store in a password manager.</FormHint>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      onClick={() => copy(regeneratedCodes.join('\n'), 'Codes')}
                      type="button"
                    >
                      <Copy className="mr-1.5 h-3.5 w-3.5" />
                      Copy all
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setRegeneratedCodes(null)}
                      type="button"
                    >
                      I've saved them
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {showDisable ? (
              <div className="space-y-3 rounded-md border border-navy-secondary bg-navy-secondary/30 p-3">
                <div
                  role="alert"
                  className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
                >
                  Turning this off removes two-step protection immediately.
                  Anyone who knows your password will be able to sign in.
                </div>
                <div>
                  <Label htmlFor="mfa-disable-pw" required>
                    Current password
                  </Label>
                  <Input
                    id="mfa-disable-pw"
                    type="password"
                    autoComplete="current-password"
                    value={disablePassword}
                    onChange={(e) => setDisablePassword(e.target.value)}
                  />
                  <FormHint>
                    We re-check your password before disabling two-step
                    sign-in.
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
                    Cancel
                  </Button>
                  <Button onClick={onDisable} loading={busy}>
                    Turn off two-step sign-in
                  </Button>
                </div>
              </div>
            ) : showRegenerate ? (
              <div className="space-y-3 rounded-md border border-navy-secondary bg-navy-secondary/30 p-3">
                <div>
                  <Label htmlFor="mfa-regen-pw" required>
                    Current password
                  </Label>
                  <Input
                    id="mfa-regen-pw"
                    type="password"
                    autoComplete="current-password"
                    value={regeneratePassword}
                    onChange={(e) => setRegeneratePassword(e.target.value)}
                  />
                  <FormHint>
                    Regenerating issues 8 fresh codes and invalidates every
                    code currently on your printout.
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
                    Cancel
                  </Button>
                  <Button onClick={onRegenerate} loading={busy}>
                    Regenerate codes
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
                  Regenerate codes
                </Button>
                <Button variant="ghost" onClick={() => setShowDisable(true)}>
                  Turn off two-step sign-in
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex justify-end">
            <Button onClick={onEnable} loading={busy}>
              Set up two-step sign-in
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmailCard() {
  const { user } = useAuth();
  const [newEmail, setNewEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const submit = async () => {
    const target = newEmail.trim().toLowerCase();
    if (!target) {
      toast.error('Enter a new email address');
      return;
    }
    if (target === user?.email.toLowerCase()) {
      toast.error('That is already your email');
      return;
    }
    if (currentPassword.length < 12) {
      toast.error('Enter your current password to confirm');
      return;
    }
    setSubmitting(true);
    try {
      await requestEmailChange({ newEmail: target, currentPassword });
      setSentTo(target);
      setNewEmail('');
      setCurrentPassword('');
      toast.success(`Confirmation link sent to ${target}.`);
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      if (code === 'invalid_credentials') {
        toast.error('Current password is incorrect');
      } else if (code === 'email_in_use') {
        toast.error('That email already belongs to another account');
      } else if (code === 'same_email') {
        toast.error('That is already your email');
      } else {
        toast.error('Could not request email change', {
          description: err instanceof Error ? err.message : String(err),
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
          Email address
        </CardTitle>
        <CardDescription>
          Current: <span className="text-white">{user?.email}</span>. Changing
          your email signs you out of every session and emails the old
          address as a security alert.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {sentTo && (
          <div className="mb-4 rounded-md border border-gold/40 bg-gold/10 px-3 py-2 text-xs text-white">
            Confirmation link sent to <span className="font-mono">{sentTo}</span>.
            It expires in 1 hour. Click the link from that inbox to finish
            the change.
          </div>
        )}
        <div className="space-y-3">
          <div>
            <Label htmlFor="set-newemail" required>
              New email
            </Label>
            <Input
              id="set-newemail"
              type="email"
              autoComplete="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              maxLength={254}
              placeholder="you@new-address.com"
            />
          </div>
          <div>
            <Label htmlFor="set-emailpw" required>
              Current password
            </Label>
            <Input
              id="set-emailpw"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
            <FormHint>
              We re-check your password before sending the confirmation link.
            </FormHint>
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            onClick={submit}
            loading={submitting}
            disabled={!newEmail || !currentPassword}
          >
            Send confirmation link
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function NotificationsCard() {
  const [entries, setEntries] = useState<NotificationPreferenceEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<NotificationCategory | null>(null);

  useEffect(() => {
    let cancelled = false;
    getNotificationPreferences()
      .then((res) => {
        if (!cancelled) setEntries(res.entries);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load preferences.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onToggle = async (entry: NotificationPreferenceEntry) => {
    if (entry.mandatory) return;
    setPending(entry.category);
    const next = !entry.emailEnabled;
    // Optimistic update — reverts on failure.
    setEntries((prev) =>
      prev
        ? prev.map((e) =>
            e.category === entry.category ? { ...e, emailEnabled: next } : e,
          )
        : prev,
    );
    try {
      await patchNotificationPreference(entry.category, next);
    } catch (err) {
      setEntries((prev) =>
        prev
          ? prev.map((e) =>
              e.category === entry.category
                ? { ...e, emailEnabled: entry.emailEnabled }
                : e,
            )
          : prev,
      );
      toast.error(err instanceof ApiError ? err.message : 'Failed to update.');
    } finally {
      setPending(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-gold" />
          Email notifications
        </CardTitle>
        <CardDescription>
          Choose which emails Alto sends you. The bell on the topbar always
          shows everything — these toggles only affect email.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <ErrorBanner>{error}</ErrorBanner>
        ) : entries === null ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-3/4" />
          </div>
        ) : (
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
                        Required
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-silver mt-0.5">{e.description}</div>
                </div>
                <label
                  className={`inline-flex items-center cursor-pointer ${
                    e.mandatory ? 'opacity-60 cursor-not-allowed' : ''
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={e.emailEnabled}
                    disabled={e.mandatory || pending === e.category}
                    onChange={() => onToggle(e)}
                  />
                  <div className="w-11 h-6 bg-navy-secondary peer-focus:outline-none rounded-full peer peer-checked:bg-gold/80 transition relative after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition peer-checked:after:translate-x-5" />
                </label>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function TimezoneCard() {
  const { user, refreshUser } = useAuth();
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
          ? 'Timezone preference cleared.'
          : 'Timezone updated.',
      );
      await refreshUser();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to update.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-4 w-4 text-gold" />
          Timezone
        </CardTitle>
        <CardDescription>
          Used to display dates and times across the app. Leave blank to
          follow this device ({browserTz}).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[240px]">
            <Label htmlFor="set-tz">Preferred timezone</Label>
            <Select
              id="set-tz"
              value={tz}
              onChange={(e) => setTz(e.target.value as SupportedTimezone | '')}
            >
              <option value="">Follow this device ({browserTz})</option>
              {SUPPORTED_TIMEZONES.map((z) => (
                <option key={z} value={z}>
                  {TIMEZONE_LABELS[z]}
                </option>
              ))}
            </Select>
          </div>
          <Button onClick={submit} loading={submitting} disabled={!dirty}>
            Save timezone
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SessionsCard() {
  const confirm = useConfirm();
  const [submitting, setSubmitting] = useState(false);

  const onRevoke = async () => {
    if (
      !(await confirm({
        title: 'Sign out everywhere else?',
        description:
          'Every other device or browser signed in to your account will be signed out immediately. This device stays signed in.',
        destructive: true,
      }))
    ) {
      return;
    }
    setSubmitting(true);
    try {
      await revokeOtherSessions();
      toast.success('Other sessions revoked.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to revoke sessions.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LogOut className="h-4 w-4 text-gold" />
          Active sessions
        </CardTitle>
        <CardDescription>
          See a sign-in below you don't recognise? Sign out everywhere else
          immediately. This device keeps its session.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex justify-end">
          <Button onClick={onRevoke} loading={submitting} variant="ghost">
            Sign out everywhere else
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ProfileCard() {
  const { user, refreshUser } = useAuth();
  const [firstName, setFirstName] = useState(user?.firstName ?? '');
  const [lastName, setLastName] = useState(user?.lastName ?? '');
  const [submitting, setSubmitting] = useState(false);

  const dirty =
    firstName.trim() !== (user?.firstName ?? '') ||
    lastName.trim() !== (user?.lastName ?? '');

  const submit = async () => {
    const f = firstName.trim();
    const l = lastName.trim();
    if (!dirty) {
      toast.error('Make a change first');
      return;
    }
    setSubmitting(true);
    try {
      const updated = await updateProfile({
        firstName: f,
        lastName: l,
      });
      toast.success('Profile updated', {
        description: `Display name is now ${updated.firstName} ${updated.lastName}.`,
      });
      // Re-fetch /auth/me so the chrome avatar/name update without reload.
      await refreshUser();
    } catch (err) {
      toast.error('Could not update profile', {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserIcon className="h-4 w-4 text-gold" />
          Display name
        </CardTitle>
        <CardDescription>
          How your name appears on shifts, paystubs, and inbox messages.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="set-first">First name</Label>
            <Input
              id="set-first"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              maxLength={100}
            />
          </div>
          <div>
            <Label htmlFor="set-last">Last name</Label>
            <Input
              id="set-last"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              maxLength={100}
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={submit} loading={submitting} disabled={!dirty}>
            Save profile
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ProfilePhotoCard() {
  const { user, refreshUser } = useAuth();
  const confirm = useConfirm();
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const onPick = () => fileRef.current?.click();

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Photo must be 5MB or smaller.');
      return;
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast.error('Photo must be PNG, JPEG, or WebP.');
      return;
    }
    setBusy('upload');
    try {
      await uploadProfilePhoto(file);
      toast.success('Photo updated.');
      await refreshUser();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to upload.');
    } finally {
      setBusy(null);
    }
  };

  const onRemove = async () => {
    if (!(await confirm({ title: 'Remove your profile photo?', destructive: true }))) return;
    setBusy('remove');
    try {
      await deleteProfilePhoto();
      toast.success('Photo removed.');
      await refreshUser();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed to remove.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Camera className="h-4 w-4 text-gold" />
          Profile photo
        </CardTitle>
        <CardDescription>
          Shown on the directory and next to your name across the app. PNG,
          JPEG, or WebP up to 5MB.
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
            size="lg"
            ringed
          />
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onPick} disabled={busy !== null}>
              <Upload className="mr-2 h-4 w-4" />
              {user?.photoUrl ? 'Replace photo' : 'Upload photo'}
            </Button>
            {user?.photoUrl && (
              <Button
                variant="ghost"
                onClick={onRemove}
                disabled={busy !== null}
              >
                Remove
              </Button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={onFile}
              className="hidden"
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PasswordCard() {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirmPassword, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const mismatch = confirmPassword !== '' && confirmPassword !== newPassword;

  const submit = async () => {
    if (newPassword !== confirmPassword) {
      toast.error('New password and confirmation must match');
      return;
    }
    if (newPassword.length < 12) {
      toast.error('New password must be at least 12 characters');
      return;
    }
    if (newPassword === currentPassword) {
      toast.error('New password must differ from your current password');
      return;
    }
    setSubmitting(true);
    try {
      await changePassword({ currentPassword, newPassword });
      toast.success('Password updated', {
        description: 'Other devices have been signed out.',
      });
      setCurrent('');
      setNew('');
      setConfirm('');
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      if (code === 'invalid_credentials') {
        toast.error('Current password is incorrect');
      } else if (code === 'invalid_body') {
        toast.error('Password does not meet requirements');
      } else {
        toast.error('Could not change password', {
          description: err instanceof Error ? err.message : String(err),
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
          Password
        </CardTitle>
        <CardDescription>
          Changing your password signs out every other device. Minimum 12
          characters.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div>
            <Label htmlFor="set-current" required>
              Current password
            </Label>
            <Input
              id="set-current"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="set-new" required>
                New password
              </Label>
              <Input
                id="set-new"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNew(e.target.value)}
                minLength={12}
              />
              <FormHint>At least 12 characters.</FormHint>
            </div>
            <div>
              <Label htmlFor="set-confirm" required>
                Confirm new password
              </Label>
              <Input
                id="set-confirm"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirm(e.target.value)}
                minLength={12}
                invalid={mismatch}
                aria-describedby={mismatch ? 'set-confirm-error' : undefined}
              />
              {mismatch && (
                <FormHint id="set-confirm-error" variant="error">
                  Passwords don't match.
                </FormHint>
              )}
            </div>
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            onClick={submit}
            loading={submitting}
            disabled={!currentPassword || !newPassword || !confirmPassword}
          >
            Change password
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

const ACTION_LABEL: Record<LoginEvent['action'], string> = {
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'auth.password_changed': 'Password changed',
  'auth.password_reset_completed': 'Password reset',
  'auth.sessions_revoked': 'Other sessions revoked',
};

function shortenAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
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
            : 'Browser';
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
              : 'Unknown OS';
  return `${browser} on ${os}`;
}

function LoginHistoryCard() {
  const { user } = useAuth();
  const [events, setEvents] = useState<LoginEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // When the user has a saved timezone, format every timestamp through it
  // so the table reads consistently across devices. Falls back to the
  // browser locale when null. Constructed once per render — DateTimeFormat
  // throws on bad TZ strings, so guard with a try/catch.
  const formatter = (() => {
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: user?.timezone ?? undefined,
      });
    } catch {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
    }
  })();

  useEffect(() => {
    let cancelled = false;
    getLoginHistory()
      .then((res) => {
        if (!cancelled) setEvents(res.events);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load activity.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-4 w-4 text-gold" />
          Recent sign-in activity
        </CardTitle>
        <CardDescription>
          Last 25 sign-ins, sign-outs, and password changes on your account.
          Spot something you don't recognise?{' '}
          <span className="inline-flex items-center gap-1 text-amber-300">
            <ShieldAlert className="h-3 w-3" />
            change your password and notify HR.
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error ? (
          <ErrorBanner>{error}</ErrorBanner>
        ) : events === null ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-3/4" />
          </div>
        ) : events.length === 0 ? (
          <div className="text-sm text-silver">No activity recorded yet.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>When</TableHead>
                <TableHead>Device</TableHead>
                <TableHead>IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-white">{ACTION_LABEL[e.action]}</TableCell>
                  <TableCell className="text-silver">
                    {formatter.format(new Date(e.at))}
                  </TableCell>
                  <TableCell className="text-silver">
                    {shortenAgent(e.userAgent)}
                  </TableCell>
                  <TableCell className="text-silver font-mono text-xs">
                    {e.ip ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
