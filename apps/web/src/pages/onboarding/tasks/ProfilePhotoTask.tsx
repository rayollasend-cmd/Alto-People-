import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Camera, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { uploadProfilePhoto } from '@/lib/selfApi';
import { finishProfilePhoto } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { TaskShell, useNextTask } from './ProfileInfoTask';
import { DocumentCapture } from '@/components/DocumentCapture';
import { PhotoCropDialog } from '@/components/PhotoCropDialog';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';

/**
 * PROFILE_PHOTO onboarding task — the Uber-style live headshot. Camera
 * only in this flow (no file picker): the point is a current, real photo
 * of the person onboarding, taken on the spot. Capture (front camera,
 * mirrored preview) → position/zoom through the same PhotoCropDialog every
 * photo goes through → uploads the 512px crop → completes the checklist
 * task. If a photo is already on file (HR set one from the People drawer
 * — the escape hatch for broken cameras), the associate can accept it
 * as-is or retake.
 */
export function ProfilePhotoTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();
  const { t } = useI18n();

  const [cameraOpen, setCameraOpen] = useState(false);
  const [cropFile, setCropFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;
  const next = useNextTask('PROFILE_PHOTO');
  const hasPhoto = Boolean(user?.photoUrl);
  const displayName =
    user?.firstName && user.lastName
      ? `${user.firstName} ${user.lastName}`
      : (user?.email ?? '');

  const done = () => {
    toast.success(t('ob.photo.saved'));
    navigate(next?.route ?? backTo, { replace: true });
  };

  // Path A: fresh capture — crop, upload, then flip the task.
  const onCropped = async (blob: Blob) => {
    setCropFile(null);
    if (!applicationId) return;
    setBusy(true);
    try {
      await uploadProfilePhoto(
        new File([blob], 'profile-photo.jpg', { type: 'image/jpeg' }),
      );
      await finishProfilePhoto(applicationId);
      // Refresh the session so the Topbar avatar and this page's preview
      // pick up the new photo; not awaited into the navigation path.
      void refreshUser();
      done();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('ob.photo.saveFailed'));
      setBusy(false);
    }
  };

  // Path B: a photo is already on file — accepting it just flips the task.
  const useCurrent = async () => {
    if (!applicationId) return;
    setBusy(true);
    try {
      await finishProfilePhoto(applicationId);
      done();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('ob.photo.failed'));
      setBusy(false);
    }
  };

  return (
    <TaskShell title={t('ob.photo.title')} backTo={backTo}>
      {cameraOpen ? (
        <DocumentCapture
          filenameBase="profile-photo"
          facingMode="user"
          mirror
          onCapture={(file) => {
            setCameraOpen(false);
            setCropFile(file);
          }}
          onCancel={() => setCameraOpen(false)}
        />
      ) : (
        <div className="space-y-5">
          <p className="text-sm text-silver">{t('ob.photo.intro')}</p>

          <div className="flex items-center gap-4">
            <Avatar
              src={user?.photoUrl ?? null}
              name={displayName}
              email={user?.email ?? ''}
              size="2xl"
              ringed
            />
            {hasPhoto && (
              <div className="flex items-center gap-1.5 text-sm text-silver">
                <CheckCircle2 className="h-4 w-4 text-success" />
                {t('ob.photo.onFile')}
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => setCameraOpen(true)} disabled={busy}>
              <Camera className="mr-2 h-4 w-4" />
              {hasPhoto ? t('ob.photo.retake') : t('ob.photo.openCamera')}
            </Button>
            {hasPhoto && (
              <Button variant="outline" onClick={() => void useCurrent()} loading={busy}>
                {next
                  ? t('ob.photo.useAndContinue', { next: next.label })
                  : t('ob.photo.usePhoto')}
              </Button>
            )}
          </div>

          <p className="text-xs text-silver">{t('ob.photo.cameraHelp')}</p>
        </div>
      )}

      {cropFile && (
        <PhotoCropDialog
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onCropped={(blob) => void onCropped(blob)}
        />
      )}
    </TaskShell>
  );
}
