import { useMemo } from 'react';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { FileText, Link2 } from 'lucide-react';
import type { Candidate, CandidateStage } from '@alto-people/shared';
import { safeHref } from '@alto-people/shared';
import { cn } from '@/lib/cn';
import { Avatar } from '@/components/ui/Avatar';
import { Badge } from '@/components/ui/Badge';

const STAGES_ORDER: CandidateStage[] = [
  'APPLIED',
  'SCREENING',
  'INTERVIEW',
  'OFFER',
  'HIRED',
  'WITHDRAWN',
  'REJECTED',
];

const STAGE_LABEL: Record<CandidateStage, string> = {
  APPLIED: 'Applied',
  SCREENING: 'Screening',
  INTERVIEW: 'Interview',
  OFFER: 'Offer',
  HIRED: 'Hired',
  WITHDRAWN: 'Withdrawn',
  REJECTED: 'Rejected',
};

/** Human labels for the stored source slugs — mirrors RecruitingHome. */
const SOURCE_LABEL: Record<string, string> = {
  referral: 'Referral',
  'careers-page': 'Careers page',
  indeed: 'Indeed',
  linkedin: 'LinkedIn',
  'walk-in': 'Walk-in',
  agency: 'Agency',
  other: 'Other',
  manual: 'Manual',
};

const STAGE_COL_TONE: Record<CandidateStage, string> = {
  APPLIED: 'border-t-silver/50',
  SCREENING: 'border-t-warning',
  INTERVIEW: 'border-t-accent',
  OFFER: 'border-t-gold',
  HIRED: 'border-t-success',
  WITHDRAWN: 'border-t-silver/30',
  REJECTED: 'border-t-alert',
};

// Terminal stages = no drag out. Cards are visible but locked.
const TERMINAL_STAGES: ReadonlySet<CandidateStage> = new Set([
  'HIRED',
  'WITHDRAWN',
  'REJECTED',
]);

interface CandidateBoardProps {
  candidates: Candidate[];
  pendingId: string | null;
  onAdvance: (c: Candidate, target: CandidateStage) => void;
  onRequestReject: (c: Candidate) => void;
  onRequestWithdraw: (c: Candidate) => void;
  onRequestHire: (c: Candidate) => void;
  /** Open the full detail drawer. Cards were drag-only before this. */
  onOpen: (c: Candidate) => void;
}

export function CandidateBoard({
  candidates,
  pendingId,
  onAdvance,
  onRequestReject,
  onRequestWithdraw,
  onRequestHire,
  onOpen,
}: CandidateBoardProps) {
  const grouped = useMemo(() => {
    const out: Record<CandidateStage, Candidate[]> = {
      APPLIED: [],
      SCREENING: [],
      INTERVIEW: [],
      OFFER: [],
      HIRED: [],
      WITHDRAWN: [],
      REJECTED: [],
    };
    for (const c of candidates) out[c.stage].push(c);
    return out;
  }, [candidates]);

  // 6px activation distance so card clicks don't start a drag accidentally.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  const handleDragEnd = (e: DragEndEvent) => {
    if (!e.over) return;
    const candidateId = String(e.active.id);
    const target = String(e.over.id) as CandidateStage;
    const c = candidates.find((x) => x.id === candidateId);
    if (!c) return;
    if (c.stage === target) return;
    if (TERMINAL_STAGES.has(c.stage)) return;

    if (target === 'REJECTED') onRequestReject(c);
    else if (target === 'WITHDRAWN') onRequestWithdraw(c);
    else if (target === 'HIRED') onRequestHire(c);
    else onAdvance(c, target);
  };

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      {/* Horizontal pipeline: snap-x lets a swipe on mobile lock each
          stage column to the viewport edge instead of stranding two half-
          columns. snap-none on sm so desktop drag-and-drop isn't fighting
          the snap behavior mid-drag. */}
      <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-2 -mx-1 px-1 sm:snap-none">
        {STAGES_ORDER.map((stage) => (
          <div key={stage} className="snap-start">
            <Column
              stage={stage}
              candidates={grouped[stage]}
              pendingId={pendingId}
              onOpen={onOpen}
            />
          </div>
        ))}
      </div>
    </DndContext>
  );
}

