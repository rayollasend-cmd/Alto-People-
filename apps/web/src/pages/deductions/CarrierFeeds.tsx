import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, FileText, Plus, Send } from 'lucide-react';
import {
  createCarrier,
  download834,
  linkCarrierPlans,
  list834,
  listCarriers,
  make834,
  saveCarrierConnection,
  send834,
  updateCarrier,
  type Carrier,
  type CarrierFeedHealth,
  type CarrierInput,
  type CarrierPlan,
  type Edi834File,
} from '@/lib/deductionsApi';
import { fmtDate } from '@/lib/format';
import { useUrlParam } from '@/lib/useUrlState';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid } from '@/components/ui/DataGrid';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';

/**
 * Carrier feeds: each insurance carrier and the enrollment files (EDI 834)
 * sent to it. A full file lists everyone covered; a change file lists only
 * additions, ends and changes since the last one.
 *
 * The page leads with how each feed is doing — who is in it, what is
 * waiting for the next file, the last file and whether it was delivered —
 * and keeps the setup (IDs, the SFTP connection) in the carrier's edit
 * dialog, read before edit.
 */

const LINE_LABEL: Record<string, string> = { HLT: 'Medical', DEN: 'Dental', VIS: 'Vision', LIF: 'Life', LTD: 'Long-term disability', STD: 'Short-term disability', AG: 'Accidental death', ADD: 'AD&D' };

/** Editing a carrier, or adding one; `connection` opens straight onto its delivery settings. */
type Editing = { carrier: Carrier | null; connection?: boolean };

/** "Delivery: SFTP, not connected" — how files reach the carrier, in one read. */
export function deliveryWords(c: Pick<Carrier, 'transport' | 'connection'>): { text: string; needsSetup: boolean } {
  if (c.transport === 'DOWNLOAD') return { text: 'Delivery: download and upload by hand', needsSetup: false };
  const how = c.transport === 'SFTP' ? 'SFTP' : 'secure upload';
  if (!c.connection.hasSecret) return { text: `Delivery: ${how}, not connected`, needsSetup: true };
  const where = c.transport === 'SFTP' ? c.connection.host : c.connection.baseUrl;
  return { text: `Delivery: ${how}${where ? ` to ${where}` : ''}`, needsSetup: false };
}

/** The last file's delivery, plainly: sent, failed (with why), or made and not sent. */
export function deliveryResult(f: NonNullable<CarrierFeedHealth['lastFile']>): { label: string; tone: 'good' | 'alert' | 'warning' } {
  if (f.status === 'SENT') return { label: 'Sent', tone: 'good' };
  if (f.status === 'FAILED') return { label: 'Failed', tone: 'alert' };
  return { label: 'Made, not sent', tone: 'warning' };
}

export function CarrierFeeds() {
  const q = useQuery({ queryKey: ['carriers'], queryFn: listCarriers });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [picked, setPicked] = useUrlParam<string>('carrier', '');
  const carriers = q.data?.carriers ?? [];
  const carrier = carriers.find((c) => c.id === picked) ?? carriers[0] ?? null;
  return (
    <ListTemplate
      title="Carrier feeds"
      subtitle="Enrollment files for each insurance carrier, made from benefit elections, covered dependents and life events."
      actions={[{ label: 'Add a carrier', icon: Plus, primary: carriers.length === 0, onSelect: () => setEditing({ carrier: null }) }]}
    >
      {q.isError ? (
        <QueryError what="carriers" query={q} />
      ) : q.isLoading ? (
        <SkeletonRows count={5} />
      ) : !carrier ? (
        <EmptyState icon={Send} title="No carriers yet" description="Add each insurer you send enrollments to, with the IDs from its EDI setup form." action={<Button onClick={() => setEditing({ carrier: null })}>Add a carrier</Button>} />
      ) : (
        <div className="space-y-4">
          {carriers.length > 1 && <FeedsGrid carriers={carriers} selectedId={carrier.id} onPick={(id) => setPicked(id === carriers[0]?.id ? '' : id)} />}
          <CarrierView carrier={carrier} allPlans={q.data?.plans ?? []} onEdit={(connection) => setEditing({ carrier, connection })} />
        </div>
      )}
      {editing && <CarrierDialog carrier={editing.carrier} focusConnection={!!editing.connection} onClose={() => setEditing(null)} />}
    </ListTemplate>
  );
}

