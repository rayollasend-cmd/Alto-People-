import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { GraduationCap, Plus, Sparkles } from '@/components/ui/icons';
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
import { useAuth, useTerm } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import { StatusBadge, statusLabel } from '@/lib/status';
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
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { Label } from '@/components/ui/Label';
import { fmtDate } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { QueryError } from '@/components/ui/QueryError';
import { useUrlParam } from '@/lib/useUrlState';
import { pickOne } from '@/lib/validationCopy';

const STATUSES: MentorshipStatus[] = [
  'PROPOSED',
  'ACTIVE',
  'COMPLETED',
  'DECLINED',
  'CANCELLED',
];

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
  const [showNew, setShowNew] = useState(false);
  const [showSuggest, setShowSuggest] = useState(false);
  const [prefill, setPrefill] = useState<PairingPrefill | null>(null);
  const [completeTarget, setCompleteTarget] = useState<Mentorship | null>(null);
  const [completing, setCompleting] = useState(false);
  // The status filter lives in the URL (?status=ACTIVE); search is the grid's own.
  const [statusFilter, setStatusFilter] = useUrlParam<MentorshipStatus | ''>('status', '', ['', ...STATUSES]);
  // One in-flight action at a time — a double-click on Activate/Decline
  // used to fire the write twice.
  const [actionKey, setActionKey] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<void>) => {
    if (actionKey) return;
    setActionKey(key);
    try {
      await fn();
    } finally {
      setActionKey(null);
    }
  };

  const refreshQuery = useQuery({
    queryKey: ['mentorships'],
    queryFn: () => listMentorships(),
  });
  const rows = refreshQuery.data?.mentorships ?? null;
  const refresh = () => void refreshQuery.refetch();

  const filtered = useMemo(() => {
    if (!rows) return null;
    return rows.filter((m) => !statusFilter || m.status === statusFilter);
  }, [rows, statusFilter]);

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="Mentorship"
        subtitle="Pair experienced people with newer ones. Status tracks the lifecycle from proposal to completion."
        actions={
          canManage
            ? [
                { label: 'New pairing', icon: Plus, primary: true, onSelect: () => setShowNew(true) },
                { label: 'Suggest mentors', icon: Sparkles, onSelect: () => setShowSuggest(true) },
              ]
            : undefined
        }
    >
      <Card>
        <CardContent className="p-0">
          {refreshQuery.error ? (
            <div className="p-6">
              <QueryError what="mentorships" query={refreshQuery} />
            </div>
          ) : filtered === null || rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            // No search, filter or export over an empty list: the empty state
            // names the two ways to start.
            <EmptyState
              icon={GraduationCap}
              title="No mentorships yet"
              description="Pair an experienced person with a newer one, or get mentor suggestions for a skill."
              action={
                canManage ? (
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button onClick={() => setShowNew(true)}>
                      <Plus className="mr-2 h-4 w-4" /> New pairing
                    </Button>
                    <Button variant="outline" onClick={() => setShowSuggest(true)}>
                      <Sparkles className="mr-2 h-4 w-4" /> Suggest mentors
                    </Button>
                  </div>
                ) : undefined
              }
            />
          ) : (
            <DataGrid<NonNullable<typeof filtered>[number]>
              id="mentorships"
              caption="Mentorship pairings"
              noun={{ one: 'pairing', many: 'pairings' }}
              rows={filtered}
              rowKey={(m) => m.id}
              search={{ placeholder: 'Search mentor or mentee…' }}
              urlKey="pairings"
              exportCsv={{ filename: 'mentorships' }}
              filters={
                <Select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as MentorshipStatus | '')}
                  aria-label="Filter by status"
                  className="w-auto"
                >
                  <option value="">All statuses</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>{statusLabel(s)}</option>
                  ))}
                </Select>
              }
              activeFilters={statusFilter ? 1 : 0}
              onClearFilters={() => setStatusFilter('')}
              columns={[
                { key: 'mentor', header: 'Mentor', accessor: (m) => m.mentorName, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'mentee', header: 'Mentee', accessor: (m) => m.menteeName, sortable: true, cardMeta: true },
                { key: 'focus', header: 'Focus', accessor: (m) => m.focusSkillName, sortable: true, cardMeta: true, className: 'text-silver', cell: (m) => m.focusSkillName ?? '—' },
                { key: 'status', header: 'Status', accessor: (m) => m.status, sortable: true, cell: (m) => <StatusBadge status={m.status} /> },
                { key: 'started', header: 'Started', accessor: (m) => m.startedAt, sortable: true, searchable: false, cardMeta: true, className: 'text-xs', cell: (m) => fmtDate(m.startedAt) },
                {
                  key: 'actions',
                  header: 'Actions',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  className: 'space-x-2',
                  cell: (m) => (
                    <>
                      {canManage && m.status === 'PROPOSED' && (
                        <>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={actionKey === `activate-${m.id}`}
                            disabled={actionKey !== null}
                            onClick={() =>
                              void act(`activate-${m.id}`, async () => {
                                try {
                                  await transitionMentorship(m.id, { status: 'ACTIVE' });
                                  toast.success('Pairing activated.');
                                  refresh();
                                } catch (err) {
                                  toast.error(err instanceof ApiError ? err.message : 'Failed.');
                                }
                              })
                            }
                          >
                            Activate
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            loading={actionKey === `decline-${m.id}`}
                            disabled={actionKey !== null}
                            onClick={() =>
                              void act(`decline-${m.id}`, async () => {
                                try {
                                  await transitionMentorship(m.id, { status: 'DECLINED' });
                                  toast.success('Pairing declined.');
                                  refresh();
                                } catch (err) {
                                  toast.error(err instanceof ApiError ? err.message : 'Failed.');
                                }
                              })
                            }
                          >
                            Decline
                          </Button>
                        </>
                      )}
                      {canManage && m.status === 'ACTIVE' && (
                        <Button size="sm" variant="ghost" onClick={() => setCompleteTarget(m)}>
                          Complete
                        </Button>
                      )}
                    </>
                  ),
                },
              ]}
            />
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
    </ListTemplate>
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
  const term = useTerm();
  const [mentor, setMentor] = useState<PickedAssociate | null>(initialMentor);
  const [mentee, setMentee] = useState<PickedAssociate | null>(initialMentee);
  const [skillId, setSkillId] = useState(initialSkillId);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [goals, setGoals] = useState('');
  const [saving, setSaving] = useState(false);

  const loadSkillsQuery = useQuery({
    queryKey: ['NewPairingDrawer', 'skills'],
    queryFn: () => listSkills(),
  });
  const skills: SkillCatalogEntry[] = loadSkillsQuery.data?.skills ?? [];
  useEffect(() => {
    const r = loadSkillsQuery.data;
    if (r === undefined) return;
    setSkillsError(null);

  }, [loadSkillsQuery.data]);
  useEffect(() => {
    if (!loadSkillsQuery.isError) return;
    setSkillsError('Failed to load the skill catalog.')
  }, [loadSkillsQuery.isError, loadSkillsQuery.error]);
  const loadSkills = () => void loadSkillsQuery.refetch();

  const submit = async () => {
    if (!mentor || !mentee) {
      toast.error(pickOne(term));
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
  const term = useTerm();
  const [mentee, setMentee] = useState<PickedAssociate | null>(null);
  const [skillId, setSkillId] = useState('');
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [results, setResults] = useState<MentorshipCandidate[] | null>(null);
  const [loading, setLoading] = useState(false);

  const loadSkillsQuery = useQuery({
    queryKey: ['SuggestDrawer', 'skills'],
    queryFn: () => listSkills(),
  });
  const skills: SkillCatalogEntry[] = loadSkillsQuery.data?.skills ?? [];
  useEffect(() => {
    const r = loadSkillsQuery.data;
    if (r === undefined) return;
    setSkillsError(null);

  }, [loadSkillsQuery.data]);
  useEffect(() => {
    if (!loadSkillsQuery.isError) return;
    setSkillsError('Failed to load the skill catalog.')
  }, [loadSkillsQuery.isError, loadSkillsQuery.error]);
  const loadSkills = () => void loadSkillsQuery.refetch();

  const submit = async () => {
    if (!mentee) {
      toast.error(pickOne(term));
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
