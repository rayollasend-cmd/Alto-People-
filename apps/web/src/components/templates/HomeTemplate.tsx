import * as React from 'react';
import { cn } from '@/lib/cn';
import { useNeedsYouCount } from '@/lib/meDecisions';
import { PageHeader, isPageActions, type PageAction } from '@/components/ui/PageHeader';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { FirstLoadGate } from './FirstLoadGate';
import { WhatsNew } from '@/components/WhatsNew';

/**
 * Home — a role's first screen (design system §4.1).
 *
 * Reading order is the principle "the system does the work; the person
 * sees decisions": banners that interrupt (emergency, onboarding), the
 * greeting, ONE hero (the number or state that defines this person's day),
 * then what needs them, then what changed and the rest of the day, then
 * the assistant's seat, then the ways into the product.
 *
 *   <HomeTemplate
 *     title={`Good morning, ${firstName}`} topbarTitle="Home"
 *     meta={<HomeMeta items={[today, ...clock]} />}
 *     hero={<MyShiftHero />}
 *     decisions={{ title: 'Needs you', queue: true, count: cards.length, content: <><Cards /><RoleDecisionQueue title={null} /></> }}
 *     changes={<WhatChanged />}
 *     waysIn={<QuickActions />}
 *     assistant={<HugoSeat />}
 *   />
 *
 * The "Needs you" count is the number of things listed under it. With
 * `queue: true` the section holds the role's decision queue, and the count
 * is its rows plus `count` (the page's own cards); a card that is also a
 * queue row is named in `cardKeys` and counted once.
 *
 * Hugo's seat is a full-width bar after the day's content, the same place
 * on every home — not a third of the page that stayed empty below him; the
 * main column takes the full width.
 */
export interface HomeTemplateProps {
  title: React.ReactNode;
  /** What the top bar shows once the greeting scrolls away ("Home"). */
  topbarTitle?: string;
  subtitle?: React.ReactNode;
  /** A quiet line under the greeting: the date, the clock (see HomeMeta). */
  meta?: React.ReactNode;
  /** At most one primary action in the header (the executive's board pack): the PageHeader list, or a node. */
  actions?: PageAction[] | React.ReactNode;
  /** Interrupting banners, above everything. */
  banners?: React.ReactNode;
  /** The one hero. */
  hero: React.ReactNode;
  /** What needs this person today. Rendered with its own section title and count. */
  decisions?: {
    title: React.ReactNode;
    /** The page's own items in the section (cards), or — without `queue` — the whole count. */
    count?: number;
    /** The section holds the role's decision queue: its rows count too. */
    queue?: boolean;
    /** The page's cards that are also queue rows (by the queue's key), counted once. */
    cardKeys?: string[];
    content: React.ReactNode;
    trailing?: React.ReactNode;
  };
  /** What changed since they last looked. */
  changes?: { title?: React.ReactNode; content: React.ReactNode };
  /** Ways into the product: quick actions, shortcuts. */
  waysIn?: React.ReactNode;
  /** Hugo's seat. */
  assistant?: React.ReactNode;
  /** Anything else, after the structured sections. */
  children?: React.ReactNode;
  className?: string;
}

export function HomeTemplate({ title, topbarTitle = 'Home', subtitle, meta, actions, banners, hero, decisions, changes, waysIn, assistant, children, className }: HomeTemplateProps) {
  const queued = useNeedsYouCount({ queue: !!decisions?.queue, cards: decisions?.count ?? 0, cardKeys: decisions?.cardKeys });
  const count = decisions?.queue ? queued : decisions?.count;
  const structured = isPageActions(actions) ? actions : undefined;
  return (
    // A home appears whole, once its cards' first data has landed (FirstLoadGate).
    <FirstLoadGate page="home">
      <div className={cn('space-y-[var(--d-stack-lg)]', className)} data-template="home">
        {banners}
        <PageHeader title={title} subtitle={subtitle} topbarTitle={topbarTitle} breadcrumbs={[]} actions={structured} primaryAction={structured ? undefined : (actions as React.ReactNode)}>
          {meta}
        </PageHeader>
        {/* The latest release note, once per note — in the page, never floating over it. */}
        <WhatsNew />
        <section aria-label="Today">{hero}</section>
        {decisions && (
          <section aria-labelledby="home-decisions">
            <SectionTitle
              id="home-decisions"
              title={
                <>
                  {decisions.title}
                  {count !== undefined && count > 0 && (
                    <span className="ml-2 inline-flex min-w-6 items-center justify-center rounded-full bg-accent-fill px-1.5 text-xs font-semibold tabular-nums text-accent-on" data-testid="needs-you-count">
                      {count}
                    </span>
                  )}
                </>
              }
              trailing={decisions.trailing}
            />
            {decisions.content}
          </section>
        )}
        {(changes || children) && (
          <div className="min-w-0 space-y-[var(--d-stack-lg)]">
            {changes && (
              <section aria-labelledby="home-changes">
                <SectionTitle id="home-changes" title={changes.title ?? 'What changed'} />
                {changes.content}
              </section>
            )}
            {children}
          </div>
        )}
        {/* Hugo renders nothing when nothing is switched on for this person,
            so an empty seat never takes room. After the day's own content —
            a phone reads the next shift before the assistant. */}
        {assistant && (
          <section aria-label="Assistant" className="empty:hidden">
            {assistant}
          </section>
        )}
        {waysIn && <section aria-label="Shortcuts">{waysIn}</section>}
      </div>
    </FirstLoadGate>
  );
}