/** Every feed at once (two or more carriers): who's in it, what's waiting, the last file and its delivery. */
function FeedsGrid({ carriers, selectedId, onPick }: { carriers: Carrier[]; selectedId: string; onPick: (id: string) => void }) {
  return (
    <DataGrid<Carrier>
      id="carrier-feeds"
      caption="Feeds"
      rows={carriers}
      rowKey={(c) => c.id}
      noun={{ one: 'carrier', many: 'carriers' }}
      search={false}
      exportCsv={false}
      onRowClick={(c) => onPick(c.id)}
      rowActionLabel={(c) => `Open ${c.name}`}
      columns={[
        { key: 'name', header: 'Carrier', primary: true, sortable: true, accessor: (c) => c.name, cell: (c) => <span className={c.id === selectedId ? 'font-medium text-gold' : 'font-medium text-ink'}>{c.name}</span> },
        { key: 'people', header: 'People', align: 'right', searchable: false, className: 'tabular-nums', accessor: (c) => c.health?.people ?? 0 },
        { key: 'waiting', header: 'Changes waiting', align: 'right', searchable: false, className: 'tabular-nums', accessor: (c) => c.health?.changesWaiting ?? -1, cell: (c) => (c.health?.changesWaiting == null ? '—' : c.health.changesWaiting) },
        { key: 'last', header: 'Last file', cardMeta: true, accessor: (c) => c.health?.lastFile?.createdAt ?? '', cell: (c) => (c.health?.lastFile ? `${fmtDate(c.health.lastFile.createdAt)} · ${c.health.lastFile.mode === 'FULL' ? 'full' : 'changes'}` : 'None yet') },
        {
          key: 'delivery',
          header: 'Delivery',
          accessor: (c) => c.health?.lastFile?.status ?? '',
          cell: (c) => {
            const f = c.health?.lastFile;
            if (!f) return <span className="text-ink-muted">—</span>;
            const r = deliveryResult(f);
            return <Badge size="sm" variant={r.tone === 'good' ? 'success' : r.tone === 'alert' ? 'destructive' : 'pending'}>{r.label}</Badge>;
          },
        },
      ]}
    />
  );
}

