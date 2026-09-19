import { useState } from 'react';
import { toast } from 'sonner';
import { Check, ChevronDown, Hand, UserPlus, X } from 'lucide-react';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Avatar } from '@/components/ui/Avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import {
  DESK_CHIP,
  DESK_LABELS,
  DESKS,
  relayApi,
  type Claim,
  type ClaimSubject,
  type Desk,
  type DeskPerson,
} from './relayTypes';

/** A desk's name in its color. */
export function DeskChip({ desk, className }: { desk: Desk; className?: string }) {
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-2xs font-semibold uppercase tracking-wider', DESK_CHIP[desk], className)}>
      {DESK_LABELS[desk]}
    </span>
  );
}

/** Faces, overlapping — who's on it at a glance, names on hover. */
export function FacePile({
  people,
  max = 4,
  size = 'xs',
  label,
}: {
  people: Array<{ key: string; name: string; photoUrl?: string | null }>;
  max?: number;
  size?: 'xs' | 'sm';
  label?: string;
}) {
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  const more = people.length - shown.length;
  return (
    <span className="flex items-center" aria-label={label ?? people.map((p) => p.name).join(', ')} role="img">
      {shown.map((p, i) => (
        <span key={p.key} title={p.name} className={cn('rounded-full ring-2 ring-navy', i > 0 && '-ml-1.5')}>
          <Avatar src={p.photoUrl ?? null} name={p.name} size={size} />
        </span>
      ))}
      {more > 0 && (
        <span className={cn('-ml-1.5 grid place-items-center rounded-full bg-navy-secondary text-2xs font-semibold text-silver ring-2 ring-navy', size === 'xs' ? 'h-6 w-6' : 'h-8 w-8')}>
          +{more}
        </span>
      )}
    </span>
  );
}

/**
 * Who holds it — the names on the relay. Unclaimed: "Claim" (it's mine)
 * or hand it to someone on any desk. Claimed: their face and name, with
 * release and hand-off one click away. Handing it to someone else rings
 * their bell.
 */
export function OwnerControl({
  subjectType,
  subjectKey,
  what,
  claim,
  desks,
  meId,
  onChanged,
  compact,
}: {
  subjectType: ClaimSubject;
  subjectKey: string;
  /** What's being claimed, in words ("Rosa Vega's lane"). */
  what: string;
  claim: Claim | undefined;
  desks: Record<Desk, DeskPerson[]> | undefined;
  meId: string | undefined;
  onChanged: () => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
      toast.success(ok);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not update who holds it.');
    } finally {
      setBusy(false);
    }
  };
  const mine = !!claim && claim.userId === meId;
  const handOff = (
    <>
      {DESKS.map((d) =>
        (desks?.[d] ?? []).length > 0 ? (
          <div key={d}>
            <DropdownMenuLabel className="text-2xs uppercase tracking-wider text-silver/60">{DESK_LABELS[d]}</DropdownMenuLabel>
            {(desks?.[d] ?? []).map((p) => (
              <DropdownMenuItem
                key={p.userId}
                disabled={claim?.userId === p.userId}
                onSelect={() =>
                  void run(
                    () => relayApi.claim(subjectType, subjectKey, p.userId === meId ? undefined : p.userId),
                    p.userId === meId ? `${what} is yours.` : `Handed to ${p.name} — they’ve been told.`,
                  )
                }
              >
                <Avatar src={p.photoUrl} name={p.name} size="xs" />
                <span className="ml-2 truncate">{p.userId === meId ? `${p.name} (you)` : p.name}</span>
                {claim?.userId === p.userId && <Check className="ml-auto h-3.5 w-3.5 text-success" aria-hidden="true" />}
              </DropdownMenuItem>
            ))}
          </div>
        ) : null,
      )}
    </>
  );

  if (!claim) {
    return (
      <span className="inline-flex shrink-0 items-center">
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => relayApi.claim(subjectType, subjectKey), `${what} is yours.`)}
          className="inline-flex items-center gap-1 rounded-l-md border border-navy-secondary px-2 py-1 text-xs text-silver hover:border-gold/50 hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright disabled:opacity-50"
          aria-label={`Claim ${what}`}
        >
          <Hand className="h-3.5 w-3.5" aria-hidden="true" />
          {!compact && 'Claim'}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy}
            className="rounded-r-md border border-l-0 border-navy-secondary px-1.5 py-1 text-silver hover:border-gold/50 hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
            aria-label={`Hand ${what} to someone`}
          >
            <UserPlus className="h-3.5 w-3.5" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 w-60 overflow-y-auto">
            <DropdownMenuLabel>Hand {what} to…</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {handOff}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={busy}
        className={cn(
          'inline-flex max-w-[11rem] shrink-0 items-center gap-1.5 rounded-full border px-1 py-0.5 pr-2 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
          mine ? 'border-gold/50 bg-gold/10 text-gold' : 'border-navy-secondary text-white hover:border-gold/40',
        )}
        aria-label={`${what}: held by ${mine ? 'you' : claim.name}. Change`}
        title={claim.claimedByName && claim.claimedByName !== claim.name ? `Handed over by ${claim.claimedByName}` : undefined}
      >
        <Avatar src={claim.photoUrl} name={claim.name} size="xs" />
        {!compact && <span className="truncate">{mine ? 'You' : claim.name.split(' ')[0]}</span>}
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-60 overflow-y-auto">
        <DropdownMenuLabel>
          {mine ? 'You hold' : `${claim.name} holds`} {what}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void run(() => relayApi.release(subjectType, subjectKey), 'Released — it’s back on the desk.')}>
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="ml-2">Release</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-silver/70">Hand to…</DropdownMenuLabel>
        {handOff}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A small section header in the relay's voice. */
export function SectionHead({ icon: Icon, title, meta, children, id }: { icon: React.ComponentType<{ className?: string }>; title: string; meta?: React.ReactNode; children?: React.ReactNode; id?: string }) {
  return (
    <div id={id} className="mb-2 flex scroll-mt-20 flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-1.5 text-sm font-semibold text-white">
        <Icon className="h-4 w-4 text-gold" aria-hidden="true" />
        {title}
        {meta && <span className="ml-1 text-xs font-normal text-silver/70">{meta}</span>}
      </h2>
      {children}
    </div>
  );
}
