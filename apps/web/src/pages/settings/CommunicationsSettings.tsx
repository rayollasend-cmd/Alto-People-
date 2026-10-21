import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckCircle2, CircleSlash, MessageCircle, Plug } from 'lucide-react';
import { CATEGORY_ROLE_ROUTING, ROLE_LABELS, type NotificationChannel, type Role } from '@alto-people/shared';
import { listChannels } from '@/lib/communicationsApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { SuppressionListCard } from '@/pages/communications/AdminCommsView';

/**
 * Settings & trust → Communications: how the organization talks to its
 * people, in one place — which channels can actually send (and why one
 * can't), WhatsApp, the do-not-email list, and who hears about which kind
 * of system notice. Sending itself stays on the Communications page.
 */

const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  IN_APP: 'In-app inbox',
  EMAIL: 'Email',
  SMS: 'SMS',
  PUSH: 'Push',
  WHATSAPP: 'WhatsApp',
};

/** Plain words for the routing table's raw category keys. */
const CATEGORY_LABEL: Record<string, string> = {
  onboarding: 'Onboarding and new hires',
  'internal-jobs': 'Internal job applications',
  documents: 'Documents',
  'hr-cases': 'HR cases',
  benefits: 'Benefits',
  reimbursements: 'Reimbursements',
  separation: 'Separations',
  dormancy: 'Dormant accounts',
  'ops.': 'Store operations',
  scheduling: 'Scheduling',
  shift_no_show: 'No-shows',
  ot_radar: 'Overtime alerts',
  'time-off': 'Time off',
  compliance: 'Compliance (including attestation reminders)',
};

export function CommunicationsSettings() {
  const channels = useQuery({ queryKey: ['communications', 'channels'], queryFn: listChannels, staleTime: 5 * 60_000 });

  return (
    <div className="space-y-6">
      <PageHeader title="Communications" subtitle="Which channels can send, WhatsApp, the do-not-email list, and who hears about what." />

      <Card>
        <CardContent className="space-y-3">
          <SectionTitle
            as="h2"
            title="Channels"
            description="What a message or broadcast can go out by. A channel with nothing connected behind it is offered disabled, with this reason, everywhere you send."
            trailing={
              <Button asChild size="sm" variant="outline">
                <Link to="/integrations">
                  <Plug className="h-3.5 w-3.5" aria-hidden="true" /> Integrations
                </Link>
              </Button>
            }
          />
          {channels.isError ? (
            <QueryError what="the channels" query={channels} />
          ) : !channels.data ? (
            <SkeletonRows count={4} />
          ) : (
            <ul className="divide-y divide-line">
              {channels.data.channels.map((c) => (
                <li key={c.channel} className="flex items-start gap-3 py-2.5 text-sm">
                  {c.available ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  ) : (
                    <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="text-ink">{CHANNEL_LABEL[c.channel]}</span>
                    {c.reason && <span className="block text-xs text-ink-muted">{c.reason}</span>}
                  </span>
                  <Badge variant={c.available ? 'success' : 'outline'}>{c.available ? 'Sending' : 'Not connected'}</Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3">
          <MessageCircle className="h-5 w-5 text-accent" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-ink">WhatsApp</span>
            <span className="block text-xs text-ink-muted">The approved message templates, who has opted in, and the conversation record.</span>
          </span>
          <Button asChild size="sm" variant="outline">
            <Link to="/communications?tab=whatsapp">Open WhatsApp</Link>
          </Button>
        </CardContent>
      </Card>

      <SuppressionListCard />

      <Card>
        <CardContent className="space-y-3">
          <SectionTitle
            as="h2"
            title="Who hears about what"
            description="System notices go to the roles whose job they are, not to everyone allowed to see them. Anything not listed here reaches every admin role. Read-only — set in the product."
          />
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Notification routing by kind</caption>
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-muted">
                  <th scope="col" className="py-2 pr-4 font-medium">
                    Kind of notice
                  </th>
                  <th scope="col" className="py-2 font-medium">
                    Goes to
                  </th>
                </tr>
              </thead>
              <tbody>
                {CATEGORY_ROLE_ROUTING.map(([key, roles]) => (
                  <tr key={key} className="border-b border-line/60 last:border-0">
                    <th scope="row" className="py-2 pr-4 text-left font-normal text-ink">
                      {CATEGORY_LABEL[key] ?? key}
                    </th>
                    <td className="py-2">
                      <span className="flex flex-wrap gap-1">
                        {roles.map((r) => (
                          <Badge key={r} variant="outline">
                            {ROLE_LABELS[r as Role] ?? r}
                          </Badge>
                        ))}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
