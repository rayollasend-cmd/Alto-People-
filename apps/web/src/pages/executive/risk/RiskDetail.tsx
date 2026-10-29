import { Link, useSearchParams } from 'react-router-dom';
import type { ExecRisk } from '@alto-people/shared';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { useAuth } from '@/lib/auth';
import { execHref, useExecFrame } from '@/lib/executiveApi';
import { useI18n } from '@/lib/i18n';
import '@/lib/i18n/en/execPortal';
import { SeverityChip } from './SeverityChip';

/**
 * One risk, read in place (deep audit 2026-10-29, LEAD-6): what it is, the
 * number behind it, and the records behind the number — read-only, and
 * without the medical or claim facts only HR may see. A risk whose working
 * desk the viewer cannot open (the leave desk, the claims desks, the
 * supervisor roster, the cash forecast) is answered here instead of on a
 * page that says "You don't have access"; the desk link shows only for a
 * viewer who holds the capability it needs.
 *
 * Opened by `?open=<risk id>` — the risk's `href` from the API when it has
 * no page every executive can read — so the home's risk preview and a sent
 * link land on it.
 */

/** The Risk page's own detail: the API's `href` for a risk read in place. */
export const isDetailHref = (href: string) => href.split('?')[0] === '/executive/risk';

export function useOpenRisk(): [string | null, (id: string | null) => void] {
  const [params, setParams] = useSearchParams();
  const open = params.get('open');
  const set = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('open', id);
    else next.delete('open');
    setParams(next, { replace: false });
  };
  return [open, set];
}

export function RiskDetailDrawer({ risks }: { risks: ExecRisk[] }) {
  const { t } = useI18n();
  const { can } = useAuth();
  const frame = useExecFrame();
  const [openId, setOpenId] = useOpenRisk();
  const risk = openId ? (risks.find((r) => r.id === openId) ?? null) : null;
  const desk = risk?.desk ?? null;
  const deskOpen = desk ? can(desk.requires) : false;
  return (
    <Drawer open={risk !== null} onOpenChange={(o) => !o && setOpenId(null)} width="max-w-lg">
      {risk && (
        <div className="flex h-full flex-col" data-testid="exec-risk-detail">
          <DrawerHeader>
            <div>
              <SeverityChip severity={risk.severity}>{t(`execPortal.risk.sev.${risk.severity}`)}</SeverityChip>
            </div>
            <DrawerTitle>{risk.title}</DrawerTitle>
            <DrawerDescription>
              {t(`execPortal.risk.cat.${risk.category}`)} · {t('execPortal.risk.detailOwner', { owner: risk.owner })} · {t(`execPortal.risk.trend.${risk.trend}`)}
            </DrawerDescription>
          </DrawerHeader>
          <DrawerBody className="space-y-5 pt-0">
            <p className="text-sm text-ink">{risk.detail}</p>
            {risk.metric && (
              <div>
                <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-ink-muted">{t('execPortal.risk.colMetric')}</h3>
                <p className="mt-1 text-sm tabular-nums text-ink">{risk.metric}</p>
              </div>
            )}
            {risk.items && risk.items.length > 0 && (
              <div>
                <h3 className="text-2xs font-semibold uppercase tracking-[0.14em] text-ink-muted">{t('execPortal.risk.detailItems')}</h3>
                <ul className="mt-1 divide-y divide-line" data-testid="exec-risk-items">
                  {risk.items.map((it, i) => (
                    <li key={`${it.label}-${i}`} className="flex flex-col gap-0.5 py-2 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                      <span className="min-w-0 text-ink">{it.label}</span>
                      {it.sub && <span className="text-xs2 tabular-nums text-ink-muted sm:shrink-0">{it.sub}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {desk && !deskOpen && <p className="text-xs2 text-ink-muted">{t('execPortal.risk.detailDeskElsewhere', { owner: risk.owner })}</p>}
          </DrawerBody>
          {((!isDetailHref(risk.href)) || (desk && deskOpen)) && (
            <DrawerFooter className="flex-wrap justify-start">
              {!isDetailHref(risk.href) && (
                <Link
                  to={execHref(risk.href, frame)}
                  className="inline-flex min-h-11 items-center rounded-md px-2 text-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  data-testid="exec-risk-detail-open"
                >
                  {t('execPortal.risk.detailOpen')}
                </Link>
              )}
              {desk && deskOpen && (
                <Link
                  to={desk.href}
                  className="inline-flex min-h-11 items-center rounded-md px-2 text-sm text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                  data-testid="exec-risk-detail-desk"
                >
                  {desk.label}
                </Link>
              )}
            </DrawerFooter>
          )}
        </div>
      )}
    </Drawer>
  );
}
