import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Download, FileSignature } from '@/components/ui/icons';
import { toast } from 'sonner';
import { useI18n, type Translate } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { StickyActionBar } from '@/components/ui/StickyActionBar';
import { INBOX_QUERY_KEY } from '@/lib/inboxApi';
import { fmtDate } from '@/lib/format';
import { acknowledgeMyPayNotice, getMyPayNotice, listMyPayNotices, type PayNotice } from '@/lib/payComplianceApi';
import { Badge, Button, Card, CardContent, EmptyState, ErrorBanner, Field, Input, SectionTitle, SkeletonRows } from '@/components/ui';
import { ListTemplate } from '@/components/templates';
import '@/lib/i18n/en/payNotice';

/**
 * The worker's state pay notices (NY Wage Theft Prevention Act, CA 2810.5,
 * IL, WA): read the notice in their language with the English copy, and
 * sign by typing their name.
 */

function whyLabel(n: PayNotice, t: Translate): string {
  if (n.trigger === 'HIRE') return t('payNotice.why.HIRE');
  if (n.trigger === 'RATE_CHANGE') return t('payNotice.why.RATE_CHANGE');
  return t('payNotice.why.MANUAL');
}

export function PayNotices() {
  const { id } = useParams<{ id?: string }>();
  return id ? <PayNoticeDetail id={id} /> : <PayNoticeList />;
}

