import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Send, X as XIcon } from 'lucide-react';
import { toast } from 'sonner';
import type {
  BulkInviteApplicant,
  BulkInviteResultRow,
  ClientSummary,
  LocationSummary,
  EmploymentType,
  OnboardingTemplate,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { bulkInvite, listClients, listInviteLocations, listTemplates } from '@/lib/onboardingApi';
import { Button } from '@/components/ui/Button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/cn';

const TRACK_LABEL: Record<string, string> = {
  STANDARD: 'Standard',
  J1: 'J-1',
  CLIENT_SPECIFIC: 'Client-specific',
};

interface ParsedRow {
  raw: string;
  email: string | null;
  firstName: string;
  lastName: string;
  /** Optional per-row position (4th column). */
  position?: string;
  /** Optional per-row start date, YYYY-MM-DD (5th column). */
  startDate?: string;
  /** Reason this row is invalid; null = ok. */
  error: string | null;
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RX = /^\d{4}-\d{2}-\d{2}$/;

/** Strict YYYY-MM-DD calendar check — the shape alone lets 2026-02-30 through. */
function isValidYmd(s: string): boolean {
  if (!DATE_RX.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Parse one row of the paste box. Supports:
 *   - "alice@example.com"
 *   - "alice@example.com,Alice,Hart"
 *   - "alice@example.com,Alice,Hart,Line cook"
 *   - "alice@example.com,Alice,Hart,Line cook,2026-08-01"
 *   - "Alice Hart <alice@example.com>"
 *   - "Alice Hart, alice@example.com"
 * The local-part of the email is the fallback when no name is given.
 * A trailing YYYY-MM-DD column is always the start date, so the position
 * column can be omitted ("email,first,last,2026-08-01" works too).
 */
function parseRow(line: string): ParsedRow {
  const raw = line.trim();
  if (!raw) {
    return { raw, email: null, firstName: '', lastName: '', error: 'empty' };
  }

  // Strip "Name <email>" form
  const angle = /^(.*?)<\s*([^>]+?)\s*>\s*$/.exec(raw);
  if (angle) {
    const name = angle[1].trim().replace(/[",]/g, '').trim();
    const email = angle[2].trim().toLowerCase();
    if (!EMAIL_RX.test(email)) {
      return { raw, email, firstName: '', lastName: '', error: 'invalid email' };
    }
    const parts = name.split(/\s+/).filter(Boolean);
    return {
      raw,
      email,
      firstName: parts[0] || email.split('@')[0],
      lastName: parts.slice(1).join(' ') || '—',
      error: null,
    };
  }

  // CSV / TSV / pipe / semicolon-separated
  const cols = raw
    .split(/[,;|\t]/)
    .map((s) => s.trim())
    .filter(Boolean);
  let email: string | undefined;
  let firstName = '';
  let lastName = '';
  let position: string | undefined;
  let startDate: string | undefined;

  for (const c of cols) {
    if (!email && EMAIL_RX.test(c)) {
      email = c.toLowerCase();
    }
  }
  // Everything that isn't the email: first, last, [position], [start date].
  let nameCols = cols.filter((c) => !EMAIL_RX.test(c));

  // A trailing date-shaped column is the start date, wherever the row
  // stopped ("email,first,last,2026-08-01" — position omitted — works).
  const tail = nameCols[nameCols.length - 1];
  if (tail !== undefined && DATE_RX.test(tail)) {
    if (!isValidYmd(tail)) {
      return {
        raw,
        email: email ?? null,
        firstName,
        lastName,
        error: 'invalid start date (use YYYY-MM-DD)',
      };
    }
    startDate = tail;
    nameCols = nameCols.slice(0, -1);
  } else if (nameCols.length >= 4) {
    // Five columns pasted but the 5th isn't a date.
    return {
      raw,
      email: email ?? null,
      firstName,
      lastName,
      error: 'invalid start date (use YYYY-MM-DD)',
    };
  }

  if (nameCols.length === 1) {
    const parts = nameCols[0].split(/\s+/).filter(Boolean);
    firstName = parts[0] ?? '';
    lastName = parts.slice(1).join(' ');
  } else if (nameCols.length >= 2) {
    firstName = nameCols[0];
    lastName = nameCols[1];
    position = nameCols.slice(2).join(' ') || undefined;
  }

  if (!email) {
    return { raw, email: null, firstName, lastName, error: 'no email' };
  }
  if (!firstName) firstName = email.split('@')[0];
  if (!lastName) lastName = '—';

  return { raw, email, firstName, lastName, position, startDate, error: null };
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Called after at least one applicant succeeded so the parent refetches. */
  onCreated: () => void;
}

/**
 * HR pastes a list of emails (one per line) → picks one client / template /
 * employment type that applies to the whole batch → POST /applications/bulk.
 * Per-row failures (duplicate ACTIVE, etc.) are surfaced in a result table
 * after submit; HR can fix the source list and re-run on just the failed ones.
 */
export function BulkInviteDialog({ open, onOpenChange, onCreated }: Props) {
  const [clients, setClients] = useState<ClientSummary[] | null>(null);
  const [templates, setTemplates] = useState<OnboardingTemplate[] | null>(null);
  const [clientId, setClientId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [locations, setLocations] = useState<LocationSummary[] | null>(null);
  const [templateId, setTemplateId] = useState('');
  const [employmentType, setEmploymentType] = useState<EmploymentType>('W2_EMPLOYEE');
  const [paste, setPaste] = useState('');
  // "Apply to all" fallbacks — used for rows that didn't carry their own
  // position / start-date column.
  const [defaultPosition, setDefaultPosition] = useState('');
  const [defaultStartDate, setDefaultStartDate] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<BulkInviteResultRow[] | null>(null);

  const reset = () => {
    setClientId('');
    setLocationId('');
    setTemplateId('');
    setEmploymentType('W2_EMPLOYEE');
    setPaste('');
    setDefaultPosition('');
    setDefaultStartDate('');
    setResults(null);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (!clients) {
      listClients()
        .then((r) => {
          if (cancelled) return;
          setClients(r.clients);
          // Client-bounded callers (SHIFT_SUPERVISOR) only ever get their own
          // client back from the scoped list — don't make them answer a
          // question with one possible answer. The server clamps this anyway.
          if (r.clients.length === 1) setClientId(r.clients[0].id);
        })
        .catch(() => !cancelled && setClients([]));
    }
    if (!templates) {
      listTemplates()
        .then((r) => !cancelled && setTemplates(r.templates))
        .catch(() => !cancelled && setTemplates([]));
    }
    return () => {
      cancelled = true;
    };
  }, [open, clients, templates]);

  // Work-site picker for the batch. Loads via the invite-scoped endpoint
  // (supervisors have no view:clients). Required when the client has sites —
  // a location-less invite leaves the associate's site unrecorded forever.
  useEffect(() => {
    setLocationId('');
    if (!clientId || !open) {
      setLocations(null);
      return;
    }
    let cancelled = false;
    setLocations(null);
    listInviteLocations(clientId)
      .then((r) => {
        if (cancelled) return;
        setLocations(r.locations);
        // One possible answer — don't make them pick it.
        if (r.locations.length === 1) setLocationId(r.locations[0].id);
      })
      .catch(() => !cancelled && setLocations([]));
    return () => {
      cancelled = true;
    };
  }, [clientId, open]);

  const visibleTemplates = useMemo(() => {
    if (!templates) return [];
    if (!clientId) return templates;
    return templates.filter((t) => t.clientId === null || t.clientId === clientId);
  }, [templates, clientId]);

  useEffect(() => {
    if (templateId && !visibleTemplates.some((t) => t.id === templateId)) {
      setTemplateId('');
    }
  }, [visibleTemplates, templateId]);

  // Parse the paste box live. De-dup by email so the same address pasted
  // twice doesn't double-invite.
  const parsed = useMemo(() => {
    const lines = paste.split(/\r?\n/);
    const rows = lines.map(parseRow).filter((r) => r.raw.length > 0);
    const seen = new Set<string>();
    return rows.map((r) => {
      if (r.email && seen.has(r.email)) {
        return { ...r, error: r.error ?? 'duplicate in paste' };
      }
      if (r.email) seen.add(r.email);
      return r;
    });
  }, [paste]);

  const validRows = parsed.filter((r) => r.error === null && r.email);
  const invalidRows = parsed.filter((r) => r.error !== null);

  const submit = async () => {
    if (!clientId) {
      toast.error('Pick a client.');
      return;
    }
    if (!templateId) {
      toast.error('Pick a template.');
      return;
    }
    if (!locationId && locations && locations.length > 0) {
      toast.error('Pick a work site — this client has locations configured.');
      return;
    }
    if (validRows.length === 0) {
      toast.error('Paste at least one valid email.');
      return;
    }
    setSubmitting(true);
    try {
      const applicants: BulkInviteApplicant[] = validRows.map((r) => {
        // Per-row values win; the "apply to all" fields fill the gaps.
        const position = r.position ?? (defaultPosition.trim() || undefined);
        const ymd = r.startDate ?? (defaultStartDate || undefined);
        return {
          email: r.email!,
          firstName: r.firstName,
          lastName: r.lastName,
          ...(position ? { position } : {}),
          // Contract wants a full ISO datetime — same midnight-UTC
          // convention as the single-invite dialog.
          ...(ymd
            ? { startDate: new Date(`${ymd}T00:00:00.000Z`).toISOString() }
            : {}),
        };
      });
      const res = await bulkInvite({
        clientId,
        templateId,
        employmentType,
        ...(locationId ? { locationId } : {}),
        applicants,
      });
      setResults(res.results);
      if (res.succeeded > 0) onCreated();
      if (res.failed === 0) {
        toast.success(`Invited ${res.succeeded} applicant${res.succeeded === 1 ? '' : 's'}.`);
      } else if (res.succeeded === 0) {
        toast.error(`All ${res.failed} invites failed.`);
      } else {
        toast.message(`Invited ${res.succeeded}, ${res.failed} failed.`, {
          description: 'Check the result list and retry the failed rows.',
        });
      }
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Bulk invite failed.';
      toast.error('Could not bulk invite.', { description: msg });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bulk invite applicants</DialogTitle>
          <DialogDescription>
            Paste a list of emails (one per line). Same client, template, and
            employment type apply to every row; position and start date can be
            set per row or once for the whole batch.
          </DialogDescription>
        </DialogHeader>

        {results ? (
          <BulkResultsPanel results={results} />
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Client" required>
                {(p) => (
                  <Select
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    disabled={clients === null}
                    {...p}
                  >
                    <option value="">
                      {clients === null ? 'Loading…' : 'Pick a client'}
                    </option>
                    {clients?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.state ? ` · ${c.state}` : ''}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Template" required>
                {(p) => (
                  <Select
                    value={templateId}
                    onChange={(e) => setTemplateId(e.target.value)}
                    disabled={templates === null || !clientId}
                    {...p}
                  >
                    <option value="">
                      {!clientId
                        ? 'Pick client first'
                        : templates === null
                          ? 'Loading…'
                          : visibleTemplates.length === 0
                            ? 'No templates'
                            : 'Pick a template'}
                    </option>
                    {visibleTemplates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} · {TRACK_LABEL[t.track] ?? t.track}
                        {t.clientId === null ? ' (global)' : ''}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field
                label={locations && locations.length > 0 ? 'Work site (required)' : 'Work site'}
              >
                {(p) => (
                  <Select
                    value={locationId}
                    onChange={(e) => setLocationId(e.target.value)}
                    disabled={!clientId || locations === null || locations.length === 0}
                    {...p}
                  >
                    <option value="">
                      {!clientId
                        ? 'Pick client first'
                        : locations === null
                          ? 'Loading…'
                          : locations.length === 0
                            ? 'No sites under this client'
                            : 'Pick a work site…'}
                    </option>
                    {locations?.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                        {l.state ? ` · ${l.state}` : ''}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>

            <Field label="Employment type">
              {(p) => (
                <Select
                  value={employmentType}
                  onChange={(e) => setEmploymentType(e.target.value as EmploymentType)}
                  {...p}
                >
                  <option value="W2_EMPLOYEE">W-2 employee</option>
                  <option value="CONTRACTOR_1099_INDIVIDUAL">1099 contractor (individual)</option>
                  <option value="CONTRACTOR_1099_BUSINESS">1099 contractor (business)</option>
                </Select>
              )}
            </Field>

            <Field
              label="Applicants"
              required
              hint={
                <>
                  Accepts plain email, &ldquo;email,first,last&rdquo;,
                  &ldquo;email,first,last,position,start date&rdquo; (start
                  date as YYYY-MM-DD; either of the last two columns can be
                  omitted), or &ldquo;Name &lt;email&gt;&rdquo;. Up to 200
                  rows. Names default to the email local-part if missing.
                </>
              }
            >
              {(p) => (
                <Textarea
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  rows={8}
                  placeholder={[
                    'alice@example.com',
                    'bob@example.com,Bob,Smith',
                    'dana@example.com,Dana,Lee,Line cook,2026-08-01',
                    'Carol Diaz <carol@example.com>',
                  ].join('\n')}
                  className="font-mono"
                  {...p}
                />
              )}
            </Field>

            {/* Batch-wide fallbacks for rows that didn't specify their own. */}
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Position (apply to all)"
                hint="Used for rows without their own position column."
              >
                {(p) => (
                  <Input
                    value={defaultPosition}
                    onChange={(e) => setDefaultPosition(e.target.value)}
                    maxLength={120}
                    placeholder="e.g. Line cook"
                    {...p}
                  />
                )}
              </Field>
              <Field
                label="Start date (apply to all)"
                hint="Used for rows without their own start-date column."
              >
                {(p) => (
                  <Input
                    type="date"
                    value={defaultStartDate}
                    onChange={(e) => setDefaultStartDate(e.target.value)}
                    {...p}
                  />
                )}
              </Field>
            </div>

            {parsed.length > 0 && (
              <div className="text-xs flex items-center gap-3">
                <span className="text-success">
                  <CheckCircle2 className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
                  {validRows.length} valid
                </span>
                {invalidRows.length > 0 && (
                  <span className="text-alert">
                    <XIcon className="inline h-3.5 w-3.5 mr-1 -mt-0.5" />
                    {invalidRows.length} invalid
                  </span>
                )}
              </div>
            )}

            {invalidRows.length > 0 && (
              <div className="rounded-md border border-alert/30 bg-alert/[0.06] p-2 max-h-32 overflow-auto text-xs">
                {invalidRows.slice(0, 8).map((r, i) => (
                  <div key={i} className="font-mono text-silver">
                    <span className="text-alert mr-2">{r.error}</span>
                    {r.raw.slice(0, 80)}
                  </div>
                ))}
                {invalidRows.length > 8 && (
                  <div className="text-silver/70 mt-1">
                    + {invalidRows.length - 8} more invalid rows
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {results ? (
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={submit}
                loading={submitting}
                disabled={validRows.length === 0 || !clientId || !templateId}
              >
                <Send className="h-4 w-4" />
                Send {validRows.length} invite{validRows.length === 1 ? '' : 's'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BulkResultsPanel({ results }: { results: BulkInviteResultRow[] }) {
  const failed = results.filter((r) => !r.ok);
  const succeeded = results.filter((r) => r.ok);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 text-sm">
        <span className="text-success">
          <CheckCircle2 className="inline h-4 w-4 mr-1 -mt-0.5" />
          {succeeded.length} succeeded
        </span>
        {failed.length > 0 && (
          <span className="text-alert">
            <XIcon className="inline h-4 w-4 mr-1 -mt-0.5" />
            {failed.length} failed
          </span>
        )}
      </div>
      <div className="rounded-md border border-navy-secondary divide-y divide-navy-secondary max-h-72 overflow-auto">
        {results.map((r, i) => (
          <div
            key={i}
            className={cn(
              'p-2 text-xs flex items-start gap-2',
              r.ok ? 'bg-success/[0.04]' : 'bg-alert/[0.06]'
            )}
          >
            {r.ok ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-success mt-0.5 shrink-0" />
            ) : (
              <XIcon className="h-3.5 w-3.5 text-alert mt-0.5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="font-mono text-silver truncate">{r.email}</div>
              {!r.ok && r.errorMessage && (
                <div className="text-alert mt-0.5">
                  {r.errorCode}: {r.errorMessage}
                </div>
              )}
              {r.ok && r.inviteUrl && (
                <div className="text-silver/70 mt-0.5 truncate font-mono">
                  {r.inviteUrl}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
