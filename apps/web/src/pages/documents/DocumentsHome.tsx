import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { ListTemplate } from '@/components/templates';
import { AssociateDocumentsView } from './AssociateDocumentsView';
import { AdminDocumentsView } from './AdminDocumentsView';
import { LettersQueue } from './LettersQueue';

export function DocumentsHome() {
  const { user, can } = useAuth();
  const [params] = useSearchParams();
  if (user?.role === 'ASSOCIATE') {
    return <AssociateDocumentsView />;
  }
  // ?tab=letters — the verification letters people asked for (the Inbox links here).
  if (params.get('tab') === 'letters' && can('view:hr-admin')) {
    return (
      <ListTemplate
        title="Verification letters"
        subtitle="Proof of employment and income people asked for. Approving freezes the facts into the letter; declining sends your reason."
        breadcrumbs={[{ label: 'Documents', to: '/documents' }, { label: 'Verification letters' }]}
        // A sibling of the vault, linked — not a back button beside the crumb.
        related={[
          { label: 'Document vault', to: '/documents' },
          { label: 'Document templates', to: '/templates' },
        ]}
      >
        <LettersQueue canManage={can('manage:documents')} />
      </ListTemplate>
    );
  }
  return <AdminDocumentsView canManage={can('manage:documents')} />;
}
