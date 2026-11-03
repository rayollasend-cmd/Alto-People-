import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { WorkStatus } from '@alto-people/shared';
import { CalendarDays, Download, FileArchive, FileCheck2, ShieldAlert } from '@/components/ui/icons';
import { useClients } from '@/lib/useClients';
import { apiFetch, ApiError } from '@/lib/api';
import { downloadCsv } from '@/lib/csv';
import { fmtDateOnly, fmtSize, fmtTime, ymdLocal } from '@/lib/format';
import { usePersistentState } from '@/lib/usePersistentState';
import {
  AssociatePicker,
  Button,
  Card,
  CardContent,
  DateField,
  EmptyState,
  ErrorBanner,
  Label,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  type PickedAssociate,
} from '@/components/ui';
import { PeopleStatusBadge } from '@/components/ui/PeopleStatusBadge';

type PacketScope =
  | 'CLIENT_PERIOD'
  | 'COUNSEL_PDF'
  | 'ALL_WORKFORCE'
  | 'ACTIVE_WORKFORCE'
  | 'INACTIVE_WORKFORCE'
  | 'INDIVIDUAL';

const SCOPE_LABEL: Record<PacketScope, { label: string; blurb: string }> = {
  CLIENT_PERIOD: {
    label: 'Client audit (ZIP)',
    blurb: 'Workers tied to one client during the period — vendor-compliance audits (e.g. Walmart).',
  },
  COUNSEL_PDF: {
    label: 'Client audit — counsel single PDF',
    blurb: 'One combined PDF in counsel\'s arrangement: worker list, I-9s with document copies, E-Verify, paycheck stubs, harassment-reporting process, background checks. Currently-employed workers only.',
  },
  ALL_WORKFORCE: {
    label: 'Entire workforce',
    blurb: 'Everyone who has ever worked for us, current and separated — DOL / ICE / insurance audits. The period bounds the pay and time sections.',
  },
  ACTIVE_WORKFORCE: {
    label: 'Active workforce only',
    blurb: 'Only currently active associates — no separated or deactivated people. The day-to-day workforce review; the cover states how many inactive records were excluded.',
  },
  INACTIVE_WORKFORCE: {
    label: 'Inactive workforce only',
    blurb: 'Only separated and temporarily deactivated associates, each labeled with which, since when, the reason, and who recorded it. Never mixes with the active roster.',
  },
  INDIVIDUAL: {
    label: 'Individual associate',
    blurb: 'One associate\'s complete evidence file — wage claims, subpoenas, single-associate I-9 requests.',
  },
};

const WORKFORCE_SCOPES: ReadonlyArray<PacketScope> = [
  'ALL_WORKFORCE',
  'ACTIVE_WORKFORCE',
  'INACTIVE_WORKFORCE',
];

// Canned openers for the audit-log reason — each clears the ≥10-char rule on
// its own; HR appends the specifics (who asked, when it's due).
const REASON_TEMPLATES = [
  'Client vendor audit',
  'Wage claim response',
  'Subpoena / records request',
  'Internal periodic review',
] as const;

const isYmd = (v: unknown): v is string =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Blob download using the pattern lib/csv.ts documents: the anchor is
 * attached before click (a detached anchor's click() is unreliable in
 * Firefox) and the object URL is revoked on the next tick (a synchronous
 * revoke can abort the download in Safari).
 */
function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * One-click client-audit response packet (built to Walmart's vendor-audit
 * scope letter): pick the client and audit period, state the reason (it
 * lands in the critical audit log), download a ZIP whose numbered folders
 * mirror the audit scope — roster, I-9s + documents, E-Verify register,
 * attestation letters, pay records, harassment-reporting process, and
 * background checks — fronted by a letterheaded cover manifest.
 */
