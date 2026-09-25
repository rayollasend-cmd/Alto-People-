import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Briefcase, ClipboardList, Copy, Download, Gift, Plus, Rss, Send, UserPlus, X } from 'lucide-react';
import type { Candidate } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import {
  approveOffer,
  closeJobPosting,
  convertReferral,
  createInterviewKit,
  createJobPosting,
  createOffer,
  createReferral,
  decideOffer,
  declineOfferApproval,
  deleteInterviewKit,
  deleteJobPosting,
  listInterviewKits,
  listJobPostings,
  listOfferLetterTemplates,
  listOffers,
  listReferrals,
  markReferralBonusPaid,
  openJobPosting,
  setJobPostingOpenings,
  updateJobPosting,
  jobFeedUrl,
  SCHEDULE_LABEL,
  type JobPostingSchedule,
  previewOfferLetter,
  sendOffer,
  signedOfferUrl,
  setReferralStatus,
  updateInterviewKit,
  type InterviewKit,
  type InterviewQuestion,
  type JobPostingRecord,
  type OfferRecord,
  type ReferralRecord,
  type ReferralStatus,
} from '@/lib/recruiting90Api';
import { getCandidate, listCandidates } from '@/lib/recruitingApi';
import { listClients } from '@/lib/clientsApi';
import { downloadCsv } from '@/lib/csv';
import { usePersistentState } from '@/lib/usePersistentState';
import { useAuth } from '@/lib/auth';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
import { StatusBadge, statusLabel } from '@/lib/status';
import {
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';
import { SearchInput } from '@/components/ui/FilterBar';
import { Label } from '@/components/ui/Label';
import { fmtDate, fmtDateTime, fmtMoney, parseYmd, ymdLocal } from '@/lib/format';
import { toast } from 'sonner';

type Tab = 'kits' | 'offers' | 'referrals' | 'postings';

const TABS: readonly Tab[] = ['kits', 'offers', 'referrals', 'postings'];

function isTab(v: string | null): v is Tab {
  return v !== null && (TABS as readonly string[]).includes(v);
}

// ----- Shared bits -------------------------------------------------------

/** Inline load-failure affordance: real error + Retry, never a fake empty. */
function LoadErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="p-6">
      <ErrorBanner
        action={
          <Button size="sm" variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        }
      >
        {message}
      </ErrorBanner>
    </div>
  );
}

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** Client list for the offer/posting drawers' <Select>. */
function useClients() {
  const query = useQuery({ queryKey: ['clients', 'names'], queryFn: () => listClients() });
  const clients = useMemo(
    () => (query.data ? query.data.clients.map((c) => ({ id: c.id, name: c.name })) : null),
    [query.data],
  );
  const error = query.error ? errMessage(query.error, 'Failed to load clients.') : null;
  const { refetch } = query;
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);
  return { clients, error, reload };
}

interface PickedCandidate {
  id: string;
  name: string;
}

/**
 * Candidate typeahead that resolves to {id, name} — same UX as
 * AssociatePicker, searched on the server as you type (it used to load
 * the newest 200 candidates and filter those, so anyone older couldn't be
 * found). Replaces the raw-UUID input on the offer drawer.
 */
