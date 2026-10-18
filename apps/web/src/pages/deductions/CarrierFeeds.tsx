import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
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
  type CarrierInput,
  type CarrierPlan,
  type Edi834File,
} from '@/lib/deductionsApi';
import { fmtDate } from '@/lib/format';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { DataGrid } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';

/**
 * Carrier feeds: each insurance carrier's connection and the EDI 834
 * enrollment files sent to it. A full file lists everyone covered; a
 * change file lists only additions, ends and changes since the last one.
 */

const LINE_LABEL: Record<string, string> = { HLT: 'Medical', DEN: 'Dental', VIS: 'Vision', LIF: 'Life', LTD: 'Long-term disability', STD: 'Short-term disability', AG: 'Accidental death', ADD: 'AD&D' };

export function CarrierFeeds() {
  const [params, setParams] = useSearchParams();
  const q = useQuery({ queryKey: ['carriers'], queryFn: listCarriers });
  const [editing, setEditing] = useState<Carrier | 'new' | null>(null);
  const carriers = q.data?.carriers ?? [];
  const selectedId = params.get('carrier') ?? carriers[0]?.id ?? null;
  const carrier = carriers.find((c) => c.id === selectedId) ?? null;
  return (
    <ListTemplate
      title="Carrier feeds"
      subtitle="Enrollment files for each insurance carrier, made from benefit elections, covered dependents and life events."
      breadcrumbs={[{ label: 'Benefits', to: '/benefits' }, { label: 'Carrier feeds' }]}
      primaryAction={
        <Button size="sm" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" aria-hidden />
          Add a carrier
        </Button>
      }
      filters={
        carriers.length > 1 ? (
          <Select
            size="sm"
            aria-label="Carrier"
            className="w-64 max-w-full"
            value={selectedId ?? ''}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              next.set('carrier', e.target.value);
              setParams(next, { replace: true });
            }}
          >
            {carriers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
        ) : null
      }
    >
      {q.isError ? (
        <QueryError what="carriers" query={q} />
      ) : q.isLoading ? (
        <SkeletonRows count={5} />
      ) : !carrier ? (
        <EmptyState icon={Send} title="No carriers yet" description="Add each insurer you send enrollments to, with the IDs from its EDI setup form." action={<Button onClick={() => setEditing('new')}>Add a carrier</Button>} />
      ) : (
        <CarrierView carrier={carrier} allPlans={q.data?.plans ?? []} onEdit={() => setEditing(carrier)} />
      )}
      {editing && <CarrierDialog carrier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </ListTemplate>
  );
}

