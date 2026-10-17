import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { useSettingsRail, type SettingsRailEntry } from '@/pages/settings/settingsRail';

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
  const sections: Array<[string, SettingsRailEntry[]]> = [];
  for (const item of rail) {
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
                      <span className="block text-sm font-medium text-ink">{item.label}</span>
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
