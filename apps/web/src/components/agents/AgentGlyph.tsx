import {
  Activity,
  Bot,
  BrainCircuit,
  BriefcaseBusiness,
  ClipboardCheck,
  Code,
  Cpu,
  FileCheck,
  GraduationCap,
  Handshake,
  HardHat,
  MessageSquareText,
  Receipt,
  Rocket,
  ScrollText,
  ShieldCheck,
  UserCog,
  UserSearch,
  Wallet,
  type LucideIcon,
} from '@/components/ui/icons';
import type { AgentFamily } from '@alto-people/shared';
import { cn } from '@/lib/cn';

/**
 * One mark for an agent everywhere it appears (the Agents page, its
 * record, the roster, the Control Room, Hugo's seat): a rounded tile whose
 * icon says the family and whose dot says the status. Every family in the
 * taxonomy (packages/shared AGENT_FAMILIES) has its own glyph, and a family
 * keeps one tone per group so a Workforce agent is recognisable across
 * screens the way a person's avatar is. An agent with no family yet is a
 * plain bot — the same glyph the Agents module uses in the sidebar.
 */
const GROUP_TONE = {
  workforce: 'bg-accent/15 text-accent',
  operations: 'bg-caution/15 text-caution',
  compliance: 'bg-info/15 text-info',
  finance: 'bg-positive/15 text-positive',
  it: 'bg-navy-secondary text-ink-muted',
  everyone: 'bg-positive/15 text-positive',
} as const;

export const AGENT_FAMILY_GLYPHS: Record<AgentFamily, { icon: LucideIcon; tone: string }> = {
  // Agents for the Workforce
  talent: { icon: UserSearch, tone: GROUP_TONE.workforce },
  workforce: { icon: BriefcaseBusiness, tone: GROUP_TONE.workforce },
  programs: { icon: GraduationCap, tone: GROUP_TONE.workforce },
  payroll: { icon: Wallet, tone: GROUP_TONE.workforce },
  'decision-intelligence': { icon: BrainCircuit, tone: GROUP_TONE.workforce },
  // Agents for Operations
  operations: { icon: ClipboardCheck, tone: GROUP_TONE.operations },
  robotics: { icon: Cpu, tone: GROUP_TONE.operations },
  safety: { icon: HardHat, tone: GROUP_TONE.operations },
  // Agents for Compliance
  compliance: { icon: ShieldCheck, tone: GROUP_TONE.compliance },
  audit: { icon: ScrollText, tone: GROUP_TONE.compliance },
  contracts: { icon: FileCheck, tone: GROUP_TONE.compliance },
  // Agents for Finance and Clients
  billing: { icon: Receipt, tone: GROUP_TONE.finance },
  client: { icon: Handshake, tone: GROUP_TONE.finance },
  // Agents for IT and Developers
  deployment: { icon: Rocket, tone: GROUP_TONE.it },
  reliability: { icon: Activity, tone: GROUP_TONE.it },
  developer: { icon: Code, tone: GROUP_TONE.it },
  // Agents for Everyone
  'associate-self-service': { icon: MessageSquareText, tone: GROUP_TONE.everyone },
  'manager-self-service': { icon: UserCog, tone: GROUP_TONE.everyone },
};

const UNPLACED = { icon: Bot, tone: 'bg-navy-secondary text-ink-muted' };

/** The family's icon alone, for rows and empty states that draw their own tile. */
export function agentFamilyIcon(family: string | null | undefined): LucideIcon {
  return (family && AGENT_FAMILY_GLYPHS[family as AgentFamily]?.icon) || Bot;
}

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
  const f = (family && AGENT_FAMILY_GLYPHS[family as AgentFamily]) || UNPLACED;
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
