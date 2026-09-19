import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, History as HistoryIcon } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError, apiFetch } from '@/lib/api';
import { fmtMoney } from '@/lib/format';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Skeleton,
} from '@/components/ui';
import { CopyValue } from '../time/FieldglassDesk';

/**
 * The Fieldglass registration packet on the finance worklist — what the
 * buyer's "new SOW worker" form asks for, in its order, each value one tap
 * to copy, dates the way Fieldglass writes them (MM/DD/YYYY). What's
 * missing is said first, so the form never stalls halfway.
 */

export interface FieldglassPacket {
  associateId: string;
  worker: {
    firstName: string;
    middleInitial: string | null;
    lastName: string;
    listName: string;
    email: string;
    phone: string | null;
    dob: string | null;
    ssnLast4: string | null;
    travelDocLast4: string | null;
    securityId: { value: string | null; source: 'ssn' | 'travel_doc' | null; needs: string[] };
    address: { line1: string; line2: string | null; city: string; state: string; zip: string } | null;
  };
  engagement: {
    clientId: string | null;
    clientName: string | null;
    site: string | null;
    billRate: number | null;
    position: string | null;
    shift: { label: string | null; start: string; end: string } | null;
    firstShiftAt: string | null;
    startDate: string | null;
    firstClockIn: { at: string; date: string; time: string } | null;
    store: { name: string; address: string | null } | null;
    siteManager: { name: string; email: string } | null;
  };
  screening: {
    backgroundCheck: { status: string; completedAt: string | null } | null;
    drugTest: { status: string; completedAt: string | null } | null;
    i9: { section1At: string | null; section2At: string | null } | null;
    eVerify: string | null;
  };
  registration: { workerId: string | null; addedAt: string; clientName: string | null } | null;
  separatedAt: string | null;
  missing: string[];
}

/** "2026-09-21" / an ISO instant → "09/21/2026", as Fieldglass writes dates. */
function usDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const [y, m, d] = v.slice(0, 10).split('-');
  return y && m && d ? `${m}/${d}/${y}` : null;
}

const cap = (s: string) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-0.5 text-2xs font-semibold uppercase tracking-wider text-silver/70">{title}</h4>
      <div className="divide-y divide-navy-secondary/50">{children}</div>
    </div>
  );
}

export function FieldglassPacketPanel({ associateId, kind }: { associateId: string; kind: 'add' | 'transfer' | 'close' }) {
  const q = useQuery({
    queryKey: ['finance', 'fieldglass', 'packet', associateId],
    queryFn: () => apiFetch<{ packet: FieldglassPacket }>(`/finance/fieldglass/${associateId}/packet`),
    staleTime: 60_000,
  });
  const p = q.data?.packet;
  if (q.isLoading) return <Skeleton className="h-48 w-full" />;
  if (!p) return <p className="text-xs text-alert">Couldn’t load their details.</p>;

  if (kind === 'close') {
    return (
      <div className="space-y-2">
        <Section title="Close in Fieldglass">
          <CopyValue label="Worker" value={p.worker.listName} />
          <CopyValue label="Worker ID" value={p.registration?.workerId ?? null} />
          <CopyValue label="Client" value={p.registration?.clientName ?? p.engagement.clientName} />
          <CopyValue label="End date" value={usDate(p.separatedAt)} />
        </Section>
      </div>
    );
  }

  const bg = p.screening.backgroundCheck;
  const drug = p.screening.drugTest;
  return (
    <div className="space-y-3">
      {p.missing.length > 0 && (
        <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            Fieldglass will ask for {p.missing.length === 1 ? 'something' : `${p.missing.length} things`} not on file yet:{' '}
            <span className="font-medium">{p.missing.join(' · ')}</span>
          </span>
        </div>
      )}
      <div className="grid gap-x-6 gap-y-3 lg:grid-cols-2">
        <Section title="Worker">
          <CopyValue label="Last name" value={p.worker.lastName} />
          <CopyValue label="First name" value={p.worker.firstName} />
          <CopyValue label="Middle initial" value={p.worker.middleInitial} />
          <CopyValue label="Email" value={p.worker.email} />
          <CopyValue label="Phone" value={p.worker.phone} />
          <CopyValue label="Date of birth" value={usDate(p.worker.dob)} />
          <CopyValue label="SSN (last 4)" value={p.worker.ssnLast4} mono />
          {!p.worker.ssnLast4 && <TravelDocField associateId={p.associateId} value={p.worker.travelDocLast4} />}
          <CopyValue label="Security ID" value={p.worker.securityId.value} mono />
          {p.worker.securityId.value ? (
            <p className="pb-1.5 text-right text-2xs text-silver/60">
              Birth MMDD + {p.worker.securityId.value.slice(4, 6)} + last 3 of{' '}
              {p.worker.securityId.source === 'travel_doc' ? 'the travel document' : 'the SSN'}
            </p>
          ) : (
            <p className="pb-1.5 text-right text-2xs text-warning">Needs {p.worker.securityId.needs.join(' and ').toLowerCase()}</p>
          )}
          <CopyValue label="Address" value={p.worker.address ? [p.worker.address.line1, p.worker.address.line2].filter(Boolean).join(', ') : null} />
          <CopyValue label="City" value={p.worker.address?.city ?? null} />
          <CopyValue label="State" value={p.worker.address?.state ?? null} />
          <CopyValue label="ZIP" value={p.worker.address?.zip ?? null} />
        </Section>
        <div className="space-y-3">
          <Section title="Engagement">
            <CopyValue label="Client" value={p.engagement.clientName} />
            <CopyValue label="Site" value={p.engagement.site} />
            <CopyValue label="Position" value={p.engagement.position} />
            <CopyValue
              label="Shift"
              value={
                p.engagement.shift
                  ? `${p.engagement.shift.label ? `${p.engagement.shift.label} · ` : ''}${p.engagement.shift.start} – ${p.engagement.shift.end}`
                  : null
              }
            />
            <CopyValue label="Start date" value={usDate(p.engagement.startDate)} />
            <CopyValue
              label="First clock-in"
              value={p.engagement.firstClockIn ? `${usDate(p.engagement.firstClockIn.date)} ${p.engagement.firstClockIn.time}` : null}
            />
            <CopyValue label="Bill rate" value={p.engagement.billRate !== null ? fmtMoney(p.engagement.billRate) : null} />
            <CopyValue label="Store" value={p.engagement.store ? p.engagement.store.name : null} />
            <CopyValue
              label="Site manager"
              value={
                p.engagement.siteManager
                  ? [p.engagement.siteManager.name, p.engagement.siteManager.email].filter(Boolean).join(' · ')
                  : null
              }
            />
          </Section>
          <Section title="Screening">
            <CopyValue
              label="Background check"
              value={bg ? `${cap(bg.status)}${bg.completedAt ? ` ${usDate(bg.completedAt)}` : ''}` : null}
            />
            <CopyValue
              label="Drug test"
              value={drug ? `${cap(drug.status)}${drug.completedAt ? ` ${usDate(drug.completedAt)}` : ''}` : null}
            />
            <CopyValue label="I-9 complete" value={usDate(p.screening.i9?.section2At)} />
            <CopyValue label="E-Verify" value={p.screening.eVerify ? cap(p.screening.eVerify) : null} />
          </Section>
          <Link
            to={`/time-attendance/timesheets/history/${p.associateId}`}
            className="inline-flex items-center gap-1 text-xs text-gold hover:underline"
          >
            <HistoryIcon className="h-3.5 w-3.5" aria-hidden="true" />
            Every timesheet, across pay periods
          </Link>
        </div>
      </div>
    </div>
  );
}

