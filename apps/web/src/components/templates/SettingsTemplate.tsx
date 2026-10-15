import * as React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/ui/PageHeader';
import { Card, CardContent } from '@/components/ui/Card';
import type { BreadcrumbSegment } from '@/components/ui/Breadcrumb';

/**
 * Settings — an area someone configures (design system §4.4): a left rail
 * of pages in sections, each page a stack of sections, every section with
 * the same header and the same place for its status ("checked 2 min ago",
 * "On", "3 of 5 passing"). Danger lives at the bottom of a page, never
 * beside a save button. On phones the rail becomes a horizontal strip.
 *
 * Two uses:
 *   - a whole page: `title` + `rail` + sections as children;
 *   - an AREA shell (pages/settings/SettingsArea): no `title`; the rail and
 *     an eyebrow, with the routed page (and its own PageHeader) as children.
 *
 *   <SettingsTemplate title="Settings & Trust" rail={RAIL} activeKey="sign-in">
 *     <SettingsSection title="Identity providers" status={<Badge …/>}>…</SettingsSection>
 *   </SettingsTemplate>
 */
export interface SettingsRailItem {
  key: string;
  label: string;
  to: string;
  icon?: LucideIcon;
  /** Rail items are grouped under these headings, in first-seen order. */
  section?: string;
  /** A short status for the rail row: a badge or a dot. */
  status?: React.ReactNode;
}

export interface SettingsTemplateProps {
  /** The page title; omit for an area shell (an eyebrow is shown instead). */
  title?: React.ReactNode;
  /** The eyebrow an area shell shows above the routed page. */
  areaLabel?: string;
  subtitle?: React.ReactNode;
  topbarTitle?: string;
  breadcrumbs?: BreadcrumbSegment[];
  rail: SettingsRailItem[];
  /** The active rail item; defaults to the item whose `to` the location starts with. */
  activeKey?: string;
  primaryAction?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function SettingsTemplate({ title, areaLabel, subtitle, topbarTitle, breadcrumbs, rail, activeKey, primaryAction, children, className }: SettingsTemplateProps) {
  const { pathname } = useLocation();
  const active =
    activeKey ??
    rail
      .filter((i) => pathname === i.to || pathname.startsWith(`${i.to}/`))
      .sort((a, b) => b.to.length - a.to.length)[0]?.key;
  const sections = React.useMemo(() => {
    const order: string[] = [];
    const by = new Map<string, SettingsRailItem[]>();
    for (const item of rail) {
      const s = item.section ?? '';
      if (!by.has(s)) {
        by.set(s, []);
        order.push(s);
      }
      by.get(s)!.push(item);
    }
    return order.map((s) => [s, by.get(s)!] as const);
  }, [rail]);

  return (
    <div className={cn('space-y-5', className)} data-template="settings">
      {title ? (
        <PageHeader title={title} subtitle={subtitle} topbarTitle={topbarTitle} breadcrumbs={breadcrumbs} primaryAction={primaryAction} />
      ) : areaLabel ? (
        <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">{areaLabel}</div>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[14rem_minmax(0,1fr)]">
        <nav aria-label={areaLabel ?? 'Settings'} className="-mx-4 flex gap-1 overflow-x-auto px-4 scrollbar-none lg:mx-0 lg:flex-col lg:gap-4 lg:overflow-visible lg:px-0">
          {sections.map(([section, items]) => (
            <div key={section || '_'} className="flex gap-1 lg:flex-col">
              {section && <div className="hidden px-3 pb-1 text-2xs uppercase tracking-[0.18em] text-ink-muted lg:block">{section}</div>}
              {items.map((item) => {
                const Icon = item.icon;
                const isActive = item.key === active;
                return (
                  <NavLink
                    key={item.key}
                    to={item.to}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm coarse:min-h-11',
                      isActive ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:bg-surface-raised/60 hover:text-ink',
                    )}
                  >
                    {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
                    <span className="truncate">{item.label}</span>
                    {item.status && <span className="ml-auto shrink-0">{item.status}</span>}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="min-w-0 space-y-5">{children}</div>
      </div>
    </div>
  );
}

export interface SettingsSectionProps {
  id?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** The section's status, right of the title: last check, on/off, a count. */
  status?: React.ReactNode;
  /** A small action for the whole section. */
  action?: React.ReactNode;
  /** Destructive sections render with a negative edge and sit last on the page. */
  danger?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function SettingsSection({ id, title, description, status, action, danger, children, className }: SettingsSectionProps) {
  const generated = React.useId();
  const headingId = id ?? generated;
  return (
    <Card className={cn(danger && 'border-negative/40', className)}>
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={headingId} className={cn('text-base font-medium', danger ? 'text-negative' : 'text-ink')}>
              {title}
            </h2>
            {description && <p className="mt-1 text-sm text-ink-muted">{description}</p>}
          </div>
          {(status || action) && (
            <div className="flex shrink-0 items-center gap-2">
              {status}
              {action}
            </div>
          )}
        </div>
        <div aria-labelledby={headingId}>{children}</div>
      </CardContent>
    </Card>
  );
}
