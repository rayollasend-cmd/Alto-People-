import { useEffect, useRef, useState } from 'react';
import { Camera, History, KeyRound, ShieldAlert, Upload, User as UserIcon } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { changePassword, getLoginHistory, updateProfile, type LoginEvent } from '@/lib/settingsApi';
import { deleteProfilePhoto, uploadProfilePhoto } from '@/lib/selfApi';
import { ROLE_LABELS } from '@/lib/roles';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Label, FormHint } from '@/components/ui/Label';
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
      <header>
        <h1 className="font-display text-3xl md:text-4xl text-white mb-1">
          Account settings
        </h1>
        <p className="text-silver text-sm">
          {user ? (
            <>
              Signed in as <span className="text-white">{user.email}</span> ·{' '}
              {ROLE_LABELS[user.role]}
            </>
          ) : (
            'Sign in to manage your account.'
          )}
        </p>
      </header>

      {user?.associateId && <ProfileCard />}
      {user?.associateId && <ProfilePhotoCard />}
      <PasswordCard />
      <LoginHistoryCard />
    </div>
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
              />
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
  const [events, setEvents] = useState<LoginEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          <div className="text-sm text-red-300">{error}</div>
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
                    {new Date(e.at).toLocaleString()}
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