function Column({
  stage,
  candidates,
  pendingId,
  onOpen,
}: {
  stage: CandidateStage;
  candidates: Candidate[];
  pendingId: string | null;
  onOpen: (c: Candidate) => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: stage });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'shrink-0 w-72 rounded-md border border-navy-secondary bg-navy/40 border-t-2 transition-colors',
        STAGE_COL_TONE[stage],
        isOver && 'bg-navy-secondary/40 ring-1 ring-gold/50',
      )}
    >
      <div className="px-3 py-2 flex items-center justify-between border-b border-navy-secondary">
        <span className="text-xs2 uppercase tracking-widest text-silver">
          {STAGE_LABEL[stage]}
        </span>
        <Badge variant="outline" className="tabular-nums">
          {candidates.length}
        </Badge>
      </div>
      <div className="p-2 min-h-[120px] max-h-[calc(100vh-22rem)] overflow-y-auto space-y-2">
        {candidates.length === 0 ? (
          <div className="text-xs2 text-silver/70 text-center py-6 select-none">
            Drop here
          </div>
        ) : (
          candidates.map((c) => (
            <CandidateCard
              key={c.id}
              candidate={c}
              pending={pendingId === c.id}
              onOpen={onOpen}
            />
          ))
        )}
      </div>
    </div>
  );
}

function CandidateCard({
  candidate,
  pending,
  onOpen,
}: {
  candidate: Candidate;
  pending: boolean;
  onOpen: (c: Candidate) => void;
}) {
  const locked = TERMINAL_STAGES.has(candidate.stage);
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: candidate.id, disabled: locked });

  const style = transform
    ? {
        transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
        zIndex: 50,
      }
    : undefined;

  const fullName = `${candidate.firstName} ${candidate.lastName}`;

  // Click-to-open layers on top of dragging: the PointerSensor activates only
  // past 6px of travel, so a stationary press stays a click. Terminal cards
  // can't be dragged but must still open — a hired candidate's record is
  // exactly the one you want to read back. Only the PointerSensor is
  // registered, so dnd-kit claims no keyboard handler and Enter/Space are
  // ours to bind.
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(locked ? {} : attributes)}
      {...(locked ? {} : listeners)}
      role="button"
      tabIndex={0}
      aria-label={`Open ${fullName}'s details`}
      onClick={() => onOpen(candidate)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(candidate);
        }
      }}
      className={cn(
        'rounded-md border border-navy-secondary bg-navy p-3 text-sm elev-1 transition-all',
        'text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright',
        !locked && 'cursor-grab active:cursor-grabbing hover:border-silver/40',
        locked && 'opacity-80 cursor-pointer hover:border-silver/40',
        isDragging && 'opacity-60 ring-1 ring-gold/60',
        pending && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-2">
        <Avatar name={fullName} email={candidate.email} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-white truncate">{fullName}</div>
          {candidate.position && (
            <div className="text-xs2 text-gold/90 truncate">
              {candidate.position}
            </div>
          )}
          <div className="text-xs2 text-silver/70 truncate">
            {candidate.email}
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-2xs uppercase tracking-wider text-silver/70 truncate">
          {SOURCE_LABEL[candidate.source ?? 'manual'] ?? candidate.source}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          {candidate.resumeUrl && (
            <a
              href={safeHref(candidate.resumeUrl)}
              target="_blank"
              rel="noopener noreferrer"
              title="Resume"
              aria-label="Open resume in a new tab"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              className="text-silver/70 hover:text-gold transition-colors"
            >
              <FileText className="h-3.5 w-3.5" />
            </a>
          )}
          {candidate.linkedinUrl && (
            <a
              href={safeHref(candidate.linkedinUrl)}
              target="_blank"
              rel="noopener noreferrer"
              title="LinkedIn"
              aria-label="Open LinkedIn profile in a new tab"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              className="text-silver/70 hover:text-gold transition-colors"
            >
              <Link2 className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>
      {candidate.rejectedReason && (
        <div className="mt-2 text-2xs text-alert/90 line-clamp-2">
          {candidate.rejectedReason}
        </div>
      )}
      {candidate.withdrawnReason && (
        <div className="mt-2 text-2xs text-silver/70 line-clamp-2">
          {candidate.withdrawnReason}
        </div>
      )}
    </div>
  );
}
