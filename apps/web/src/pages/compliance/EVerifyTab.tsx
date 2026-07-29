import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, Copy, ShieldCheck } from 'lucide-react';
import type {
  EVerifyBlocker,
  EVerifyCaseDetail,
  EVerifyRosterRow,
  EVerifyStatus,
} from '@alto-people/shared';
import {
  getEVerifyCase,
  listEVerifyRoster,
  recordEVerifyCase,
  updateEVerifyIdentity,
} from '@/lib/complianceApi';
import { ApiError } from '@/lib/api';
import { DocumentThumbnails } from '@/components/DocumentViewer';
import { IDENTITY_DOC_KINDS, uploadAdminDocument } from '@/lib/documentsApi';
import { cn } from '@/lib/cn';
import { fmtDate } from '@/lib/format';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerHeader,
  DrawerTitle,
  EmptyState,
  ErrorBanner,
  Input,
  Select,
  SkeletonRows,
} from '@/components/ui';
import { SearchInput } from '@/components/ui/FilterBar';

/**
 * E-Verify directorate.
 *
 * Built for one complaint: ~20 minutes to E-Verify one associate, because the
 * fields the federal portal asks for were spread across five screens. The
 * detail panel here lays them out in the portal's own order with a copy button
 * on each, so the verifier works down one column.
 *
 * The list exists to answer "who still needs this, and who is overdue" without
 * opening anyone — hence the blockers column, which says *why* a person isn't
 * actionable rather than just leaving them looking unstarted.
 */

const STATUS_LABEL: Record<EVerifyStatus, string> = {
  PENDING: 'Pending',
  EMPLOYMENT_AUTHORIZED: 'Authorized',
  TENTATIVE_NONCONFIRMATION: 'Tentative nonconfirmation',
  FINAL_NONCONFIRMATION: 'Final nonconfirmation',
  CLOSE_CASE_AND_RESUBMIT: 'Close and resubmit',
};

const STATUS_VARIANT: Record<
  EVerifyStatus,
  'success' | 'pending' | 'destructive' | 'default'
> = {
  PENDING: 'pending',
  EMPLOYMENT_AUTHORIZED: 'success',
  TENTATIVE_NONCONFIRMATION: 'destructive',
  FINAL_NONCONFIRMATION: 'destructive',
  CLOSE_CASE_AND_RESUBMIT: 'pending',
};

const BLOCKER_LABEL: Record<EVerifyBlocker, string> = {
  NO_I9: 'No I-9 started',
  SECTION1_INCOMPLETE: 'Section 1 unsigned',
  SECTION2_INCOMPLETE: 'Section 2 not verified',
  NO_CITIZENSHIP: 'No citizenship status',
  NO_SSN: 'No readable SSN',
  NO_DOB: 'No date of birth',
  NO_HIRE_DATE: 'No hire date',
};

const CITIZENSHIP_LABEL: Record<string, string> = {
  US_CITIZEN: 'A citizen of the United States',
  NON_CITIZEN_NATIONAL: 'A noncitizen national of the United States',
  LAWFUL_PERMANENT_RESIDENT: 'A lawful permanent resident',
  ALIEN_AUTHORIZED_TO_WORK: 'An alien authorized to work',
};

type StatusFilter = 'all' | 'not_run' | 'pending' | 'authorized' | 'issue' | 'overdue';

