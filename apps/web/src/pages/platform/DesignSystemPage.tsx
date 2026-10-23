import { useEffect, useMemo, useState } from 'react';
import { Bot, Building2, CalendarDays, Clock, Inbox, ScrollText, ShieldCheck, Users, Wallet, BarChart3 } from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorBanner } from '@/components/ui/ErrorBanner';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Select } from '@/components/ui/Select';
import { Skeleton, SkeletonRows } from '@/components/ui/Skeleton';
import baseline from '../../../design-baseline.json';

/**
 * The living design system (step 1, docs/design-system.md): tokens read
 * from the page's own CSS variables, so what this page shows is what the
 * product renders in the current theme; the type scale; every component
 * in every state; the five templates; and the design-lint baseline that
 * the sweep pays down. For designers and engineers (view:product-analytics).
 */

const TOKENS: Array<{ job: string; cssVar: string; cls: string; use: string }> = [
  { job: 'App background', cssVar: '--color-surface-sunken', cls: 'bg-surface-sunken', use: 'the page behind cards' },
  { job: 'Surface', cssVar: '--color-surface', cls: 'bg-surface', use: 'cards, panels, sheets' },
  { job: 'Raised', cssVar: '--color-surface-raised', cls: 'bg-surface-raised', use: 'hover, selected row' },
  { job: 'Line', cssVar: '--color-line', cls: 'border-line', use: 'borders, dividers' },
  { job: 'Ink', cssVar: '--color-ink', cls: 'text-ink', use: 'primary text' },
  { job: 'Ink muted', cssVar: '--color-ink-muted', cls: 'text-ink-muted', use: 'secondary text' },
  { job: 'Ink subtle', cssVar: '--color-ink-subtle', cls: 'text-ink-subtle', use: 'placeholders, disabled' },
  { job: 'Accent', cssVar: '--color-accent', cls: 'text-accent', use: 'the one accent, as text' },
  { job: 'Accent fill', cssVar: '--color-accent-fill', cls: 'bg-accent-fill text-accent-on', use: 'the primary button' },
  { job: 'Positive', cssVar: '--color-positive', cls: 'text-positive', use: 'done, healthy, paid' },
  { job: 'Caution', cssVar: '--color-caution', cls: 'text-caution', use: 'waiting, due soon' },
  { job: 'Negative', cssVar: '--color-negative', cls: 'text-negative', use: 'failed, late, danger' },
  { job: 'Info', cssVar: '--color-info', cls: 'text-info', use: 'links, informational' },
];

const SCALE: Array<{ job: string; cls: string; sample: string; where: string }> = [
  { job: 'Hero', cls: 'font-display text-hero md:text-hero-lg leading-[1.1] tracking-tight text-ink', sample: 'Good morning, Maria', where: 'PageHeader; a home greeting' },
  { job: 'Title', cls: 'text-xl text-ink', sample: 'No shifts scheduled', where: 'EmptyState, a drawer title' },
  { job: 'Section', cls: 'text-base font-medium text-ink', sample: 'Needs you', where: 'SectionTitle' },
  { job: 'Body', cls: 'text-sm md:text-base text-ink', sample: 'Three timesheets wait for approval before Friday.', where: 'prose, cells' },
  { job: 'Caption', cls: 'text-xs2 text-ink-muted', sample: 'Checked 2 minutes ago', where: 'meta, hints' },
  { job: 'Micro', cls: 'text-2xs uppercase tracking-[0.18em] text-ink-muted', sample: 'This week', where: 'eyebrows, column labels' },
];

const ICONS = [
  ['Analytics', BarChart3],
  ['Clients', Building2],
  ['Compliance / Trust', ShieldCheck],
  ['Payroll', Wallet],
  ['Scheduling', CalendarDays],
  ['Time', Clock],
  ['People', Users],
  ['Agents', Bot],
  ['Audit', ScrollText],
  ['Desk', Inbox],
] as const;

