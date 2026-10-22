import * as React from 'react';
import { Link } from 'react-router-dom';
import { MoreHorizontal, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useConfirmIfMounted, type ConfirmOptions } from '@/lib/confirm';
import { useI18n } from '@/lib/i18n';
import { useResolvedCrumbs } from '@/lib/navTrail';
import { useHeroObserver, usePublishPageTitle } from '@/lib/pageTitle';
import { useMediaQuery } from '@/lib/useViewport';
import { Breadcrumb, headerCrumbs, type BreadcrumbSegment } from './Breadcrumb';
import { Button } from './Button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './Dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './DropdownMenu';

/**
 * The page header every page uses (design system §4; the F500 fix-up of
 * 2026-10-22): breadcrumb, title and status, the page's key facts, then the
 * actions — one primary, at most two more beside it, and everything else
 * (every destructive action included) in a "More" menu. On a phone only the
 * primary stays out; the rest open in one sheet.
 *
 *   <PageHeader
 *     title="Payroll run · Oct 3 – Oct 16"
 *     subtitle="Biweekly · pays Oct 23"
 *     facts={[{ label: 'Gross', value: '$84,120.00' }, { label: 'People', value: '212', to: '/payroll/pay-checks?run=…' }]}
 *     actions={[
 *       { label: 'Approve run', primary: true, onSelect: approve },
 *       { label: 'Export', icon: Download, onSelect: exportCsv },
 *       { label: 'Void run', destructive: true, confirm: { title: 'Void this run?' }, onSelect: voidRun },
 *     ]}
 *     related={[{ label: 'Pay schedules', to: '/payroll/schedules' }]}
 *   />
 *
 * Breadcrumbs: leave `breadcrumbs` out and the trail comes from the nav
 * (lib/navTrail — the door and parent module the sidebar shows); pass your
 * own only for a record's drill-down; pass `[]` for none. A lone crumb that
 * only repeats the title is never drawn.
 *
 * Navigation to a sibling page is not an action: put it in `related`
 * (a quiet row of links), not in a button.
 *
 * `primaryAction` / `secondaryActions` (React nodes) still work for pages
 * not yet on `actions`; on a phone their secondaries move into the sheet.
 */

/** One header action. Give it `onSelect`, `to` (inside the app) or `href`. */
export interface PageAction {
  /** Stable key; defaults to the label. */
  key?: string;
  label: string;
  icon?: LucideIcon;
  onSelect?: () => void;
  to?: string;
  href?: string;
  /** For `href`: a file to save rather than a page to open. */
  download?: boolean | string;
  /** The page's main action: gold, always in view (phones too). One per header. */
  primary?: boolean;
  /** Removes, cancels, stops or suspends: always in "More", last, in the alert colour. */
  destructive?: boolean;
  /** Asked before `onSelect` runs — a destructive action keeps its confirm. */
  confirm?: ConfirmOptions;
  disabled?: boolean;
  loading?: boolean;
  /** Belongs in "More" even when there is room beside the primary (rarely used). */
  overflow?: boolean;
  /** A line of help: the button's tooltip, the menu item's second line. */
  hint?: string;
  /** Left out (a capability the person lacks) — easier than filtering at the call site. */
  hidden?: boolean;
}

/** One key fact under the title — a number or state someone would ask about. */
export interface PageFact {
  label: string;
  /** Null/undefined/'' hides the fact: never show a stand-in for a number we don't have. */
  value: React.ReactNode;
  /** The list behind the number. */
  to?: string;
  hint?: string;
}

/** A sibling or related page: navigation, so a link — never an action button. */
export interface RelatedLink {
  label: string;
  to: string;
}

/** The shared confirm, or null (no provider; a test that mocks lib/confirm with less). */
function useMaybeConfirm() {
  try {
    return useConfirmIfMounted();
  } catch {
    return null;
  }
}

/** How many secondary actions stand beside the primary before "More". */
export const MAX_VISIBLE_SECONDARY = 2;

