import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileBadge } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { listMyLetters, letterPdfUrl, requestLetter, type LetterKind, type VerificationLetter } from '@/lib/verificationLettersApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import '@/lib/i18n/en/docs';

/**
 * The person's letters (HR pack 2026-10): ask for proof of employment or
 * income, see HR's answer, download the approved PDF. Every string is
 * translated — this sits on the associate's documents page.
 */
export function LettersSection() {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [kind, setKind] = useState<LetterKind>('EMPLOYMENT');
  const [addressedTo, setAddressedTo] = useState('');
  const [purpose, setPurpose] = useState('');
  const letters = useQuery({ queryKey: ['my', 'verification-letters'], queryFn: listMyLetters });
  const request = useMutation({
    mutationFn: () => requestLetter({ kind, addressedTo: addressedTo.trim() || null, purpose: purpose.trim() || null }),
    onSuccess: () => {
      toast.success(t('docs.letters.requested'));
      setAddressedTo('');
      setPurpose('');
      void qc.invalidateQueries({ queryKey: ['my', 'verification-letters'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : t('docs.letters.failed')),
  });
  const rows: VerificationLetter[] = letters.data?.letters ?? [];
  const kindLabel = (k: LetterKind) => (k === 'INCOME' ? t('docs.letters.kindIncome') : t('docs.letters.kindEmployment'));
  const statusLabel = (l: VerificationLetter) => (l.status === 'APPROVED' ? t('docs.letters.ready') : l.status === 'DECLINED' ? t('docs.letters.declined') : t('docs.letters.waiting'));

  return (
    <section className="space-y-3" aria-labelledby="my-letters">
      <SectionTitle as="h2" icon={FileBadge} title={<span id="my-letters">{t('docs.letters.title')}</span>} description={t('docs.letters.subtitle')} />
      <Card>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={t('docs.letters.kind')}>
              {(p) => (
                <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as LetterKind)}>
                  <option value="EMPLOYMENT">{t('docs.letters.kindEmployment')}</option>
                  <option value="INCOME">{t('docs.letters.kindIncome')}</option>
                </Select>
              )}
            </Field>
            <Field label={t('docs.letters.addressedTo')} hint={t('docs.letters.addressedToHint')}>
              {(p) => <Input {...p} value={addressedTo} onChange={(e) => setAddressedTo(e.target.value)} maxLength={160} />}
            </Field>
            <Field label={t('docs.letters.purpose')}>
              {(p) => <Input {...p} value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={500} />}
            </Field>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => request.mutate()} loading={request.isPending} className="coarse:min-h-11">
              {t('docs.letters.request')}
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          {letters.isLoading ? (
            <div className="p-6">
              <SkeletonRows count={2} />
            </div>
          ) : rows.length === 0 ? (
            <p className="p-6 text-sm text-ink-muted">{t('docs.letters.empty')}</p>
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-ink">{kindLabel(l.kind)}</div>
                    <div className="text-xs text-ink-muted">
                      {fmtDate(l.createdAt)}
                      {l.addressedTo ? ` · ${l.addressedTo}` : ''}
                      {l.status === 'DECLINED' && l.declineReason ? ` · ${l.declineReason}` : ''}
                    </div>
                  </div>
                  <Badge variant={l.status === 'APPROVED' ? 'success' : l.status === 'DECLINED' ? 'destructive' : 'pending'}>{statusLabel(l)}</Badge>
                  {l.status === 'APPROVED' && (
                    <Button size="sm" variant="outline" asChild className="coarse:min-h-11">
                      <a href={letterPdfUrl(l.id)} target="_blank" rel="noopener noreferrer">
                        {t('docs.letters.download')}
                      </a>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
