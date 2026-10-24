import { useContext, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, ExternalLink, Search } from '@/components/ui/icons';
import { toast } from 'sonner';
import type { StatusState } from '@alto-people/shared';
import { ApiError, apiFetch } from '@/lib/api';
import { AuthContext } from '@/lib/auth';
import { fmtDate } from '@/lib/format';
import { useI18n, type MessageKey } from '@/lib/i18n';
import { searchKb } from '@/lib/kb124Api';
import { getPublicStatus } from '@/lib/statusApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { ListTemplate } from '@/components/templates';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import '@/lib/i18n/en/support';

/**
 * Brief 2-6 step 5 — "Contact Alto People support": the form, my requests
 * and their answers, and the status page link. What is sent is what the
 * person writes, the page they came from and the app version; no worker
 * data rides along.
 *
 * F500 G5: it opens on help (the articles, searched), how long an answer
 * takes and whether the platform is up — not a blank form; the form sits in
 * a readable column with "My requests" beside it, each with its status and a
 * way to answer back; an associate is pointed to HR for pay, schedule and job
 * questions (this desk is the software's, not the employer's), and every
 * word goes through t().
 */

interface MyRequest {
  id: string;
  category: string;
  subject: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
  reply: string | null;
  createdAt: string;
}

const STATUS: Record<MyRequest['status'], { label: MessageKey; variant: 'pending' | 'accent' | 'success' }> = {
  OPEN: { label: 'support.statusOpen', variant: 'pending' },
  IN_PROGRESS: { label: 'support.statusInProgress', variant: 'accent' },
  RESOLVED: { label: 'support.statusResolved', variant: 'success' },
};

const PLATFORM: Record<StatusState, { label: MessageKey; variant: 'success' | 'pending' | 'destructive' | 'default' }> = {
  OPERATIONAL: { label: 'support.platformOk', variant: 'success' },
  DEGRADED: { label: 'support.platformDegraded', variant: 'pending' },
  OUTAGE: { label: 'support.platformOutage', variant: 'destructive' },
  UNMEASURED: { label: 'support.platformUnknown', variant: 'default' },
};

const CATEGORIES: Array<{ value: string; label: MessageKey; staffOnly?: boolean }> = [
  { value: 'QUESTION', label: 'support.catQuestion' },
  { value: 'PROBLEM', label: 'support.catProblem' },
  { value: 'BILLING', label: 'support.catBilling', staffOnly: true },
  { value: 'ACCOUNT', label: 'support.catAccount' },
  { value: 'OTHER', label: 'support.catOther' },
];

/** "about 6 hours" / "about 2 days". */
function typicalWords(hours: number, t: ReturnType<typeof useI18n>['t']): string {
  return hours < 36 ? t('support.typicalHours', { count: hours }) : t('support.typicalDays', { count: Math.round(hours / 24) });
}

