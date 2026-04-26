import { useParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { TaskShell } from './ProfileInfoTask';

const KIND_LABEL: Record<string, string> = {
  document_upload: 'Identity documents',
  e_sign: 'Document e-signatures',
  background_check: 'Background check',
  i9_verification: 'I-9 verification',
  j1_docs: 'J-1 documents',
};

export function StubTask() {
  const { applicationId, taskKind } = useParams<{
    applicationId: string;
    taskKind: string;
  }>();
  const { user } = useAuth();

  const label = (taskKind && KIND_LABEL[taskKind]) ?? 'Task';
  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;

  return (
    <TaskShell title={label} backTo={backTo}>
      <div className="inline-block px-3 py-1 rounded-full bg-gold/10 border border-gold/30 text-gold text-xs uppercase tracking-widest mb-4">
        Coming in a future phase
      </div>
      <p className="text-silver text-sm">
        This onboarding step requires integration work that's scheduled for a
        later phase (S3 file storage, signature pad UX, or third-party APIs).
        HR can mark it complete from the application detail page in the meantime.
      </p>
    </TaskShell>
  );
}
