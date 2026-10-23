import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { finishAvailability } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { Button } from '@/components/ui/Button';
import { AvailabilityEditor } from '@/pages/scheduling/AvailabilityEditor';
import { TaskShell, useNextTask } from './ProfileInfoTask';

/**
 * The onboarding task that asks when a new hire can work (role walk
 * supervisor 11). It embeds the same editor the schedule uses, presets and
 * all; "Done" checks that at least one window is saved and moves on.
 */
export function AvailabilityTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const navigate = useNavigate();
  const { t } = useI18n();
  const next = useNextTask('AVAILABILITY');
  const backTo = `/onboarding/me/${applicationId}`;
  const [finishing, setFinishing] = useState(false);

  const finish = async () => {
    if (!applicationId) return;
    setFinishing(true);
    try {
      await finishAvailability(applicationId);
      navigate(next?.route ?? backTo, { replace: true });
    } catch (err) {
      toast.error(err instanceof ApiError && err.code === 'no_availability' ? t('ob.availability.needOne') : err instanceof ApiError ? err.message : t('ob.availability.needOne'));
    } finally {
      setFinishing(false);
    }
  };

  return (
    <TaskShell title={t('ob.availability.title')} backTo={backTo}>
      <p className="mb-4 text-sm text-silver">{t('ob.availability.intro')}</p>
      <AvailabilityEditor />
      <div className="mt-6 flex justify-end">
        <Button onClick={() => void finish()} loading={finishing}>
          <CheckCircle2 className="h-4 w-4" />
          {next ? next.label : t('ob.availability.done')}
        </Button>
      </div>
    </TaskShell>
  );
}
