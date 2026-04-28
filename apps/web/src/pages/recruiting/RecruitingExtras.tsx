import { useEffect, useState } from 'react';
import { Briefcase, ClipboardList, Gift, Plus, Send } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  closeJobPosting,
  createInterviewKit,
  createJobPosting,
  createOffer,
  createReferral,
  decideOffer,
  deleteInterviewKit,
  deleteJobPosting,
  listInterviewKits,
  listJobPostings,
  listOffers,
  listReferrals,
  markReferralBonusPaid,
  openJobPosting,
  sendOffer,
  setReferralStatus,
  type InterviewKit,
  type JobPostingRecord,
  type OfferRecord,
  type ReferralRecord,
  type ReferralStatus,
} from '@/lib/recruiting90Api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { toast } from 'sonner';

type Tab = 'kits' | 'offers' | 'referrals' | 'postings';

export function RecruitingExtras() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:recruiting') : false;
  const [tab, setTab] = useState<Tab>('kits');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Interviewing & offers"
        subtitle="Interview kits, offer letters, employee referrals, and the public careers page."
        breadcrumbs={[{ label: 'Recruiting' }, { label: 'Hiring tools' }]}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="kits">
            <ClipboardList className="mr-2 h-4 w-4" /> Interview kits
          </TabsTrigger>
          <TabsTrigger value="offers">
            <Send className="mr-2 h-4 w-4" /> Offers
          </TabsTrigger>
          <TabsTrigger value="referrals">
            <Gift className="mr-2 h-4 w-4" /> Referrals
          </TabsTrigger>
          <TabsTrigger value="postings">
            <Briefcase className="mr-2 h-4 w-4" /> Job postings
          </TabsTrigger>
        </TabsList>
        <TabsContent value="kits"><KitsTab canManage={canManage} /></TabsContent>
        <TabsContent value="offers"><OffersTab canManage={canManage} /></TabsContent>
        <TabsContent value="referrals"><ReferralsTab canManage={canManage} /></TabsContent>
        <TabsContent value="postings"><PostingsTab canManage={canManage} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ----- Kits -------------------------------------------------------------

function KitsTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [kits, setKits] = useState<InterviewKit[] | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setKits(null);
    listInterviewKits()
      .then((r) => setKits(r.kits))
      .catch(() => setKits([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Delete this kit?', destructive: true }))) return;
    try {
      await deleteInterviewKit(id);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New kit
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {kits === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : kits.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No kits"
              description="Build interview kits with structured questions to keep panels consistent."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Questions</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-32 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {kits.map((k) => (
                  <TableRow key={k.id} className="group">
                    <TableCell className="font-medium text-white">{k.name}</TableCell>
                    <TableCell>{k.questions.length}</TableCell>
                    <TableCell>{new Date(k.updatedAt).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right">
                      {canManage && (
                        <button
                          onClick={() => onDelete(k.id)}
                          className="opacity-0 group-hover:opacity-100 text-silver hover:text-destructive transition text-xs"
                        >
                          Delete
                        </button>
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
        <NewKitDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewKitDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [questionsText, setQuestionsText] = useState('');
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!name.trim()) {
      toast.error('Name required.');
      return;
    }
    const questions = questionsText
      .split('\n')
      .map((q) => q.trim())
      .filter(Boolean)
      .map((prompt) => ({ prompt, kind: 'GENERAL' as const }));
    setSaving(true);
    try {
      await createInterviewKit({
        name: name.trim(),
        description: description.trim() || null,
        questions,
      });
      toast.success('Kit created.');
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
        <DrawerTitle>New interview kit</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <Label>Description (optional)</Label>
          <Textarea
            className="mt-1"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div>
          <Label>Questions (one per line)</Label>
          <Textarea
            className="mt-1 min-h-32 font-mono text-xs"
            value={questionsText}
            onChange={(e) => setQuestionsText(e.target.value)}
            placeholder="Tell me about a time you led under pressure..."
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Create'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

// ----- Offers -----------------------------------------------------------

const OFFER_BADGE: Record<OfferRecord['status'], 'default' | 'success' | 'pending' | 'destructive' | 'accent'> = {
  DRAFT: 'pending',
  SENT: 'accent',
  ACCEPTED: 'success',
  DECLINED: 'destructive',
  EXPIRED: 'default',
  WITHDRAWN: 'default',
};

function OffersTab({ canManage }: { canManage: boolean }) {
  const [offers, setOffers] = useState<OfferRecord[] | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setOffers(null);
    listOffers()
      .then((r) => setOffers(r.offers))
      .catch(() => setOffers([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const onSend = async (id: string) => {
    try {
      await sendOffer(id);
      toast.success('Offer sent.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onDecide = async (id: string, decision: 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN') => {
    try {
      await decideOffer(id, decision);
      toast.success(`Offer ${decision.toLowerCase()}.`);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New offer
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {offers === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : offers.length === 0 ? (
            <EmptyState
              icon={Send}
              title="No offers"
              description="Create offer letters once a candidate has been interviewed and approved."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Candidate</TableHead>
                  <TableHead>Job title</TableHead>
                  <TableHead>Start</TableHead>
                  <TableHead>Pay</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {offers.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="font-medium text-white">{o.candidateName}</TableCell>
                    <TableCell>{o.jobTitle}</TableCell>
                    <TableCell>{o.startDate}</TableCell>
                    <TableCell>
                      {o.salary
                        ? `${o.currency} ${Number(o.salary).toLocaleString()}/yr`
                        : o.hourlyRate
                          ? `${o.currency} ${o.hourlyRate}/hr`
                          : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={OFFER_BADGE[o.status]}>{o.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManage && o.status === 'DRAFT' && (
                        <Button size="sm" onClick={() => onSend(o.id)}>
                          Send
                        </Button>
                      )}
                      {canManage && o.status === 'SENT' && (
                        <>
                          <Button size="sm" onClick={() => onDecide(o.id, 'ACCEPTED')}>
                            Accept
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onDecide(o.id, 'DECLINED')}
                          >
                            Decline
                          </Button>
                        </>
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
        <NewOfferDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewOfferDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [candidateId, setCandidateId] = useState('');
  const [clientId, setClientId] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [startDate, setStartDate] = useState('');
  const [salary, setSalary] = useState('');
  const [hourlyRate, setHourlyRate] = useState('');
  const [letterBody, setLetterBody] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!candidateId || !clientId || !jobTitle || !startDate) {
      toast.error('Candidate, client, title, and start date are required.');
      return;
    }
    if (!salary && !hourlyRate) {
      toast.error('Either salary or hourly rate required.');
      return;
    }
    setSaving(true);
    try {
      await createOffer({
        candidateId: candidateId.trim(),
        clientId: clientId.trim(),
        jobTitle: jobTitle.trim(),
        startDate,
        salary: salary ? Number(salary) : null,
        hourlyRate: hourlyRate ? Number(hourlyRate) : null,
        letterBody: letterBody.trim() || null,
      });
      toast.success('Offer drafted.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-2xl">
      <DrawerHeader>
        <DrawerTitle>New offer</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Candidate ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={candidateId}
            onChange={(e) => setCandidateId(e.target.value)}
            placeholder="UUID"
          />
        </div>
        <div>
          <Label>Client ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="UUID"
          />
        </div>
        <div>
          <Label>Job title</Label>
          <Input
            className="mt-1"
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
          />
        </div>
        <div>
          <Label>Start date</Label>
          <Input
            type="date"
            className="mt-1"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Annual salary (USD)</Label>
            <Input
              type="number"
              className="mt-1"
              value={salary}
              onChange={(e) => setSalary(e.target.value)}
            />
          </div>
          <div>
            <Label>Hourly rate (USD)</Label>
            <Input
              type="number"
              step="0.01"
              className="mt-1"
              value={hourlyRate}
              onChange={(e) => setHourlyRate(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label>Offer letter body (optional)</Label>
          <Textarea
            className="mt-1 min-h-32 font-mono text-xs"
            value={letterBody}
            onChange={(e) => setLetterBody(e.target.value)}
            placeholder="Render a template first or paste the letter body here."
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Create draft'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

// ----- Referrals --------------------------------------------------------

const REF_BADGE: Record<ReferralStatus, 'default' | 'success' | 'pending' | 'destructive' | 'accent'> = {
  OPEN: 'pending',
  INTERVIEWING: 'accent',
  HIRED: 'success',
  REJECTED: 'destructive',
};

function ReferralsTab({ canManage }: { canManage: boolean }) {
  const [referrals, setReferrals] = useState<ReferralRecord[] | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setReferrals(null);
    listReferrals()
      .then((r) => setReferrals(r.referrals))
      .catch(() => setReferrals([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const onStatus = async (id: string, status: ReferralStatus) => {
    try {
      await setReferralStatus(id, status);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onMarkPaid = async (id: string) => {
    try {
      await markReferralBonusPaid(id);
      toast.success('Bonus marked paid.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setShowNew(true)}>
          <Plus className="mr-2 h-4 w-4" /> Refer someone
        </Button>
      </div>
      <Card>
        <CardContent className="p-0">
          {referrals === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : referrals.length === 0 ? (
            <EmptyState
              icon={Gift}
              title="No referrals yet"
              description="Refer a friend or colleague to earn the program bonus on hire."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Candidate</TableHead>
                  <TableHead>Position</TableHead>
                  <TableHead>Referrer</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Bonus</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {referrals.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium text-white">
                      <div>{r.candidateName}</div>
                      <div className="text-xs text-silver">{r.candidateEmail}</div>
                    </TableCell>
                    <TableCell>{r.position ?? '—'}</TableCell>
                    <TableCell className="text-xs">{r.referrerEmail}</TableCell>
                    <TableCell>
                      <Badge variant={REF_BADGE[r.status]}>{r.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {r.bonusAmount
                        ? `${r.bonusCurrency} ${r.bonusAmount}${r.bonusPaidAt ? ' (paid)' : ''}`
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManage && r.status !== 'HIRED' && r.status !== 'REJECTED' && (
                        <select
                          className="bg-navy-secondary/40 border border-navy-secondary text-xs rounded px-2 py-1 text-white"
                          value={r.status}
                          onChange={(e) => onStatus(r.id, e.target.value as ReferralStatus)}
                        >
                          <option value="OPEN">OPEN</option>
                          <option value="INTERVIEWING">INTERVIEWING</option>
                          <option value="HIRED">HIRED</option>
                          <option value="REJECTED">REJECTED</option>
                        </select>
                      )}
                      {canManage &&
                        r.status === 'HIRED' &&
                        r.bonusAmount &&
                        !r.bonusPaidAt && (
                          <Button size="sm" onClick={() => onMarkPaid(r.id)}>
                            Mark bonus paid
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
        <NewReferralDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewReferralDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [candidateName, setCandidateName] = useState('');
  const [candidateEmail, setCandidateEmail] = useState('');
  const [candidatePhone, setCandidatePhone] = useState('');
  const [position, setPosition] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!candidateName.trim() || !candidateEmail.trim()) {
      toast.error('Name and email required.');
      return;
    }
    setSaving(true);
    try {
      await createReferral({
        candidateName: candidateName.trim(),
        candidateEmail: candidateEmail.trim(),
        candidatePhone: candidatePhone.trim() || null,
        position: position.trim() || null,
        notes: notes.trim() || null,
      });
      toast.success('Referral submitted.');
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
        <DrawerTitle>Refer someone</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Candidate name</Label>
          <Input
            className="mt-1"
            value={candidateName}
            onChange={(e) => setCandidateName(e.target.value)}
          />
        </div>
        <div>
          <Label>Email</Label>
          <Input
            type="email"
            className="mt-1"
            value={candidateEmail}
            onChange={(e) => setCandidateEmail(e.target.value)}
          />
        </div>
        <div>
          <Label>Phone (optional)</Label>
          <Input
            className="mt-1"
            value={candidatePhone}
            onChange={(e) => setCandidatePhone(e.target.value)}
          />
        </div>
        <div>
          <Label>Position</Label>
          <Input
            className="mt-1"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
          />
        </div>
        <div>
          <Label>Notes (why they'd be a good fit)</Label>
          <Textarea
            className="mt-1 min-h-24"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Submit referral'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

// ----- Postings ---------------------------------------------------------

const POSTING_BADGE: Record<JobPostingRecord['status'], 'default' | 'success' | 'pending'> = {
  DRAFT: 'pending',
  OPEN: 'success',
  CLOSED: 'default',
};

function PostingsTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [postings, setPostings] = useState<JobPostingRecord[] | null>(null);
  const [showNew, setShowNew] = useState(false);

  const refresh = () => {
    setPostings(null);
    listJobPostings()
      .then((r) => setPostings(r.postings))
      .catch(() => setPostings([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const onOpen = async (id: string) => {
    try {
      await openJobPosting(id);
      toast.success('Posting opened.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onClose = async (id: string) => {
    try {
      await closeJobPosting(id);
      toast.success('Posting closed.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Delete this posting?', destructive: true }))) return;
    try {
      await deleteJobPosting(id);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New posting
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {postings === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : postings.length === 0 ? (
            <EmptyState
              icon={Briefcase}
              title="No postings"
              description="Create a job posting to surface it on the public careers page."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Title</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Location</TableHead>
                  <TableHead>Pay range</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {postings.map((p) => (
                  <TableRow key={p.id} className="group">
                    <TableCell className="font-medium text-white">{p.title}</TableCell>
                    <TableCell className="font-mono text-xs">/careers/{p.slug}</TableCell>
                    <TableCell>{p.location ?? '—'}</TableCell>
                    <TableCell>
                      {p.minSalary && p.maxSalary
                        ? `${p.currency} ${p.minSalary}–${p.maxSalary}`
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={POSTING_BADGE[p.status]}>{p.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManage && p.status === 'DRAFT' && (
                        <Button size="sm" onClick={() => onOpen(p.id)}>
                          Open
                        </Button>
                      )}
                      {canManage && p.status === 'OPEN' && (
                        <Button size="sm" variant="ghost" onClick={() => onClose(p.id)}>
                          Close
                        </Button>
                      )}
                      {canManage && (
                        <button
                          onClick={() => onDelete(p.id)}
                          className="opacity-0 group-hover:opacity-100 text-silver hover:text-destructive transition text-xs"
                        >
                          Delete
                        </button>
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
        <NewPostingDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewPostingDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [minSalary, setMinSalary] = useState('');
  const [maxSalary, setMaxSalary] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!title.trim() || !slug.trim() || !description.trim()) {
      toast.error('Title, slug, and description required.');
      return;
    }
    if (!/^[a-z0-9-]+$/.test(slug)) {
      toast.error('Slug must be lowercase letters, digits, and hyphens.');
      return;
    }
    setSaving(true);
    try {
      await createJobPosting({
        title: title.trim(),
        slug: slug.trim(),
        description: description.trim(),
        location: location.trim() || null,
        minSalary: minSalary ? Number(minSalary) : null,
        maxSalary: maxSalary ? Number(maxSalary) : null,
      });
      toast.success('Posting drafted.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-2xl">
      <DrawerHeader>
        <DrawerTitle>New job posting</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Title</Label>
          <Input
            className="mt-1"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div>
          <Label>Slug (URL path)</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="senior-caregiver-nyc"
          />
        </div>
        <div>
          <Label>Description (markdown OK)</Label>
          <Textarea
            className="mt-1 min-h-40"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div>
          <Label>Location</Label>
          <Input
            className="mt-1"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Min salary</Label>
            <Input
              type="number"
              className="mt-1"
              value={minSalary}
              onChange={(e) => setMinSalary(e.target.value)}
            />
          </div>
          <div>
            <Label>Max salary</Label>
            <Input
              type="number"
              className="mt-1"
              value={maxSalary}
              onChange={(e) => setMaxSalary(e.target.value)}
            />
          </div>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Save draft'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

