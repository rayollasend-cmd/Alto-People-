import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { I9Tab } from './I9Tab';
import { EVerifyTab } from './EVerifyTab';
import { BackgroundTab } from './BackgroundTab';
import { DrugTestTab } from './DrugTestTab';
import { J1Tab } from './J1Tab';
import { ComplianceScorecard } from './ComplianceScorecard';
import { PageHeader } from '@/components/ui/PageHeader';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';

type Tab = 'scorecard' | 'i9' | 'everify' | 'background' | 'drugtests' | 'j1';

export function ComplianceHome() {
  const { can } = useAuth();
  const canManage = can('manage:compliance');
  // Scorecard is the new default landing — preventative dashboard. The
  // existing forensic tabs (I-9 / background / J-1) stay as drill-downs.
  // ?tab= lets other pages deep-link a specific directorate (the profile
  // document vault links each category to its owning tab).
  const [searchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab');
  const [tab, setTab] = useState<Tab>(
    requestedTab &&
      ['scorecard', 'i9', 'everify', 'background', 'drugtests', 'j1'].includes(requestedTab)
      ? (requestedTab as Tab)
      : 'scorecard',
  );

  return (
    <div className="mx-auto">
      <PageHeader
        title="Compliance"
        subtitle="Track I-9, background-check, drug-test, and J-1 obligations across every active associate."
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="scorecard">Scorecard</TabsTrigger>
          <TabsTrigger value="i9">I-9 verification</TabsTrigger>
          {/* Sits next to I-9 because E-Verify is downstream of it — the
              verifier finishes Section 2 and moves straight here. */}
          <TabsTrigger value="everify">E-Verify</TabsTrigger>
          <TabsTrigger value="background">Background checks</TabsTrigger>
          <TabsTrigger value="drugtests">Drug tests</TabsTrigger>
          <TabsTrigger value="j1">J-1 program</TabsTrigger>
        </TabsList>
        <TabsContent value="scorecard">
          <ComplianceScorecard />
        </TabsContent>
        <TabsContent value="i9">
          <I9Tab canManage={canManage} />
        </TabsContent>
        <TabsContent value="everify">
          <EVerifyTab canManage={canManage} />
        </TabsContent>
        <TabsContent value="background">
          <BackgroundTab canManage={canManage} />
        </TabsContent>
        <TabsContent value="drugtests">
          <DrugTestTab canManage={canManage} />
        </TabsContent>
        <TabsContent value="j1">
          <J1Tab canManage={canManage} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
