import { useQuery } from '@tanstack/react-query';
import { Download, FileText } from '@/components/ui/icons';
import { listTaxDocs, type TaxDoc } from '@/lib/selfApi';
import { useI18n } from '@/lib/i18n';
import { fmtDate } from '@/lib/format';
import { QueryError } from '@/components/ui/QueryError';
import { SkeletonRows } from '@/components/ui/Skeleton';
import '@/lib/i18n/en/me';

/** The form's own name — "Form W-2" is what the IRS calls it. */
export const TAX_DOC_FORM: Record<TaxDoc['kind'], string> = {
  W2: 'Form W-2',
  W3: 'Form W-3',
  N_1099_NEC: 'Form 1099-NEC',
  N_1095_C: 'Form 1095-C',
};

/**
 * Their year-end tax forms, where they look for them: inside Pay (ASSOC-30
 * — "Tax documents" jumped from Pay to My profile, onto a select used as
 * tabs). One line per form, one Download each; the same list as My
 * profile's tab.
 */
export function MyTaxDocsList() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ['me', 'taxDocs'], queryFn: () => listTaxDocs() });
  return (
    <section aria-labelledby="pay-tax-docs" data-testid="pay-tax-docs">
      <h3 id="pay-tax-docs" className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-ink">
        <FileText className="h-4 w-4 text-gold" aria-hidden="true" />
        {t('me.tab.taxDocs')}
      </h3>
      {q.isError ? (
        <QueryError what={t('me.tax.what')} query={q} />
      ) : !q.data ? (
        <SkeletonRows count={2} />
      ) : q.data.documents.length === 0 ? (
        <p className="text-xs text-silver">{t('me.tax.emptyDesc')}</p>
      ) : (
        <ul className="divide-y divide-navy-secondary/60 rounded-md border border-navy-secondary">
          {q.data.documents.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-1.5 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block text-ink">
                  {TAX_DOC_FORM[d.kind] ?? d.kind} · {d.taxYear}
                </span>
                <span className="block text-xs text-silver/70">{fmtDate(d.issuedAt)}</span>
              </span>
              {d.downloadUrl ? (
                <a
                  href={d.downloadUrl}
                  download
                  className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-gold hover:text-gold-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                >
                  <Download className="h-4 w-4" aria-hidden="true" />
                  {t('me.tax.download')}
                </a>
              ) : (
                <span className="text-xs text-silver/70">{t('me.tax.legacyHint')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
