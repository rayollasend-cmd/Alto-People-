import * as React from 'react';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/ui/PageHeader';
import { SectionTitle } from '@/components/ui/SectionTitle';

/**
 * Home — a role's first screen (design system §4.1).
 *
 * Reading order is the principle "the system does the work; the person
 * sees decisions": banners that interrupt (emergency, onboarding), the
 * greeting, ONE hero (the number or state that defines this person's day),
 * then what needs them, then what changed, then the ways into the product.
 * Hugo has the same seat on every home.
 *
 *   <HomeTemplate
 *     title={`Good morning, ${firstName}`} topbarTitle="Home"
 *     hero={<MyShiftHero />}
 *     decisions={{ title: 'Needs you', count: 3, content: <DecisionQueue /> }}
 *     changes={<WhatChanged />}
 *     waysIn={<QuickActions />}
 *     assistant={<HugoCard />}
 *   />
 */
export interface HomeTemplateProps {
  title: React.ReactNode;
  /** What the top bar shows once the greeting scrolls away ("Home"). */
  topbarTitle?: string;
  subtitle?: React.ReactNode;
  /** Interrupting banners, above everything. */
  banners?: React.ReactNode;
  /** The one hero. */
  hero: React.ReactNode;
  /** What needs this person today. Rendered with its own section title and count. */
  decisions?: { title: React.ReactNode; count?: number; content: React.ReactNode; trailing?: React.ReactNode };
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

export function HomeTemplate({ title, topbarTitle = 'Home', subtitle, banners, hero, decisions, changes, waysIn, assistant, children, className }: HomeTemplateProps) {
  return (
    <div className={cn('space-y-6', className)} data-template="home">
      {banners}
      <PageHeader title={title} subtitle={subtitle} topbarTitle={topbarTitle} />
      <section aria-label="Today">{hero}</section>
      {decisions && (
        <section aria-labelledby="home-decisions">
          <SectionTitle
            id="home-decisions"
            title={
              <>
                {decisions.title}
                {decisions.count !== undefined && decisions.count > 0 && (
                  <span className="ml-2 inline-flex min-w-6 items-center justify-center rounded-full bg-accent-fill px-1.5 text-xs font-semibold tabular-nums text-accent-on">{decisions.count}</span>
                )}
              </>
            }
            trailing={decisions.trailing}
          />
          {decisions.content}
        </section>
      )}
      <div className={cn('grid gap-6', assistant ? 'lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]' : '')}>
        <div className="min-w-0 space-y-6">
          {changes && (
            <section aria-labelledby="home-changes">
              <SectionTitle id="home-changes" title={changes.title ?? 'What changed'} />
              {changes.content}
            </section>
          )}
          {children}
        </div>
        {assistant && <aside className="min-w-0">{assistant}</aside>}
      </div>
      {waysIn && <section aria-label="Shortcuts">{waysIn}</section>}
    </div>
  );
}