export function EVerifyTab({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<EVerifyRosterRow[] | null>(null);
  const [counts, setCounts] = useState<{
    total: number;
    authorized: number;
    pending: number;
    nonconfirmation: number;
    notRun: number;
    overdue: number;
    blocked: number;
  } | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [openFor, setOpenFor] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const res = await listEVerifyRoster();
      setRows(res.rows);
      setCounts(res.counts);
      setTruncated(res.truncated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the roster.');
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visible = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !r.associateName.toLowerCase().includes(q) &&
          !r.associateEmail.toLowerCase().includes(q)) {
        return false;
      }
      switch (filter) {
        case 'not_run':
          return r.status === null;
        case 'pending':
          return r.status === 'PENDING';
        case 'authorized':
          return r.status === 'EMPLOYMENT_AUTHORIZED';
        case 'issue':
          return (
            r.status === 'TENTATIVE_NONCONFIRMATION' ||
            r.status === 'FINAL_NONCONFIRMATION'
          );
        case 'overdue':
          return r.overdue;
        default:
          return true;
      }
    });
  }, [rows, query, filter]);

  return (
    <div>
      {error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}

      {/* Snapshot — the "how are we doing on E-Verify" question, answered
          without scrolling a table. */}
      {counts && counts.total > 0 && (
        <div className="mb-4 flex flex-wrap gap-x-6 gap-y-2 rounded-md border border-navy-secondary bg-navy-secondary/30 px-4 py-3">
          <Kpi label="Associates" value={counts.total} />
          <Kpi label="Authorized" value={counts.authorized} tone="text-success" />
          <Kpi label="Pending" value={counts.pending} />
          <Kpi
            label="Nonconfirmation"
            value={counts.nonconfirmation}
            tone={counts.nonconfirmation > 0 ? 'text-alert' : undefined}
          />
          <Kpi label="Not yet run" value={counts.notRun} />
          <Kpi
            label="Overdue"
            value={counts.overdue}
            tone={counts.overdue > 0 ? 'text-alert' : undefined}
          />
          <Kpi
            label="Blocked"
            value={counts.blocked}
            tone={counts.blocked > 0 ? 'text-warning' : undefined}
          />
        </div>
      )}

      {truncated && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/[0.07] p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <div className="text-silver">
            Showing the first {rows?.length ?? 0} associates — the roster is
            larger than one page. Narrow with the search box to find someone
            who isn&apos;t listed.
          </div>
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or email…"
          wrapperClassName="w-full sm:w-72"
        />
        <Select
          value={filter}
          onChange={(e) => setFilter(e.target.value as StatusFilter)}
          size="sm"
          className="w-auto"
          // No visible label — the options carry the meaning ("All statuses").
          // Without this a screen reader announces an unnamed combobox.
          aria-label="Filter by E-Verify status"
        >
          <option value="all">All statuses</option>
          <option value="not_run">Not yet run</option>
          <option value="pending">Pending</option>
          <option value="authorized">Authorized</option>
          <option value="issue">Nonconfirmation</option>
          <option value="overdue">Overdue</option>
        </Select>
      </div>

      {rows === null ? (
        <SkeletonRows count={6} />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="Nobody matches this filter"
          description="Clear the search or switch the status filter to see the full roster."
        />
      ) : (
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div className="divide-y divide-navy-secondary">
              {visible.map((r) => (
                <RosterRow
                  key={r.associateId}
                  row={r}
                  onOpen={() => setOpenFor(r.associateId)}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {openFor && (
        <CaseDrawer
          associateId={openFor}
          canManage={canManage}
          onClose={() => setOpenFor(null)}
          onSaved={() => void refresh()}
        />
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div>
      <div className="text-2xs uppercase tracking-wider text-silver/70">{label}</div>
      <div className={cn('font-display text-xl tabular-nums', tone ?? 'text-white')}>
        {value}
      </div>
    </div>
  );
}

function RosterRow({ row, onOpen }: { row: EVerifyRosterRow; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-left transition-colors hover:bg-navy-secondary/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-white">{row.associateName}</span>
          {/* The "indicate it by their name" ask — status sits with the person,
              not in a column you have to scan across to. */}
          {row.status ? (
            <Badge variant={STATUS_VARIANT[row.status]}>
              {STATUS_LABEL[row.status]}
            </Badge>
          ) : (
            <Badge variant="default">Not run</Badge>
          )}
          {row.overdue && <Badge variant="destructive">Overdue</Badge>}
        </div>
        <div className="mt-0.5 truncate text-xs text-silver/70">
          {row.associateEmail}
          {row.ssnLast4 ? ` · SSN ••••${row.ssnLast4}` : ''}
          {row.caseNumber ? ` · Case ${row.caseNumber}` : ''}
        </div>
      </div>

      <div className="text-xs tabular-nums text-silver">
        <div className="text-2xs uppercase tracking-wider text-silver/60">Hired</div>
        {row.hireDate ? fmtDate(row.hireDate) : '—'}
      </div>
      <div className="text-xs tabular-nums">
        <div className="text-2xs uppercase tracking-wider text-silver/60">Due by</div>
        <span className={row.overdue ? 'text-alert' : 'text-silver'}>
          {row.dueBy ? fmtDate(row.dueBy) : '—'}
        </span>
      </div>

      {/* Why this person isn't actionable, without opening them. */}
      <div className="w-full sm:w-56">
        {row.blockers.length === 0 ? (
          <span className="inline-flex items-center gap-1 text-xs text-success">
            <Check className="h-3.5 w-3.5" />
            Ready
          </span>
        ) : (
          <span className="text-xs text-warning">
            {row.blockers.map((b) => BLOCKER_LABEL[b]).join(' · ')}
          </span>
        )}
      </div>
    </button>
  );
}

/** Copy-to-clipboard field. The concrete fix for retyping into the portal. */
function CopyField({
  label,
  value,
  hint,
  mono,
}: {
  label: string;
  value: string | null;
  hint?: string;
  mono?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const empty = !value;

  const copy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy — your browser blocked clipboard access.');
    }
  };

  return (
    <div className="min-w-0">
      <div className="text-2xs uppercase tracking-widest text-silver/80">{label}</div>
      <div className="mt-0.5 flex items-center gap-2">
        <span
          className={cn(
            'min-w-0 flex-1 break-words text-sm',
            mono && 'font-mono',
            empty ? 'text-warning' : 'text-white',
          )}
        >
          {value || 'Missing'}
        </span>
        {!empty && (
          <button
            type="button"
            onClick={() => void copy()}
            aria-label={`Copy ${label}`}
            className="shrink-0 rounded p-1 text-silver/70 transition-colors hover:text-gold focus:outline-none focus-visible:ring-2 focus-visible:ring-gold-bright"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-success" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </button>
        )}
      </div>
      {hint && <div className="mt-0.5 text-2xs text-silver/60">{hint}</div>}
    </div>
  );
}

function CaseDrawer({
  associateId,
  canManage,
  onClose,
  onSaved,
}: {
  associateId: string;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [detail, setDetail] = useState<EVerifyCaseDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setDetail(await getEVerifyCase(associateId));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the case.');
    }
  }, [associateId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>
          {detail ? `${detail.firstName} ${detail.lastName}` : 'E-Verify case'}
        </DrawerTitle>
      </DrawerHeader>
      <DrawerBody>
        {error && <ErrorBanner className="mb-3">{error}</ErrorBanner>}
        {!detail ? (
          <SkeletonRows count={8} />
        ) : (
          <div className="space-y-6">
            {detail.blockers.length > 0 && (
              <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/[0.07] p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <div className="min-w-0 text-xs">
                  <div className="font-medium text-white">
                    Not ready to run in E-Verify
                  </div>
                  <div className="mt-0.5 text-silver">
                    {detail.blockers.map((b) => BLOCKER_LABEL[b]).join(' · ')}
                  </div>
                </div>
              </div>
            )}

            <Section title="Section 1 — Employee information and attestation">
              <div className="grid grid-cols-2 gap-4">
                <CopyField label="Last name" value={detail.lastName} />
                <CopyField label="First name" value={detail.firstName} />
                <CopyField label="Middle initial" value={detail.middleInitial} />
                <CopyField
                  label="Other last names used"
                  value={detail.otherLastNames.join(', ') || null}
                />
                <CopyField label="Date of birth" value={detail.dob} mono />
                <CopyField
                  label="U.S. Social Security number"
                  value={detail.ssn}
                  mono
                  hint={
                    detail.ssn
                      ? undefined
                      : 'No readable SSN — the employee must re-submit their W-4.'
                  }
                />
                <div className="col-span-2">
                  <CopyField label="E-mail address" value={detail.email} />
                </div>
                <div className="col-span-2">
                  <CopyField
                    label="Citizenship status"
                    value={
                      detail.citizenshipStatus
                        ? (CITIZENSHIP_LABEL[detail.citizenshipStatus] ??
                          detail.citizenshipStatus)
                        : null
                    }
                  />
                </div>
                {detail.alienRegistrationNumber && (
                  <CopyField
                    label="Alien registration / USCIS number"
                    value={detail.alienRegistrationNumber}
                    mono
                  />
                )}
                {detail.workAuthExpiresAt && (
                  <CopyField
                    label="Work authorization expires"
                    value={detail.workAuthExpiresAt}
                    mono
                  />
                )}
              </div>

              {canManage && (
                <IdentityEditor
                  associateId={associateId}
                  middleInitial={detail.middleInitial}
                  otherLastNames={detail.otherLastNames}
                  onSaved={() => void load()}
                />
              )}
            </Section>

            <Section title="Section 2 — Employer review and verification">
              <div className="grid grid-cols-2 gap-4">
                <CopyField
                  label="Document list"
                  value={
                    detail.documentList === 'LIST_A'
                      ? 'List A'
                      : detail.documentList === 'LIST_B_AND_C'
                        ? 'List B & C'
                        : null
                  }
                />
                <CopyField label="Date of hire" value={detail.hireDate} mono />
              </div>
              <div className="mt-3">
                <div className="text-2xs uppercase tracking-widest text-silver/80">
                  Identity documents
                </div>
                <p className="mb-2 mt-0.5 text-2xs text-silver/60">
                  Click to view in place — zoom and rotate for small print.
                  Nothing is saved to your computer.
                </p>
                {/* Viewed in-site rather than downloaded: reviewing an ID used
                    to drop a copy of someone's passport into the reviewer's
                    Downloads folder on every case, outside the product's
                    retention rules. */}
                <DocumentThumbnails
                  documents={detail.documents}
                  emptyMessage="No documents uploaded — Section 2 can't be evidenced."
                  bulkDownloadAssociateId={detail.associateId}
                  // Identity documents only — not the associate's whole file.
                  bulkDownloadKinds={IDENTITY_DOC_KINDS}
                />
              </div>
            </Section>

            <Section title="Case">
              <CaseRecorder
                associateId={associateId}
                detail={detail}
                canManage={canManage}
                onSaved={() => {
                  void load();
                  onSaved();
                }}
              />
            </Section>

            <Section title="E-Verify packet">
              <PacketSection
                associateId={associateId}
                packets={detail.packets}
                canManage={canManage}
                onUploaded={() => void load()}
              />
            </Section>
          </div>
        )}
      </DrawerBody>
    </Drawer>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 border-b border-navy-secondary pb-1 text-xs font-medium uppercase tracking-wider text-silver">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * The packet E-Verify returns once a case closes.
 *
 * HR downloads it from the federal portal and files it here, against the
 * associate, so the government's answer lives next to the case number rather
 * than in someone's Downloads folder. Stored as I9_VERIFICATION_RESULT
 * documents, which is what that kind was always meant for.
 *
 * Multi-select because the portal hands back a folder, not a single file —
 * and the API accepts a .zip on the HR path so the archive can go up whole
 * if that's how it arrived.
 */
function PacketSection({
  associateId,
  packets,
  canManage,
  onUploaded,
}: {
  associateId: string;
  packets: EVerifyCaseDetail['packets'];
  canManage: boolean;
  onUploaded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setErr(null);
    const failures: string[] = [];
    let ok = 0;
    // Sequential, not Promise.all: each file is its own audited write, and a
    // partial failure should say which file rather than rejecting the batch.
    for (const file of Array.from(files)) {
      try {
        await uploadAdminDocument(file, 'I9_VERIFICATION_RESULT', associateId);
        ok += 1;
      } catch (e) {
        failures.push(`${file.name}: ${e instanceof Error ? e.message : 'failed'}`);
      }
    }
    setBusy(false);
    if (inputRef.current) inputRef.current.value = '';
    if (ok > 0) onUploaded();
    if (failures.length === 0) {
      toast.success(`Uploaded ${ok} file${ok === 1 ? '' : 's'}.`);
    } else {
      setErr(failures.join(' · '));
      if (ok > 0) toast.warning(`Uploaded ${ok}, ${failures.length} failed.`);
    }
  };

  return (
    <div>
      {err && <ErrorBanner className="mb-2">{err}</ErrorBanner>}

      {packets.length === 0 ? (
        <p className="mb-2 text-xs text-silver">
          Nothing filed yet. Once the case is closed, download the packet from
          E-Verify and upload it here.
        </p>
      ) : (
        <div className="mb-3">
          <DocumentThumbnails
            documents={packets}
            bulkDownloadAssociateId={associateId}
            bulkDownloadKinds={['I9_VERIFICATION_RESULT']}
          />
        </div>
      )}

      {canManage && (
        <div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.webp,.zip"
            onChange={(e) => void upload(e.target.files)}
            disabled={busy}
            aria-label="Upload E-Verify packet files"
            className="block w-full text-xs text-silver file:mr-3 file:rounded file:border file:border-navy-secondary file:bg-navy-secondary/40 file:px-3 file:py-1.5 file:text-xs file:text-white hover:file:border-gold/60 disabled:opacity-50"
          />
          <p className="mt-1 text-2xs text-silver/60">
            PDF, image, or a .zip of the whole folder. Up to 10 MB per file —
            select several at once if the packet is multiple documents.
          </p>
          {busy && <p className="mt-1 text-2xs text-gold">Uploading…</p>}
        </div>
      )}
    </div>
  );
}

/** Backfill for people onboarded before these fields existed. */
function IdentityEditor({
  associateId,
  middleInitial,
  otherLastNames,
  onSaved,
}: {
  associateId: string;
  middleInitial: string | null;
  otherLastNames: string[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mi, setMi] = useState(middleInitial ?? '');
  const [names, setNames] = useState<string[]>(otherLastNames);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await updateEVerifyIdentity(associateId, {
        middleInitial: mi.trim() ? mi.trim().slice(0, 1) : null,
        otherLastNames: names,
      });
      toast.success('Identity details updated.');
      setOpen(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 text-2xs uppercase tracking-wider text-silver/70 underline underline-offset-2 hover:text-gold"
      >
        Edit middle initial / other last names
      </button>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-navy-secondary p-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-2xs uppercase tracking-widest text-silver/80">
            Middle initial
          </div>
          <Input
            value={mi}
            maxLength={1}
            onChange={(e) => setMi(e.target.value)}
            className="mt-1 h-8 text-sm"
          />
        </div>
        <div>
          <div className="text-2xs uppercase tracking-widest text-silver/80">
            Other last names used
          </div>
          <Input
            value={draft}
            placeholder="Type a name, press Enter"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              const v = draft.trim();
              if (v && !names.includes(v)) setNames([...names, v]);
              setDraft('');
            }}
            className="mt-1 h-8 text-sm"
          />
        </div>
      </div>
      {names.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {names.map((n) => (
            <span
              key={n}
              className="inline-flex items-center gap-1 rounded border border-navy-secondary bg-navy-secondary/40 px-2 py-0.5 text-xs text-white"
            >
              {n}
              <button
                type="button"
                aria-label={`Remove ${n}`}
                onClick={() => setNames(names.filter((x) => x !== n))}
                className="text-silver/70 hover:text-alert"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={() => void save()} loading={saving} disabled={saving}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function CaseRecorder({
  associateId,
  detail,
  canManage,
  onSaved,
}: {
  associateId: string;
  detail: EVerifyCaseDetail;
  canManage: boolean;
  onSaved: () => void;
}) {
  const [caseNumber, setCaseNumber] = useState(detail.caseNumber ?? '');
  const [status, setStatus] = useState<EVerifyStatus | ''>(detail.status ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!canManage) {
    return (
      <div className="grid grid-cols-2 gap-4">
        <CopyField label="Case number" value={detail.caseNumber} mono />
        <CopyField
          label="Status"
          value={detail.status ? STATUS_LABEL[detail.status] : null}
        />
      </div>
    );
  }

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      await recordEVerifyCase(associateId, {
        caseNumber: caseNumber.trim() || null,
        status: status || null,
        // Stamp the open time on first recording — it anchors the federal
        // 3-business-day deadline the roster measures against.
        ...(detail.caseOpenedAt ? {} : { caseOpenedAt: new Date().toISOString() }),
        ...(status && status !== 'PENDING' && !detail.closedAt
          ? { closedAt: new Date().toISOString() }
          : {}),
      });
      toast.success('E-Verify case recorded.');
      onSaved();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not record the case.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {err && <ErrorBanner className="mb-2">{err}</ErrorBanner>}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-2xs uppercase tracking-widest text-silver/80">
            Case number
          </div>
          <Input
            value={caseNumber}
            onChange={(e) => setCaseNumber(e.target.value)}
            placeholder="From the E-Verify portal"
            className="mt-1 h-9 text-sm"
          />
        </div>
        <div>
          <div className="text-2xs uppercase tracking-widest text-silver/80">
            Outcome
          </div>
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value as EVerifyStatus | '')}
            className="mt-1"
          >
            <option value="">Not run yet</option>
            {(Object.keys(STATUS_LABEL) as EVerifyStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {detail.dueBy && (
        <p className={cn('mt-2 text-xs', detail.overdue ? 'text-alert' : 'text-silver')}>
          Federal deadline: {fmtDate(detail.dueBy)} — 3 business days after the
          first day worked.
          {detail.overdue && ' This case is overdue.'}
        </p>
      )}
      <div className="mt-3">
        <Button onClick={() => void save()} loading={saving} disabled={saving}>
          Save case
        </Button>
      </div>
    </div>
  );
}
