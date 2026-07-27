import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { AssociateTimeOffView } from './AssociateTimeOffView';
import { AdminTimeOffView } from './AdminTimeOffView';
import { AdminTimeOffEntitlementsView } from './AdminTimeOffEntitlementsView';
import { PageHeader } from '@/components/ui/PageHeader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';

type Tab = 'requests' | 'entitlements' | 'mine';

export function TimeOffHome() {
  const { user, can } = useAuth();
  const isAssociate = user?.role === 'ASSOCIATE';
  const canManage = can('manage:time');
  // Managers/HR who are ALSO on the roster (linked associate record) get a
  // "My time off" tab so they can request their own leave without a second
  // account.
  const hasOwnTimeOff = Boolean(user?.associateId);
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
          {hasOwnTimeOff && <TabsTrigger value="mine">My time off</TabsTrigger>}
        </TabsList>
        <TabsContent value="requests">
          <AdminTimeOffView canManage={canManage} />
        </TabsContent>
        <TabsContent value="entitlements">
          <AdminTimeOffEntitlementsView canManage={canManage} />
        </TabsContent>
        {hasOwnTimeOff && (
          <TabsContent value="mine">
            <AssociateTimeOffView />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