function PayNoticeList() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['me', 'pay-notices'], queryFn: listMyPayNotices });
  const rows = q.data?.notices ?? null;
  return (
    <ListTemplate title={t('payNotice.title')} subtitle={t('payNotice.subtitle')}>
      {q.error && (
        <ErrorBanner action={<Button size="sm" variant="secondary" onClick={() => void q.refetch()}>{t('payNotice.retry')}</Button>}>{t('payNotice.error')}</ErrorBanner>
      )}
      {!rows && !q.error && <SkeletonRows count={3} rowHeight="h-16" />}
      {rows && rows.length === 0 && <EmptyState icon={FileSignature} title={t('payNotice.empty.title')} description={t('payNotice.empty.body')} />}
      {rows && rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((n) => (
            <li key={n.id}>
              <Link
                to={`/me/pay-notices/${n.id}`}
                className="flex min-h-[56px] items-center justify-between gap-3 rounded-lg border border-navy-secondary bg-navy px-4 py-3 hover:border-gold/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-ink">{whyLabel(n, t)}</div>
                  <div className="text-xs text-silver">{fmtDate(new Date(n.sentAt))} · {n.state}</div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {n.status === 'SENT' ? (
                    <Badge variant="pending">{t('payNotice.status.waiting')}</Badge>
                  ) : (
                    <Badge variant="success">{t('payNotice.status.signed', { date: fmtDate(new Date(n.acknowledgedAt ?? n.sentAt)) })}</Badge>
                  )}
                  <ChevronRight className="h-4 w-4 text-silver" aria-hidden />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ListTemplate>
  );
}

function PayNoticeDetail({ id }: { id: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['me', 'pay-notices', id], queryFn: () => getMyPayNotice(id), retry: (n, err) => !(err instanceof ApiError && err.status === 404) && n < 2 });
  const [name, setName] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);
  const sign = useMutation({
    mutationFn: () => acknowledgeMyPayNotice(id, name.trim()),
    onSuccess: () => {
      toast.success(t('payNotice.signed'));
      void qc.invalidateQueries({ queryKey: ['me', 'pay-notices'] });
      void qc.invalidateQueries({ queryKey: INBOX_QUERY_KEY });
    },
    onError: () => toast.error(t('payNotice.signError')),
  });
  const n = q.data?.notice;
  // A removed or unknown notice is not something a retry fixes (F500 G5).
  const gone = q.error instanceof ApiError && q.error.status === 404;
  const waiting = n?.status === 'SENT';
  return (
    <ListTemplate
      // The notice itself is the heading — it was only a crumb under "Pay notices".
      title={n ? whyLabel(n, t) : gone ? t('payNotice.title') : '…'}
      subtitle={n ? t('payNotice.detailSub', { state: n.state, date: fmtDate(new Date(n.sentAt)) }) : undefined}
      status={
        n ? (
          waiting ? (
            <Badge variant="pending">{t('payNotice.status.waiting')}</Badge>
          ) : (
            <Badge variant="success">{t('payNotice.status.signed', { date: fmtDate(new Date(n.acknowledgedAt ?? n.sentAt)) })}</Badge>
          )
        ) : undefined
      }
      breadcrumbs={[{ label: t('payNotice.title'), to: '/me/pay-notices' }]}
      secondaryActions={
        n ? (
          <Button asChild variant="secondary" size="sm">
            <a href={`/api/me/pay-notices/${id}/pdf`} target="_blank" rel="noreferrer">
              <Download className="h-4 w-4" aria-hidden /> {t('payNotice.pdf')}
            </a>
          </Button>
        ) : undefined
      }
    >
      {gone ? (
        <EmptyState
          icon={FileSignature}
          title={t('payNotice.gone.title')}
          description={t('payNotice.gone.body')}
          action={
            <Button asChild variant="secondary" size="sm">
              <Link to="/me/pay-notices">{t('payNotice.back')}</Link>
            </Button>
          }
        />
      ) : q.error ? (
        <ErrorBanner action={<Button size="sm" variant="secondary" onClick={() => void q.refetch()}>{t('payNotice.retry')}</Button>}>{t('payNotice.error')}</ErrorBanner>
      ) : null}
      {!q.data && !q.error && <SkeletonRows count={6} rowHeight="h-10" />}
      {q.data && n && (
        <div className="space-y-4">
          {waiting && <p className="text-sm text-silver" data-testid="pay-notice-read-first">{t('payNotice.readThenSign')}</p>}
          {q.data.sections.map((s, i) => (
            <Card key={s.language}>
              <CardContent>
                {i > 0 && <SectionTitle title={t('payNotice.englishCopy')} />}
                <dl className="divide-y divide-navy-secondary">
                  {s.lines.map((l) => (
                    <div key={l.label} className="grid gap-1 py-2 sm:grid-cols-3">
                      <dt className="text-xs uppercase tracking-wide text-silver">{l.label}</dt>
                      <dd className="text-sm text-ink sm:col-span-2">{l.value}</dd>
                    </div>
                  ))}
                </dl>
              </CardContent>
            </Card>
          ))}
          <Card id="pay-notice-sign">
            <CardContent>
              {n.status === 'ACKNOWLEDGED' ? (
                <p className="text-sm text-success">{t('payNotice.signedBy', { name: n.signedName ?? '', date: fmtDate(new Date(n.acknowledgedAt ?? n.sentAt)) })}</p>
              ) : (
                <form
                  className="space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (name.trim().length >= 2) sign.mutate();
                  }}
                >
                  <p className="text-sm text-silver">{t('payNotice.ack')}</p>
                  <Field label={t('payNotice.signLabel')} required>
                    <Input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={200} />
                  </Field>
                  <Button type="submit" loading={sign.isPending} disabled={name.trim().length < 2 || sign.isPending} className="w-full sm:w-auto">
                    <FileSignature className="h-4 w-4" aria-hidden /> {t('payNotice.sign')}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
          {/* On a phone the way to sign stays in reach past both language copies. */}
          {waiting && (
            <StickyActionBar
              label={t('payNotice.sign')}
              note={t('payNotice.readThenSign')}
              primary={
                <Button
                  onClick={() => {
                    document.getElementById('pay-notice-sign')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    nameRef.current?.focus({ preventScroll: true });
                  }}
                >
                  <FileSignature className="h-4 w-4" aria-hidden /> {t('payNotice.sign')}
                </Button>
              }
            />
          )}
        </div>
      )}
    </ListTemplate>
  );
}