function rgbOf(cssVar: string): string {
  if (typeof window === 'undefined') return '';
  const raw = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  // Tokens are RGB triplets ("11 24 50"), possibly through var() indirection, which getComputedStyle resolves.
  const m = raw.match(/\d+/g);
  if (!m || m.length < 3) return raw;
  const hex = m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
  return `#${hex.toUpperCase()}`;
}

export function DesignSystemPage() {
  const [theme, setTheme] = useState<string>(() => document.documentElement.getAttribute('data-theme') ?? 'dark');
  const [, bump] = useState(0);
  useEffect(() => {
    const obs = new MutationObserver(() => {
      setTheme(document.documentElement.getAttribute('data-theme') ?? 'dark');
      bump((n) => n + 1);
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  const [seg, setSeg] = useState<'a' | 'b' | 'c'>('a');
  const totals = useMemo(() => Object.entries((baseline as { totals: Record<string, number> }).totals), []);

  return (
    <div className="space-y-8" data-template="list">
      <PageHeader
        title="Design system"
        subtitle="The written standard the product follows, rendered from the live tokens so it cannot drift."
        breadcrumbs={[{ label: 'Settings & trust', to: '/admin' }, { label: 'Design system' }]}
        secondaryActions={<Badge variant="outline">Theme: {theme}</Badge>}
      />

      <section aria-labelledby="ds-principles">
        <SectionTitle id="ds-principles" title="Principles" />
        <ol className="grid gap-3 text-sm text-ink md:grid-cols-2">
          {[
            ['The system does the work; the person sees decisions.', 'A home opens with what needs that person today.'],
            ['Premium for every user.', 'The associate’s phone gets the same care as the executive’s board pack.'],
            ['Restraint.', 'Gold is punctuation. One hero per surface. Money in the sans, tabular.'],
            ['Trust you can see.', 'Evidence, chain status, decision records and gates are first-class surfaces.'],
            ['One language.', 'The tenant’s terms, three languages, icons that mean their labels.'],
            ['Nothing hand-rolled twice.', 'A pattern used on two pages becomes a component with states.'],
          ].map(([h, b], i) => (
            <li key={h} className="rounded-lg border border-line bg-surface p-4">
              <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">{i + 1}</div>
              <div className="mt-1 font-medium">{h}</div>
              <div className="mt-1 text-ink-muted">{b}</div>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="ds-tokens">
        <SectionTitle id="ds-tokens" title="Tokens by job" description="Read from this page’s CSS variables right now. Switch the theme in Settings and these change with it." />
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-2xs uppercase tracking-[0.18em] text-ink-muted">
                  <th className="px-4 py-2">Job</th>
                  <th className="px-4 py-2">Swatch</th>
                  <th className="px-4 py-2">Value</th>
                  <th className="px-4 py-2">Class</th>
                  <th className="hidden px-4 py-2 md:table-cell">Use</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {TOKENS.map((t) => (
                  <tr key={t.cssVar} className="text-ink">
                    <td className="px-4 py-2 font-medium">{t.job}</td>
                    <td className="px-4 py-2">
                      <span className="inline-block h-6 w-10 rounded-md border border-line" style={{ background: `rgb(var(${t.cssVar}))` }} aria-hidden="true" />
                    </td>
                    <td className="px-4 py-2 font-mono text-xs2 tabular-nums text-ink-muted">{rgbOf(t.cssVar)}</td>
                    <td className="px-4 py-2 font-mono text-xs2">{t.cls}</td>
                    <td className="hidden px-4 py-2 text-ink-muted md:table-cell">{t.use}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="ds-type">
        <SectionTitle id="ds-type" title="Type scale" description="Six jobs. Geist for everything read or compared; Cormorant Garamond for titles and greetings only." />
        <Card>
          <CardContent className="divide-y divide-line p-0">
            {SCALE.map((s) => (
              <div key={s.job} className="grid gap-2 px-4 py-3 md:grid-cols-[8rem_minmax(0,1fr)_14rem] md:items-baseline">
                <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">{s.job}</div>
                <div className={s.cls}>{s.sample}</div>
                <div className="text-xs2 text-ink-muted">{s.where}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="ds-components">
        <SectionTitle id="ds-components" title="Components and their states" description="Every component renders all of its states; pages never improvise one." />
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardContent className="space-y-3">
              <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">Button</div>
              <div className="flex flex-wrap gap-2">
                <Button>Primary</Button>
                <Button variant="secondary">Secondary</Button>
                <Button variant="outline">Outline</Button>
                <Button variant="ghost">Ghost</Button>
                <Button variant="destructive">Destructive</Button>
                <Button variant="link">Link</Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm">Small</Button>
                <Button disabled>Disabled</Button>
                <Button loading>Saving</Button>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-3">
              <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">Badge</div>
              <div className="flex flex-wrap gap-2">
                <Badge>Default</Badge>
                <Badge variant="success">Active</Badge>
                <Badge variant="pending">Waiting</Badge>
                <Badge variant="destructive">Failed</Badge>
                <Badge variant="accent">New</Badge>
                <Badge variant="info">Info</Badge>
                <Badge variant="outline">Outline</Badge>
              </div>
              <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">Segmented control</div>
              <SegmentedControl
                ariaLabel="Example"
                options={[
                  { value: 'a', label: 'Accounts' },
                  { value: 'b', label: 'Access report' },
                  { value: 'c', label: 'Roles' },
                ]}
                value={seg}
                onChange={setSeg}
              />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-3">
              <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">Form</div>
              <Field label="Email" hint="Where the invite goes." required>
                {(p) => <Input {...p} placeholder="ana@acme.com" />}
              </Field>
              <Field label="Role" error="Pick a role.">
                {(p) => (
                  <Select {...p} defaultValue="">
                    <option value="">Choose…</option>
                    <option value="m">Manager</option>
                  </Select>
                )}
              </Field>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-3">
              <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">Loading</div>
              <Skeleton className="h-8 w-40" />
              <SkeletonRows count={3} />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-3">
              <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">Nothing here</div>
              <EmptyState icon={CalendarDays} title="No shifts scheduled" description="Create the first shift to start staffing this week." action={<Button size="sm">New shift</Button>} />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-3">
              <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">Notices</div>
              <ErrorBanner>Could not save the role. Try again.</ErrorBanner>
              <ErrorBanner severity="warning">Two people hold this role; deleting it is refused.</ErrorBanner>
              <ErrorBanner severity="info">Changes reach holders on their next request.</ErrorBanner>
            </CardContent>
          </Card>
        </div>
      </section>

      <section aria-labelledby="ds-templates">
        <SectionTitle id="ds-templates" title="The five page templates" description="Every page is one of these and says so (data-template)." />
        <div className="grid gap-3 md:grid-cols-5">
          {[
            ['Home', 'banners · greeting · one hero · decisions · what changed · Hugo · ways in'],
            ['List', 'header · summary · one filter row · DataGrid · Drawer'],
            ['Record', 'identity · title · status · actions · tabs · timeline'],
            ['Settings', 'left rail · sections · status in the same place · danger last'],
            ['Desk', 'counts · filter · queue · open item · action · closure'],
          ].map(([h, b]) => (
            <div key={h} className="rounded-lg border border-line bg-surface p-4">
              <div className="font-medium text-ink">{h}</div>
              <div className="mt-1 text-xs2 text-ink-muted">{b}</div>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="ds-icons">
        <SectionTitle id="ds-icons" title="Icons mean their labels" />
        <div className="flex flex-wrap gap-3">
          {ICONS.map(([label, Icon]) => (
            <div key={label} className="flex items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink">
              <Icon className="h-4 w-4 text-ink-muted" aria-hidden="true" />
              {label}
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="ds-lint">
        <SectionTitle id="ds-lint" title="The design debt" description="What the design lint counts in page code. The baseline only shrinks; a rise fails CI." />
        <div className="grid gap-3 sm:grid-cols-3 md:grid-cols-6">
          {totals.map(([k, n]) => (
            <div key={k} className="rounded-lg border border-line bg-surface p-4">
              <div className="text-2xs uppercase tracking-[0.18em] text-ink-muted">{k}</div>
              <div className="mt-1 font-sans text-2xl font-semibold tabular-nums text-ink">{n}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
