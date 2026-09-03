import { useSearchParams } from 'react-router-dom';
import { Inbox, Send } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { AssociateInboxView } from './AssociateInboxView';
import { AdminCommsView } from './AdminCommsView';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';

/**
 * /communications. Everyone gets a real personal inbox — the bell's
 * "View all in Inbox" used to dump every non-associate onto the outbound
 * send-log table, which meant admins, managers, supervisors, and finance
 * had NO page listing their own notifications past the bell's 50-row cap.
 * Comms managers additionally get the send/broadcast admin view as a
 * second tab (?tab=sends, replace-written per the deep-link convention).
 */
export function CommunicationsHome() {
  const { user, can } = useAuth();
  const canManageComms = can('manage:communications');
  const [params, setParams] = useSearchParams();

  if (user?.role === 'ASSOCIATE' || !canManageComms) {
    return <AssociateInboxView />;
  }

  const tab = params.get('tab') === 'sends' ? 'sends' : 'inbox';
  const setTab = (next: string) => {
    const p = new URLSearchParams(params);
    if (next === 'inbox') p.delete('tab');
    else p.set('tab', next);
    setParams(p, { replace: true });
  };

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="inbox">
          <Inbox className="mr-2 h-4 w-4" /> My inbox
        </TabsTrigger>
        <TabsTrigger value="sends">
          <Send className="mr-2 h-4 w-4" /> Sends & broadcasts
        </TabsTrigger>
      </TabsList>
      <TabsContent value="inbox">
        <AssociateInboxView />
      </TabsContent>
      <TabsContent value="sends">
        <AdminCommsView canManage={canManageComms} />
      </TabsContent>
    </Tabs>
  );
}
