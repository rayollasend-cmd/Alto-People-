import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import { TERM_LANGS, type WhatsAppMessageRow, type WhatsAppMessageStatus } from '@alto-people/shared';
import { fmtDateTime } from '@/lib/format';
import { getWhatsAppOverview, listWhatsAppMessages } from '@/lib/whatsappApi';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Badge } from '@/components/ui/Badge';
import { statusLabel } from '@/lib/status';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid } from '@/components/ui/DataGrid';
import { EmptyState } from '@/components/ui/EmptyState';
import { MetricCard } from '@/components/ui/MetricCard';
import { QueryError } from '@/components/ui/QueryError';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * WhatsApp as a channel (Brief 1C-4): is it wired, what went out, what
 * came back, and the exact templates to register in WhatsApp Manager.
 */

const STATUS_VARIANT: Record<WhatsAppMessageStatus, 'pending' | 'success' | 'info' | 'destructive' | 'default'> = {
  QUEUED: 'default',
  SENT: 'pending',
  DELIVERED: 'success',
  READ: 'info',
  FAILED: 'destructive',
  RECEIVED: 'info',
};

const KIND_LABEL: Record<WhatsAppMessageRow['kind'], string> = {
  TEMPLATE: 'Notice',
  TEXT: 'Text',
  QUESTION: 'Question',
  ANSWER: 'Answer',
  HANDOFF: 'Handed off',
  SYSTEM: 'System',
};

const truncate = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function WhatsAppAdmin() {
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);
  const overview = useQuery({ queryKey: ['whatsapp', 'admin', 'overview'], queryFn: getWhatsAppOverview, refetchInterval: 30_000 });
  const messages = useQuery({
    queryKey: ['whatsapp', 'admin', 'messages', associate?.id ?? null],
    queryFn: () => listWhatsAppMessages({ associateId: associate?.id, limit: 100 }),
    refetchInterval: 30_000,
  });

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied.');
    } catch {
      toast.error('Could not copy — select the text and copy it by hand.');
    }
  };

  if (overview.isError) return <QueryError what="WhatsApp" query={overview} />;
  const o = overview.data;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <MessageCircle className="h-4 w-4 text-gold" aria-hidden="true" />
        {o ? (
          <>
            <Badge variant={o.configured ? 'success' : 'pending'}>{o.configured ? 'Sending configured' : 'Sending not configured'}</Badge>
            <Badge variant={o.webhookConfigured ? 'success' : 'pending'}>{o.webhookConfigured ? 'Webhook configured' : 'Webhook not configured'}</Badge>
            <Badge variant="outline">API {o.apiVersion}</Badge>
            {o.phoneNumberId && <Badge variant="outline">Number id {o.phoneNumberId}</Badge>}
            <span className="text-xs text-silver">
              {o.consent.optedIn} opted in · {o.consent.optedOut} opted out
            </span>
          </>
        ) : (
          <Skeleton className="h-6 w-64" />
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Sent (7 days)" value={o ? String(o.last7Days.sent) : '—'} hint={o ? `${o.last7Days.questions} questions in` : ''} />
        <MetricCard label="Delivered" value={o ? String(o.last7Days.delivered) : '—'} hint="Handsets that took it" />
        <MetricCard label="Read" value={o ? String(o.last7Days.read) : '—'} hint={o ? `${o.last7Days.handoffs} handed to a supervisor` : ''} />
        <MetricCard label="Failed" value={o ? String(o.last7Days.failed) : '—'} hint="Rejected by Meta or the handset" accent={!!o && o.last7Days.failed > 0} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Templates to register in WhatsApp Manager</CardTitle>
          <CardDescription>
            Meta only lets a business start a conversation with a pre-approved template. Register each one under its name, category
            Utility, in English, Spanish and Turkish, with the body exactly as shown; the numbered parameters are filled at send time.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {!o ? (
            <Skeleton className="h-24" />
          ) : (
            o.templates.map((tpl) => (
              <details key={tpl.key} className="rounded-md border border-navy-secondary px-3 py-2">
                <summary className="cursor-pointer text-sm">
                  <code className="text-gold">{tpl.metaName}</code> <span className="text-silver">· {tpl.metaCategory} · {tpl.description}</span>
                </summary>
                <div className="mt-2 space-y-2 text-sm">
                  <p className="text-xs text-silver">Parameters: {tpl.params.map((p, i) => `{{${i + 1}}} ${p}`).join(' · ')}</p>
                  {TERM_LANGS.map((lang) => (
                    <div key={lang} className="flex items-start gap-2">
                      <Badge variant="outline">{lang.toUpperCase()}</Badge>
                      <pre className="flex-1 whitespace-pre-wrap font-sans text-sm text-white">{tpl.body[lang]}</pre>
                      <Button variant="ghost" size="sm" onClick={() => void copy(tpl.body[lang])} aria-label={`Copy ${tpl.metaName} ${lang}`}>
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                      </Button>
                    </div>
                  ))}
                </div>
              </details>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Message record</CardTitle>
              <CardDescription>What went out and what came in, with the receipt. Numbers show their last four digits.</CardDescription>
            </div>
            <div className="w-64">
              <AssociatePicker value={associate} onChange={setAssociate} placeholder="Filter by associate…" />
            </div>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {messages.isError ? (
            <QueryError what="the message record" query={messages} />
          ) : messages.isLoading ? (
            <Skeleton className="h-48" />
          ) : (messages.data?.messages ?? []).length === 0 ? (
            <EmptyState icon={MessageCircle} title="No messages yet" description="Messages appear here as associates opt in and notices go out." />
          ) : (
            <DataGrid<WhatsAppMessageRow>
              id="whatsapp-messages"
              caption="WhatsApp message record"
              rows={messages.data?.messages ?? []}
              rowKey={(m) => m.id}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'whatsapp-messages' }}
              columnChooser={false}
              columns={[
                { key: 'when', header: 'When', accessor: (m) => m.createdAt, sortable: true, primary: true, cell: (m) => fmtDateTime(m.createdAt) },
                { key: 'who', header: 'Associate', accessor: (m) => m.associateName ?? '', sortable: true, cardMeta: true, cell: (m) => m.associateName ?? <span className="text-silver">unknown {m.phone}</span> },
                { key: 'dir', header: 'Direction', accessor: (m) => m.direction, sortable: true, searchable: false, cell: (m) => (m.direction === 'OUTBOUND' ? 'Out' : 'In') },
                { key: 'kind', header: 'Kind', accessor: (m) => KIND_LABEL[m.kind], sortable: true, searchable: false },
                { key: 'tpl', header: 'Template · lang', accessor: (m) => `${m.templateName ?? '—'} · ${m.language}`, sortable: true, searchable: false, className: 'font-mono text-xs text-silver' },
                { key: 'status', header: 'Status', accessor: (m) => m.status, sortable: true, searchable: false, cardMeta: true, cell: (m) => <Badge variant={STATUS_VARIANT[m.status]}>{statusLabel(m.status)}</Badge> },
                { key: 'body', header: 'Message', accessor: (m) => m.body, sortable: false, cell: (m) => <span title={m.body}>{truncate(m.body)}</span> },
                { key: 'fail', header: 'Failure', accessor: (m) => m.failureReason ?? '', sortable: false, className: 'text-alert', cell: (m) => m.failureReason ?? '' },
              ]}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
