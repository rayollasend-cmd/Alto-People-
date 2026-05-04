import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Send, X as XIcon } from 'lucide-react';
import { toast } from 'sonner';
import type {
  BulkInviteApplicant,
  BulkInviteResultRow,
  ClientSummary,
  EmploymentType,
  OnboardingTemplate,
} from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { bulkInvite, listClients, listTemplates } from '@/lib/onboardingApi';
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
import { Select } from '@/components/ui/Select';
import { cn } from '@/lib/cn';

const TRACK_LABEL: Record<string, string> = {
  STANDARD: 'Standard',
  J1: 'J-1',
  CLIENT_SPECIFIC: 'Client-specific',
};

const TEXTAREA_CX =
  'w-full rounded-md border border-navy-secondary bg-navy-secondary/40 text-white px-3 py-2 text-sm font-mono ' +
  'focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold';

interface ParsedRow {
  raw: string;
  email: string | null;
  firstName: string;
  lastName: string;
  /** Reason this row is invalid; null = ok. */
  error: string | null;
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Parse one row of the paste box. Supports:
 *   - "alice@example.com"
 *   - "alice@example.com,Alice,Hart"
 *   - "Alice Hart <alice@example.com>"
 *   - "Alice Hart, alice@example.com"
 * The local-part of the email is the fallback when no name is given.
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

  for (const c of cols) {
    if (!email && EMAIL_RX.test(c)) {
      email = c.toLowerCase();
    }
  }
  // Names = the non-email columns, in order.
  const nonEmail = cols.filter((c) => !EMAIL_RX.test(c));
  if (nonEmail.length === 1) {
    const parts = nonEmail[0].split(/\s+/).filter(Boolean);
    firstName = parts[0] ?? '';
    lastName = parts.slice(1).join(' ');
  } else if (nonEmail.length >= 2) {
    firstName = nonEmail[0];
    lastName = nonEmail.slice(1).join(' ');
  }

  if (!email) {
    return { raw, email: null, firstName, lastName, error: 'no email' };
  }
  if (!firstName) firstName = email.split('@')[0];
  if (!lastName) lastName = '—';

  return { raw, email, firstName, lastName, error: null };
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
  const [templateId, setTemplateId] = useState('');
  const [employmentType, setEmploymentType] = useState<EmploymentType>('W2_EMPLOYEE');
  const [paste, setPaste] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<BulkInviteResultRow[] | null>(null);

  const reset = () => {
    setClientId('');
    setTemplateId('');
    setEmploymentType('W2_EMPLOYEE');
    setPaste('');
    setResults(null);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (!clients) {
      listClients()
        .then((r) => !cancelled && setClients(r.clients))
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
      toast.error('Pick a client');
      return;
    }
    if (!templateId) {
      toast.error('Pick a template');
      return;
    }
    if (validRows.length === 0) {
      toast.error('Paste at least one valid email');
      return;
    }
    setSubmitting(true);
    try {
      const applicants: BulkInviteApplicant[] = validRows.map((r) => ({
        email: r.email!,
        firstName: r.firstName,
        lastName: r.lastName,
      }));
      const res = await bulkInvite({
        clientId,
        templateId,
        employmentType,
        applicants,
      });
      setResults(res.results);
      if (res.succeeded > 0) onCreated();
      if (res.failed === 0) {
        toast.success(`Invited ${res.succeeded} applicant${res.succeeded === 1 ? '' : 's'}`);
      } else if (res.succeeded === 0) {
        toast.error(`All ${res.failed} invites failed`);
      } else {
        toast.message(`Invited ${res.succeeded}, ${res.failed} failed`, {
          description: 'Check the result list and retry the failed rows.',
        });
      }
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Bulk invite failed';
      toast.error('Could not bulk invite', { description: msg });
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
            employment type apply to every row.
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
                  Accepts plain email, &ldquo;email,first,last&rdquo;, or
                  &ldquo;Name &lt;email&gt;&rdquo;. Up to 200 rows. Names
                  default to the email local-part if missing.
                </>
              }
            >
              {(p) => (
                <textarea
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  rows={8}
                  placeholder={[
                    'alice@example.com',
                    'bob@example.com,Bob,Smith',
                    'Carol Diaz <carol@example.com>',
                  ].join('\n')}
                  className={TEXTAREA_CX}
                  {...p}
                />
              )}
            </Field>

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
                  <div className="text-silver/60 mt-1">
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
                <div className="text-silver/60 mt-0.5 truncate font-mono">
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
