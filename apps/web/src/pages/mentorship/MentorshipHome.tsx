import { useEffect, useMemo, useState } from 'react';
import { Download, GraduationCap, Plus, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  listMentorships,
  proposeMentorship,
  suggestMentors,
  transitionMentorship,
  type Mentorship,
  type MentorshipCandidate,
  type MentorshipStatus,
} from '@/lib/mentorship112Api';
import { listSkills, type SkillCatalogEntry } from '@/lib/skills111Api';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import {
  Badge,
  Button,
  Card,
  CardContent,
  ConfirmDialog,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  FilterBar,
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@/components/ui';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Label } from '@/components/ui/Label';
import { fmtDate, ymdLocal } from '@/lib/format';
import { downloadCsv } from '@/lib/csv';

const STATUSES: MentorshipStatus[] = [
  'PROPOSED',
  'ACTIVE',
  'COMPLETED',
  'DECLINED',
  'CANCELLED',
];

const STATUS_LABELS: Record<MentorshipStatus, string> = {
  PROPOSED: 'Proposed',
  ACTIVE: 'Active',
  COMPLETED: 'Completed',
  DECLINED: 'Declined',
  CANCELLED: 'Cancelled',
};

// Status contract: success = active/completed, pending = awaiting a
// decision, destructive = declined/cancelled.
const STATUS_VARIANT: Record<MentorshipStatus, 'success' | 'pending' | 'destructive'> = {
  PROPOSED: 'pending',
  ACTIVE: 'success',
  COMPLETED: 'success',
  DECLINED: 'destructive',
  CANCELLED: 'destructive',
};

const LEVEL_LABELS: Record<MentorshipCandidate['level'], string> = {
  BEGINNER: 'Beginner',
  INTERMEDIATE: 'Intermediate',
  ADVANCED: 'Advanced',
  EXPERT: 'Expert',
};

interface PairingPrefill {
  mentor: PickedAssociate;
  mentee: PickedAssociate;
  skillId: string;
}

export function MentorshipHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:org') : false;
  const [rows, setRows] = useState<Mentorship[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showSuggest, setShowSuggest] = useState(false);
  const [prefill, setPrefill] = useState<PairingPrefill | null>(null);
  const [completeTarget, setCompleteTarget] = useState<Mentorship | null>(null);
  const [completing, setCompleting] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<MentorshipStatus | ''>('');

  const refresh = () => {
    setRows(null);
    setLoadError(null);
    listMentorships()
      .then((r) => setRows(r.mentorships))
      .catch((err) =>
        setLoadError(
          err instanceof ApiError ? err.message : 'Failed to load mentorships.',
        ),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = search.trim().toLowerCase();
    return rows.filter(
      (m) =>
        (!q ||
          m.mentorName.toLowerCase().includes(q) ||
          m.menteeName.toLowerCase().includes(q)) &&
        (!statusFilter || m.status === statusFilter),
    );
  }, [rows, search, statusFilter]);

  const onExportCsv = () => {
    if (!filtered) return;
    downloadCsv(`mentorships-${ymdLocal()}.csv`, [
      ['Mentor', 'Mentee', 'Focus skill', 'Status', 'Started', 'Ended', 'Created'],
      ...filtered.map((m) => [
        m.mentorName,
        m.menteeName,
        m.focusSkillName ?? '',
        STATUS_LABELS[m.status],
        m.startedAt ? fmtDate(m.startedAt) : '',
        m.endedAt ? fmtDate(m.endedAt) : '',
        fmtDate(m.createdAt),
      ]),
    ]);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Mentorship"
        subtitle="Pair experienced associates with juniors. Status tracks the lifecycle from proposal to completion."
        breadcrumbs={[{ label: 'Mentorship' }]}
        primaryAction={
          canManage ? (
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> New pairing
            </Button>
          ) : undefined
        }
        secondaryActions={
          <>
            {canManage && (
              <Button variant="outline" onClick={() => setShowSuggest(true)}>
                <Sparkles className="mr-2 h-4 w-4" /> Suggest mentors
              </Button>
            )}
            <Button
              variant="outline"
              onClick={onExportCsv}
              disabled={!filtered || filtered.length === 0}
            >
              <Download className="mr-2 h-4 w-4" /> Export CSV
            </Button>
          </>
        }
      />
      <FilterBar>
        <Input
          placeholder="Search mentor or mentee…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
          aria-label="Search mentor or mentee"
        />
        <Select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as MentorshipStatus | '')}
          aria-label="Filter by status"
          className="w-auto"
        >
          <option value="">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{STATUS_LABELS[s]}</option>
          ))}
        </Select>
      </FilterBar>
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6">
              <ErrorBanner>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{loadError}</span>
                  <Button size="sm" variant="outline" onClick={refresh}>
                    Retry
                  </Button>
                </div>
              </ErrorBanner>
            </div>
          ) : filtered === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={GraduationCap}
              title={rows && rows.length > 0 ? 'No matches' : 'No mentorships yet'}
              description={
                rows && rows.length > 0
                  ? 'No pairing matches the current search or status filter.'
                  : 'Pair an experienced associate with a junior to start one.'
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mentor</TableHead>
                  <TableHead>Mentee</TableHead>
                  <TableHead className="hidden md:table-cell">Focus</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Started</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((m) => (
                  <TableRow key={m.id} className="group">
                    <TableCell className="font-medium text-white">
                      <div className="truncate">{m.mentorName}</div>
                      <div className="md:hidden text-xs2 text-silver/70 truncate">
                        {m.focusSkillName ?? '—'} · {fmtDate(m.startedAt)}
                      </div>
                    </TableCell>
                    <TableCell>{m.menteeName}</TableCell>
                    <TableCell className="text-silver hidden md:table-cell">{m.focusSkillName ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[m.status]}>
                        {STATUS_LABELS[m.status]}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs hidden md:table-cell">
                      {fmtDate(m.startedAt)}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManage && m.status === 'PROPOSED' && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              try {
                                await transitionMentorship(m.id, { status: 'ACTIVE' });
                                toast.success('Pairing activated.');
                                refresh();
                              } catch (err) {
                                toast.error(err instanceof ApiError ? err.message : 'Failed.');
                              }
                            }}
                          >
                            Activate
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              try {
                                await transitionMentorship(m.id, { status: 'DECLINED' });
                                toast.success('Pairing declined.');
                                refresh();
                              } catch (err) {
                                toast.error(err instanceof ApiError ? err.message : 'Failed.');
                              }
                            }}
                          >
                            Decline
                          </Button>
                        </>
                      )}
                      {canManage && m.status === 'ACTIVE' && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setCompleteTarget(m)}
                        >
                          Complete
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {(showNew || prefill !== null) && (
        <NewPairingDrawer
          initialMentor={prefill?.mentor ?? null}
          initialMentee={prefill?.mentee ?? null}
          initialSkillId={prefill?.skillId ?? ''}
          onClose={() => {
            setShowNew(false);
            setPrefill(null);
          }}
          onSaved={() => {
            setShowNew(false);
            setPrefill(null);
            refresh();
          }}
        />
      )}
      {showSuggest && (
        <SuggestDrawer
          onClose={() => setShowSuggest(false)}
          onPropose={(p) => {
            setShowSuggest(false);
            setPrefill(p);
          }}
        />
      )}
      <ConfirmDialog
        open={completeTarget !== null}
        onOpenChange={(o) => !o && setCompleteTarget(null)}
        title="Complete mentorship"
        description="Mark this pairing as completed. Outcome notes are optional but help future matching."
        confirmLabel="Mark complete"
        requireReason="optional"
        reasonLabel="Outcome notes (what went well, what to apply next time)"
        reasonPlaceholder="Optional"
        busy={completing}
        onConfirm={async (reason) => {
          if (!completeTarget) return;
          setCompleting(true);
          try {
            await transitionMentorship(completeTarget.id, {
              status: 'COMPLETED',
              endedReason: reason || undefined,
            });
            toast.success('Mentorship completed.');
            setCompleteTarget(null);
            refresh();
          } catch (err) {
            toast.error(err instanceof ApiError ? err.message : 'Failed.');
          } finally {
            setCompleting(false);
          }
        }}
      />
    </div>
  );
}

