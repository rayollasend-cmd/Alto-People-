import { useState } from 'react';
import { FileArchive, ShieldAlert } from 'lucide-react';
import { useClients } from '@/lib/useClients';
import { ymdLocal } from '@/lib/format';
import {
  AssociatePicker,
  Button,
  Card,
  CardContent,
  ErrorBanner,
  Label,
  Select,
  Textarea,
  type PickedAssociate,
} from '@/components/ui';

type PacketScope = 'CLIENT_PERIOD' | 'ALL_WORKFORCE' | 'INDIVIDUAL';

const SCOPE_LABEL: Record<PacketScope, { label: string; blurb: string }> = {
  CLIENT_PERIOD: {
    label: 'Client audit',
    blurb: 'Workers tied to one client during the period — vendor-compliance audits (e.g. Walmart).',
  },
  ALL_WORKFORCE: {
    label: 'Entire workforce',
    blurb: 'Everyone who has ever worked for us, current and separated — DOL / ICE / insurance audits. The period bounds the pay and time sections.',
  },
  INDIVIDUAL: {
    label: 'Individual associate',
    blurb: 'One associate\'s complete evidence file — wage claims, subpoenas, single-associate I-9 requests.',
  },
};

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
  const [scope, setScope] = useState<PacketScope>('CLIENT_PERIOD');
  const [clientId, setClientId] = useState('');
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);
  const [workforceConfirmed, setWorkforceConfirmed] = useState(false);
  const today = ymdLocal();
  const yearAgo = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return ymdLocal(d);
  })();
  const [periodStart, setPeriodStart] = useState(yearAgo);
  const [periodEnd, setPeriodEnd] = useState(today);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = async () => {
    setError(null);
    if (scope === 'CLIENT_PERIOD' && !clientId) {
      setError('Pick the auditing client.');
      return;
    }
    if (scope === 'INDIVIDUAL' && !associate) {
      setError('Pick the associate to audit.');
      return;
    }
    if (scope === 'ALL_WORKFORCE' && !workforceConfirmed) {
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
      // apiFetch JSON-parses responses; this endpoint streams a ZIP, so
      // hit fetch directly and hand the blob to the browser.
      const res = await fetch('/api/audit-packets/generate', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope,
          ...(scope === 'CLIENT_PERIOD' ? { clientId } : {}),
          ...(scope === 'INDIVIDUAL' ? { associateId: associate!.id } : {}),
          periodStart,
          periodEnd,
          reason: reason.trim(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? `Packet generation failed (${res.status}).`);
      }
      const blob = await res.blob();
      const disposition = res.headers.get('Content-Disposition') ?? '';
      const match = /filename="([^"]+)"/.exec(disposition);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = match?.[1] ?? `audit-packet-${periodStart}-to-${periodEnd}.zip`;
      a.click();
      URL.revokeObjectURL(a.href);
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
        <CardContent className="space-y-4 p-5">
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

          {scope === 'CLIENT_PERIOD' && (
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

          {scope === 'ALL_WORKFORCE' && (
            <label className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/[0.07] p-3 text-xs text-silver">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={workforceConfirmed}
                onChange={(e) => setWorkforceConfirmed(e.target.checked)}
              />
              <span>
                I understand this exports the I-9 records, identity documents,
                and pay data of <strong className="text-white">every worker the
                company has ever employed</strong> in a single file, and that
                this action is permanently recorded in the critical audit log.
              </span>
            </label>
          )}

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
            <Label htmlFor="audit-reason">Reason for export</Label>
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
    </div>
  );
}
