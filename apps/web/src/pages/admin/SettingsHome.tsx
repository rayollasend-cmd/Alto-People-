import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { EmptyState } from '@/components/ui/EmptyState';
import { SearchInput } from '@/components/ui/FilterBar';
import { PageHeader } from '@/components/ui/PageHeader';
import { useSettingsRail, type SettingsRailEntry } from '@/pages/settings/settingsRail';

interface HealthItem {
  key: string;
  tone: 'bad' | 'warn';
  label: string;
}

/**
 * Settings & trust — the room behind the one door.
 *
 * Fifteen admin pages used to sit as fifteen rows in the sidebar, peers of
 * Scheduling and Payroll. They are one door now, and this is the overview
 * the door opens on: the same pages the area's rail lists, as cards in the
 * sections an IT or HR administrator thinks in, each with the one line
 * that says what it is for. It renders inside the area shell
 * (pages/settings/SettingsArea), which draws the rail.
 */
export function SettingsHome() {
  const rail = useSettingsRail();
  const [q, setQ] = useState('');
  // A badge on the cards with something wrong now (a failing integration,
  // no email provider, an access review past due).
  const health = useQuery({
    queryKey: ['settings', 'health'],
    queryFn: () => apiFetch<{ items: HealthItem[] }>('/admin/settings-health'),
    staleTime: 60_000,
    retry: false,
  });
  const badge = new Map((health.data?.items ?? []).map((h) => [h.key, h]));
  const term = q.trim().toLowerCase();
  const shown = term ? rail.filter((i) => `${i.label} ${i.description} ${i.section ?? ''}`.toLowerCase().includes(term)) : rail;
  const sections: Array<[string, SettingsRailEntry[]]> = [];
  for (const item of shown) {
    const s = item.section ?? '';
    const found = sections.find(([name]) => name === s);
    if (found) found[1].push(item);
    else sections.push([s, [item]]);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings & trust"
        subtitle="How the organization is run — and the evidence that it is."
      />
      <div className="max-w-md">
        <SearchInput aria-label="Find a setting" placeholder="Find a setting — “SSO”, “retention”, “logo”…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {shown.length === 0 && <EmptyState title="No setting matches" description="Try another word, or clear the search." />}
      {sections.map(([name, items]) => (
        <section key={name || '_'} aria-labelledby={`settings-${name}`}>
          <h2 id={`settings-${name}`} className="mb-2 text-2xs font-semibold uppercase tracking-[0.18em] text-ink-muted">
            {name}
          </h2>
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" role="list">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.key}>
                  <Link
                    to={item.to}
                    className="group flex h-full items-start gap-3 rounded-lg border border-navy-secondary bg-surface-raised/30 p-3.5 transition-colors hover:border-silver/40 hover:bg-surface-raised/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
                  >
                    {Icon && (
                      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-surface-raised text-gold">
                        <Icon className="h-4 w-4" aria-hidden="true" />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                        {item.label}
                        {badge.get(item.key) && (
                          <Badge variant={badge.get(item.key)!.tone === 'bad' ? 'destructive' : 'pending'} size="sm">
                            {badge.get(item.key)!.label}
                          </Badge>
                        )}
                      </span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{item.description}</span>
                    </span>
                    <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-ink-muted/60 transition-colors group-hover:text-ink-muted" aria-hidden="true" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