function NewPairingDrawer({
  initialMentor = null,
  initialMentee = null,
  initialSkillId = '',
  onClose,
  onSaved,
}: {
  initialMentor?: PickedAssociate | null;
  initialMentee?: PickedAssociate | null;
  initialSkillId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [mentor, setMentor] = useState<PickedAssociate | null>(initialMentor);
  const [mentee, setMentee] = useState<PickedAssociate | null>(initialMentee);
  const [skillId, setSkillId] = useState(initialSkillId);
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([]);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [goals, setGoals] = useState('');
  const [saving, setSaving] = useState(false);

  const loadSkills = () => {
    setSkillsError(null);
    listSkills()
      .then((r) => setSkills(r.skills))
      .catch(() => setSkillsError('Failed to load the skill catalog.'));
  };
  useEffect(() => {
    loadSkills();
  }, []);

  const submit = async () => {
    if (!mentor || !mentee) {
      toast.error('Pick an associate.');
      return;
    }
    setSaving(true);
    try {
      await proposeMentorship({
        mentorAssociateId: mentor.id,
        menteeAssociateId: mentee.id,
        focusSkillId: skillId || null,
        goals: goals.trim() || null,
      });
      toast.success('Pairing proposed.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Propose mentorship</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Mentor</Label>
          <div className="mt-1">
            <AssociatePicker value={mentor} onChange={setMentor} />
          </div>
        </div>
        <div>
          <Label>Mentee</Label>
          <div className="mt-1">
            <AssociatePicker value={mentee} onChange={setMentee} />
          </div>
        </div>
        <div>
          <Label>Focus skill (optional)</Label>
          {skillsError ? (
            <ErrorBanner className="mt-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{skillsError}</span>
                <Button size="sm" variant="outline" onClick={loadSkills}>
                  Retry
                </Button>
              </div>
            </ErrorBanner>
          ) : (
            <Select className="mt-1" value={skillId} onChange={(e) => setSkillId(e.target.value)}>
              <option value="">None</option>
              {skills.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          )}
        </div>
        <div>
          <Label>Goals (optional)</Label>
          <Textarea
            className="mt-1 h-24"
            value={goals}
            onChange={(e) => setGoals(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Proposing…' : 'Propose'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function SuggestDrawer({
  onClose,
  onPropose,
}: {
  onClose: () => void;
  onPropose: (prefill: PairingPrefill) => void;
}) {
  const [mentee, setMentee] = useState<PickedAssociate | null>(null);
  const [skillId, setSkillId] = useState('');
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([]);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [results, setResults] = useState<MentorshipCandidate[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadSkills = () => {
    setSkillsError(null);
    listSkills()
      .then((r) => setSkills(r.skills))
      .catch(() => setSkillsError('Failed to load the skill catalog.'));
  };
  useEffect(() => {
    loadSkills();
  }, []);

  const submit = async () => {
    if (!mentee) {
      toast.error('Pick an associate.');
      return;
    }
    if (!skillId) {
      toast.error('Pick a skill.');
      return;
    }
    setLoading(true);
    try {
      const r = await suggestMentors({
        menteeAssociateId: mentee.id,
        skillId,
      });
      setResults(r.candidates);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Suggest mentors</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Mentee</Label>
          <div className="mt-1">
            <AssociatePicker value={mentee} onChange={setMentee} />
          </div>
        </div>
        <div>
          <Label>Skill</Label>
          {skillsError ? (
            <ErrorBanner className="mt-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>{skillsError}</span>
                <Button size="sm" variant="outline" onClick={loadSkills}>
                  Retry
                </Button>
              </div>
            </ErrorBanner>
          ) : (
            <Select className="mt-1" value={skillId} onChange={(e) => setSkillId(e.target.value)}>
              <option value="">Select a skill…</option>
              {skills.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          )}
        </div>
        <Button onClick={submit} disabled={loading}>
          {loading ? 'Searching…' : 'Find candidates'}
        </Button>
        {results && (
          <div className="space-y-2 pt-3 border-t border-navy-secondary">
            {results.length === 0 ? (
              <div className="text-sm text-silver">
                No advanced/expert mentors available for this skill.
              </div>
            ) : (
              results.map((c) => (
                <div
                  key={c.associateId}
                  className="flex items-center justify-between gap-2 p-2 rounded border border-navy-secondary"
                >
                  <div className="min-w-0">
                    <div className="text-white text-sm truncate">{c.name}</div>
                    <div className="text-xs text-silver truncate">
                      {c.email} • {c.yearsExperience ? `${c.yearsExperience}y exp` : 'exp unknown'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={c.level === 'EXPERT' ? 'success' : 'accent'}>
                      {LEVEL_LABELS[c.level]}
                    </Badge>
                    <Button
                      size="sm"
                      onClick={() => {
                        if (!mentee) return;
                        onPropose({
                          mentor: { id: c.associateId, name: c.name },
                          mentee,
                          skillId,
                        });
                      }}
                    >
                      Propose
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}
