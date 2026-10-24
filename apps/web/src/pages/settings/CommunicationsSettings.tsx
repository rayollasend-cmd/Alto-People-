import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CheckCircle2, CircleSlash, Mail, MessageCircle, Plug } from '@/components/ui/icons';
import { toast } from 'sonner';
import { CATEGORY_ROLE_ROUTING, ROLE_LABELS, type NotificationChannel, type Role } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { listChannels, sendTestEmail } from '@/lib/communicationsApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { SuppressionListCard } from '@/pages/communications/AdminCommsView';
import { WhatsAppTemplatesCard } from '@/pages/communications/WhatsAppAdmin';

/**
 * Settings & trust → Communications: how the organization talks to its
 * people, in one place — which channels can actually send (and, when one
 * can't, who connects it: no circular "set one up in Settings ›
 * Communications" on this very page), a test email, the WhatsApp templates
 * to register, the do-not-email list, and who hears about which kind of
 * system notice. Sending itself stays on the Notifications page.
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
  const qc = useQueryClient();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ delivered: boolean; to: string; reason: string | null } | null>(null);
  const developerNotes = (channels.data?.channels ?? []).filter((c) => !c.available && c.developerNote);

  const runTest = async () => {
    setTesting(true);
    try {
      const r = await sendTestEmail();
      setTestResult({ delivered: r.delivered, to: r.to, reason: r.notification.failureReason });
      if (r.delivered) toast.success(`Test email sent to ${r.to}.`);
      void qc.invalidateQueries({ queryKey: ['AdminCommsView'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send the test email.');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Communications" subtitle="Which channels can send, WhatsApp, the do-not-email list, and who hears about what." />

      <Card>
        <CardContent className="space-y-3">
          <SectionTitle
            as="h2"
            title="Channels"
            description="What a message or broadcast can go out by. A channel that isn't connected is offered disabled, with this reason, everywhere you send."
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
                <li key={c.channel} className="flex flex-wrap items-start gap-3 py-2.5 text-sm">
                  {c.available ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  ) : (
                    <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="text-ink">{CHANNEL_LABEL[c.channel]}</span>
                    {c.reason && <span className="block text-xs text-ink-muted">{c.reason}</span>}
                    {c.channel === 'EMAIL' && (
                      <Button size="sm" variant="outline" className="mt-2" loading={testing} onClick={() => void runTest()}>
                        <Mail className="h-3.5 w-3.5" aria-hidden="true" /> Send test email
                      </Button>
                    )}
                  </span>
                  <Badge variant={c.available ? 'success' : 'outline'}>{c.available ? 'Sending' : 'Not connected'}</Badge>
                </li>
              ))}
            </ul>
          )}
          {testResult && !testResult.delivered && (
            <p className="rounded-md border border-line bg-surface-raised px-3 py-2 text-sm text-ink" role="status">
              {testResult.reason
                ? `The test email to ${testResult.to} didn’t go out: ${testResult.reason}`
                : `No email went to ${testResult.to}: there's no email provider connected, so the message was written to the server log instead. It's on the sent log as "Not sent".`}
            </p>
          )}
          {testResult?.delivered && (
            <p className="text-sm text-ink-muted" role="status">
              Sent to {testResult.to}. If it doesn’t arrive in a few minutes, check the spam folder, then the sent log.
            </p>
          )}
          {(developerNotes.length > 0 || channels.data?.channels.some((c) => !c.available)) && (
            <div className="space-y-1 text-sm text-ink-muted">
              <p>
                Connecting email, texting or push is done once for the whole organization.{' '}
                <Link to="/support" className="text-accent underline-offset-2 hover:underline">
                  Ask Alto People support
                </Link>{' '}
                to connect a channel.
              </p>
              {developerNotes.length > 0 && (
                <details className="rounded-md border border-line px-3 py-2">
                  <summary className="cursor-pointer text-xs">For developers</summary>
                  <ul className="mt-2 space-y-1 text-xs">
                    {developerNotes.map((c) => (
                      <li key={c.channel}>
                        <span className="text-ink">{CHANNEL_LABEL[c.channel]}:</span> {c.developerNote}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <WhatsAppTemplatesCard />
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3">
          <MessageCircle className="h-5 w-5 text-accent" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-ink">WhatsApp record</span>
            <span className="block text-xs text-ink-muted">Who has opted in, the week's deliveries, and every message with its receipt.</span>
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
