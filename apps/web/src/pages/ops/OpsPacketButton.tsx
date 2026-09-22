import { Download, FileText } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { opsPacketUrl } from '@/lib/opsApi';
import { opsToday } from './opsTime';

/**
 * The SOP packet, as a download.
 *
 * Three shapes of the same record — one shift, one day, one month — each
 * a report someone can hand to an executive rather than a screen they
 * have to be shown. Whatever the board is currently filtered to goes into
 * the packet, so "Destin, overnight" on screen is "Destin, overnight" on
 * paper.
 *
 * Plain links, not fetches: the server sets the filename and the browser
 * (including iOS Safari, which will not honour a blob download) handles
 * it the way the platform expects.
 */

export type PacketScope = {
  locationId?: string;
  period?: string;
  department?: string;
};

/** A month key (YYYY-MM) for "this month", on the ops clock. */
function thisMonth(): string {
  return opsToday().slice(0, 7);
}

function scopeSentence(scope: PacketScope, storeName: string | null): string {
  const parts = [
    storeName ?? (scope.locationId ? 'the selected store' : 'every store'),
    scope.period ? scope.period.toLowerCase() : null,
    scope.department ?? null,
  ].filter(Boolean);
  return parts.join(' · ');
}

export function OpsPacketButton({
  scope,
  storeName = null,
  dateKey,
  size = 'sm',
}: {
  scope: PacketScope;
  /** The store's name, for the sentence that says what is in the packet. */
  storeName?: string | null;
  /** The day a daily packet should cover. Defaults to today. */
  dateKey?: string;
  size?: 'xs' | 'sm';
}) {
  const day = dateKey ?? opsToday();
  const links: { label: string; hint: string; href: string }[] = [
    {
      label: 'Today',
      hint: 'every shift on this day, with its exceptions',
      href: opsPacketUrl('day', { ...scope, dateKey: day }),
    },
    {
      label: 'This month',
      hint: 'the day-by-day trend and the accounts behind it',
      href: opsPacketUrl('month', { ...scope, month: thisMonth() }),
    },
  ];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size={size}>
          <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          SOP packet
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel className="text-2xs font-normal normal-case text-silver/70">
          {/* What the reader is about to get, in their own filter's words. */}
          {scopeSentence(scope, storeName)}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {links.map((l) => (
          <DropdownMenuItem key={l.label} asChild>
            <a href={l.href} target="_blank" rel="noreferrer" download>
              <FileText className="h-3.5 w-3.5 shrink-0 text-gold" aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-sm">{l.label}</span>
                <span className="block text-2xs text-silver/60">{l.hint}</span>
              </span>
            </a>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The single-shift packet — one button, no menu, on a shift record. */
export function OpsShiftPacketLink({
  shiftId,
  size = 'sm',
  className,
}: {
  shiftId: string;
  size?: 'xs' | 'sm';
  className?: string;
}) {
  return (
    <Button variant="outline" size={size} asChild className={className}>
      <a
        href={opsPacketUrl('shift', { shiftId })}
        target="_blank"
        rel="noreferrer"
        download
        aria-label="Download this shift's SOP packet as a PDF"
      >
        <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Shift packet
      </a>
    </Button>
  );
}