function CarrierView({ carrier, allPlans, onEdit }: { carrier: Carrier; allPlans: CarrierPlan[]; onEdit: (connection?: boolean) => void }) {
  const qc = useQueryClient();
  const files = useQuery({ queryKey: ['carriers', 'files', carrier.id], queryFn: () => list834(carrier.id) });
  const [linking, setLinking] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const make = useMutation({
    mutationFn: (mode: 'FULL' | 'CHANGE') => make834(carrier.id, mode),
    onSuccess: (r) => {
      setExcluded(r.excluded);
      if (r.file) toast.success(`${r.file.mode === 'FULL' ? 'Full' : 'Change'} enrollment file made with ${r.file.memberCount} ${r.file.memberCount === 1 ? 'member' : 'members'}.`);
      else toast.success(r.message ?? 'Nothing to send.');
      void qc.invalidateQueries({ queryKey: ['carriers'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const send = useMutation({
    mutationFn: send834,
    onSuccess: () => {
      toast.success('Sent to the carrier.');
      void qc.invalidateQueries({ queryKey: ['carriers'] });
    },
    onError: (e: Error) => {
      toast.error(e.message);
      void qc.invalidateQueries({ queryKey: ['carriers', 'files', carrier.id] });
    },
  });
  const delivery = deliveryWords(carrier);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="flex flex-wrap items-center gap-2">
              {carrier.name}
              <Badge variant={carrier.usageIndicator === 'P' ? 'success' : 'pending'}>{carrier.usageIndicator === 'P' ? 'Production' : 'Testing'}</Badge>
            </CardTitle>
            <CardDescription>
              {carrier.policyNumber ? `Group ${carrier.policyNumber} · ` : ''}
              {delivery.text}
              {delivery.needsSetup && (
                <>
                  {' · '}
                  <button type="button" className="text-gold underline-offset-2 hover:underline" onClick={() => onEdit(true)}>
                    Set up
                  </button>
                </>
              )}
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => onEdit()}>Edit carrier</Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <FeedHealthStrip health={carrier.health} />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-ink">Plans in this feed</p>
            <Button size="sm" variant="ghost" onClick={() => setLinking(true)}>Choose plans</Button>
          </div>
          {carrier.plans.length === 0 ? (
            <p className="text-sm text-ink-muted">No plans yet. Choose which benefit plans this carrier insures.</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {carrier.plans.map((p) => (
                <li key={p.id}>
                  <Badge variant="outline">{`${p.name} · ${LINE_LABEL[p.insuranceLineCode ?? ''] ?? p.insuranceLineCode ?? 'Medical'}${p.carrierPlanCode ? ` · ${p.carrierPlanCode}` : ''}`}</Badge>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button onClick={() => make.mutate('CHANGE')} loading={make.isPending && make.variables === 'CHANGE'} disabled={!carrier.plans.length}>Make a change file</Button>
            <Button variant="outline" onClick={() => make.mutate('FULL')} loading={make.isPending && make.variables === 'FULL'} disabled={!carrier.plans.length}>Make a full file</Button>
          </div>
          <p className="text-xs text-ink-muted">{carrier.lastFile ? `Last file ${fmtDate(carrier.lastFile.createdAt)}. A change file covers what changed since then.` : 'Start with a full file; after that, change files carry only what changed.'}</p>
          {excluded.length > 0 && (
            <div className="rounded-md border border-warning/30 bg-warning/5 p-3 text-sm">
              <p className="font-medium text-ink">{`${excluded.length} left out of the file`}</p>
              <ul className="mt-1 list-disc pl-5 text-ink-muted">
                {excluded.slice(0, 8).map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Send log</CardTitle>
          <CardDescription>Every enrollment file made for this carrier, with its control number.</CardDescription>
        </CardHeader>
        <CardContent>
          {files.isError ? (
            <QueryError what="files" query={files} />
          ) : (
            <DataGrid<Edi834File>
              id="carrier-files"
              caption="Enrollment files"
              rows={files.data?.files}
              loading={files.isLoading}
              rowKey={(f) => f.id}
              noun={{ one: 'file', many: 'files' }}
              search={false}
              columns={[
                { key: 'made', header: 'Made', primary: true, sortable: true, accessor: (f) => f.createdAt, cell: (f) => <div><p className="font-medium text-ink">{f.mode === 'FULL' ? 'Full file' : 'Change file'}</p><p className="text-xs text-ink-muted">{`${fmtDate(f.createdAt)} · control ${f.controlNumber}`}</p></div> },
                { key: 'members', header: 'Members', align: 'right', searchable: false, accessor: (f) => f.memberCount, className: 'tabular-nums' },
                {
                  key: 'status',
                  header: 'Status',
                  cardMeta: true,
                  accessor: (f) => f.status,
                  cell: (f) => (
                    <div>
                      <Badge variant={f.status === 'SENT' ? 'success' : f.status === 'FAILED' ? 'destructive' : 'pending'}>{f.status === 'SENT' ? `Sent ${f.sentAt ? fmtDate(f.sentAt) : ''}`.trim() : f.status === 'FAILED' ? 'Not sent' : 'Ready'}</Badge>
                      {f.error && <p className="mt-1 max-w-xs text-xs text-ink-muted">{f.error}</p>}
                    </div>
                  ),
                },
                {
                  key: 'actions',
                  header: '',
                  searchable: false,
                  stopRowClick: true,
                  accessor: () => '',
                  cell: (f) => (
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="ghost" aria-label="Download the enrollment file" onClick={() => void download834(f.id).catch((e: Error) => toast.error(e.message))}>
                        <Download className="h-4 w-4" aria-hidden />
                      </Button>
                      {f.status !== 'SENT' && carrier.transport !== 'DOWNLOAD' && (
                        <Button size="sm" variant="outline" onClick={() => send.mutate(f.id)} loading={send.isPending && send.variables === f.id}>
                          <Send className="h-4 w-4" aria-hidden />
                          Send
                        </Button>
                      )}
                    </div>
                  ),
                },
              ]}
              empty={{ icon: FileText, title: 'No files yet', description: 'Make a full file to start the feed.' }}
            />
          )}
        </CardContent>
      </Card>

      {linking && <LinkPlansDialog carrier={carrier} allPlans={allPlans} onClose={() => setLinking(false)} />}
    </div>
  );
}

/**
 * How the feed is doing, from the send log. There is no carrier schedule in
 * the data, so no "due" date is invented; what's waiting is the real count
 * of people whose enrollment changed since the last file.
 */
function FeedHealthStrip({ health }: { health: CarrierFeedHealth | undefined }) {
  if (!health) return null;
  const f = health.lastFile;
  const result = f ? deliveryResult(f) : null;
  return (
    <div className="space-y-2">
      <MetricStrip
        label="Feed health"
        // A feed with no one in it and no file yet has nothing to report: no
        // row of four empty tiles (the plans section below says what to do).
        empty={health.people === 0 && !f}
      >
        <MetricCard label="People in the feed" value={health.people} tone="neutral" hint="Everyone a full file would carry" nothing={health.people === 0 ? 'No one enrolled in these plans' : undefined} />
        <MetricCard
          label="Waiting for the next file"
          value={health.changesWaiting ?? 0}
          tone={health.changesWaiting ? 'warning' : 'default'}
          hint={health.changesWaiting ? `${health.changesWaiting === 1 ? 'person' : 'people'} changed since the last file` : undefined}
          nothing={health.changesWaiting === null ? 'First file: make a full one' : health.changesWaiting === 0 ? 'Nothing changed since the last file' : undefined}
        />
        <MetricCard
          label="Last file"
          value={f ? fmtDate(f.createdAt) : '—'}
          tone="neutral"
          hint={f ? `${f.mode === 'FULL' ? 'Full' : 'Changes'} · control ${f.controlNumber} · ${f.memberCount} ${f.memberCount === 1 ? 'member' : 'members'}` : undefined}
          nothing={f ? undefined : 'No file made yet'}
        />
        <MetricCard
          label="Delivery"
          value={result?.label ?? '—'}
          tone={result?.tone}
          hint={f?.status === 'SENT' && f.sentAt ? `Sent ${fmtDate(f.sentAt)}` : f?.error ?? undefined}
          nothing={f ? undefined : 'Nothing sent yet'}
        />
      </MetricStrip>
      {f && <p className="text-xs text-ink-muted">
        A carrier’s acknowledgment (999 or TA1) isn’t received here, so delivery is as far as this goes — the carrier’s portal shows whether it accepted a file.
      </p>}
    </div>
  );
}

function CarrierDialog({ carrier, focusConnection, onClose }: { carrier: Carrier | null; focusConnection: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<CarrierInput>(
    carrier
      ? { name: carrier.name, receiverId: carrier.receiverId, receiverQualifier: carrier.receiverQualifier, senderId: carrier.senderId, senderQualifier: carrier.senderQualifier, sponsorTaxId: carrier.sponsorTaxId, policyNumber: carrier.policyNumber, usageIndicator: carrier.usageIndicator, transport: carrier.transport, active: carrier.active }
      : { name: '', receiverId: '', receiverQualifier: 'ZZ', senderId: '', senderQualifier: 'ZZ', sponsorTaxId: null, policyNumber: null, usageIndicator: 'T', transport: 'DOWNLOAD' },
  );
  // The delivery settings live here now, read before edit — not as an always-open form under the log.
  const [conn, setConn] = useState({
    baseUrl: carrier?.connection.baseUrl ?? '',
    apiKey: '',
    host: carrier?.connection.host ?? '',
    port: '22',
    username: carrier?.connection.username ?? '',
    password: '',
    privateKey: '',
    remoteDir: carrier?.connection.remoteDir ?? '',
  });
  const hasSecret = carrier?.connection.hasSecret ?? false;
  const connTouched =
    conn.apiKey !== '' ||
    conn.password !== '' ||
    conn.privateKey !== '' ||
    conn.baseUrl !== (carrier?.connection.baseUrl ?? '') ||
    conn.host !== (carrier?.connection.host ?? '') ||
    conn.username !== (carrier?.connection.username ?? '') ||
    conn.remoteDir !== (carrier?.connection.remoteDir ?? '') ||
    conn.port !== '22';
  const m = useMutation({
    mutationFn: async () => {
      const saved = carrier ? await updateCarrier(carrier.id, f) : await createCarrier(f);
      if (f.transport !== 'DOWNLOAD' && connTouched) {
        await saveCarrierConnection(
          saved.carrier.id,
          f.transport === 'SFTP'
            ? { host: conn.host || undefined, port: Number(conn.port) || 22, username: conn.username || undefined, password: conn.password || undefined, privateKey: conn.privateKey || undefined, remoteDir: conn.remoteDir || undefined }
            : { baseUrl: conn.baseUrl || undefined, apiKey: conn.apiKey || undefined },
        );
      }
      return saved;
    },
    onSuccess: () => {
      toast.success(carrier ? 'Carrier saved.' : 'Carrier added. Choose the plans it insures next.');
      void qc.invalidateQueries({ queryKey: ['carriers'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const valid = f.name.trim().length >= 2 && f.receiverId.trim().length >= 2 && f.senderId.trim().length >= 2;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{carrier ? `Edit ${carrier.name}` : 'Add a carrier'}</DialogTitle>
          <DialogDescription>The IDs come from the carrier’s EDI enrollment setup form or companion guide.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Carrier name" required className="sm:col-span-2">{(p) => <Input {...p} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label="Carrier’s receiver ID" required hint="ISA08">{(p) => <Input {...p} value={f.receiverId} maxLength={15} onChange={(e) => setF({ ...f, receiverId: e.target.value })} />}</Field>
          <Field label="Receiver ID type" hint="ISA07, usually ZZ">{(p) => <Input {...p} value={f.receiverQualifier} maxLength={2} onChange={(e) => setF({ ...f, receiverQualifier: e.target.value.toUpperCase() })} />}</Field>
          <Field label="Your sender ID" required hint="ISA06, assigned by the carrier">{(p) => <Input {...p} value={f.senderId} maxLength={15} onChange={(e) => setF({ ...f, senderId: e.target.value })} />}</Field>
          <Field label="Sender ID type" hint="ISA05, usually ZZ">{(p) => <Input {...p} value={f.senderQualifier} maxLength={2} onChange={(e) => setF({ ...f, senderQualifier: e.target.value.toUpperCase() })} />}</Field>
          <Field label="Group policy number">{(p) => <Input {...p} value={f.policyNumber ?? ''} onChange={(e) => setF({ ...f, policyNumber: e.target.value || null })} />}</Field>
          <Field label="Your EIN" hint="9 digits; defaults to the company’s">{(p) => <Input {...p} inputMode="numeric" value={f.sponsorTaxId ?? ''} maxLength={9} onChange={(e) => setF({ ...f, sponsorTaxId: e.target.value.replace(/\D/g, '') || null })} />}</Field>
          <Field label="Mode">
            {(p) => (
              <Select {...p} value={f.usageIndicator} onChange={(e) => setF({ ...f, usageIndicator: e.target.value as 'T' | 'P' })}>
                <option value="T">Testing</option>
                <option value="P">Production</option>
              </Select>
            )}
          </Field>
          <Field label="How files reach the carrier">
            {(p) => (
              <Select {...p} value={f.transport} onChange={(e) => setF({ ...f, transport: e.target.value as CarrierInput['transport'] })}>
                <option value="DOWNLOAD">Download and upload by hand</option>
                <option value="SFTP">SFTP</option>
                <option value="HTTPS">Secure upload (HTTPS)</option>
              </Select>
            )}
          </Field>
        </div>
        {f.transport !== 'DOWNLOAD' && (
          <section aria-labelledby="carrier-delivery" className="space-y-3 rounded-lg border border-line p-3">
            <div>
              <h3 id="carrier-delivery" className="text-sm font-medium text-ink">
                {f.transport === 'SFTP' ? 'SFTP connection' : 'Secure upload'}
              </h3>
              <p className="text-xs text-ink-muted">{hasSecret ? 'Connected. Leave a secret blank to keep the one saved; secrets are stored encrypted.' : 'Fill this in to send files from here. Secrets are stored encrypted.'}</p>
            </div>
            {f.transport === 'SFTP' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="SFTP host">{(p) => <Input {...p} autoFocus={focusConnection} value={conn.host} onChange={(e) => setConn({ ...conn, host: e.target.value })} />}</Field>
                <Field label="Port">{(p) => <Input {...p} type="number" value={conn.port} onChange={(e) => setConn({ ...conn, port: e.target.value })} />}</Field>
                <Field label="User name">{(p) => <Input {...p} autoComplete="off" value={conn.username} onChange={(e) => setConn({ ...conn, username: e.target.value })} />}</Field>
                <Field label="Password">{(p) => <Input {...p} type="password" autoComplete="new-password" value={conn.password} placeholder={hasSecret ? 'Saved' : ''} onChange={(e) => setConn({ ...conn, password: e.target.value })} />}</Field>
                <Field label="Folder">{(p) => <Input {...p} value={conn.remoteDir} placeholder="/inbound" onChange={(e) => setConn({ ...conn, remoteDir: e.target.value })} />}</Field>
                <Field label="Private key, instead of a password" className="sm:col-span-2">{(p) => <Textarea {...p} rows={3} value={conn.privateKey} placeholder={hasSecret ? 'Saved' : ''} onChange={(e) => setConn({ ...conn, privateKey: e.target.value })} />}</Field>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Upload address" hint="Starts with https://">{(p) => <Input {...p} autoFocus={focusConnection} value={conn.baseUrl} onChange={(e) => setConn({ ...conn, baseUrl: e.target.value })} />}</Field>
                <Field label="API key">{(p) => <Input {...p} type="password" autoComplete="new-password" value={conn.apiKey} placeholder={hasSecret ? 'Saved' : ''} onChange={(e) => setConn({ ...conn, apiKey: e.target.value })} />}</Field>
              </div>
            )}
          </section>
        )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => m.mutate()} loading={m.isPending} disabled={!valid}>{carrier ? 'Save carrier' : 'Add carrier'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LinkPlansDialog({ carrier, allPlans, onClose }: { carrier: Carrier; allPlans: CarrierPlan[]; onClose: () => void }) {
  const qc = useQueryClient();
  const eligible = allPlans.filter((p) => !p.carrierId || p.carrierId === carrier.id);
  const [chosen, setChosen] = useState<Record<string, { on: boolean; line: string; code: string }>>(() =>
    Object.fromEntries(eligible.map((p) => [p.id, { on: p.carrierId === carrier.id, line: p.insuranceLineCode ?? p.defaultLine ?? '', code: p.carrierPlanCode ?? '' }])),
  );
  const m = useMutation({
    mutationFn: () => linkCarrierPlans(carrier.id, Object.entries(chosen).filter(([, v]) => v.on).map(([planId, v]) => ({ planId, insuranceLineCode: v.line || null, carrierPlanCode: v.code || null }))),
    onSuccess: () => {
      toast.success('Plans saved.');
      void qc.invalidateQueries({ queryKey: ['carriers'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{`Plans ${carrier.name} insures`}</DialogTitle>
          <DialogDescription>Use the carrier’s own plan code where it gives one. A plan can belong to one carrier.</DialogDescription>
        </DialogHeader>
        {eligible.length === 0 ? (
          <p className="text-sm text-ink-muted">No benefit plans are free to add. Create plans on the Benefits page first.</p>
        ) : (
          <ul className="max-h-[60vh] divide-y divide-navy-secondary overflow-y-auto">
            {eligible.map((p) => {
              const v = chosen[p.id]!;
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-3 py-2.5">
                  <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink">
                    <input type="checkbox" className="h-4 w-4 accent-gold" checked={v.on} onChange={(e) => setChosen({ ...chosen, [p.id]: { ...v, on: e.target.checked } })} />
                    <span className="truncate">{p.name}</span>
                  </label>
                  {v.on && (
                    <>
                      <Select size="sm" aria-label={`${p.name} coverage line`} className="w-40" value={v.line} onChange={(e) => setChosen({ ...chosen, [p.id]: { ...v, line: e.target.value } })}>
                        <option value="">Choose a line…</option>
                        {Object.entries(LINE_LABEL).map(([k, l]) => (
                          <option key={k} value={k}>{l}</option>
                        ))}
                      </Select>
                      <Input aria-label={`${p.name} carrier plan code`} className="h-8 w-36" placeholder="Plan code" value={v.code} onChange={(e) => setChosen({ ...chosen, [p.id]: { ...v, code: e.target.value } })} />
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={() => m.mutate()} loading={m.isPending}>Save plans</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
