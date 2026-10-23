import { useState } from 'react';
import { Megaphone, Send } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import { useUrlParam } from '@/lib/useUrlState';
import { AssociateInboxView, useInboxEntries } from './AssociateInboxView';
import { AdminCommsView } from './AdminCommsView';
import { WhatsAppAdmin } from './WhatsAppAdmin';
import { Badge, PageHeader, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';

const TABS = ['inbox', 'sends', 'whatsapp'] as const;
type Tab = (typeof TABS)[number];

const SUBTITLES: Record<Exclude<Tab, 'inbox'>, string> = {
  sends: 'Message one person, or broadcast to a client, a department or everyone. Every message is on the log with how it was delivered.',
  whatsapp: 'Notices and answers by WhatsApp, each with its receipt.',
};

/**
 * /communications — "Notifications". Everyone gets their own notifications
 * here (the decision queue is the Inbox; this is not it). People who manage
 * communications also get the sends log and WhatsApp, as tabs under ONE
 * header: the tabs used to sit above the title, and the WhatsApp tab had
 * no title at all. ?tab=sends|whatsapp, pushed so Back steps between tabs.
 */
export function CommunicationsHome() {
  const { user, can } = useAuth();
  const { t } = useI18n();
  const canManageComms = can('manage:communications');
  const [tab, setTab] = useUrlParam<Tab>('tab', 'inbox', TABS, { history: 'push' });
  const [compose, setCompose] = useState<'send' | 'broadcast' | null>(null);
  const inbox = useInboxEntries();
  const unread = inbox.data?.filter((i) => !i.readAt).length ?? 0;

  if (user?.role === 'ASSOCIATE' || !canManageComms) {
    return <AssociateInboxView />;
  }

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
      <PageHeader
        title={t('inbox.title')}
        subtitle={tab === 'inbox' ? t('inbox.subtitle') : SUBTITLES[tab]}
        actions={
          tab === 'sends'
            ? [
                { label: 'Send', icon: Send, primary: true, onSelect: () => setCompose('send') },
                { label: 'New broadcast', icon: Megaphone, onSelect: () => setCompose('broadcast') },
              ]
            : undefined
        }
      >
        <TabsList>
          <TabsTrigger value="inbox">
            {t('inbox.title')}
            {unread > 0 && (
              <Badge variant="accent" className="ml-2 tabular-nums">
                {unread}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="sends">
            {/* Three tabs fit a phone only with the short name. */}
            <span className="sm:hidden">Sends</span>
            <span className="hidden sm:inline">Sends & broadcasts</span>
          </TabsTrigger>
          <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
        </TabsList>
      </PageHeader>
      <TabsContent value="inbox">
        <AssociateInboxView embedded />
      </TabsContent>
      <TabsContent value="sends">
        <AdminCommsView canManage={canManageComms} compose={compose} onComposeChange={setCompose} />
      </TabsContent>
      <TabsContent value="whatsapp">
        <WhatsAppAdmin />
      </TabsContent>
    </Tabs>
  );
}
