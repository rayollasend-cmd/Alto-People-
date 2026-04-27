import { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { I9Tab } from './I9Tab';
import { BackgroundTab } from './BackgroundTab';
import { J1Tab } from './J1Tab';
import { PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';

type Tab = 'i9' | 'background' | 'j1';

export function ComplianceHome() {
  const { can } = useAuth();
  const canManage = can('manage:compliance');
  const [tab, setTab] = useState<Tab>('i9');

  return (
    <div className="max-w-6xl mx-auto">
      <PageHeader
        title="Compliance"
        subtitle={
          canManage
            ? 'Track I-9, background checks, and J-1 program status across associates.'
            : 'Read-only view of compliance state.'
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="i9">I-9 verification</TabsTrigger>
          <TabsTrigger value="background">Background checks</TabsTrigger>
          <TabsTrigger value="j1">J-1 program</TabsTrigger>
        </TabsList>
        <TabsContent value="i9">
          <I9Tab canManage={canManage} />
        </TabsContent>
        <TabsContent value="background">
          <BackgroundTab canManage={canManage} />
        </TabsContent>
        <TabsContent value="j1">
          <J1Tab canManage={canManage} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
