import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Send, X } from '@/components/ui/icons';
import { toast } from 'sonner';
import type { Candidate } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import {
  createOffer,
  listJobPostings,
  listOfferLetterTemplates,
  previewOfferLetter,
  sendOffer,
} from '@/lib/recruiting90Api';
import { getCandidate, listCandidates } from '@/lib/recruitingApi';
import { listClients } from '@/lib/clientsApi';
import { usePersistentState } from '@/lib/usePersistentState';
import {
  Button,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  ErrorBanner,
  Input,
  Select,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

/**
 * The offer form, one copy for both doors: the Offers tab (draft, then send)
 * and the candidate's own record (HR walk 8), where it opens on top of the
 * candidate drawer, filled from their posting — client, pay, title, next
 * Monday — with the client's letter written in, and one "Create & send".
 */

function errMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** The next Monday after today, as YYYY-MM-DD (local). */
export function nextMonday(from: Date = new Date()): string {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const add = ((8 - d.getDay()) % 7) || 7;
  d.setDate(d.getDate() + add);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Client names for the offer form's <Select>. */
function useClientNames() {
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

export interface PickedCandidate {
  id: string;
  name: string;
}

/**
 * Candidate typeahead that resolves to {id, name} — same UX as
 * AssociatePicker, searched on the server as you type (it used to load
 * the newest 200 candidates and filter those, so anyone older couldn't be
 * found). Replaces the raw-UUID input on the offer drawer.
 */
export function CandidatePicker({
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
        <span className="text-ink">{value.name}</span>
        <button
          type="button"
          onClick={() => {
            onChange(null);
            setTerm('');
          }}
          className="text-silver/60 hover:text-ink"
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
              className="block w-full px-3 py-2 text-left text-sm text-silver hover:bg-navy-secondary hover:text-ink"
              onClick={() => {
                onChange({ id: r.id, name: r.name });
                setOpen(false);
              }}
            >
              <span className="block text-ink">{r.name}</span>
              <span className="block text-xs text-silver/70">{r.email}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function NewOfferDrawer({
  seedCandidateId,
  oneStep = false,
  onClose,
  onSaved,
}: {
  /** Pre-fill this candidate (and their position) instead of the picker. */
  seedCandidateId?: string | null;
  /**
   * From the candidate's own record: one "Create & send" instead of a draft
   * to send later. The Offers tab keeps the two steps.
   */
  oneStep?: boolean;
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
  const { clients, error: clientsError, reload: reloadClients } = useClientNames();
  // The posting the candidate is hired against fills the client and pay.
  const postingsQuery = useQuery({
    queryKey: ['recruiting', 'postings'],
    queryFn: () => listJobPostings(),
    enabled: Boolean(seedCandidateId),
    staleTime: 60_000,
  });
  // The client's published offer-letter templates, its own first.
  const templatesQuery = useQuery({
    queryKey: ['recruiting', 'offer-letter-templates', clientId],
    queryFn: () => listOfferLetterTemplates(clientId || undefined),
  });
  const templates = templatesQuery.data?.templates ?? [];

  const lettersReady = Boolean(candidate && clientId && jobTitle.trim() && startDate && (salary || hourlyRate));
  const writeFromTemplate = async (quiet = false) => {
    if (!lettersReady || !candidate) {
      if (!quiet) toast.error('Fill in the candidate, client, title, start date and pay first — the letter uses them.');
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
      if (!quiet) toast.success(`Letter written from “${r.templateName}” — edit it as you need.`);
    } catch (err) {
      if (!quiet) toast.error(errMessage(err, 'Could not write the letter.'));
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
  // From the candidate's posting: the client, the pay (by its unit), the
  // title when they named no position, and next Monday as the start.
  const prefilled = useRef(false);
  useEffect(() => {
    const c = seededQuery.data;
    if (!seedCandidateId || !c || prefilled.current) return;
    const po = c.jobPostingId ? postingsQuery.data?.postings.find((p) => p.id === c.jobPostingId) : null;
    if (c.jobPostingId && !postingsQuery.data && !postingsQuery.isError) return; // still loading
    prefilled.current = true;
    if (po) {
      if (po.clientId) setClientId(po.clientId);
      if (!c.position) setJobTitle((prev) => prev || po.title);
      if (po.minSalary) {
        if (po.payUnit === 'YEAR') setSalary((prev) => prev || po.minSalary!);
        else setHourlyRate((prev) => prev || po.minSalary!);
      }
    }
    setStartDate((prev) => prev || nextMonday());
  }, [seedCandidateId, seededQuery.data, postingsQuery.data, postingsQuery.isError]);
  // The client's published template writes the letter the moment the facts
  // it uses are in — once, and never over something already typed.
  const autoWritten = useRef(false);
  useEffect(() => {
    if (!seedCandidateId || autoWritten.current || !lettersReady || letterBody.trim() || templatesQuery.isLoading) return;
    if (templates.length === 0) return;
    autoWritten.current = true;
    void writeFromTemplate(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedCandidateId, lettersReady, letterBody, templatesQuery.isLoading, templates.length]);
  useEffect(() => {
    if (seedCandidateId && seededQuery.isError) {
      toast.error('Could not load the candidate — pick them manually.');
    }
  }, [seedCandidateId, seededQuery.isError]);

  const onSubmit = async (send: boolean) => {
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
        // Outside the band: the approvers were asked on create, and it goes
        // to the candidate once one of them approves.
        toast.warning(send ? 'Sent for approval — it goes to the candidate once approved.' : 'Drafted — and held for approval before it can be sent.', {
          description: created.approvalNote ?? undefined,
        });
      } else if (send) {
        try {
          const sent = await sendOffer(created.id);
          toast.success(
            sent.emailed
              ? `Offer sent to ${candidate.name}.`
              : `Offer is out, but ${candidate.name} has no email on file — share their signing link from the Offers tab.`,
          );
        } catch (err) {
          toast.error(errMessage(err, 'The offer was created, but it could not be sent. Send it from the Offers tab.'));
        }
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
              onClick={() => void writeFromTemplate(false)}
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
        {/* "Create & send" is the main button everywhere (it used to be
            only in the candidate drawer); a draft is the secondary path. */}
        {!oneStep && (
          <Button variant="secondary" onClick={() => void onSubmit(false)} loading={saving} disabled={saving}>
            Create draft
          </Button>
        )}
        <Button onClick={() => void onSubmit(true)} loading={saving} disabled={saving}>
          <Send className="h-4 w-4" />
          Create &amp; send
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