export function AuditPacketTab() {
  const { clients } = useClients();
  // Scope, client, and period survive revisits — audits are worked over days
  // and the same request shape gets rebuilt each time. The reason stays
  // volatile: it names ONE request and must be typed per export.
  const [scope, setScope] = usePersistentState<PacketScope>(
    'alto:list.audit-packet.scope.v1',
    'CLIENT_PERIOD',
    (v): v is PacketScope => typeof v === 'string' && v in SCOPE_LABEL,
  );
  const [clientId, setClientId] = usePersistentState<string>(
    'alto:list.audit-packet.client.v1',
    '',
    (v): v is string => typeof v === 'string',
  );
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);
  const [workforceConfirmed, setWorkforceConfirmed] = useState(false);
  const today = ymdLocal();
  const yearAgo = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return ymdLocal(d);
  })();
  const [periodStart, setPeriodStart] = usePersistentState<string>(
    'alto:list.audit-packet.periodStart.v1',
    yearAgo,
    isYmd,
  );
  const [periodEnd, setPeriodEnd] = usePersistentState<string>(
    'alto:list.audit-packet.periodEnd.v1',
    today,
    isYmd,
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Last successful packet, held in memory until the next generation
  // replaces it: success stays visible (a background download is easy to
  // miss), and "Download again" re-saves the SAME bytes without re-running
  // the audited PII export.
  const [result, setResult] = useState<{
    blob: Blob;
    filename: string;
    generatedAt: Date;
  } | null>(null);

  // Calendar-period presets, computed with plain date math (no toLocale*).
  const presets = (() => {
    const now = new Date();
    const y = now.getFullYear();
    const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
    return [
      {
        label: 'Last quarter',
        // Date() normalizes month -3 → Q4 of the previous year; day 0 of
        // the current quarter's start month is the last day of last quarter.
        start: ymdLocal(new Date(y, qStartMonth - 3, 1)),
        end: ymdLocal(new Date(y, qStartMonth, 0)),
      },
      {
        label: 'Last year',
        start: `${y - 1}-01-01`,
        end: `${y - 1}-12-31`,
      },
      {
        label: 'Year to date',
        start: `${y}-01-01`,
        end: ymdLocal(now),
      },
    ];
  })();

  const generate = async () => {
    setError(null);
    if ((scope === 'CLIENT_PERIOD' || scope === 'COUNSEL_PDF') && !clientId) {
      setError('Pick the auditing client.');
      return;
    }
    if (scope === 'INDIVIDUAL' && !associate) {
      setError('Pick the associate to audit.');
      return;
    }
    if (WORKFORCE_SCOPES.includes(scope) && !workforceConfirmed) {
      setError('Confirm you understand the scope of a full-workforce export.');
      return;
    }
    if (!periodStart || !periodEnd || periodEnd < periodStart) {
      setError('Pick a valid audit period.');
      return;
    }
    if (reason.trim().length < 10) {
      setError('State the reason for this export (at least 10 characters) — it is recorded in the audit log.');
      return;
    }
    setBusy(true);
    try {
      // apiFetch JSON-parses responses; these endpoints stream a ZIP/PDF,
      // so hit fetch directly and hand the blob to the browser.
      const res = await fetch(
        scope === 'COUNSEL_PDF'
          ? '/api/audit-packets/generate-counsel'
          : '/api/audit-packets/generate',
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            scope === 'COUNSEL_PDF'
              ? { clientId, periodStart, periodEnd, reason: reason.trim() }
              : {
                  scope,
                  ...(scope === 'CLIENT_PERIOD' ? { clientId } : {}),
                  ...(scope === 'INDIVIDUAL' ? { associateId: associate!.id } : {}),
                  periodStart,
                  periodEnd,
                  reason: reason.trim(),
                },
          ),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `Packet generation failed (${res.status}).`);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disposition);
      const filename =
        match?.[1] ??
        `audit-${scope === 'COUNSEL_PDF' ? 'response' : 'packet'}-${periodStart}-to-${periodEnd}.${scope === 'COUNSEL_PDF' ? 'pdf' : 'zip'}`;
      saveBlob(blob, filename);
      setResult({ blob, filename, generatedAt: new Date() });
    } catch (err) {
      // A TypeError from fetch/blob() means the connection died mid-
      // generation — the server aborts the stream when a section fails,
      // and it used to just hang here forever instead.
      setError(
        err instanceof TypeError
          ? 'Packet generation failed partway through — the download was aborted. Try a shorter audit period; if it keeps failing, contact your administrator (the server log names the failing section).'
          : err instanceof Error
            ? err.message
            : 'Packet generation failed.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-silver">
        Assembles the complete audit response for a client's vendor-compliance
        review as a single ZIP: worker roster, Form I-9s with identity
        documents, E-Verify register, attestation letters, pay records
        (punches, pay register, paystubs, external payments), the
        harassment-reporting process with its acknowledgment log, background
        checks, and a letterheaded cover manifest mapping each folder to the
        audit scope.
      </p>

      <Card>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="audit-scope">Audit scope</Label>
            <Select
              id="audit-scope"
              className="mt-1"
              value={scope}
              onChange={(e) => {
                setScope(e.target.value as PacketScope);
                setWorkforceConfirmed(false);
                setError(null);
              }}
            >
              {(Object.keys(SCOPE_LABEL) as PacketScope[]).map((s) => (
                <option key={s} value={s}>
                  {SCOPE_LABEL[s].label}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-2xs text-silver">{SCOPE_LABEL[scope].blurb}</p>
          </div>

          {(scope === 'CLIENT_PERIOD' || scope === 'COUNSEL_PDF') && (
            <div>
              <Label htmlFor="audit-client">Auditing client</Label>
              <Select
                id="audit-client"
                className="mt-1"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
              >
                <option value="">Select a client…</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
          )}

          {scope === 'INDIVIDUAL' && (
            <div>
              <Label htmlFor="audit-associate">Associate</Label>
              <div className="mt-1">
                <AssociatePicker id="audit-associate" value={associate} onChange={setAssociate} />
              </div>
            </div>
          )}

          {WORKFORCE_SCOPES.includes(scope) && (
            <label className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/[0.07] p-3 text-xs text-silver">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={workforceConfirmed}
                onChange={(e) => setWorkforceConfirmed(e.target.checked)}
              />
              <span>
                I understand this exports the I-9 records, identity documents,
                and pay data of{' '}
                <strong className="text-white">
                  {scope === 'ALL_WORKFORCE'
                    ? 'every worker the company has ever employed'
                    : scope === 'ACTIVE_WORKFORCE'
                      ? 'every currently active worker'
                      : 'every separated or deactivated worker'}
                </strong>{' '}
                in a single file, and that this action is permanently recorded
                in the critical audit log.
              </span>
            </label>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-2xs uppercase tracking-widest text-silver/80">
              Period preset
            </span>
            {presets.map((p) => (
              <Button
                key={p.label}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  setPeriodStart(p.start);
                  setPeriodEnd(p.end);
                }}
              >
                {p.label}
              </Button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="audit-start">Audit period start</Label>
              <input
                id="audit-start"
                type="date"
                className="mt-1 w-full h-10 px-3 py-2 text-sm rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none text-white"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="audit-end">Audit period end</Label>
              <input
                id="audit-end"
                type="date"
                className="mt-1 w-full h-10 px-3 py-2 text-sm rounded bg-navy-secondary/60 border border-navy-secondary focus:border-gold focus:outline-none text-white"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
            </div>
          </div>

          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Label htmlFor="audit-reason">Reason for export</Label>
              <Select
                size="sm"
                className="w-auto"
                aria-label="Insert a reason template"
                // Always renders the placeholder — picking an option fills
                // the textarea below (still editable) and resets here.
                value=""
                onChange={(e) => {
                  if (e.target.value) setReason(e.target.value);
                }}
              >
                <option value="">Insert template…</option>
                {REASON_TEMPLATES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </div>
            <Textarea
              id="audit-reason"
              className="mt-1"
              rows={2}
              maxLength={500}
              placeholder='e.g. "Walmart vendor compliance audit received 2026-08-10, response due 2026-08-24"'
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <p className="mt-1 text-2xs text-silver">
              Recorded permanently in the critical audit log with your identity.
            </p>
          </div>

          {error && <ErrorBanner>{error}</ErrorBanner>}

          <div className="flex items-center gap-3">
            <Button onClick={generate} loading={busy} disabled={busy}>
              <FileArchive className="mr-2 h-4 w-4" />
              {busy ? 'Assembling packet…' : 'Generate & download packet'}
            </Button>
          </div>

          {result && (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-success/40 bg-success/[0.07] p-3 text-xs">
              <FileCheck2 className="h-4 w-4 shrink-0 text-success" />
              <div className="min-w-0 flex-1">
                <div className="text-white">
                  Packet ready · {fmtSize(result.blob.size)} · generated{' '}
                  {fmtTime(result.generatedAt)}
                </div>
                <div className="truncate text-2xs text-silver/70">
                  {result.filename} — if the download didn&rsquo;t start,
                  use Download again.
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => saveBlob(result.blob, result.filename)}
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Download again
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/[0.07] p-3.5 text-xs text-silver">
        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <div>
          Before transmitting: any attestation letters and the subcontractor
          statement included in the packet are generated as clean-history
          templates — an authorized officer must verify each statement is
          factually true, then sign and date them. The packet contains I-9
          images, SSN cards, and pay data for everyone in scope; send it only
          through the channel the requesting party specified.
        </div>
      </div>

      <AsOfRosterCard />
    </div>
  );
}

/* ----- Who was on the books on a day ------------------------------------- */

/** One person on GET /audit-packets/roster-as-of (apps/api/src/routes/auditPacket.ts). */
interface AsOfRosterRow {
  associateId: string;
  firstName: string;
  lastName: string;
  /** Where they stand today, and its English word (the CSV's Employment column). */
  workStatus: WorkStatus;
  employment: string;
  hiredOn: string | null;
  separatedOn: string | null;
  section1On: string | null;
  section2On: string | null;
  eVerifyCaseNumber: string | null;
  eVerifyStatus: string | null;
  eVerifyStatusWords: string | null;
  workAuthEndsOn: string | null;
  /** Null while they still work here: the I-9 is kept for as long as they do. */
  retainUntil: string | null;
}

interface AsOfRosterResponse {
  date: string;
  generatedAt: string;
  total: number;
  stillEmployed: number;
  leftSince: number;
  noSection2: number;
  rows: AsOfRosterRow[];
}

const WHILE_EMPLOYED = 'While employed';

/**
 * "Who was on the books on this day" (owner, 2026-11-03), for an I-9
 * inspection notice: pick the day the notice names and get everyone
 * employed then — people who have left since included, with the day they
 * left — beside their I-9 Section 1 and 2 dates, E-Verify case, work
 * authorization end and how long their I-9 must be kept. The compliance
 * lists answer "who is here now"; this answers "who was here then". The
 * CSV is the list to hand over with the I-9s.
 */
function AsOfRosterCard() {
  const today = ymdLocal();
  const [day, setDay] = useState(today);
  // The roster loads when asked for, for the day asked; changing the day
  // afterwards doesn't refetch until Show is pressed again.
  const [asOf, setAsOf] = useState<string | null>(null);
  const roster = useQuery({
    queryKey: ['audit-roster-as-of', asOf],
    queryFn: () => apiFetch<AsOfRosterResponse>(`/audit-packets/roster-as-of?date=${asOf}`),
    enabled: asOf !== null,
    staleTime: 60_000,
  });
  const data = roster.data;

  const exportCsv = () => {
    if (!data) return;
    downloadCsv(`i9-roster-as-of-${data.date}.csv`, [
      [
        'Last name',
        'First name',
        'Employment (today)',
        'Hire date',
        'Separation date',
        'I-9 Section 1',
        'I-9 Section 2',
        'E-Verify case number',
        'E-Verify status',
        'Work authorization ends',
        'Keep I-9 until',
      ],
      ...data.rows.map((r) => [
        r.lastName,
        r.firstName,
        r.employment,
        r.hiredOn,
        r.separatedOn,
        r.section1On,
        r.section2On,
        r.eVerifyCaseNumber,
        r.eVerifyStatusWords,
        r.workAuthEndsOn,
        r.retainUntil ?? WHILE_EMPLOYED,
      ]),
    ]);
  };

  return (
    <Card>
      <CardContent className="space-y-4">
        <div>
          <div className="text-sm font-medium text-ink">Who was on the books on a day</div>
          <p className="mt-1 text-xs text-silver">
            For an I-9 inspection notice: everyone employed on the day you pick, including people
            who have left since, with their I-9 dates, E-Verify case and how long their I-9 must be
            kept. Download it as a CSV to hand over with the forms.
          </p>
        </div>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (day) setAsOf(day);
          }}
        >
          <div>
            <Label htmlFor="audit-roster-day">On the books on</Label>
            <div className="mt-1">
              <DateField id="audit-roster-day" value={day} max={today} clearable={false} onChange={setDay} />
            </div>
          </div>
          <Button type="submit" variant="outline" disabled={!day || day > today}>
            <CalendarDays className="mr-2 h-4 w-4" />
            Show who was on the books
          </Button>
          {data && (
            <Button type="button" variant="outline" onClick={exportCsv} disabled={data.rows.length === 0}>
              <Download className="mr-2 h-4 w-4" />
              Download CSV
            </Button>
          )}
        </form>

        {roster.isError && (
          <ErrorBanner>
            {roster.error instanceof ApiError ? roster.error.message : 'Could not load the roster. Try again.'}
          </ErrorBanner>
        )}
        {roster.isFetching && !data && <SkeletonRows count={4} rowHeight="h-9" />}
        {data && (
          <div className="space-y-3">
            <p className="text-xs text-silver" data-testid="audit-roster-summary">
              <strong className="text-ink">
                {data.total} {data.total === 1 ? 'person was' : 'people were'} on the books on{' '}
                {fmtDateOnly(data.date)}
              </strong>
              {data.total > 0 && (
                <>
                  {' '}— {data.stillEmployed} still employed, {data.leftSince} left since.
                  {data.noSection2 > 0 &&
                    ` ${data.noSection2} ${data.noSection2 === 1 ? 'has' : 'have'} no I-9 Section 2 on file.`}
                </>
              )}
            </p>
            {data.rows.length === 0 ? (
              <EmptyState
                size="sm"
                title="Nobody was on the books that day"
                description="Pick a later day, or check the hire dates on People."
              />
            ) : (
              <div className="max-h-[28rem] overflow-y-auto rounded-lg border border-navy-secondary">
                <Table caption={`Who was on the books on ${fmtDateOnly(data.date)}`}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Employment today</TableHead>
                      <TableHead>Hired</TableHead>
                      <TableHead>Left</TableHead>
                      <TableHead>I-9 Section 1</TableHead>
                      <TableHead>I-9 Section 2</TableHead>
                      <TableHead>E-Verify</TableHead>
                      <TableHead>Work authorization ends</TableHead>
                      <TableHead>Keep I-9 until</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.rows.map((r) => (
                      <TableRow key={r.associateId}>
                        <TableCell className="whitespace-nowrap text-ink">
                          {r.lastName}, {r.firstName}
                        </TableCell>
                        <TableCell>
                          <PeopleStatusBadge status={r.workStatus} />
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">{fmtDateOnly(r.hiredOn)}</TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">{r.separatedOn ? fmtDateOnly(r.separatedOn) : '—'}</TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">{fmtDateOnly(r.section1On)}</TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">
                          {r.section2On ? fmtDateOnly(r.section2On) : <span className="text-warning">Not on file</span>}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          {r.eVerifyCaseNumber ? (
                            <>
                              <span className="tabular-nums">{r.eVerifyCaseNumber}</span>
                              {r.eVerifyStatusWords && <span className="block text-2xs text-silver">{r.eVerifyStatusWords}</span>}
                            </>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">{fmtDateOnly(r.workAuthEndsOn)}</TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums">
                          {r.retainUntil ? fmtDateOnly(r.retainUntil) : WHILE_EMPLOYED}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
