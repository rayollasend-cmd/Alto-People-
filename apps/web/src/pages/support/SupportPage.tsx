import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ListTemplate } from '@/components/templates';
import { QueryError } from '@/components/ui/QueryError';

/**
 * Brief 2-6 step 5 — "Contact Alto People support": the form, my requests
 * and their answers, and the status page link. What is sent is what the
 * person writes, the page they came from and the app version; no worker
 * data rides along.
 */

interface MyRequest {
  id: string;
  category: string;
  subject: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
  reply: string | null;
  createdAt: string;
}

const STATUS: Record<MyRequest['status'], { label: string; variant: 'pending' | 'accent' | 'success' }> = {
  OPEN: { label: 'Open', variant: 'pending' },
  IN_PROGRESS: { label: 'In progress', variant: 'accent' },
  RESOLVED: { label: 'Resolved', variant: 'success' },
};

export function SupportPage() {
  const qc = useQueryClient();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? document.referrer.replace(window.location.origin, '') ?? null;
  const config = useQuery({ queryKey: ['support', 'config'], queryFn: () => apiFetch<{ statusPageUrl: string | null }>('/support/config'), staleTime: 60 * 60_000 });
  const mine = useQuery({ queryKey: ['support', 'mine'], queryFn: () => apiFetch<{ requests: MyRequest[] }>('/support/mine') });
  const [category, setCategory] = useState('QUESTION');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    setSending(true);
    try {
      await apiFetch('/support', { method: 'POST', body: { category, subject: subject.trim(), body: body.trim(), pageUrl: from || null, appVersion: import.meta.env.VITE_APP_VERSION ?? null } });
      toast.success('Sent. We answer here and in your notifications.');
      setSubject('');
      setBody('');
      void qc.invalidateQueries({ queryKey: ['support', 'mine'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not send it.');
    } finally {
      setSending(false);
    }
  };

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Support" subtitle="Ask Alto People for help. We answer here and in your notifications." breadcrumbs={[{ label: 'Help' }, { label: 'Support' }]}
    >
      {config.data?.statusPageUrl && (
        <a className="inline-flex items-center gap-1 text-sm text-gold underline-offset-2 hover:underline" href={config.data.statusPageUrl} target="_blank" rel="noreferrer">
          System status <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
        </a>
      )}
      <Card>
        <CardContent className="space-y-4">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <Field label="About">
              {(p) => (
                <Select {...p} value={category} onChange={(e) => setCategory(e.target.value)}>
                  <option value="QUESTION">A question</option>
                  <option value="PROBLEM">Something is not working</option>
                  <option value="BILLING">Billing</option>
                  <option value="ACCOUNT">My account or sign-in</option>
                  <option value="OTHER">Something else</option>
                </Select>
              )}
            </Field>
            <Field label="Subject" required>
              {(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={160} />}
            </Field>
            <Field label="What happened" required hint="Please leave out Social Security numbers, bank details and other private data.">
              {(p) => <Textarea {...p} rows={5} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />}
            </Field>
            <Button type="submit" disabled={sending || subject.trim().length < 3 || body.trim().length < 5}>
              {sending ? 'Sending…' : 'Send'}
            </Button>
          </form>
        </CardContent>
      </Card>
      <section aria-labelledby="mine-title" className="space-y-2">
        <h2 id="mine-title" className="text-base font-semibold text-white">My requests</h2>
        {mine.isError ? (
          <QueryError what="your requests" query={mine} />
        ) : (
          <ul className="space-y-2">
            {(mine.data?.requests ?? []).map((r) => (
              <li key={r.id} className="rounded-md border border-navy-secondary p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-white">{r.subject}</span>
                  <Badge variant={STATUS[r.status].variant} size="sm">
                    {STATUS[r.status].label}
                  </Badge>
                  <span className="ml-auto text-xs text-silver">{fmtDate(r.createdAt)}</span>
                </div>
                {r.reply && <p className="mt-1 whitespace-pre-wrap text-silver">{r.reply}</p>}
              </li>
            ))}
            {mine.data && mine.data.requests.length === 0 && <li className="text-sm text-silver">None yet.</li>}
          </ul>
        )}
      </section>
    </ListTemplate>
  );
}
