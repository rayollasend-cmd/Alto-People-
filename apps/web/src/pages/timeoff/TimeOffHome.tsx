import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { AssociateTimeOffView } from './AssociateTimeOffView';
import { AdminTimeOffView } from './AdminTimeOffView';
import { AdminTimeOffEntitlementsView } from './AdminTimeOffEntitlementsView';

const TABS = [
  { key: 'requests', label: 'Requests' },
  { key: 'entitlements', label: 'Entitlements' },
] as const;

type Tab = (typeof TABS)[number]['key'];

export function TimeOffHome() {
  const { user, can } = useAuth();
  const isAssociate = user?.role === 'ASSOCIATE';
  const canManage = can('manage:time');
  const [tab, setTab] = useState<Tab>('requests');

  if (isAssociate) {
    return <AssociateTimeOffView />;
  }
  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-5 flex gap-1 border-b border-navy-secondary">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors',
              tab === t.key
                ? 'border-gold text-white'
                : 'border-transparent text-silver hover:text-white'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'requests' && <AdminTimeOffView canManage={canManage} />}
      {tab === 'entitlements' && (
        <AdminTimeOffEntitlementsView canManage={canManage} />
      )}
    </div>
  );
}