export function SupportPage() {
  const { t } = useI18n();
  // Read without requiring a provider (the page also renders signed-out shells and tests).
  const isAssociate = useContext(AuthContext)?.user?.role === 'ASSOCIATE';
  const qc = useQueryClient();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? document.referrer.replace(window.location.origin, '') ?? null;
  const config = useQuery({ queryKey: ['support', 'config'], queryFn: () => apiFetch<{ statusPageUrl: string | null }>('/support/config'), staleTime: 60 * 60_000 });
  const platform = useQuery({ queryKey: ['status', 'public'], queryFn: getPublicStatus, staleTime: 60_000, retry: false });
  const mine = useQuery({ queryKey: ['support', 'mine'], queryFn: () => apiFetch<{ requests: MyRequest[]; typicalResolveHours?: number | null }>('/support/mine') });
  const [q, setQ] = useState('');
  const articles = useQuery({ queryKey: ['kb', 'search', q], queryFn: () => searchKb({ q }), enabled: q.trim().length >= 2, staleTime: 60_000 });
  const [category, setCategory] = useState('QUESTION');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    setSending(true);
    try {
      await apiFetch('/support', { method: 'POST', body: { category, subject: subject.trim(), body: body.trim(), pageUrl: from || null, appVersion: import.meta.env.VITE_APP_VERSION ?? null } });
      toast.success(t('support.sent'));
      setSubject('');
      setBody('');
      void qc.invalidateQueries({ queryKey: ['support', 'mine'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('support.sendFailed'));
    } finally {
      setSending(false);
    }
  };

  const typical = mine.data?.typicalResolveHours ?? null;
  const overall = platform.data?.overall;

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    // The nav trail names where this is (the "Help" crumb went nowhere).
    <ListTemplate title={t('support.title')} subtitle={t('support.subtitle')}>
      {/* What people look for first: the platform's state, how fast an answer comes, and help that may already exist. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm" data-testid="support-facts">
        {overall && (
          <span className="inline-flex items-center gap-2">
            <Badge variant={PLATFORM[overall].variant} size="sm">
              {t(PLATFORM[overall].label)}
            </Badge>
            {config.data?.statusPageUrl && (
              <a className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline" href={config.data.statusPageUrl} target="_blank" rel="noreferrer">
                {t('support.statusLink')} <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            )}
          </span>
        )}
        {!overall && config.data?.statusPageUrl && (
          <a className="inline-flex items-center gap-1 text-gold underline-offset-2 hover:underline" href={config.data.statusPageUrl} target="_blank" rel="noreferrer">
            {t('support.statusLink')} <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
          </a>
        )}
        <span className="text-silver" data-testid="support-typical">
          {typical ? t('support.typical', { time: typicalWords(typical, t) }) : t('support.answerWhere')}
        </span>
      </div>

      {isAssociate && (
        // The employer's questions go to HR, not to the software's desk.
        <Card className="border-gold/30" data-testid="support-ask-hr">
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink">{t('support.askHrLine')}</p>
            <Button asChild size="sm">
              <Link to="/hr-cases?new=1">{t('support.askHr')}</Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <section aria-labelledby="support-help" className="space-y-2">
        <h2 id="support-help" className="flex items-center gap-2 text-base font-semibold text-ink">
          <BookOpen className="h-4 w-4 text-gold" aria-hidden="true" />
          {t('support.helpTitle')}
        </h2>
        <label className="relative block max-w-2xl">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-silver/50" aria-hidden="true" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('support.helpSearch')} aria-label={t('support.helpSearch')} className="pl-8" />
        </label>
        {q.trim().length >= 2 && (
          <ul className="max-w-2xl divide-y divide-navy-secondary/60 rounded-md border border-navy-secondary" data-testid="support-articles">
            {articles.isLoading ? (
              <li className="p-3">
                <Skeleton className="h-4 w-2/3" />
              </li>
            ) : (articles.data?.articles ?? []).length === 0 ? (
              <li className="p-3 text-sm text-silver">{t('support.helpNone')}</li>
            ) : (
              articles.data!.articles.slice(0, 5).map((a) => (
                <li key={a.id}>
                  <Link to={`/help-center?article=${encodeURIComponent(a.slug)}`} className="block px-3 py-2 text-sm text-ink hover:bg-navy-secondary/30">
                    {a.title}
                    <span className="ml-2 text-xs text-silver">{a.category}</span>
                  </Link>
                </li>
              ))
            )}
          </ul>
        )}
      </section>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,42rem)_minmax(0,1fr)]">
        <Card>
          <CardContent className="space-y-4">
            <SectionTitle title={t('support.formTitle')} className="mb-0" />
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <Field label={t('support.about')}>
                {(p) => (
                  <Select {...p} value={category} onChange={(e) => setCategory(e.target.value)}>
                    {CATEGORIES.filter((c) => !(isAssociate && c.staffOnly)).map((c) => (
                      <option key={c.value} value={c.value}>
                        {t(c.label)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('support.subject')} required>
                {(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={160} />}
              </Field>
              <Field label={t('support.what')} required hint={t('support.privacyHint')}>
                {(p) => <Textarea {...p} rows={5} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />}
              </Field>
              <Button type="submit" disabled={sending || subject.trim().length < 3 || body.trim().length < 5}>
                {sending ? t('support.sending') : t('support.send')}
              </Button>
            </form>
          </CardContent>
        </Card>

        <section aria-labelledby="mine-title" className="space-y-2">
          <h2 id="mine-title" className="text-base font-semibold text-ink">
            {t('support.mine')}
          </h2>
          {mine.isError ? (
            <QueryError what={t('support.mineWhat')} query={mine} />
          ) : mine.isLoading ? (
            <div className="space-y-2" data-testid="support-mine-loading">
              <Skeleton className="h-16" />
              <Skeleton className="h-16" />
            </div>
          ) : (
            <ul className="space-y-2">
              {(mine.data?.requests ?? []).map((r) => (
                <RequestRow key={r.id} r={r} />
              ))}
              {mine.data && mine.data.requests.length === 0 && <li className="text-sm text-silver">{t('support.mineNone')}</li>}
            </ul>
          )}
        </section>
      </div>
    </ListTemplate>
  );
}

/** One request: its status, its answer, and a way to answer back. */
function RequestRow({ r }: { r: MyRequest }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setBusy(true);
    try {
      await apiFetch(`/support/${r.id}/followup`, { method: 'POST', body: { body: text.trim() } });
      toast.success(t('support.followupSent'));
      setText('');
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ['support', 'mine'] });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('support.sendFailed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="rounded-md border border-navy-secondary p-3 text-sm" data-testid="support-request">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{r.subject}</span>
        <Badge variant={STATUS[r.status].variant} size="sm">
          {t(STATUS[r.status].label)}
        </Badge>
        <span className="ml-auto text-xs text-silver">{fmtDate(r.createdAt)}</span>
      </div>
      {r.reply && (
        <div className="mt-2 rounded-md bg-navy-secondary/30 px-3 py-2">
          <div className="text-2xs uppercase tracking-wider text-silver">{t('support.ourAnswer')}</div>
          <p className="mt-0.5 whitespace-pre-wrap text-ink">{r.reply}</p>
        </div>
      )}
      {open ? (
        <div className="mt-2 space-y-2">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} aria-label={t('support.followupAria')} placeholder={t('support.followupPh')} autoFocus />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void send()} loading={busy} disabled={text.trim().length < 2}>
              {t('support.send')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <Button size="xs" variant="ghost" className="mt-1" onClick={() => setOpen(true)}>
          {r.reply ? t('support.answerBack') : t('support.addDetail')}
        </Button>
      )}
    </li>
  );
}
