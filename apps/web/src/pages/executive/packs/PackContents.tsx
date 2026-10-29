import { Card, CardContent } from '@/components/ui/Card';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';

/** The pages of the pack, in order, each in one line. */
export const PACK_PAGES = ['cover', 'scorecard', 'financials', 'clients', 'workforce', 'risk', 'appendix'] as const;
export type PackPage = (typeof PACK_PAGES)[number];

/** A company with no clients (a hotel employing its own team) has no Clients page. */
export function packPages(clients: boolean): PackPage[] {
  return PACK_PAGES.filter((p) => clients || p !== 'clients');
}

export function PackContents({ pages }: { pages: readonly PackPage[] }) {
  const { t } = useI18n();
  return (
    <Card data-testid="exec-pack-contents">
      <CardContent className="p-4 md:p-5">
        <ol className="divide-y divide-line">
          {pages.map((p, i) => (
            <li key={p} className="flex gap-4 py-3 first:pt-0 last:pb-0">
              <span className="w-6 shrink-0 pt-0.5 text-right text-sm tabular-nums text-ink-muted" aria-hidden="true">
                {i + 1}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-medium text-ink">{t(`execPortal.packs.page.${p}`)}</div>
                <p className="text-sm text-ink-muted">{t(`execPortal.packs.pageLine.${p}`)}</p>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
