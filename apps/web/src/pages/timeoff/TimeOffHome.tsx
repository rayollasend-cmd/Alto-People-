import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { AssociateTimeOffView } from './AssociateTimeOffView';
import { AdminTimeOffView } from './AdminTimeOffView';
import { AdminTimeOffEntitlementsView } from './AdminTimeOffEntitlementsView';
import { PageHeader } from '@/components/ui/PageHeader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';

type Tab = 'requests' | 'entitlements';

export function TimeOffHome() {
  const { user, can } = useAuth();
  const isAssociate = user?.role === 'ASSOCIATE';
  const canManage = can('manage:time');
  const [tab, setTab] = useState<Tab>('requests');

  if (isAssociate) {
    return <AssociateTimeOffView />;
  }
  return (
    <div className="mx-auto">
      <PageHeader
        title="Time off"
        subtitle="Approve requests and manage entitlement balances by policy."
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="requests">Requests</TabsTrigger>
          <TabsTrigger value="entitlements">Entitlements</TabsTrigger>
        </TabsList>
        <TabsContent value="requests">
          <AdminTimeOffView canManage={canManage} />
        </TabsContent>
        <TabsContent value="entitlements">
          <AdminTimeOffEntitlementsView canManage={canManage} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
