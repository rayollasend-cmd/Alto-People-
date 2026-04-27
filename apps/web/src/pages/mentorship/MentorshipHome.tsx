import { useEffect, useState } from 'react';
import { GraduationCap, Plus, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  listMentorships,
  proposeMentorship,
  suggestMentors,
  transitionMentorship,
  type Mentorship,
  type MentorshipCandidate,
} from '@/lib/mentorship112Api';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  Input,
  PageHeader,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

export function MentorshipHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:org') : false;
  const [rows, setRows] = useState<Mentorship[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showSuggest, setShowSuggest] = useState(false);

  const refresh = () => {
    setRows(null);
    listMentorships()
      .then((r) => setRows(r.mentorships))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Mentorship"
        subtitle="Pair experienced associates with juniors. Status tracks the lifecycle from proposal to completion."
        breadcrumbs={[{ label: 'Mentorship' }]}
      />
      {canManage && (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setShowSuggest(true)}>
            <Sparkles className="mr-2 h-4 w-4" /> Suggest mentors
          </Button>
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New pairing
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={GraduationCap}
              title="No mentorships yet"
              description="Pair an experienced associate with a junior to start one."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Mentor</TableHead>
                  <TableHead>Mentee</TableHead>
                  <TableHead>Focus</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((m) => (
                  <TableRow key={m.id} className="group">
                    <TableCell className="font-medium text-white">{m.mentorName}</TableCell>
                    <TableCell>{m.menteeName}</TableCell>
                    <TableCell className="text-silver">{m.focusSkillName ?? '—'}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          m.status === 'ACTIVE'
                            ? 'success'
                            : m.status === 'PROPOSED'
                              ? 'pending'
                              : m.status === 'COMPLETED'
                                ? 'accent'
                                : 'destructive'
                        }
                      >
                        {m.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {m.startedAt ? new Date(m.startedAt).toLocaleDateString() : '—'}
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
                          onClick={async () => {
                            const reason = window.prompt('Outcome notes (optional):', '');
                            if (reason === null) return;
                            try {
                              await transitionMentorship(m.id, {
                                status: 'COMPLETED',
                                endedReason: reason || undefined,
                              });
                              refresh();
                            } catch (err) {
                              toast.error(err instanceof ApiError ? err.message : 'Failed.');
                            }
                          }}
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
      {showNew && (
        <NewPairingDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {showSuggest && (
        <SuggestDrawer onClose={() => setShowSuggest(false)} />
      )}
    </div>
  );
}

function NewPairingDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [mentor, setMentor] = useState('');
  const [mentee, setMentee] = useState('');
  const [skillId, setSkillId] = useState('');
  const [goals, setGoals] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!mentor.trim() || !mentee.trim()) {
      toast.error('Mentor and mentee IDs required.');
      return;
    }
    setSaving(true);
    try {
      await proposeMentorship({
        mentorAssociateId: mentor.trim(),
        menteeAssociateId: mentee.trim(),
        focusSkillId: skillId.trim() || null,
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
          <Label>Mentor associate ID</Label>
          <Input className="mt-1 font-mono text-xs" value={mentor} onChange={(e) => setMentor(e.target.value)} />
        </div>
        <div>
          <Label>Mentee associate ID</Label>
          <Input className="mt-1 font-mono text-xs" value={mentee} onChange={(e) => setMentee(e.target.value)} />
        </div>
        <div>
          <Label>Focus skill ID (optional)</Label>
          <Input className="mt-1 font-mono text-xs" value={skillId} onChange={(e) => setSkillId(e.target.value)} />
        </div>
        <div>
          <Label>Goals (optional)</Label>
          <textarea
            className="mt-1 w-full h-24 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
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

function SuggestDrawer({ onClose }: { onClose: () => void }) {
  const [menteeId, setMenteeId] = useState('');
  const [skillId, setSkillId] = useState('');
  const [results, setResults] = useState<MentorshipCandidate[] | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!menteeId.trim() || !skillId.trim()) {
      toast.error('Mentee and skill IDs required.');
      return;
    }
    setLoading(true);
    try {
      const r = await suggestMentors({
        menteeAssociateId: menteeId.trim(),
        skillId: skillId.trim(),
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
          <Label>Mentee associate ID</Label>
          <Input className="mt-1 font-mono text-xs" value={menteeId} onChange={(e) => setMenteeId(e.target.value)} />
        </div>
        <div>
          <Label>Skill ID</Label>
          <Input className="mt-1 font-mono text-xs" value={skillId} onChange={(e) => setSkillId(e.target.value)} />
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
                  className="flex items-center justify-between p-2 rounded border border-navy-secondary"
                >
                  <div>
                    <div className="text-white text-sm">{c.name}</div>
                    <div className="text-xs text-silver">
                      {c.email} • {c.yearsExperience ? `${c.yearsExperience}y exp` : 'exp unknown'}
                    </div>
                  </div>
                  <Badge variant={c.level === 'EXPERT' ? 'success' : 'accent'}>
                    {c.level}
                  </Badge>
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
