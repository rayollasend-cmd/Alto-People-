import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
  FilterBar,
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
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
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<MentorshipStatus | ''>('');
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
  const loadError = refreshQuery.error ? (refreshQuery.error instanceof ApiError ? refreshQuery.error.message : 'Failed to load mentorships.') : null;
  const refresh = () => void refreshQuery.refetch();

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
        statusLabel(m.status),
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
            <option key={s} value={s}>{statusLabel(s)}</option>
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
            <DataGrid<NonNullable<typeof filtered>[number]>
              id="mentorships"
              caption="Mentorship pairings"
              rows={filtered}
              rowKey={(m) => m.id}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'mentorships' }}
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