function CarrierView({ carrier, allPlans, onEdit }: { carrier: Carrier; allPlans: CarrierPlan[]; onEdit: () => void }) {
  const qc = useQueryClient();
  const files = useQuery({ queryKey: ['carriers', 'files', carrier.id], queryFn: () => list834(carrier.id) });
  const [linking, setLinking] = useState(false);
  const [excluded, setExcluded] = useState<string[]>([]);
  const make = useMutation({
    mutationFn: (mode: 'FULL' | 'CHANGE') => make834(carrier.id, mode),
    onSuccess: (r) => {
      setExcluded(r.excluded);
      if (r.file) toast.success(`${r.file.mode === 'FULL' ? 'Full' : 'Change'} file made with ${r.file.memberCount} ${r.file.memberCount === 1 ? 'member' : 'members'}.`);
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
              {[carrier.policyNumber ? `Group ${carrier.policyNumber}` : null, `Receiver ${carrier.receiverId}`, carrier.transport === 'DOWNLOAD' ? 'Files download for upload by hand' : carrier.connection.hasSecret ? `Sent by ${carrier.transport}` : `${carrier.transport} not connected yet`].filter(Boolean).join(' · ')}
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={onEdit}>Edit carrier</Button>
        </CardHeader>
        <CardContent className="space-y-3">
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
          <CardDescription>Every 834 made for this carrier, with its control number.</CardDescription>
        </CardHeader>
        <CardContent>
          {files.isError ? (
            <QueryError what="files" query={files} />
          ) : (
            <DataGrid<Edi834File>
              id="carrier-files"
              caption="834 files"
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
                      <Button size="sm" variant="ghost" aria-label="Download the 834 file" onClick={() => void download834(f.id).catch((e: Error) => toast.error(e.message))}>
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

      {carrier.transport !== 'DOWNLOAD' && <CarrierConnection carrier={carrier} />}
      {linking && <LinkPlansDialog carrier={carrier} allPlans={allPlans} onClose={() => setLinking(false)} />}
    </div>
  );
}

function CarrierDialog({ carrier, onClose }: { carrier: Carrier | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<CarrierInput>(
    carrier
      ? { name: carrier.name, receiverId: carrier.receiverId, receiverQualifier: carrier.receiverQualifier, senderId: carrier.senderId, senderQualifier: carrier.senderQualifier, sponsorTaxId: carrier.sponsorTaxId, policyNumber: carrier.policyNumber, usageIndicator: carrier.usageIndicator, transport: carrier.transport, active: carrier.active }
      : { name: '', receiverId: '', receiverQualifier: 'ZZ', senderId: '', senderQualifier: 'ZZ', sponsorTaxId: null, policyNumber: null, usageIndicator: 'T', transport: 'DOWNLOAD' },
  );
  const m = useMutation({
    mutationFn: () => (carrier ? updateCarrier(carrier.id, f) : createCarrier(f)),
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

function CarrierConnection({ carrier }: { carrier: Carrier }) {
  const qc = useQueryClient();
  const sftp = carrier.transport === 'SFTP';
  const [f, setF] = useState({ baseUrl: carrier.connection.baseUrl ?? '', apiKey: '', host: carrier.connection.host ?? '', port: '22', username: carrier.connection.username ?? '', password: '', privateKey: '', remoteDir: carrier.connection.remoteDir ?? '' });
  const m = useMutation({
    mutationFn: () =>
      saveCarrierConnection(
        carrier.id,
        sftp
          ? { host: f.host || undefined, port: Number(f.port) || 22, username: f.username || undefined, password: f.password || undefined, privateKey: f.privateKey || undefined, remoteDir: f.remoteDir || undefined }
          : { baseUrl: f.baseUrl || undefined, apiKey: f.apiKey || undefined },
      ),
    onSuccess: () => {
      toast.success('Connection saved. Secrets are stored encrypted.');
      setF((p) => ({ ...p, apiKey: '', password: '', privateKey: '' }));
      void qc.invalidateQueries({ queryKey: ['carriers'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Connection</CardTitle>
        <CardDescription>{carrier.connection.hasSecret ? 'Connected. Leave a secret blank to keep the one saved.' : 'Fill this in to send files from here.'}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {sftp ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="SFTP host">{(p) => <Input {...p} value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} />}</Field>
            <Field label="Port">{(p) => <Input {...p} type="number" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} />}</Field>
            <Field label="User name">{(p) => <Input {...p} autoComplete="off" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} />}</Field>
            <Field label="Password">{(p) => <Input {...p} type="password" autoComplete="new-password" value={f.password} placeholder={carrier.connection.hasSecret ? 'Saved' : ''} onChange={(e) => setF({ ...f, password: e.target.value })} />}</Field>
            <Field label="Folder">{(p) => <Input {...p} value={f.remoteDir} placeholder="/inbound/834" onChange={(e) => setF({ ...f, remoteDir: e.target.value })} />}</Field>
            <Field label="Private key, instead of a password" className="sm:col-span-2">{(p) => <Textarea {...p} rows={3} value={f.privateKey} placeholder={carrier.connection.hasSecret ? 'Saved' : ''} onChange={(e) => setF({ ...f, privateKey: e.target.value })} />}</Field>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Upload address" hint="Starts with https://">{(p) => <Input {...p} value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} />}</Field>
            <Field label="API key">{(p) => <Input {...p} type="password" autoComplete="new-password" value={f.apiKey} placeholder={carrier.connection.hasSecret ? 'Saved' : ''} onChange={(e) => setF({ ...f, apiKey: e.target.value })} />}</Field>
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="outline" onClick={() => m.mutate()} loading={m.isPending}>Save connection</Button>
        </div>
      </CardContent>
    </Card>
  );
}
