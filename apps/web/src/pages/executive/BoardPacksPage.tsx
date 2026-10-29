import { ExecPage, ExecSection } from '@/components/executive/ExecPage';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { CalendarClock, Download, FileText } from '@/components/ui/icons';
import { fmtDateOnlyRange } from '@/lib/format';
import { useTenant } from '@/lib/auth';
import { useExecFrame, useExecOverview } from '@/lib/executiveApi';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { PackContents, packPages } from './packs/PackContents';
import { useBoardPackDownload } from './packs/useBoardPackDownload';

/**
 * The chairman's Board packs page (2026-10-27): the period bar decides
 * which pack — the week, month, quarter or year to date, against the plan,
 * the prior period or last year — and one button makes it, fresh, as a
 * PDF. What is inside, page by page; how the Saturday digest delivers last
 * week's pack on its own; and the one caveat a board should hear: figures
 * marked est. are at standard rates.
 */
export function ExecBoardPacksPage() {
  const { t } = useI18n();
  const frame = useExecFrame();
  // The scorecard's own answer names the period and comparison exactly as
  // the pack will (and is usually already in hand from the home page).
  const overview = useExecOverview(frame);
  const period = overview.data?.period ?? null;
  const comparison = overview.data?.comparison ?? null;
  const { busy, download } = useBoardPackDownload(frame);
  // A company with no clients (a hotel employing its own team) has no Clients page, and no client statements.
  const clients = useTenant().moduleOn('clientPortal');
  const pages = packPages(clients);
  const which = period
    ? `${period.label}${comparison ? ` · ${comparison.available ? comparison.label : t(`execPortal.compare.${frame.compare}`)}` : ''}`
    : `${t(`execPortal.packs.periodWord.${frame.period}`)} · ${t(`execPortal.compare.${frame.compare}`)}`;
  return (
    <ExecPage title={t('execPortal.packs.title')} subtitle={t('execPortal.packs.subtitle')} frame={frame} period={period} comparison={comparison} testId="exec-board-packs">
      <Card data-testid="exec-pack-hero">
        <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between md:p-6">
          <div className="flex min-w-0 items-start gap-4">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-lg border border-line bg-surface-raised text-accent">
              <FileText className="h-6 w-6" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <div className="text-2xs font-semibold uppercase tracking-[0.18em] text-ink-muted">{t('execPortal.packs.thisPack')}</div>
              <div className="mt-1 text-xl text-ink">{which}</div>
              <p className="mt-1 text-sm text-ink-muted">
                {period ? `${fmtDateOnlyRange(period.start, period.end)} · ` : ''}
                {t('execPortal.packs.heroSub', { count: pages.length })}
              </p>
            </div>
          </div>
          <Button size="lg" onClick={() => void download()} loading={busy} disabled={busy} className="shrink-0" data-testid="exec-pack-download">
            <Download className="mr-2 h-4 w-4" aria-hidden="true" />
            {busy ? t('execPortal.packs.preparing') : t('execPortal.packs.download')}
          </Button>
        </CardContent>
      </Card>

      <div className="grid items-start gap-6 lg:grid-cols-5">
        <div className="min-w-0 lg:col-span-3">
          <ExecSection id="exec-pack-inside" title={t('execPortal.packs.insideTitle')} description={t('execPortal.packs.insideDesc', { count: pages.length })}>
            <PackContents pages={pages} />
          </ExecSection>
        </div>
        <div className="min-w-0 lg:col-span-2">
          <ExecSection id="exec-pack-delivery" title={t('execPortal.packs.deliveryTitle')} description={t('execPortal.packs.deliveryDesc')}>
            <Card data-testid="exec-pack-delivery">
              <CardContent className="space-y-3 p-4 md:p-5">
                <div className="flex items-start gap-3">
                  <CalendarClock className="mt-0.5 h-5 w-5 shrink-0 text-ink-muted" aria-hidden="true" />
                  <div className="min-w-0 space-y-2 text-sm">
                    <p className="font-medium text-ink">{t('execPortal.packs.digestWhen')}</p>
                    <p className="text-ink-muted">{t('execPortal.packs.digestWho')}</p>
                    <p className="text-ink-muted">{t('execPortal.packs.digestWhat')}</p>
                    <p className="text-ink-muted">{t('execPortal.packs.digestChange')}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </ExecSection>
        </div>
      </div>

      <p className="text-xs text-ink-muted">{t(clients ? 'execPortal.packs.note' : 'execPortal.packs.noteNoClients')}</p>
    </ExecPage>
  );
}