/** No SSN: the last 4 of their passport / travel document — what the
 *  Security ID ends in instead. */
function TravelDocField({ associateId, value }: { associateId: string; value: string | null }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(value ?? '');
  const [busy, setBusy] = useState(false);
  const clean = draft.trim().toUpperCase();
  const bad = clean !== '' && !/^[A-Z0-9]{3,4}$/.test(clean);
  const save = async () => {
    setBusy(true);
    try {
      await apiFetch(`/finance/fieldglass/${associateId}/travel-doc`, { method: 'PATCH', body: { last4: clean } });
      await qc.invalidateQueries({ queryKey: ['finance', 'fieldglass', 'packet', associateId] });
      toast.success(clean ? 'Travel document saved.' : 'Travel document cleared.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not save it.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex items-center justify-between gap-3 py-1.5 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        if (!bad) void save();
      }}
    >
      <label htmlFor={`travel-doc-${associateId}`} className="text-silver/70">
        Passport / travel doc (last 4)
      </label>
      <span className="flex items-center gap-1.5">
        <Input
          id={`travel-doc-${associateId}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={4}
          placeholder="—"
          aria-invalid={bad}
          className="h-8 w-20 text-center font-mono uppercase"
        />
        <Button type="submit" size="sm" variant="secondary" loading={busy} disabled={busy || bad || clean === (value ?? '')}>
          Save
        </Button>
      </span>
    </form>
  );
}

/** "Mark added" — with the Worker ID Fieldglass just gave them. */
export function MarkAddedDialog({
  name,
  busy,
  onConfirm,
  onClose,
}: {
  name: string;
  busy: boolean;
  onConfirm: (workerId: string | undefined) => void;
  onClose: () => void;
}) {
  const [workerId, setWorkerId] = useState('');
  const bad = workerId.trim() !== '' && !/^[A-Za-z0-9._-]+$/.test(workerId.trim());
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Added {name} to Fieldglass?</DialogTitle>
          <DialogDescription>
            Their Fieldglass Worker ID ties Alto’s hours to their account. Add it now, or later — importing the Fieldglass list fills it in
            too.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!bad) onConfirm(workerId.trim() || undefined);
          }}
        >
          <label className="block text-sm text-silver" htmlFor="fg-worker-id">
            Fieldglass Worker ID
          </label>
          <Input
            id="fg-worker-id"
            value={workerId}
            onChange={(e) => setWorkerId(e.target.value)}
            placeholder="e.g. WKR00012345"
            autoFocus
            className="mt-1 font-mono"
            aria-invalid={bad}
          />
          {bad && <p className="mt-1 text-xs text-alert">Letters, numbers and dashes only.</p>}
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={busy} disabled={busy || bad}>
              Mark added
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
