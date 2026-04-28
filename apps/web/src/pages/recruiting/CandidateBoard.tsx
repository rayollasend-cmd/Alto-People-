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
}

export function CandidateBoard({
  candidates,
  pendingId,
  onAdvance,
  onRequestReject,
  onRequestWithdraw,
  onRequestHire,
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
      <div className="flex gap-3 overflow-x-auto pb-2 -mx-1 px-1">
        {STAGES_ORDER.map((stage) => (
          <Column
            key={stage}
            stage={stage}
            candidates={grouped[stage]}
            pendingId={pendingId}
          />
        ))}
      </div>
    </DndContext>
  );
}

function Column({
  stage,
  candidates,
  pendingId,
}: {
  stage: CandidateStage;
  candidates: Candidate[];
  pendingId: string | null;
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
        <span className="text-[11px] uppercase tracking-widest text-silver">
          {STAGE_LABEL[stage]}
        </span>
        <Badge variant="outline" className="tabular-nums">
          {candidates.length}
        </Badge>
      </div>
      <div className="p-2 min-h-[120px] max-h-[calc(100vh-22rem)] overflow-y-auto space-y-2">
        {candidates.length === 0 ? (
          <div className="text-[11px] text-silver/50 text-center py-6 select-none">
            Drop here
          </div>
        ) : (
          candidates.map((c) => (
            <CandidateCard
              key={c.id}
              candidate={c}
              pending={pendingId === c.id}
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
}: {
  candidate: Candidate;
  pending: boolean;
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(locked ? {} : attributes)}
      {...(locked ? {} : listeners)}
      className={cn(
        'rounded-md border border-navy-secondary bg-navy p-3 text-sm shadow-sm transition-all',
        !locked && 'cursor-grab active:cursor-grabbing hover:border-silver/40',
        locked && 'opacity-80',
        isDragging && 'opacity-60 ring-1 ring-gold/60',
        pending && 'opacity-60',
      )}
    >
      <div className="flex items-start gap-2">
        <Avatar name={fullName} email={candidate.email} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-white truncate">{fullName}</div>
          {candidate.position && (
            <div className="text-[11px] text-gold/90 truncate">
              {candidate.position}
            </div>
          )}
          <div className="text-[11px] text-silver/70 truncate">
            {candidate.email}
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-silver/60 truncate">
          {candidate.source ?? 'manual'}
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          {candidate.resumeUrl && (
            <a
              href={candidate.resumeUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Resume"
              aria-label="Open resume in a new tab"
              onPointerDown={(e) => e.stopPropagation()}
              className="text-silver/70 hover:text-gold transition-colors"
            >
              <FileText className="h-3.5 w-3.5" />
            </a>
          )}
          {candidate.linkedinUrl && (
            <a
              href={candidate.linkedinUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="LinkedIn"
              aria-label="Open LinkedIn profile in a new tab"
              onPointerDown={(e) => e.stopPropagation()}
              className="text-silver/70 hover:text-gold transition-colors"
            >
              <Link2 className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </div>
      {candidate.rejectedReason && (
        <div className="mt-2 text-[10px] text-alert/90 line-clamp-2">
          {candidate.rejectedReason}
        </div>
      )}
      {candidate.withdrawnReason && (
        <div className="mt-2 text-[10px] text-silver/70 line-clamp-2">
          {candidate.withdrawnReason}
        </div>
      )}
    </div>
  );
}