/** True when `x` is the structured actions model rather than React nodes. */
export function isPageActions(x: unknown): x is PageAction[] {
  return (
    Array.isArray(x) &&
    x.length > 0 &&
    x.every((a) => !!a && typeof a === 'object' && !React.isValidElement(a) && typeof (a as PageAction).label === 'string')
  );
}

/** Fragments unwrapped, nulls dropped, each keyed: the nodes a `secondaryActions` prop really holds. */
function flattenNodes(node: React.ReactNode, prefix = ''): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  React.Children.toArray(node).forEach((child) => {
    if (child === '') return;
    if (React.isValidElement(child) && child.type === React.Fragment) {
      out.push(...flattenNodes((child.props as { children?: React.ReactNode }).children, `${prefix}${String(child.key ?? '')}/`));
      return;
    }
    out.push(React.isValidElement(child) ? React.cloneElement(child, { key: `${prefix}${String(child.key ?? '')}` }) : child);
  });
  return out;
}

export interface HeaderActionsProps {
  actions?: PageAction[];
  /** Legacy: the primary as a node. Always in view. */
  primaryAction?: React.ReactNode;
  /** Legacy: secondaries as nodes. In view on desktop; in the "More" sheet on a phone when there is more than one. */
  secondaryActions?: React.ReactNode;
  className?: string;
}

/**
 * The header's action row — shared by PageHeader and the templates that
 * draw their own header (RecordTemplate), so every page counts its
 * actions the same way.
 */
