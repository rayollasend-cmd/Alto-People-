import { cn } from '@/lib/cn';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/Tooltip';
import { HEALTH_LABEL, type Health } from './clientsList';

/**
 * An account's health as a dot and a word — Good, Watch, At risk — with
 * the reasons a hover (or focus) away. The colour never stands alone: the
 * word is always there, and the reasons are the dot's accessible name.
 */

const DOT: Record<Health, string> = {
  good: 'bg-success',
  watch: 'bg-warning',
  risk: 'bg-alert',
};
const TEXT: Record<Health, string> = {
  good: 'text-ink-muted',
  watch: 'text-warning',
  risk: 'text-alert',
};

export function HealthDot({ health, className }: { health: Health; className?: string }) {
  return <span aria-hidden="true" className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', DOT[health], className)} />;
}

export function healthSentence(health: Health, reasons: string[]): string {
  return reasons.length ? `${HEALTH_LABEL[health]}: ${reasons.join('; ')}` : HEALTH_LABEL[health];
}

/** The table's Health cell: dot + label, the reasons in a tooltip. */
export function HealthCell({ health, reasons }: { health: Health | undefined; reasons: string[] | undefined }) {
  if (!health) return <span className="text-ink-subtle">—</span>;
  const list = reasons ?? [];
  const body = (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-sm', TEXT[health])}>
      <HealthDot health={health} />
      <span className={list.length > 0 ? 'underline decoration-dotted underline-offset-4' : undefined}>{HEALTH_LABEL[health]}</span>
    </span>
  );
  if (list.length === 0) return body;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright" aria-label={healthSentence(health, list)}>
          {body}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-xs">
        <ul className="space-y-1">
          {list.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}
