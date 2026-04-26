import { useEffect, useState } from 'react';
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
export function OnboardingBanner() {
  const [item, setItem] = useState<ApplicationSummary | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    listApplications()
      .then((res) => {
        if (cancelled) return;
        // For ASSOCIATE callers the API only returns their own apps; pick
        // the most recent incomplete one. APPROVED/REJECTED are terminal
        // and not actionable from the associate's side.
        const open = res.applications.find(
          (a) => a.percentComplete < 100 && a.status !== 'REJECTED'
        );
        setItem(open ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        // 403 = caller isn't an associate → silently render nothing.
        if (err instanceof ApiError && err.status === 403) {
          setItem(null);
          return;
        }
        // Any other error → fail-quiet; the regular onboarding tile is
        // still in the module grid below.
        setItem(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!item) return null;

  const isFresh = item.percentComplete === 0;

  return (
    <Link
      to={`/onboarding/me/${item.id}`}
      className="group block mb-6 rounded-lg border border-gold/40 bg-gradient-to-br from-gold/10 via-navy to-navy p-5 transition-all hover:border-gold hover:from-gold/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
      aria-label="Continue onboarding"
    >
      <div className="flex items-start gap-4">
        <div className="hidden sm:grid h-10 w-10 rounded-lg bg-gold/20 place-items-center text-gold shrink-0">
          <Sparkles className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <div className="font-display text-lg text-gold">
              {isFresh ? 'Welcome — let\'s get you set up' : 'Finish your onboarding'}
            </div>
            <div className="text-sm text-silver tabular-nums shrink-0">
              {item.percentComplete}% complete
            </div>
          </div>
          <p className="text-sm text-silver mt-1">
            {isFresh
              ? `Your onboarding tasks for ${item.clientName} are ready. Most associates finish in about 15 minutes.`
              : `Pick up where you left off — ${item.clientName}.`}
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
