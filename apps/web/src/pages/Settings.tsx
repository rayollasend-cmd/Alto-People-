import { useState } from 'react';
import { KeyRound, User as UserIcon } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { changePassword, updateProfile } from '@/lib/settingsApi';
import { ROLE_LABELS } from '@/lib/roles';
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

/**
 * Phase 39 — self-service account settings. Two cards: profile (display
 * name, only meaningful for accounts linked to an Associate row) and
 * password change. The password change route bumps tokenVersion server
 * side and re-issues a cookie; the cookie swap is invisible to the user.
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
      <PasswordCard />
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
