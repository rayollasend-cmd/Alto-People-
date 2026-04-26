import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ApplicationSummary } from '@alto-people/shared';
import { listApplications } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { ProgressBar } from '@/components/ProgressBar';

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'Draft',
  SUBMITTED: 'Submitted',
  IN_REVIEW: 'In review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

const TRACK_LABEL: Record<string, string> = {
  STANDARD: 'Standard',
  J1: 'J-1',
  CLIENT_SPECIFIC: 'Client-specific',
};

export function ApplicationsList() {
  const [items, setItems] = useState<ApplicationSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listApplications()
      .then((res) => {
        if (!cancelled) setItems(res.applications);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Failed to load.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="max-w-6xl mx-auto">
      <header className="mb-6">
        <h1 className="font-display text-4xl md:text-5xl text-white mb-2 leading-tight">
          Onboarding
        </h1>
        <p className="text-silver">
          Active applications and their checklist progress.
        </p>
      </header>

      {error && (
        <div className="mb-4 p-3 rounded border border-alert/40 bg-alert/10 text-alert text-sm">
          {error}
        </div>
      )}

      {!items && !error && <p className="text-silver">Loading…</p>}

      {items && items.length === 0 && (
        <div className="bg-navy border border-navy-secondary rounded-lg p-8 text-center">
          <p className="font-display text-xl text-white mb-1">
            No active applications
          </p>
          <p className="text-silver text-sm">
            HR can create one via{' '}
            <code className="text-gold">POST /onboarding/applications</code>{' '}
            (see README).
          </p>
        </div>
      )}

      {items && items.length > 0 && (
        <div className="bg-navy border border-navy-secondary rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-navy-secondary/60 text-silver text-xs uppercase tracking-widest">
              <tr>
                <th className="text-left px-4 py-3">Applicant</th>
                <th className="text-left px-4 py-3 hidden md:table-cell">Client</th>
                <th className="text-left px-4 py-3 hidden lg:table-cell">Track</th>
                <th className="text-left px-4 py-3">Status</th>
                <th className="text-left px-4 py-3 w-48">Progress</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr
                  key={a.id}
                  className="border-t border-navy-secondary hover:bg-navy-secondary/30"
                >
                  <td className="px-4 py-3">
                    <Link
                      to={`/onboarding/applications/${a.id}`}
                      className="text-gold hover:text-gold-bright"
                    >
                      {a.associateName}
                    </Link>
                    {a.position && (
                      <div className="text-xs text-silver mt-0.5">
                        {a.position}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-white">
                    {a.clientName}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell text-silver">
                    {TRACK_LABEL[a.onboardingTrack] ?? a.onboardingTrack}
                  </td>
                  <td className="px-4 py-3 text-silver">
                    {STATUS_LABEL[a.status] ?? a.status}
                  </td>
                  <td className="px-4 py-3">
                    <ProgressBar percent={a.percentComplete} hideLabel />
                    <div className="text-xs text-silver mt-1">
                      {a.percentComplete}%
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
