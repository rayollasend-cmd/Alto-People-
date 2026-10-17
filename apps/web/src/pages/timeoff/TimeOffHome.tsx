import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { AssociateTimeOffView } from './AssociateTimeOffView';
import { AdminTimeOffView } from './AdminTimeOffView';
import { AdminTimeOffEntitlementsView } from './AdminTimeOffEntitlementsView';
import { TimeOffPoliciesView } from './TimeOffPoliciesView';
import { ListTemplate } from '@/components/templates';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';

type Tab = 'requests' | 'policies' | 'entitlements' | 'mine';

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
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        className="mx-auto"
        title="Time off"
        subtitle="Approve requests, set how leave is earned, and manage entitlement balances."
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="requests">Requests</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
          <TabsTrigger value="entitlements">Entitlements</TabsTrigger>
          {hasOwnTimeOff && <TabsTrigger value="mine">My time off</TabsTrigger>}
        </TabsList>
        <TabsContent value="requests">
          <AdminTimeOffView canManage={canManage} />
        </TabsContent>
        <TabsContent value="policies">
          <TimeOffPoliciesView canManage={canManage} />
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
    </ListTemplate>
  );
}
