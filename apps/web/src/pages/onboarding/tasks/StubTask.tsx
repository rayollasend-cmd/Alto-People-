import { useParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { TaskShell } from './ProfileInfoTask';

const KIND_LABEL: Record<string, MessageKey> = {
  document_upload: 'ob.stub.kindDocuments',
  e_sign: 'ob.stub.kindESign',
  background_check: 'ob.stub.kindBackground',
  i9_verification: 'ob.stub.kindI9',
  j1_docs: 'ob.stub.kindJ1',
};

export function StubTask() {
  const { applicationId, taskKind } = useParams<{
    applicationId: string;
    taskKind: string;
  }>();
  const { user } = useAuth();
  const { t } = useI18n();

  const label =
    taskKind && KIND_LABEL[taskKind] ? t(KIND_LABEL[taskKind]) : t('ob.stub.task');
  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;

  return (
    <TaskShell title={label} backTo={backTo}>
      <div className="inline-block px-3 py-1 rounded-full bg-gold/10 border border-gold/30 text-gold text-xs uppercase tracking-widest mb-4">
        {t('ob.stub.comingSoon')}
      </div>
      <p className="text-silver text-sm">{t('ob.stub.body')}</p>
    </TaskShell>
  );
}
