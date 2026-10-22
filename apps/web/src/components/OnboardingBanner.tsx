import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ArrowRight, Sparkles } from 'lucide-react';
import type { ApplicationSummary } from '@alto-people/shared';
import { listApplications } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { ProgressBar } from '@/components/ProgressBar';

/**
 * Phase 32 — persistent onboarding nudge for associates whose checklist
 * isn't 100% complete. Renders nothing for HR / Ops / etc., for
 * associates with no application, and for completed checklists. The
 * common "they accepted the invite then forgot" failure mode dies here:
 * every dashboard visit re-surfaces the unfinished work prominently.
 */
/**
 * The associate's unfinished onboarding, if any: undefined while loading,
 * null when there is none (or the person has no application at all). The
 * home reads it to decide what the hero is; the card renders it.
 */
export function useOpenOnboarding(): ApplicationSummary | null | undefined {
  const [item, setItem] = useState<ApplicationSummary | null | undefined>(undefined);

  const itemQuery = useQuery({
    queryKey: ['OnboardingBanner', 'item'],
    queryFn: () => listApplications({ pageSize: 10 }),
  });
  useEffect(() => {
    const res = itemQuery.data;
    if (res === undefined) return;
    const open = res.applications.find(
      (a) => a.percentComplete < 100 && a.status !== 'REJECTED' && a.status !== 'CANCELLED'
    );
    setItem(open ?? null);
  }, [itemQuery.data]);
  useEffect(() => {
    if (!itemQuery.isError) return;
    const err = itemQuery.error;
    if (err instanceof ApiError && err.status === 403) {
      setItem(null);
      return;
    }
    setItem(null);
  }, [itemQuery.isError, itemQuery.error]);

  return item;
}

/**
 * The onboarding card. On the associate home it IS the hero while the
 * checklist is unfinished (`hero`): a person who cannot work yet has one
 * job, and the greeting sits above it, not under a banner. Elsewhere it
 * is the nudge it always was.
 */
export function OnboardingBanner({ hero = false }: { hero?: boolean }) {
  const { t } = useI18n();
  const item = useOpenOnboarding();

  if (!item) return null;

  const isFresh = item.percentComplete === 0;

  return (
    <Link
      to={`/onboarding/me/${item.id}`}
      className={`group block rounded-lg border border-gold/40 bg-gradient-to-br from-gold/10 via-navy to-navy p-5 transition-all hover:border-gold hover:from-gold/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright ${hero ? '' : 'mb-6'}`}
      aria-label={t('onbBanner.continue')}
    >
      <div className="flex items-start gap-4">
        <div className="hidden sm:grid h-10 w-10 rounded-lg bg-gold/20 place-items-center text-gold shrink-0">
          <Sparkles className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <div className="text-lg text-gold">
              {isFresh ? t('onbBanner.welcome') : t('onbBanner.finish')}
            </div>
            <div className="text-sm text-silver tabular-nums shrink-0">
              {t('onbBanner.percent', { n: item.percentComplete })}
            </div>
          </div>
          <p className="text-sm text-silver mt-1">
            {isFresh
              ? t('onbBanner.freshBody', { client: item.clientName })
              : t('onbBanner.resumeBody', { client: item.clientName })}
          </p>
          <div className="mt-3">
            <ProgressBar percent={item.percentComplete} hideLabel />
          </div>
        </div>
        <ArrowRight className="hidden sm:block h-5 w-5 text-gold/60 group-hover:text-gold group-hover:translate-x-0.5 transition-all shrink-0 mt-1" />
      </div>
    </Link>
  );
}
