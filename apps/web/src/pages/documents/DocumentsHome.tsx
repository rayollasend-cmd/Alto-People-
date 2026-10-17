import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/Button';
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
        secondaryActions={
          <Button asChild variant="outline">
            <Link to="/documents">
              <ArrowLeft className="h-4 w-4" />
              Document vault
            </Link>
          </Button>
        }
      >
        <LettersQueue canManage={can('manage:documents')} />
      </ListTemplate>
    );
  }
  return <AdminDocumentsView canManage={can('manage:documents')} />;
}