function CandidatePicker({
  value,
  onChange,
  placeholder = 'Search candidate by name or email…',
}: {
  value: PickedCandidate | null;
  onChange: (v: PickedCandidate | null) => void;
  placeholder?: string;
}) {
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 250);
    return () => clearTimeout(t);
  }, [term]);

  const searching = !value && debounced.length >= 2;
  const candidatesQuery = useQuery({
    queryKey: ['recruiting', 'candidate-search', debounced],
    queryFn: () => listCandidates({ q: debounced, sort: 'name' }, { limit: 8 }),
    enabled: searching,
    staleTime: 30_000,
  });
  const results: Array<PickedCandidate & { email: string }> = searching
    ? (candidatesQuery.data?.candidates ?? []).map((c: Candidate) => ({
        id: c.id,
        name: `${c.firstName} ${c.lastName}`.trim(),
        email: c.email,
      }))
    : [];
  const loadError = candidatesQuery.error
    ? errMessage(candidatesQuery.error, 'Failed to search candidates.')
    : null;
  const { refetch: refetchCandidates } = candidatesQuery;
  const load = useCallback(() => {
    void refetchCandidates();
  }, [refetchCandidates]);
  useEffect(() => {
    if (searching && candidatesQuery.data) setOpen(true);
  }, [searching, candidatesQuery.data]);

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-navy-secondary bg-navy px-3 py-2 text-sm">
        <span className="text-white">{value.name}</span>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            setTerm('');
          }}
          className="text-silver/60 hover:text-white"
          aria-label="Clear candidate"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  if (loadError) {
    return (
      <ErrorBanner
        action={
          <Button size="sm" variant="secondary" onClick={load}>
            Retry
          </Button>
        }
      >
        {loadError}
      </ErrorBanner>
    );
  }

  return (
    <div className="relative">
      <Input
        placeholder={placeholder}
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        onFocus={() => results.length > 0 && setOpen(true)}
      />
      {open && results.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-md border border-navy-secondary bg-navy elev-2">
          {results.map((r) => (
            <button
              key={r.id}
              type="button"
              className="block w-full px-3 py-2 text-left text-sm text-silver hover:bg-navy-secondary hover:text-white"
              onClick={() => {
                onChange({ id: r.id, name: r.name });
                setOpen(false);
              }}
            >
              <span className="block text-white">{r.name}</span>
              <span className="block text-xs text-silver/70">{r.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function RecruitingExtras() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:recruiting') : false;

  // ?tab= lives in the URL (same pattern as RecruitingHome's ?stage=) so the
  // candidate drawer's "Extend offer" handoff can land on the right tab.
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: Tab = isTab(tabParam) ? tabParam : 'kits';
  const setTab = useCallback(
    (v: Tab) =>
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (v === 'kits') next.delete('tab'); // default tab keeps the URL clean
        else next.set('tab', v);
        return next;
      }),
    [setSearchParams],
  );

  // ?new=1[&candidate=<id>] — pre-open the offer drawer, optionally seeded
  // with a candidate (from the drawer's "No offers extended." dead end).
  // Captured once, then the params are consumed so refresh/Back don't
  // re-open the drawer.
  const [offerSeed, setOfferSeed] = useState<{ candidateId: string | null } | null>(
    () => {
      const sp = new URLSearchParams(window.location.search);
      return sp.get('new') === '1' ? { candidateId: sp.get('candidate') } : null;
    },
  );
  useEffect(() => {
    if (!offerSeed) return;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('new');
        next.delete('candidate');
        return next;
      },
      { replace: true },
    );
    // Consume exactly once, on mount — offerSeed is captured before render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        <TabsContent value="offers">
          <OffersTab
            canManage={canManage}
            seed={canManage ? offerSeed : null}
            onSeedConsumed={() => setOfferSeed(null)}
          />
        </TabsContent>
        <TabsContent value="referrals"><ReferralsTab canManage={canManage} /></TabsContent>
        <TabsContent value="postings"><PostingsTab canManage={canManage} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ----- Kits -------------------------------------------------------------

function KitsTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [showNew, setShowNew] = useState(false);
  const [editTarget, setEditTarget] = useState<InterviewKit | null>(null);

  const kitsQuery = useQuery({ queryKey: ['recruiting', 'kits'], queryFn: () => listInterviewKits() });
  const kits: InterviewKit[] | null = kitsQuery.data?.kits ?? null;
  const error = kitsQuery.error ? errMessage(kitsQuery.error, 'Failed to load interview kits.') : null;
  const refresh = () => void kitsQuery.refetch();

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Delete this kit?', destructive: true }))) return;
    try {
      await deleteInterviewKit(id);
      refresh();
    } catch (err) {
      toast.error(errMessage(err, 'Could not delete the kit.'));
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
          {error ? (
            <LoadErrorState message={error} onRetry={refresh} />
          ) : kits === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : kits.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No kits"
              description="Build interview kits with structured questions to keep panels consistent."
              action={
                canManage ? (
                  <Button onClick={() => setShowNew(true)}>
                    <Plus className="mr-2 h-4 w-4" /> New kit
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <DataGrid<NonNullable<typeof kits>[number]>
              id="interview-kits"
              caption="Interview kits"
              rows={kits}
              rowKey={(k) => k.id}
              search={{ placeholder: 'Kit name…' }}
              urlState={false}
              exportCsv={{ filename: 'interview-kits' }}
              onRowClick={canManage ? (k) => setEditTarget(k) : undefined}
              rowActionLabel={(k) => `Edit ${k.name}`}
              columns={[
                { key: 'name', header: 'Name', accessor: (k) => k.name, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'questions', header: 'Questions', accessor: (k) => k.questions.length, sortable: true, searchable: false, cardMeta: true, className: 'tabular-nums' },
                { key: 'updated', header: 'Updated', accessor: (k) => k.updatedAt, sortable: true, searchable: false, cardMeta: true, cell: (k) => fmtDate(k.updatedAt) },
                ...(canManage
                  ? [
                      {
                        key: 'actions',
                        header: 'Actions',
                        accessor: () => null,
                        searchable: false,
                        csv: () => '',
                        align: 'right' as const,
                        stopRowClick: true,
                        className: 'space-x-2',
                        cell: (k: NonNullable<typeof kits>[number]) => (
                          <>
                            <Button size="sm" variant="ghost" onClick={() => setEditTarget(k)}>
                              Edit
                            </Button>
                            <Button size="sm" variant="ghost" className="text-silver hover:text-alert" onClick={() => onDelete(k.id)}>
                              Delete
                            </Button>
                          </>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
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
      {editTarget && (
        <EditKitDrawer
          kit={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function EditKitDrawer({
  kit,
  onClose,
  onSaved,
}: {
  kit: InterviewKit;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(kit.name);
  const [description, setDescription] = useState(kit.description ?? '');
  const [questionsText, setQuestionsText] = useState(
    kit.questions.map((q) => q.prompt).join('\n'),
  );
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!name.trim()) {
      toast.error('Name is required.');
      return;
    }
    // Preserve `kind` and `hint` for prompts that already exist; default to
    // GENERAL for newly typed lines so we never blank out structure HR set
    // up via a future advanced editor.
    const existingByPrompt = new Map<string, InterviewQuestion>();
    for (const q of kit.questions) existingByPrompt.set(q.prompt.trim(), q);
    const questions: InterviewQuestion[] = questionsText
      .split('\n')
      .map((q) => q.trim())
      .filter(Boolean)
      .map((prompt) => existingByPrompt.get(prompt) ?? { prompt, kind: 'GENERAL' });
    setSaving(true);
    try {
      await updateInterviewKit(kit.id, {
        name: name.trim(),
        description: description.trim() || null,
        questions,
      });
      toast.success('Kit updated.');
      onSaved();
    } catch (err) {
      toast.error(errMessage(err, 'Could not update the kit.'));
    } finally {
      setSaving(false);
    }
  };

  // Long interview-question textareas are painful to retype — guard user
  // dismissals (Esc/overlay/X/swipe) behind a confirm while edited.
  const dirty =
    name !== kit.name ||
    description !== (kit.description ?? '') ||
    questionsText !== kit.questions.map((q) => q.prompt).join('\n');

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} confirmDiscard={() => dirty}>
      <DrawerHeader>
        <DrawerTitle>Edit kit</DrawerTitle>
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
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function NewKitDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [questionsText, setQuestionsText] = useState('');
  const [saving, setSaving] = useState(false);
  const onSubmit = async () => {
    if (!name.trim()) {
      toast.error('Name is required.');
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
      toast.error(errMessage(err, 'Could not create the kit.'));
    } finally {
      setSaving(false);
    }
  };
  const dirty =
    name.trim() !== '' || description.trim() !== '' || questionsText.trim() !== '';
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} confirmDiscard={() => dirty}>
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

// Deliberate departures from the shared vocabulary: a SENT offer is awaiting
// the candidate's decision — an in-flight spotlight state (gold), not the
// vocabulary's dispatched-successfully green. ACCEPTED is domain-only
// terminal-good.
const OFFER_STATUS_TONES = { SENT: 'accent', ACCEPTED: 'success', PENDING_APPROVAL: 'pending' } as const;

function OffersTab({
  canManage,
  seed,
  onSeedConsumed,
}: {
  canManage: boolean;
  /** Open the new-offer drawer on mount, pre-seeded with this candidate. */
  seed?: { candidateId: string | null } | null;
  onSeedConsumed?: () => void;
}) {
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [seedCandidateId, setSeedCandidateId] = useState<string | null>(null);
  const { user, can } = useAuth();
  const prompt = usePrompt();
  // Maker-checker: approving takes the right to set pay, and it can't be
  // your own offer — the server says the same.
  const canApprove = (o: OfferRecord) => can('manage:comp') && o.createdById !== user?.id;

  useEffect(() => {
    if (!seed) return;
    setSeedCandidateId(seed.candidateId);
    setShowNew(true);
    onSeedConsumed?.();
  }, [seed, onSeedConsumed]);

  const offersQuery = useQuery({ queryKey: ['recruiting', 'offers'], queryFn: () => listOffers() });
  const offers: OfferRecord[] | null = offersQuery.data?.offers ?? null;
  const error = offersQuery.error ? errMessage(offersQuery.error, 'Failed to load offers.') : null;
  const refresh = () => void offersQuery.refetch();

  const filtered = useMemo(() => {
    if (!offers) return null;
    const q = search.trim().toLowerCase();
    if (!q) return offers;
    return offers.filter((o) => o.candidateName.toLowerCase().includes(q));
  }, [offers, search]);

  const onExport = () => {
    if (!filtered || filtered.length === 0) return;
    downloadCsv(`offers-${ymdLocal()}.csv`, [
      ['Candidate', 'Client', 'Job title', 'Start date', 'Salary', 'Hourly rate', 'Currency', 'Status', 'Sent at', 'Decided at'],
      ...filtered.map((o) => [
        o.candidateName,
        o.clientName,
        o.jobTitle,
        fmtDate(parseYmd(o.startDate)),
        o.salary ?? '',
        o.hourlyRate ?? '',
        o.currency,
        statusLabel(o.status),
        o.sentAt ? fmtDateTime(o.sentAt) : '',
        o.decidedAt ? fmtDateTime(o.decidedAt) : '',
      ]),
    ]);
  };

  const onSend = async (id: string) => {
    try {
      const r = await sendOffer(id);
      if (r.emailed === false) {
        toast.warning('Marked sent — no candidate email on file.');
      } else if (r.link) {
        // No email configured (dev): hand over the signing link to pass on.
        const link = r.link;
        toast.success('Offer sent — email is off here, so copy the signing link.', {
          action: { label: 'Copy link', onClick: () => void navigator.clipboard.writeText(link) },
        });
      } else {
        toast.success('Offer sent — they can read and sign it from the email.');
      }
      refresh();
    } catch (err) {
      toast.error(errMessage(err, 'Could not send the offer.'));
    }
  };

  const onApprove = async (id: string) => {
    try {
      await approveOffer(id);
      toast.success('Approved — it can be sent.');
      refresh();
    } catch (err) {
      toast.error(errMessage(err, 'Could not approve the offer.'));
    }
  };

  const onDeclineApproval = async (o: OfferRecord) => {
    const reason = await prompt({
      title: `Decline ${o.candidateName}'s offer?`,
      description: o.approvalNote ?? undefined,
      reasonLabel: 'Why',
      reasonPlaceholder: 'e.g. Keep it inside the band — offer $17.00.',
      confirmLabel: 'Decline',
      destructive: true,
    });
    if (!reason) return;
    try {
      await declineOfferApproval(o.id, reason);
      toast.success('Declined — whoever drafted it has been told why.');
      refresh();
    } catch (err) {
      toast.error(errMessage(err, 'Could not decline the offer.'));
    }
  };

  const onDecide = async (id: string, decision: 'ACCEPTED' | 'DECLINED' | 'WITHDRAWN') => {
    try {
      await decideOffer(id, decision);
      toast.success(`Offer ${statusLabel(decision).toLowerCase()}.`);
      refresh();
    } catch (err) {
      toast.error(errMessage(err, 'Could not record the decision.'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <SearchInput
          wrapperClassName="w-full sm:w-64"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by candidate name…"
          aria-label="Search offers by candidate name"
        />
        <Button
          variant="secondary"
          onClick={onExport}
          disabled={!filtered || filtered.length === 0}
        >
          <Download className="mr-2 h-4 w-4" /> Export CSV
        </Button>
        {canManage && (
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New offer
          </Button>
        )}
      </div>
      <Card>
        <CardContent className="p-0">
          {error ? (
            <LoadErrorState message={error} onRetry={refresh} />
          ) : filtered === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Send}
              title={search.trim() ? 'No offers match your search' : 'No offers'}
              description={
                search.trim()
                  ? 'Try a different candidate name.'
                  : 'Create offer letters once a candidate has been interviewed and approved.'
              }
              action={
                search.trim() ? (
                  <Button variant="secondary" onClick={() => setSearch('')}>
                    Clear search
                  </Button>
                ) : canManage ? (
                  <Button onClick={() => setShowNew(true)}>
                    <Plus className="mr-2 h-4 w-4" /> New offer
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <DataGrid<NonNullable<typeof filtered>[number]>
              id="offers"
              caption="Offers"
              rows={filtered}
              rowKey={(o) => o.id}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'offers' }}
              columns={[
                { key: 'candidate', header: 'Candidate', accessor: (o) => o.candidateName, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'job', header: 'Job title', accessor: (o) => o.jobTitle, sortable: true, cardMeta: true },
                { key: 'start', header: 'Start', accessor: (o) => o.startDate, sortable: true, searchable: false, cardMeta: true, cell: (o) => fmtDate(parseYmd(o.startDate)) },
                {
                  key: 'pay',
                  header: 'Pay',
                  accessor: (o) => (o.salary ? `${fmtMoney(o.salary, { currency: o.currency })}/yr` : o.hourlyRate ? `${fmtMoney(o.hourlyRate, { currency: o.currency })}/hr` : null),
                  searchable: false,
                  align: 'right',
                  className: 'tabular-nums whitespace-nowrap',
                  cell: (o) => (o.salary ? `${fmtMoney(o.salary, { currency: o.currency })}/yr` : o.hourlyRate ? `${fmtMoney(o.hourlyRate, { currency: o.currency })}/hr` : '—'),
                },
                {
                  key: 'status',
                  header: 'Status',
                  accessor: (o) => o.status,
                  sortable: true,
                  cell: (o) => (
                    <div className="space-y-0.5">
                      <StatusBadge status={o.status} overrides={OFFER_STATUS_TONES} />
                      {o.status === 'PENDING_APPROVAL' && o.approvalNote && (
                        <div className="max-w-[16rem] text-2xs text-warning">{o.approvalNote}</div>
                      )}
                      {o.status === 'SENT' && <div className="text-2xs text-silver">Awaiting their signature</div>}
                      {o.signedName && o.signedAt && (
                        <div className="text-2xs text-silver">
                          Signed by {o.signedName}, {fmtDate(o.signedAt)}
                        </div>
                      )}
                      {o.approvalDeclinedReason && (
                        <div className="max-w-[16rem] text-2xs text-alert">Not approved: {o.approvalDeclinedReason}</div>
                      )}
                      {o.declineReason && (
                        <div className="max-w-[16rem] text-2xs text-silver">"{o.declineReason}"</div>
                      )}
                    </div>
                  ),
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  className: 'space-x-2',
                  cell: (o) => (
                    <>
                      {o.status === 'PENDING_APPROVAL' &&
                        (canApprove(o) ? (
                          <>
                            <Button size="sm" onClick={() => onApprove(o.id)}>
                              Approve
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => onDeclineApproval(o)}>
                              Decline
                            </Button>
                          </>
                        ) : (
                          <span className="text-xs text-silver">Waiting on approval</span>
                        ))}
                      {o.hasSignedPdf && (
                        <Button asChild size="sm" variant="outline">
                          <a href={signedOfferUrl(o.id)} target="_blank" rel="noopener noreferrer">
                            Signed letter
                          </a>
                        </Button>
                      )}
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
                          <Button size="sm" variant="ghost" onClick={() => onDecide(o.id, 'DECLINED')}>
                            Decline
                          </Button>
                        </>
                      )}
                    </>
                  ),
                },
              ]}
            />
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewOfferDrawer
          seedCandidateId={seedCandidateId}
          onClose={() => {
            setShowNew(false);
            setSeedCandidateId(null);
          }}
          onSaved={() => {
            setShowNew(false);
            setSeedCandidateId(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewOfferDrawer({
  seedCandidateId,
  onClose,
  onSaved,
}: {
  /** Pre-fill this candidate (and their position) instead of the picker. */
  seedCandidateId?: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [candidate, setCandidate] = useState<PickedCandidate | null>(null);
  // Offers cluster on the same client week after week — remember the last
  // pick so most drafts start with the client already right.
  const [lastClientId, setLastClientId] = usePersistentState<string>(
    'alto:recruiting.offers.lastClientId.v1',
    '',
  );
  const [clientId, setClientId] = useState(lastClientId);
  const [jobTitle, setJobTitle] = useState('');
  const [startDate, setStartDate] = useState('');
  const [salary, setSalary] = useState('');
  const [hourlyRate, setHourlyRate] = useState('');
  const [letterBody, setLetterBody] = useState('');
  const [saving, setSaving] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [writing, setWriting] = useState(false);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const { clients, error: clientsError, reload: reloadClients } = useClients();
  // The client's published offer-letter templates, its own first.
  const templatesQuery = useQuery({
    queryKey: ['recruiting', 'offer-letter-templates', clientId],
    queryFn: () => listOfferLetterTemplates(clientId || undefined),
  });
  const templates = templatesQuery.data?.templates ?? [];

  const writeFromTemplate = async () => {
    if (!candidate || !clientId || !jobTitle.trim() || !startDate || (!salary && !hourlyRate)) {
      toast.error('Fill in the candidate, client, title, start date and pay first — the letter uses them.');
      return;
    }
    setWriting(true);
    try {
      const r = await previewOfferLetter({
        candidateId: candidate.id,
        clientId,
        jobTitle: jobTitle.trim(),
        startDate,
        salary: salary ? Number(salary) : null,
        hourlyRate: hourlyRate ? Number(hourlyRate) : null,
        ...(templateId ? { templateId } : {}),
      });
      setLetterBody(r.body);
      setUnresolved(r.unresolvedTokens);
      toast.success(`Letter written from “${r.templateName}” — edit it as you need.`);
    } catch (err) {
      toast.error(errMessage(err, 'Could not write the letter.'));
    } finally {
      setWriting(false);
    }
  };

  // A remembered client that has since been archived would sit invisibly
  // selected (no matching <option>) — drop it once the list is in hand.
  useEffect(() => {
    if (clients && clientId && !clients.some((c) => c.id === clientId)) {
      setClientId('');
    }
  }, [clients, clientId]);

  // Resolve the seeded candidate to {id, name} + default the job title to
  // their applied-for position. Failure just leaves the picker for manual
  // selection — the drawer must not block on it.
  const seededQuery = useQuery({
    queryKey: ['recruiting', 'candidate', seedCandidateId],
    queryFn: () => getCandidate(seedCandidateId!),
    enabled: Boolean(seedCandidateId),
  });
  useEffect(() => {
    const c = seededQuery.data;
    if (!seedCandidateId || !c) return;
    setCandidate({ id: c.id, name: `${c.firstName} ${c.lastName}`.trim() });
    if (c.position) setJobTitle((prev) => prev || c.position!);
  }, [seedCandidateId, seededQuery.data]);
  useEffect(() => {
    if (seedCandidateId && seededQuery.isError) {
      toast.error('Could not load the candidate — pick them manually.');
    }
  }, [seedCandidateId, seededQuery.isError]);

  const onSubmit = async () => {
    if (!candidate || !clientId || !jobTitle || !startDate) {
      toast.error('Candidate, client, title, and start date are required.');
      return;
    }
    if (!salary && !hourlyRate) {
      toast.error('Either a salary or an hourly rate is required.');
      return;
    }
    setSaving(true);
    try {
      const created = await createOffer({
        candidateId: candidate.id,
        clientId,
        jobTitle: jobTitle.trim(),
        startDate,
        salary: salary ? Number(salary) : null,
        hourlyRate: hourlyRate ? Number(hourlyRate) : null,
        letterBody: letterBody.trim() || null,
      });
      setLastClientId(clientId);
      if (created.status === 'PENDING_APPROVAL') {
        toast.warning('Drafted — and held for approval before it can be sent.', {
          description: created.approvalNote ?? undefined,
        });
      } else {
        toast.success('Offer drafted.');
      }
      onSaved();
    } catch (err) {
      toast.error(errMessage(err, 'Could not create the offer.'));
    } finally {
      setSaving(false);
    }
  };
  // clientId is deliberately excluded — it's remembered from the last
  // offer, not typed for this one.
  const dirty =
    candidate !== null ||
    jobTitle.trim() !== '' ||
    startDate !== '' ||
    salary !== '' ||
    hourlyRate !== '' ||
    letterBody.trim() !== '';

  return (
    <Drawer
      open={true}
      onOpenChange={(o) => !o && onClose()}
      width="max-w-2xl"
      confirmDiscard={() => dirty}
    >
      <DrawerHeader>
        <DrawerTitle>New offer</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Candidate</Label>
          <div className="mt-1">
            <CandidatePicker value={candidate} onChange={setCandidate} />
          </div>
        </div>
        <div>
          <Label>Client</Label>
          {clientsError ? (
            <ErrorBanner
              className="mt-1"
              action={
                <Button size="sm" variant="secondary" onClick={reloadClients}>
                  Retry
                </Button>
              }
            >
              {clientsError}
            </ErrorBanner>
          ) : (
            <Select
              className="mt-1"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              disabled={clients === null}
            >
              <option value="">
                {clients === null ? 'Loading clients…' : 'Select a client…'}
              </option>
              {clients?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
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
          <Label>Offer letter</Label>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Select
              aria-label="Letter template"
              className="min-w-0 flex-1"
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              disabled={templates.length === 0}
            >
              <option value="">
                {templates.length === 0 ? 'No offer-letter templates published yet' : "The client's template"}
              </option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.clientName ? ` · ${t.clientName}` : ' · all clients'}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void writeFromTemplate()}
              loading={writing}
              disabled={writing || templates.length === 0}
            >
              Write from template
            </Button>
          </div>
          {unresolved.length > 0 && (
            <p className="mt-1 text-xs text-warning">
              The template asks for {unresolved.map((t) => `{{${t}}}`).join(', ')}, which the offer doesn't have — those
              spots are blank. Fill them in below.
            </p>
          )}
          <Textarea
            aria-label="Offer letter body"
            className="mt-2 min-h-32 font-mono text-xs"
            value={letterBody}
            onChange={(e) => setLetterBody(e.target.value)}
            placeholder="Write it from a template above, or type the letter here. The candidate reads and signs this."
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

const REF_STATUSES: ReferralStatus[] = ['OPEN', 'INTERVIEWING', 'HIRED', 'REJECTED'];

function ReferralsTab({ canManage }: { canManage: boolean }) {
  const [showNew, setShowNew] = useState(false);
  const [convertingId, setConvertingId] = useState<string | null>(null);

  const referralsQuery = useQuery({ queryKey: ['recruiting', 'referrals'], queryFn: () => listReferrals() });
  const referrals: ReferralRecord[] | null = referralsQuery.data?.referrals ?? null;
  const error = referralsQuery.error ? errMessage(referralsQuery.error, 'Failed to load referrals.') : null;
  const refresh = () => void referralsQuery.refetch();

  const onStatus = async (id: string, status: ReferralStatus) => {
    try {
      await setReferralStatus(id, status);
      refresh();
    } catch (err) {
      toast.error(errMessage(err, 'Could not update the referral status.'));
    }
  };

  const onMarkPaid = async (id: string) => {
    try {
      await markReferralBonusPaid(id);
      toast.success('Bonus marked as paid.');
      refresh();
    } catch (err) {
      toast.error(errMessage(err, 'Could not mark the bonus paid.'));
    }
  };

  const onConvert = async (id: string) => {
    setConvertingId(id);
    try {
      await convertReferral(id);
      toast.success('Converted — candidate created in the funnel.');
      refresh();
    } catch (err) {
      toast.error(errMessage(err, 'Could not convert the referral.'));
    } finally {
      setConvertingId(null);
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
          {error ? (
            <LoadErrorState message={error} onRetry={refresh} />
          ) : referrals === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : referrals.length === 0 ? (
            <EmptyState
              icon={Gift}
              title="No referrals yet"
              description="Refer a friend or colleague to earn the program bonus on hire."
              action={
                <Button onClick={() => setShowNew(true)}>
                  <Plus className="mr-2 h-4 w-4" /> Refer someone
                </Button>
              }
            />
          ) : (
            <DataGrid<NonNullable<typeof referrals>[number]>
              id="referrals"
              caption="Referrals"
              rows={referrals}
              rowKey={(r) => r.id}
              search={{ placeholder: 'Candidate, position, referrer…' }}
              urlState={false}
              exportCsv={{ filename: 'referrals' }}
              columns={[
                {
                  key: 'candidate',
                  header: 'Candidate',
                  accessor: (r) => r.candidateName,
                  sortable: true,
                  primary: true,
                  cell: (r) => (
                    <>
                      <div className="font-medium text-white">{r.candidateName}</div>
                      <div className="text-xs text-silver">{r.candidateEmail}</div>
                    </>
                  ),
                },
                { key: 'position', header: 'Position', accessor: (r) => r.position, sortable: true, cardMeta: true, cell: (r) => r.position ?? '—' },
                { key: 'referrer', header: 'Referrer', accessor: (r) => r.referrerEmail, sortable: true, className: 'text-xs' },
                { key: 'status', header: 'Status', accessor: (r) => r.status, sortable: true, cell: (r) => <StatusBadge status={r.status} /> },
                {
                  key: 'bonus',
                  header: 'Bonus',
                  accessor: (r) => (r.bonusAmount ? Number(r.bonusAmount) : null),
                  csv: (r) => (r.bonusAmount ? `${fmtMoney(r.bonusAmount, { currency: r.bonusCurrency })}${r.bonusPaidAt ? ' (paid)' : ''}` : ''),
                  sortable: true,
                  searchable: false,
                  align: 'right',
                  cardMeta: true,
                  className: 'tabular-nums whitespace-nowrap',
                  cell: (r) => (r.bonusAmount ? `${fmtMoney(r.bonusAmount, { currency: r.bonusCurrency })}${r.bonusPaidAt ? ' (paid)' : ''}` : '—'),
                },
                {
                  key: 'actions',
                  header: 'Actions',
                  accessor: () => null,
                  searchable: false,
                  csv: () => '',
                  align: 'right',
                  stopRowClick: true,
                  className: 'space-x-2',
                  cell: (r) => (
                    <>
                      {canManage && r.status !== 'HIRED' && r.status !== 'REJECTED' && (
                        <div className="inline-block">
                          <Select size="sm" aria-label={`Referral status for ${r.candidateName}`} value={r.status} onChange={(e) => onStatus(r.id, e.target.value as ReferralStatus)}>
                            {REF_STATUSES.map((st) => (
                              <option key={st} value={st}>
                                {statusLabel(st)}
                              </option>
                            ))}
                          </Select>
                        </div>
                      )}
                      {canManage && r.status === 'HIRED' && !r.candidateId && (
                        <Button size="sm" variant="secondary" onClick={() => onConvert(r.id)} disabled={convertingId === r.id}>
                          <UserPlus className="mr-1 h-3.5 w-3.5" />
                          {convertingId === r.id ? 'Converting…' : 'Convert to candidate'}
                        </Button>
                      )}
                      {canManage && r.status === 'HIRED' && r.bonusAmount && !r.bonusPaidAt && (
                        <Button size="sm" onClick={() => onMarkPaid(r.id)}>
                          Mark bonus paid
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
  const [bonusAmount, setBonusAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!candidateName.trim() || !candidateEmail.trim()) {
      toast.error('Name and email are required.');
      return;
    }
    setSaving(true);
    try {
      await createReferral({
        candidateName: candidateName.trim(),
        candidateEmail: candidateEmail.trim(),
        candidatePhone: candidatePhone.trim() || null,
        position: position.trim() || null,
        bonusAmount: bonusAmount ? Number(bonusAmount) : null,
        notes: notes.trim() || null,
      });
      toast.success('Referral submitted.');
      onSaved();
    } catch (err) {
      toast.error(errMessage(err, 'Could not submit the referral.'));
    } finally {
      setSaving(false);
    }
  };
  const dirty =
    candidateName.trim() !== '' ||
    candidateEmail.trim() !== '' ||
    candidatePhone.trim() !== '' ||
    position.trim() !== '' ||
    bonusAmount !== '' ||
    notes.trim() !== '';
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} confirmDiscard={() => dirty}>
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
          <Label>Bonus amount (USD, optional)</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            className="mt-1"
            value={bonusAmount}
            onChange={(e) => setBonusAmount(e.target.value)}
            placeholder="e.g. 500"
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

// DRAFT is the canonical "default" chip; CLOSED is a settled, de-emphasised
// terminal state, so it reads as an outline rather than a warning.

function PostingsTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [showNew, setShowNew] = useState(false);

  const postingsQuery = useQuery({ queryKey: ['recruiting', 'postings'], queryFn: () => listJobPostings() });
  const postings: JobPostingRecord[] | null = postingsQuery.data?.postings ?? null;
  const error = postingsQuery.error ? errMessage(postingsQuery.error, 'Failed to load job postings.') : null;
  const refresh = () => void postingsQuery.refetch();

  const onOpen = async (id: string) => {
    try {
      await openJobPosting(id);
      toast.success('Posting opened.');
      refresh();
    } catch (err) {
      toast.error(errMessage(err, 'Could not open the posting.'));
    }
  };

  const onClose = async (id: string) => {
    try {
      await closeJobPosting(id);
      toast.success('Posting closed.');
      refresh();
    } catch (err) {
      toast.error(errMessage(err, 'Could not close the posting.'));
    }
  };

  const onOpenings = async (po: JobPostingRecord) => {
    const raw = await prompt({
      title: `How many people for ${po.title}?`,
      description: `${po.hired} hired against it so far. Fill rate counts hires against this number.`,
      reasonLabel: 'Openings',
      reasonPlaceholder: String(po.openings),
      reasonMaxLength: 3,
      confirmLabel: 'Save',
    });
    if (raw === null) return;
    const n = Number(raw.trim());
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      toast.error('Openings must be a whole number from 1 to 500.');
      return;
    }
    try {
      await setJobPostingOpenings(po.id, n);
      refresh();
    } catch (err) {
      toast.error(errMessage(err, 'Could not change the openings.'));
    }
  };

  const onSyndicate = async (po: JobPostingRecord, on: boolean) => {
    try {
      await updateJobPosting(po.id, { syndicate: on });
      toast.success(on ? `${po.title} is back in the job-board feeds.` : `${po.title} is on the careers page only.`);
      refresh();
    } catch (err) {
      toast.error(errMessage(err, 'Could not change it.'));
    }
  };

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Delete this posting?', destructive: true }))) return;
    try {
      await deleteJobPosting(id);
      refresh();
    } catch (err) {
      toast.error(errMessage(err, 'Could not delete the posting.'));
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
      <JobBoardsCard postings={postings} />
      <Card>
        <CardContent className="p-0">
          {error ? (
            <LoadErrorState message={error} onRetry={refresh} />
          ) : postings === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : postings.length === 0 ? (
            <EmptyState
              icon={Briefcase}
              title="No postings"
              description="Create a job posting to surface it on the public careers page."
              action={
                canManage ? (
                  <Button onClick={() => setShowNew(true)}>
                    <Plus className="mr-2 h-4 w-4" /> New posting
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <DataGrid<NonNullable<typeof postings>[number]>
              id="job-postings"
              caption="Job postings"
              rows={postings}
              rowKey={(po) => po.id}
              search={{ placeholder: 'Title, location…' }}
              urlState={false}
              exportCsv={{ filename: 'job-postings' }}
              columns={[
                { key: 'title', header: 'Title', accessor: (po) => po.title, sortable: true, primary: true, className: 'font-medium text-white' },
                {
                  key: 'slug',
                  header: 'Slug',
                  accessor: (po) => `/careers/${po.slug}`,
                  sortable: true,
                  className: 'font-mono text-xs',
                  stopRowClick: true,
                  // The address used to be printed with nowhere to go; the
                  // careers page now exists, so it's a link. Only an open
                  // posting renders publicly.
                  cell: (po) =>
                    po.status === 'OPEN' ? (
                      <a href={`/careers/${po.slug}`} target="_blank" rel="noopener noreferrer" className="text-gold hover:underline">
                        /careers/{po.slug}
                      </a>
                    ) : (
                      <span className="text-silver">/careers/{po.slug}</span>
                    ),
                },
                { key: 'location', header: 'Location', accessor: (po) => po.location, sortable: true, cardMeta: true, cell: (po) => po.location ?? '—' },
                {
                  key: 'pay',
                  header: 'Pay range',
                  accessor: (po) => (po.minSalary && po.maxSalary ? `${fmtMoney(po.minSalary, { currency: po.currency })}–${fmtMoney(po.maxSalary, { currency: po.currency })}` : null),
                  searchable: false,
                  align: 'right',
                  cardMeta: true,
                  className: 'tabular-nums whitespace-nowrap',
                  cell: (po) => (po.minSalary && po.maxSalary ? `${fmtMoney(po.minSalary, { currency: po.currency })}–${fmtMoney(po.maxSalary, { currency: po.currency })}` : '—'),
                },
                {
                  key: 'filled',
                  header: 'Filled',
                  accessor: (po) => `${Math.min(po.hired, po.openings)} of ${po.openings}`,
                  searchable: false,
                  align: 'right',
                  cardMeta: true,
                  className: 'tabular-nums whitespace-nowrap',
                  stopRowClick: true,
                  cell: (po) =>
                    canManage ? (
                      <button
                        type="button"
                        className="underline decoration-dotted underline-offset-2 hover:text-white"
                        aria-label={`${po.title}: ${Math.min(po.hired, po.openings)} of ${po.openings} filled — change openings`}
                        onClick={() => void onOpenings(po)}
                      >
                        {Math.min(po.hired, po.openings)} of {po.openings}
                      </button>
                    ) : (
                      `${Math.min(po.hired, po.openings)} of ${po.openings}`
                    ),
                },
                { key: 'status', header: 'Status', accessor: (po) => po.status, sortable: true, cell: (po) => <StatusBadge status={po.status} /> },
                {
                  key: 'boards',
                  header: 'Job boards',
                  accessor: (po) => (po.syndicate ? 'In feeds' : 'Careers page only'),
                  searchable: false,
                  cardMeta: true,
                  stopRowClick: true,
                  cell: (po) =>
                    canManage ? (
                      <label className="inline-flex items-center gap-2 text-xs2 text-silver">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-gold"
                          checked={po.syndicate}
                          onChange={(e) => void onSyndicate(po, e.target.checked)}
                          aria-label={`${po.title}: list on job boards`}
                        />
                        {po.syndicate ? 'In feeds' : 'Careers page only'}
                      </label>
                    ) : po.syndicate ? (
                      'In feeds'
                    ) : (
                      'Careers page only'
                    ),
                },
                ...(canManage
                  ? [
                      {
                        key: 'actions',
                        header: 'Actions',
                        accessor: () => null,
                        searchable: false,
                        csv: () => '',
                        align: 'right' as const,
                        stopRowClick: true,
                        className: 'space-x-2',
                        cell: (po: NonNullable<typeof postings>[number]) => (
                          <>
                            {po.status === 'DRAFT' && (
                              <Button size="sm" onClick={() => onOpen(po.id)}>
                                Open
                              </Button>
                            )}
                            {po.status === 'OPEN' && (
                              <Button size="sm" variant="ghost" onClick={() => onClose(po.id)}>
                                Close
                              </Button>
                            )}
                            <Button size="sm" variant="ghost" className="text-silver hover:text-alert" onClick={() => onDelete(po.id)}>
                              Delete
                            </Button>
                          </>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
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

const BOARDS: Array<{ key: string; name: string; how: string }> = [
  { key: 'indeed', name: 'Indeed', how: 'Send it to your Indeed account manager, or add it under Employer → XML feed.' },
  { key: 'ziprecruiter', name: 'ZipRecruiter', how: 'Send it to your ZipRecruiter rep as an XML job feed.' },
  { key: 'glassdoor', name: 'Glassdoor', how: 'Glassdoor reads the same feed — send it to your rep.' },
  { key: 'linkedin', name: 'LinkedIn', how: 'For LinkedIn Limited Listings, give it to your LinkedIn contact.' },
];

/**
 * Where the postings go beyond the careers page. Open postings are
 * published as a feed in Indeed's XML format — which ZipRecruiter,
 * Glassdoor, LinkedIn and most aggregators also read — one link per
 * board, so every applicant is credited to the board they came from and
 * shows up in source of hire and cost per hire.
 */
function JobBoardsCard({ postings }: { postings: JobPostingRecord[] | null }) {
  const open = (postings ?? []).filter((p) => p.status === 'OPEN');
  const inFeeds = open.filter((p) => p.syndicate).length;
  const copy = async (url: string, name: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success(`${name} feed link copied.`);
    } catch {
      toast.error('Could not copy — select the link and copy it.');
    }
  };
  return (
    <Card>
      <CardContent className="space-y-3 p-4 md:p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-medium text-white">
              <Rss className="h-4 w-4 text-gold" aria-hidden="true" />
              Job boards
            </h3>
            <p className="mt-0.5 text-xs text-silver">
              {inFeeds} of {open.length} open posting{open.length === 1 ? '' : 's'} in the feeds. Each board gets its own link,
              so applicants are credited to the board they came from. Google for Jobs reads the careers page directly —
              nothing to send.
            </p>
          </div>
        </div>
        <ul className="divide-y divide-navy-secondary/60">
          {BOARDS.map((b) => {
            const url = jobFeedUrl(b.key);
            return (
              <li key={b.key} className="flex flex-col gap-1.5 py-2.5 sm:flex-row sm:items-center sm:gap-3">
                <div className="w-28 shrink-0 text-sm text-white">{b.name}</div>
                <div className="min-w-0 flex-1">
                  <input
                    readOnly
                    value={url}
                    aria-label={`${b.name} feed link`}
                    onFocus={(e) => e.currentTarget.select()}
                    className="w-full truncate rounded-md border border-navy-secondary bg-navy px-2 py-1 font-mono text-2xs text-silver"
                  />
                  <p className="mt-1 text-2xs text-silver/70">{b.how}</p>
                </div>
                <Button size="sm" variant="outline" className="self-start sm:self-center" onClick={() => void copy(url, b.name)}>
                  <Copy className="h-3.5 w-3.5" /> Copy
                </Button>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

/** "Senior Caregiver (NYC)" → "senior-caregiver-nyc". */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
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
  // Once the user types in the slug field themselves, blurring the title
  // stops overwriting it — auto-fill must never clobber a manual edit.
  const [slugEdited, setSlugEdited] = useState(false);
  const [clientId, setClientId] = useState('');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [minSalary, setMinSalary] = useState('');
  const [maxSalary, setMaxSalary] = useState('');
  const [openings, setOpenings] = useState('1');
  const [schedule, setSchedule] = useState<JobPostingSchedule | ''>('');
  const [payUnit, setPayUnit] = useState<'HOUR' | 'YEAR' | ''>('HOUR');
  const [syndicate, setSyndicate] = useState(true);
  const [saving, setSaving] = useState(false);
  const { clients, error: clientsError, reload: reloadClients } = useClients();

  const onSubmit = async () => {
    const headcount = Number(openings);
    if (!Number.isInteger(headcount) || headcount < 1 || headcount > 500) {
      toast.error('Openings must be a whole number from 1 to 500.');
      return;
    }
    if (!title.trim() || !slug.trim() || !description.trim()) {
      toast.error('Title, slug, and description are required.');
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
        clientId: clientId || null,
        description: description.trim(),
        location: location.trim() || null,
        minSalary: minSalary ? Number(minSalary) : null,
        maxSalary: maxSalary ? Number(maxSalary) : null,
        openings: headcount,
        schedule: schedule || null,
        payUnit: minSalary || maxSalary ? payUnit || null : null,
        syndicate,
      });
      toast.success('Posting drafted.');
      onSaved();
    } catch (err) {
      toast.error(errMessage(err, 'Could not create the posting.'));
    } finally {
      setSaving(false);
    }
  };

  const dirty =
    title.trim() !== '' ||
    slug.trim() !== '' ||
    clientId !== '' ||
    description.trim() !== '' ||
    location.trim() !== '' ||
    minSalary !== '' ||
    maxSalary !== '';

  return (
    <Drawer
      open={true}
      onOpenChange={(o) => !o && onClose()}
      width="max-w-2xl"
      confirmDiscard={() => dirty}
    >
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
            onBlur={() => {
              if (!slugEdited && title.trim()) setSlug(slugify(title));
            }}
          />
        </div>
        <div>
          <Label>Slug (URL path)</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={slug}
            onChange={(e) => {
              setSlugEdited(true);
              setSlug(e.target.value);
            }}
            placeholder="senior-caregiver-nyc"
          />
        </div>
        <div>
          <Label>Client (optional)</Label>
          {clientsError ? (
            <ErrorBanner
              className="mt-1"
              action={
                <Button size="sm" variant="secondary" onClick={reloadClients}>
                  Retry
                </Button>
              }
            >
              {clientsError}
            </ErrorBanner>
          ) : (
            <Select
              className="mt-1"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              disabled={clients === null}
            >
              <option value="">
                {clients === null ? 'Loading clients…' : 'No client (company-wide)'}
              </option>
              {clients?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </div>
        <div>
          <Label>Description (markdown OK)</Label>
          <Textarea
            className="mt-1 min-h-40"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="grid grid-cols-[1fr_8rem] gap-3">
          <div>
            <Label>Location</Label>
            <Input
              className="mt-1"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </div>
          <div>
            <Label>Openings</Label>
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={500}
              className="mt-1"
              value={openings}
              onChange={(e) => setOpenings(e.target.value)}
              aria-describedby="openings-hint"
            />
          </div>
        </div>
        <p id="openings-hint" className="-mt-2 text-xs text-silver">
          How many people the client asked for — hires against the posting count toward its fill rate.
        </p>
        <div>
          <Label>Schedule</Label>
          <Select className="mt-1" value={schedule} onChange={(e) => setSchedule(e.target.value as JobPostingSchedule | '')}>
            <option value="">Not specified</option>
            {(Object.keys(SCHEDULE_LABEL) as JobPostingSchedule[]).map((k) => (
              <option key={k} value={k}>
                {SCHEDULE_LABEL[k]}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-[1fr_1fr_8rem] gap-3">
          <div>
            <Label>Min pay</Label>
            <Input
              type="number"
              className="mt-1"
              value={minSalary}
              onChange={(e) => setMinSalary(e.target.value)}
            />
          </div>
          <div>
            <Label>Max pay</Label>
            <Input
              type="number"
              className="mt-1"
              value={maxSalary}
              onChange={(e) => setMaxSalary(e.target.value)}
            />
          </div>
          <div>
            <Label>Per</Label>
            <Select className="mt-1" value={payUnit} onChange={(e) => setPayUnit(e.target.value as 'HOUR' | 'YEAR' | '')}>
              <option value="HOUR">Hour</option>
              <option value="YEAR">Year</option>
            </Select>
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm text-silver">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-gold"
            checked={syndicate}
            onChange={(e) => setSyndicate(e.target.checked)}
          />
          <span>
            List it on job boards while it&rsquo;s open (Indeed, ZipRecruiter, Glassdoor, LinkedIn). Off keeps it on the
            careers page only.
          </span>
        </label>
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

