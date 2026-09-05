import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { authorizeBackgroundCheck } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { TaskShell, inputCls, Field, useNextTask } from './ProfileInfoTask';
import { Button } from '@/components/ui/Button';

export function BackgroundCheckTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const { t } = useI18n();
  const navigate = useNavigate();

  const disclosure = [
    t('ob.bg.disclosureIntro'),
    '',
    t('ob.bg.disclosureRightsTitle'),
    ` • ${t('ob.bg.disclosureRightCopy')}`,
    ` • ${t('ob.bg.disclosureRightDispute')}`,
    ` • ${t('ob.bg.disclosureRightWithdraw')}`,
    '',
    t('ob.bg.disclosureSummary'),
  ].join('\n');

  const [typedName, setTypedName] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;
  const next = useNextTask('BACKGROUND_CHECK');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!applicationId || submitting) return;
    if (!typedName.trim()) {
      setError(t('ob.bg.nameRequired'));
      return;
    }
    if (!accepted) {
      setError(t('ob.bg.checkboxRequired'));
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await authorizeBackgroundCheck(applicationId, {
        typedName: typedName.trim(),
        authorize: true,
      });
      toast.success(t('ob.bg.authorizedToast'));
      navigate(next?.route ?? backTo, { replace: true });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : null;
      if (code === 'name_mismatch') {
        setError(t('ob.bg.nameMismatch'));
      } else {
        setError(err instanceof ApiError ? err.message : t('ob.bg.authFailed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <TaskShell title={t('ob.bg.title')} backTo={backTo}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-md border border-navy-secondary bg-navy-secondary/40 p-4 text-sm text-silver whitespace-pre-line leading-relaxed">
          {disclosure}
        </div>

        <label className="flex items-start gap-2 text-sm text-silver">
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-navy-secondary bg-navy text-gold focus:ring-gold focus:ring-offset-0 cursor-pointer"
          />
          <span>{t('ob.bg.consent')}</span>
        </label>

        <Field label={t('ob.bg.typedNameLabel')}>
          <input
            type="text"
            value={typedName}
            onChange={(e) => setTypedName(e.target.value)}
            className={inputCls}
            placeholder={t('ob.bg.typedNamePlaceholder')}
            autoComplete="name"
            required
          />
        </Field>

        {error && (
          <p role="alert" className="text-sm text-alert">
            {error}
          </p>
        )}

        <div className="flex items-center gap-3 pt-2">
          <Button
            type="submit"
            loading={submitting}
            disabled={submitting || !accepted || !typedName.trim()}
          >
            {!submitting && <ShieldCheck className="h-4 w-4" />}
            {submitting
              ? t('ob.bg.authorizing')
              : next
                ? t('ob.bg.authorizeContinue', { next: next.label })
                : t('ob.bg.authorize')}
          </Button>
          <Link to={backTo} className="text-sm text-silver hover:text-white">
            {t('common.cancel')}
          </Link>
        </div>
      </form>
    </TaskShell>
  );
}