export function HeaderActions({ actions, primaryAction, secondaryActions, className }: HeaderActionsProps) {
  const { t } = useI18n();
  const wide = useMediaQuery('(min-width: 768px)');
  const confirm = useMaybeConfirm();
  const [sheetOpen, setSheetOpen] = React.useState(false);

  const list = (actions ?? []).filter((a) => a && !a.hidden);
  const primary = list.find((a) => a.primary && !a.destructive) ?? null;
  const others = list.filter((a) => a !== primary);
  const plain = others.filter((a) => !a.destructive && !a.overflow);
  const tucked = others.filter((a) => !a.destructive && a.overflow);
  const danger = others.filter((a) => a.destructive);
  const legacy = flattenNodes(secondaryActions);
  const hasPrimary = !!primary || flattenNodes(primaryAction).length > 0;

  const run = async (a: PageAction) => {
    if (a.disabled || a.loading || !a.onSelect) return;
    if (a.confirm) {
      const options = { destructive: a.destructive, ...a.confirm };
      const ok = confirm ? await confirm(options) : window.confirm(options.title);
      if (!ok) return;
    }
    a.onSelect();
  };

  let inline: PageAction[];
  let menu: PageAction[];
  let legacyInline: boolean;
  if (wide) {
    inline = plain.slice(0, MAX_VISIBLE_SECONDARY);
    menu = [...plain.slice(MAX_VISIBLE_SECONDARY), ...tucked];
    legacyInline = true;
  } else {
    // A phone: the primary, and one "More". A lone secondary with nothing
    // else around it stays a button — a menu of one is a detour.
    const loneAction = !hasPrimary && legacy.length === 0 && danger.length === 0 && plain.length + tucked.length === 1;
    const loneNode = !hasPrimary && plain.length + tucked.length + danger.length === 0 && legacy.length === 1;
    inline = loneAction ? [...plain, ...tucked] : [];
    menu = loneAction ? [] : [...plain, ...tucked];
    legacyInline = loneNode;
  }
  const inMenu = menu.length + danger.length + (legacyInline ? 0 : legacy.length);
  if (!hasPrimary && inline.length === 0 && inMenu === 0 && (!legacyInline || legacy.length === 0)) return null;

  const moreLabel = t('header.more');
  const moreAria = t('header.moreActions');

  return (
    <div
      className={cn(
        // Wraps rather than scrolls: a row that swipes sideways hid its
        // last buttons off-screen ("Tomorrow" read "To").
        'flex max-w-full min-w-0 flex-wrap items-center gap-2',
        className,
      )}
      data-testid="page-actions"
    >
      {/* Phone: the main action first, full of itself; desktop: last. */}
      {wide && legacyInline && legacy}
      {inline.map((a) => (
        <ActionButton key={a.key ?? a.label} action={a} variant="secondary" onRun={run} />
      ))}
      {primary && <ActionButton action={primary} variant="primary" onRun={run} className={cn(!wide && 'order-first')} />}
      {primaryAction && (
        // A page's own row of buttons (a legacy node) wraps too: the driver's
        // Sound · Safety · Report · Log fuel ran 6px off a 390px screen.
        <div className={cn('flex min-w-0 max-w-full flex-wrap items-center gap-2 [&>*]:max-w-full [&>div]:flex-wrap', !wide && 'order-first')}>{primaryAction}</div>
      )}
      {!wide && legacyInline && legacy}
      {inMenu > 0 &&
        (wide ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary" aria-label={moreAria}>
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                {moreLabel}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[13rem]">
              {menu.map((a) => (
                <MenuAction key={a.key ?? a.label} action={a} onRun={run} />
              ))}
              {menu.length > 0 && danger.length > 0 && <DropdownMenuSeparator />}
              {danger.map((a) => (
                <MenuAction key={a.key ?? a.label} action={a} onRun={run} />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <>
            <Button variant="secondary" aria-label={moreAria} aria-haspopup="dialog" aria-expanded={sheetOpen} onClick={() => setSheetOpen(true)}>
              <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
              {moreLabel}
            </Button>
            <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
              <DialogContent onCloseAutoFocus={(e) => e.preventDefault()}>
                <DialogHeader>
                  <DialogTitle>{moreAria}</DialogTitle>
                  <DialogDescription className="sr-only">{t('header.moreActionsHint')}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-1">
                  {menu.map((a) => (
                    <SheetAction key={a.key ?? a.label} action={a} onRun={run} close={() => setSheetOpen(false)} />
                  ))}
                </div>
                {!legacyInline && legacy.length > 0 && (
                  <div
                    className="flex flex-col gap-2 [&>*]:w-full [&>*]:justify-start"
                    // A tap on one of the page's own buttons does its job and
                    // puts the sheet away — unless it opens something of its
                    // own here (a menu), which needs the sheet to stay.
                    onClickCapture={(e) => {
                      const el = (e.target as HTMLElement).closest('a,button');
                      if (!el || el.getAttribute('aria-haspopup') === 'menu' || el.getAttribute('aria-haspopup') === 'listbox') return;
                      window.setTimeout(() => setSheetOpen(false), 0);
                    }}
                  >
                    {legacy}
                  </div>
                )}
                {danger.length > 0 && (
                  <div className="flex flex-col gap-1 border-t border-line pt-2">
                    {danger.map((a) => (
                      <SheetAction key={a.key ?? a.label} action={a} onRun={run} close={() => setSheetOpen(false)} />
                    ))}
                  </div>
                )}
              </DialogContent>
            </Dialog>
          </>
        ))}
    </div>
  );
}

function ActionContent({ action }: { action: PageAction }) {
  const Icon = action.icon;
  return (
    <>
      {Icon && <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />}
      {action.label}
    </>
  );
}

function ActionButton({
  action,
  variant,
  onRun,
  className,
}: {
  action: PageAction;
  variant: 'primary' | 'secondary';
  onRun: (a: PageAction) => void;
  className?: string;
}) {
  if (action.to && !action.disabled) {
    return (
      <Button asChild variant={variant} className={className} title={action.hint}>
        <Link to={action.to}>
          <ActionContent action={action} />
        </Link>
      </Button>
    );
  }
  if (action.href && !action.disabled) {
    return (
      <Button asChild variant={variant} className={className} title={action.hint}>
        <a href={action.href} download={action.download}>
          <ActionContent action={action} />
        </a>
      </Button>
    );
  }
  return (
    <Button
      variant={variant}
      className={className}
      title={action.hint}
      loading={action.loading}
      disabled={action.disabled}
      onClick={() => onRun(action)}
    >
      <ActionContent action={action} />
    </Button>
  );
}

function MenuAction({ action, onRun }: { action: PageAction; onRun: (a: PageAction) => void }) {
  const body = (
    <span className="flex min-w-0 flex-col">
      <span className="flex items-center gap-2">
        <ActionContent action={action} />
      </span>
      {action.hint && <span className="text-xs text-silver">{action.hint}</span>}
    </span>
  );
  if ((action.to || action.href) && !action.disabled) {
    return (
      <DropdownMenuItem asChild destructive={action.destructive}>
        {action.to ? (
          <Link to={action.to}>{body}</Link>
        ) : (
          <a href={action.href} download={action.download}>
            {body}
          </a>
        )}
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem
      destructive={action.destructive}
      disabled={action.disabled || action.loading}
      // Let the menu close first, so a confirm dialog opens over the page
      // rather than racing the menu's own focus return.
      onSelect={() => window.setTimeout(() => onRun(action), 0)}
    >
      {body}
    </DropdownMenuItem>
  );
}

function SheetAction({ action, onRun, close }: { action: PageAction; onRun: (a: PageAction) => void; close: () => void }) {
  const cls = cn(
    'flex min-h-12 w-full items-center gap-3 rounded-md px-3 text-left text-base transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright disabled:opacity-50',
    action.destructive ? 'text-alert hover:bg-alert/10' : 'text-ink hover:bg-surface-raised',
  );
  const body = (
    <span className="flex min-w-0 flex-col">
      <span className="flex items-center gap-2">
        <ActionContent action={action} />
      </span>
      {action.hint && <span className="text-xs text-ink-muted">{action.hint}</span>}
    </span>
  );
  if (action.to && !action.disabled) {
    return (
      <Link to={action.to} className={cls} onClick={close}>
        {body}
      </Link>
    );
  }
  if (action.href && !action.disabled) {
    return (
      <a href={action.href} download={action.download} className={cls} onClick={close}>
        {body}
      </a>
    );
  }
  return (
    <button
      type="button"
      className={cls}
      disabled={action.disabled || action.loading}
      onClick={() => {
        close();
        window.setTimeout(() => onRun(action), 0);
      }}
    >
      {body}
    </button>
  );
}

/** The key facts row: label over value, the value a link when there's a list behind it. */
export function HeaderFacts({ facts, className }: { facts?: PageFact[]; className?: string }) {
  const shown = (facts ?? []).filter((f) => f.value !== null && f.value !== undefined && f.value !== '' && f.value !== false);
  if (shown.length === 0) return null;
  return (
    <dl className={cn('mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:flex sm:flex-wrap', className)} data-testid="page-facts">
      {shown.map((f) => (
        <div key={f.label} className="min-w-0" title={f.hint}>
          <dt className="text-xs text-ink-muted">{f.label}</dt>
          <dd className="mt-0.5 truncate text-sm font-medium tabular-nums text-ink">
            {f.to ? (
              <Link to={f.to} className="underline-offset-2 hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded-sm">
                {f.value}
              </Link>
            ) : (
              f.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Related pages, as links under the title — where navigation styled as buttons used to sit. */
export function RelatedLinks({ links, className }: { links?: RelatedLink[]; className?: string }) {
  const { t } = useI18n();
  if (!links || links.length === 0) return null;
  return (
    <nav aria-label={t('header.related')} className={cn('mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm', className)}>
      <span className="text-ink-muted">{t('header.related')}</span>
      {links.map((l) => (
        <Link key={l.to + l.label} to={l.to} className="text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright rounded-sm">
          {l.label}
        </Link>
      ))}
    </nav>
  );
}

interface PageHeaderProps {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /**
   * What the topbar/chrome shows for "you are here", when it should differ
   * from the on-page hero. Defaults to `title`. Use it when the hero is a
   * greeting or other non-page-name copy (e.g. "Hey Maria 👋" → "Home") so
   * the chrome doesn't redundantly echo the h1 sitting right beneath it.
   */
  topbarTitle?: string;
  /** Leave out for the nav's trail; `[]` for none; your own for a drill-down. */
  breadcrumbs?: BreadcrumbSegment[];
  /** Status badges beside the title. */
  status?: React.ReactNode;
  /** The key facts under the title (label · value), each linking to its list. */
  facts?: PageFact[];
  /** Sibling pages, as links — not as buttons. */
  related?: RelatedLink[];
  /** A quiet row under the subtitle (a desk's counts, "as of"). */
  meta?: React.ReactNode;
  /** The actions, as data: one primary, two beside it, the rest (and every destructive one) in "More". */
  actions?: PageAction[];
  /** Legacy: the primary CTA as a node. */
  primaryAction?: React.ReactNode;
  /** Legacy: secondary actions as nodes. */
  secondaryActions?: React.ReactNode;
  /** Optional content rendered below the stripe (e.g., a tab bar). */
  children?: React.ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  topbarTitle,
  breadcrumbs,
  status,
  facts,
  related,
  meta,
  actions,
  primaryAction,
  secondaryActions,
  children,
  className,
}: PageHeaderProps) {
  // Publish the title + breadcrumbs to the topbar context so chrome can
  // show "you are here" wayfinding after the user scrolls past this header.
  // `topbarTitle` wins when set; otherwise only string titles can roundtrip
  // (richer ReactNodes fall back to the page's nav label).
  const published = topbarTitle ?? (typeof title === 'string' ? title : null);
  const crumbs = useResolvedCrumbs(breadcrumbs, published);
  usePublishPageTitle(published, crumbs);
  // In the page: the way up; the page's own name is the heading below it.
  const trail = headerCrumbs(crumbs, published);

  // While this heading is on screen the topbar keeps quiet; once it scrolls
  // away the chrome picks the name up. One title at a time, like an app.
  const heroRef = React.useRef<HTMLHeadingElement>(null);
  useHeroObserver(heroRef);

  const hasActions = (actions && actions.some((a) => !a.hidden)) || primaryAction || secondaryActions;

  return (
    <header className={cn('mb-5 md:mb-[var(--d-stack-lg)]', className)}>
      {/* Phones read like an app's large-title header: no breadcrumb trail
          (the top bar names the page and carries Back). */}
      {trail && (
        <div className="hidden md:block">
          <Breadcrumb segments={trail.segments} current={trail.current} />
        </div>
      )}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        {/* min-w-[16rem] (not min-w-0): with a long action row, flex-1 +
            min-w-0 let this block collapse to a sliver — on tablets the
            subtitle rendered one word per line. Guaranteeing a readable
            minimum makes the WRAP happen instead (actions drop below). */}
        <div className="min-w-[min(16rem,100%)] flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 ref={heroRef} className="font-display text-hero md:text-hero-lg leading-[1.1] tracking-tight text-white">
              {title}
            </h1>
            {status}
          </div>
          {/* The whole sentence, on every screen: a two-line clamp cut
              "…it does not mean you agree with it" off a phone. */}
          {subtitle && <p className="text-silver mt-2 text-sm md:text-base max-w-3xl leading-relaxed">{subtitle}</p>}
          <HeaderFacts facts={facts} />
          {meta && <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div>}
          <RelatedLinks links={related} />
        </div>
        {hasActions && <HeaderActions actions={actions} primaryAction={primaryAction} secondaryActions={secondaryActions} />}
      </div>
      {children && <div className="mt-5">{children}</div>}
    </header>
  );
}
