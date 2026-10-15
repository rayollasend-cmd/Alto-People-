import { Bot, BriefcaseBusiness, Gavel, MessageSquareText, Rocket, ShieldCheck, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * One mark for an agent everywhere it appears (the Agents page, its
 * record, the roster, Hugo's seat): a rounded tile whose icon says the
 * family and whose dot says the status. Families keep one colour each so
 * a Workforce agent is recognisable across screens the way a person's
 * avatar is.
 */
const FAMILY: Record<string, { icon: LucideIcon; tone: string }> = {
  workforce: { icon: BriefcaseBusiness, tone: 'bg-accent/15 text-accent' },
  compliance: { icon: ShieldCheck, tone: 'bg-info/15 text-info' },
  'associate-self-service': { icon: MessageSquareText, tone: 'bg-positive/15 text-positive' },
  'decision-intelligence': { icon: Gavel, tone: 'bg-caution/15 text-caution' },
  deployment: { icon: Rocket, tone: 'bg-navy-secondary text-ink-muted' },
};

const STATUS_DOT: Record<string, string> = {
  ACTIVE: 'bg-positive',
  ONBOARDING: 'bg-caution',
  SUSPENDED: 'bg-negative',
  OFFBOARDED: 'bg-ink-subtle',
};

export function AgentGlyph({
  family,
  status,
  size = 'md',
  className,
}: {
  family: string | null | undefined;
  status?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const f = (family && FAMILY[family]) || { icon: Bot, tone: 'bg-navy-secondary text-ink-muted' };
  const Icon = f.icon;
  const box = size === 'lg' ? 'h-14 w-14 rounded-xl' : size === 'sm' ? 'h-7 w-7 rounded-md' : 'h-10 w-10 rounded-lg';
  const icon = size === 'lg' ? 'h-7 w-7' : size === 'sm' ? 'h-3.5 w-3.5' : 'h-5 w-5';
  return (
    <span className={cn('relative inline-grid shrink-0 place-items-center', box, f.tone, className)} aria-hidden="true">
      <Icon className={icon} />
      {status && (
        <span
          className={cn(
            'absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-surface',
            size === 'lg' ? 'h-3.5 w-3.5' : 'h-2.5 w-2.5',
            STATUS_DOT[status] ?? 'bg-ink-subtle',
          )}
        />
      )}
    </span>
  );
}
