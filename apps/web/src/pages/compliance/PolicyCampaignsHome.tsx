import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Megaphone, Plus, Send } from 'lucide-react';
import { toast } from 'sonner';
import { ROLE_LABELS, type Role } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { fmtDate, fmtDateTime, parseYmd, ymdLocal } from '@/lib/format';
import { listDepartments } from '@/lib/orgApi';
import { useOrgSites } from '@/lib/useOrgSites';
import { useClients } from '@/lib/useClients';
import { listTemplates } from '@/lib/docTemplatesApi';
import {
  audienceSize,
  closePolicyCampaign,
  createPolicyCampaign,
  getPolicyCampaign,
  launchPolicyCampaign,
  listPolicyCampaigns,
  waivePolicyRecipient,
  type PolicyAudience,
  type PolicyCampaignRow,
  type PolicyRecipient,
} from '@/lib/policyCampaignsApi';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  Field,
  Input,
  ProgressBar,
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { AssociateLink } from '@/components/ui/AssociateLink';
import { ListTemplate } from '@/components/templates';

/**
 * Policy campaigns (HR pack 2026-10): one policy to an audience at once,
 * signed per person, reminded on a cadence, with completion on one screen.
 * The list is the campaigns with their completion; the drawer is one
 * campaign with every recipient's status.
 */

const STATUS_LABEL: Record<PolicyCampaignRow['status'], string> = { DRAFT: 'Draft', ACTIVE: 'Active', CLOSED: 'Closed' };
const RECIPIENT_LABEL: Record<PolicyRecipient['status'], string> = { PENDING: 'Waiting', SIGNED: 'Signed', WAIVED: 'Waived' };

const ROLE_OPTIONS: Role[] = ['ASSOCIATE', 'SHIFT_SUPERVISOR', 'FLOOR_SUPERVISOR', 'DRIVER', 'MANAGER', 'WORKFORCE_MANAGER', 'INTERNAL_RECRUITER', 'FINANCE_ACCOUNTANT', 'OPERATIONS_MANAGER', 'HR_ADMINISTRATOR'];

function audienceLabel(a: PolicyAudience, term: ReturnType<typeof useTerm>): string {
  switch (a.kind) {
    case 'ALL':
      return `Everyone employed`;
    case 'DEPARTMENT':
      return `${a.ids.length} ${a.ids.length === 1 ? 'department' : 'departments'}`;
    case 'CLIENT':
      return `${a.ids.length} ${(a.ids.length === 1 ? term('label.client') : term('label.clients')).toLowerCase()}`;
    case 'SITE':
      return `${a.ids.length} ${(a.ids.length === 1 ? term('site') : term('sites')).toLowerCase()}`;
    case 'ROLE':
      return a.roles.map((r) => ROLE_LABELS[r as Role] ?? r).join(', ');
  }
}

export function PolicyCampaignsHome() {
  const { can } = useAuth();
  const term = useTerm();
  const canManage = can('manage:documents');
  const [showNew, setShowNew] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['policy-campaigns'], queryFn: listPolicyCampaigns });
  const rows = query.data?.campaigns ?? null;
  const error = query.error ? (query.error instanceof ApiError ? query.error.message : 'Could not load policy campaigns.') : null;

  const columns: GridColumn<PolicyCampaignRow>[] = [
    { key: 'name', header: 'Policy', accessor: (r) => r.name, sortable: true, primary: true, cell: (r) => (
      <>
        <div className="font-medium text-ink">{r.name}</div>
        <div className="text-xs text-ink-muted">{r.templateName} · v{r.version}</div>
      </>
    ) },
    { key: 'audience', header: 'Audience', accessor: (r) => audienceLabel(r.audience, term), cardMeta: true, className: 'text-sm text-ink-muted' },
    { key: 'status', header: 'Status', accessor: (r) => STATUS_LABEL[r.status], sortable: true, cell: (r) => <Badge variant={r.status === 'ACTIVE' ? 'accent' : r.status === 'CLOSED' ? 'success' : 'default'}>{STATUS_LABEL[r.status]}</Badge> },
    { key: 'due', header: 'Due', accessor: (r) => r.dueOn, sortable: true, searchable: false, className: 'whitespace-nowrap text-sm', cell: (r) => fmtDate(parseYmd(r.dueOn)) },
    {
      key: 'completion',
      header: 'Signed',
      accessor: (r) => r.completion.pct,
      sortable: true,
      searchable: false,
      align: 'right',
      className: 'tabular-nums',
      csv: (r) => `${r.completion.signed + r.completion.waived}/${r.completion.total}`,
      cell: (r) =>
        r.status === 'DRAFT' ? (
          <span className="text-xs text-ink-muted">Not sent</span>
        ) : (
          <div className="min-w-[8rem]">
            <div className="flex items-center justify-between text-xs tabular-nums">
              <span>{r.completion.signed + r.completion.waived} of {r.completion.total}</span>
              <span className={r.completion.pct === 100 ? 'text-success' : 'text-ink-muted'}>{r.completion.pct}%</span>
            </div>
            <ProgressBar percent={r.completion.pct} hideLabel label={`${r.name} signed`} className="mt-1" />
          </div>
        ),
    },
  ];

  return (
    <ListTemplate
      title="Policy campaigns"
      subtitle="Send one policy to everyone it applies to, remind until it is signed, and see who has not."
      actions={canManage ? [{ label: 'New campaign', icon: Plus, primary: true, onSelect: () => setShowNew(true) }] : undefined}
    >
      <Card>
        <CardContent className="p-0">
          <div className="p-3">
            <DataGrid<PolicyCampaignRow>
              id="policy-campaigns"
              caption="Policy campaigns"
              rows={rows}
              rowKey={(r) => r.id}
              loading={rows === null && !error}
              error={error}
              onRetry={() => void query.refetch()}
              search={{ placeholder: 'Policy, template…' }}
              urlKey="campaigns"
              exportCsv={{ filename: 'policy-campaigns' }}
              onRowClick={(r) => setOpenId(r.id)}
              rowActionLabel={(r) => `Open ${r.name}`}
              columns={columns}
              empty={{
                icon: Megaphone,
                title: 'No policy campaigns yet',
                description: 'Pick a policy, choose who must sign, set a due date.',
                action: canManage ? (
                  <Button size="sm" variant="outline" onClick={() => setShowNew(true)}>
                    <Plus className="h-4 w-4" />
                    New campaign
                  </Button>
                ) : undefined,
              }}
            />
          </div>
        </CardContent>
      </Card>
      {showNew && (
        <NewCampaignDrawer
          onClose={() => setShowNew(false)}
          onSaved={(id) => {
            setShowNew(false);
            void query.refetch();
            setOpenId(id);
          }}
        />
      )}
      {openId && <CampaignDrawer id={openId} canManage={canManage} onClose={() => setOpenId(null)} onChanged={() => void query.refetch()} />}
    </ListTemplate>
  );
}

function NewCampaignDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  const term = useTerm();
  const tenant = useTenant();
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [kind, setKind] = useState<PolicyAudience['kind']>('ALL');
  const [ids, setIds] = useState<string[]>([]);
  const [roles, setRoles] = useState<string[]>([]);
  const [dueOn, setDueOn] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 14);
    return ymdLocal(d);
  });
  const [every, setEvery] = useState('3');
  const templates = useQuery({ queryKey: ['doc-templates', 'all'], queryFn: () => listTemplates() });
  const departments = useQuery({ queryKey: ['org', 'departments'], queryFn: () => listDepartments(), enabled: kind === 'DEPARTMENT' });
  const sites = useOrgSites(kind === 'SITE');
  const { clients } = useClients({ enabled: kind === 'CLIENT' && tenant.modules.clientPortal });
  const published = useMemo(() => (templates.data?.templates ?? []).filter((t) => t.currentVersionId), [templates.data]);
  useEffect(() => {
    if (!templateId && published.length > 0) setTemplateId(published[0]!.id);
  }, [published, templateId]);

  const audience: PolicyAudience | null =
    kind === 'ALL' ? { kind: 'ALL' } : kind === 'ROLE' ? (roles.length ? { kind: 'ROLE', roles } : null) : ids.length ? ({ kind, ids } as PolicyAudience) : null;
  const size = useQuery({ queryKey: ['policy-campaigns', 'audience-size', audience], queryFn: () => audienceSize(audience!), enabled: audience !== null });

  const body = () => ({ name: name.trim(), templateId, audience: audience!, dueOn, reminderEveryDays: Math.max(1, Math.min(30, Number(every) || 3)) });
  const create = useMutation({
    mutationFn: () => createPolicyCampaign(body()),
    onSuccess: (r) => {
      toast.success('Campaign drafted. Launch it when the audience looks right.');
      onSaved(r.id);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not create the campaign.'),
  });
  // The drawer already shows how many people it reaches: create and send in
  // one step instead of draft → open → Send → confirm.
  const createAndSend = useMutation({
    mutationFn: async () => {
      const r = await createPolicyCampaign(body());
      const sent = await launchPolicyCampaign(r.id);
      return { id: r.id, recipients: sent.recipients };
    },
    onSuccess: (r) => {
      toast.success(`Sent to ${r.recipients} ${r.recipients === 1 ? 'person' : 'people'}.`);
      onSaved(r.id);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not send the campaign.'),
  });

  const toggle = (list: string[], v: string, set: (xs: string[]) => void) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const picker = (label: string, options: Array<{ id: string; name: string }> | null | undefined, selected: string[], set: (xs: string[]) => void) => (
    <Field label={label}>
      {(p) => (
        <div {...p} className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-line p-2">
          {!options ? (
            <SkeletonRows count={3} />
          ) : options.length === 0 ? (
            <div className="text-xs text-ink-muted">None on file.</div>
          ) : (
            options.map((o) => (
              <label key={o.id} className="flex cursor-pointer items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={selected.includes(o.id)} onChange={() => toggle(selected, o.id, set)} className="accent-[var(--accent)]" />
                {o.name}
              </label>
            ))
          )}
        </div>
      )}
    </Field>
  );

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()} confirmDiscard={() => name.trim().length > 0}>
      <DrawerHeader>
        <DrawerTitle>New policy campaign</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <Field label="Name" required hint="What people see in the request to sign.">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Code of conduct 2027" maxLength={160} />}
        </Field>
        <Field label="Policy (template version)" required hint="Only templates with a published version can go out.">
          {(p) => (
            <Select {...p} value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
              {published.length === 0 && <option value="">No published templates</option>}
              {published.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} · v{t.currentVersion}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Audience">
          {(p) => (
            <Select
              {...p}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as PolicyAudience['kind']);
                setIds([]);
                setRoles([]);
              }}
            >
              <option value="ALL">Everyone employed</option>
              <option value="DEPARTMENT">Departments</option>
              {tenant.modules.clientPortal && <option value="CLIENT">{term('label.clients')}</option>}
              <option value="SITE">{term('sites')}</option>
              <option value="ROLE">Roles</option>
            </Select>
          )}
        </Field>
        {kind === 'DEPARTMENT' && picker('Departments', departments.data?.departments, ids, setIds)}
        {kind === 'SITE' && picker(term('sites'), sites, ids, setIds)}
        {kind === 'CLIENT' && picker(term('label.clients'), clients, ids, setIds)}
        {kind === 'ROLE' && picker('Roles', ROLE_OPTIONS.map((r) => ({ id: r, name: ROLE_LABELS[r] })), roles, setRoles)}
        <div className="text-sm text-ink-muted" aria-live="polite">
          {audience === null ? 'Pick who this goes to.' : size.data ? `${size.data.count} ${size.data.count === 1 ? 'person' : 'people'} will be asked to sign.` : 'Counting…'}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Due by" required>
            {(p) => <Input {...p} type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} min={ymdLocal()} />}
          </Field>
          <Field label="Remind every (days)">
            {(p) => <Input {...p} type="number" min={1} max={30} value={every} onChange={(e) => setEvery(e.target.value)} />}
          </Field>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="secondary" onClick={() => create.mutate()} loading={create.isPending} disabled={createAndSend.isPending || !name.trim() || !templateId || audience === null || !dueOn}>
          Save draft
        </Button>
        <Button onClick={() => createAndSend.mutate()} loading={createAndSend.isPending} disabled={create.isPending || !name.trim() || !templateId || audience === null || !dueOn || !size.data}>
          <Send className="h-4 w-4" />
          Create &amp; send{size.data ? ` to ${size.data.count}` : ''}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function CampaignDrawer({ id, canManage, onClose, onChanged }: { id: string; canManage: boolean; onClose: () => void; onChanged: () => void }) {
  const term = useTerm();
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [waiveFor, setWaiveFor] = useState<PolicyRecipient | null>(null);
  const [waiveReason, setWaiveReason] = useState('');
  const detail = useQuery({ queryKey: ['policy-campaigns', id], queryFn: () => getPolicyCampaign(id) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['policy-campaigns', id] });
    onChanged();
  };
  const launch = useMutation({
    mutationFn: () => launchPolicyCampaign(id),
    onSuccess: (r) => {
      toast.success(`Sent to ${r.recipients} ${r.recipients === 1 ? 'person' : 'people'}.`);
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not launch the campaign.'),
  });
  const close = useMutation({
    mutationFn: () => closePolicyCampaign(id),
    onSuccess: () => {
      toast.success('Campaign closed. Reminders stop.');
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not close the campaign.'),
  });
  const waive = useMutation({
    mutationFn: (r: PolicyRecipient) => waivePolicyRecipient(id, r.id, waiveReason.trim()),
    onSuccess: () => {
      toast.success('Waived.');
      setWaiveFor(null);
      setWaiveReason('');
      refresh();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not waive.'),
  });
  const c = detail.data;

  const onLaunch = async () => {
    if (!c) return;
    const ok = await confirm({
      title: `Send "${c.name}" to ${c.audienceSize} ${c.audienceSize === 1 ? 'person' : 'people'}?`,
      description: `Each person gets the policy rendered for them and a request to sign by ${fmtDate(parseYmd(c.dueOn))}. Reminders go out every ${c.reminderEveryDays} days until they do.`,
      confirmLabel: 'Send',
    });
    if (ok) launch.mutate();
  };

  const recipientColumns: GridColumn<PolicyRecipient>[] = [
    { key: 'name', header: term('worker'), accessor: (r) => r.associateName, sortable: true, primary: true, cell: (r) => <AssociateLink associateId={r.associateId}>{r.associateName}</AssociateLink> },
    { key: 'status', header: 'Status', accessor: (r) => RECIPIENT_LABEL[r.status], sortable: true, cell: (r) => <Badge variant={r.status === 'SIGNED' ? 'success' : r.status === 'WAIVED' ? 'default' : 'pending'}>{RECIPIENT_LABEL[r.status]}</Badge> },
    { key: 'signed', header: 'Signed', accessor: (r) => r.signedAt ?? '', searchable: false, className: 'text-xs text-ink-muted', cell: (r) => (r.signedAt ? fmtDateTime(r.signedAt) : r.remindedAt ? `Reminded ${fmtDate(r.remindedAt)}` : '—') },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: '',
            accessor: () => '',
            searchable: false,
            stopRowClick: true,
            cell: (r: PolicyRecipient) =>
              r.status === 'PENDING' && c?.status === 'ACTIVE' ? (
                <Button size="sm" variant="ghost" onClick={() => setWaiveFor(r)}>
                  Waive
                </Button>
              ) : null,
          } satisfies GridColumn<PolicyRecipient>,
        ]
      : []),
  ];

  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>{c?.name ?? 'Policy campaign'}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {detail.isError ? (
          <div role="alert" className="text-sm text-alert">
            Could not load this campaign.
          </div>
        ) : !c ? (
          <SkeletonRows count={4} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
              <Badge variant={c.status === 'ACTIVE' ? 'accent' : c.status === 'CLOSED' ? 'success' : 'default'}>{STATUS_LABEL[c.status]}</Badge>
              <span>{c.templateName} · v{c.version}</span>
              <span>· {audienceLabel(c.audience, term)}</span>
              <span>· due {fmtDate(parseYmd(c.dueOn))}</span>
            </div>
            {c.status !== 'DRAFT' && (
              <div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-ink">
                    {c.completion.signed} signed · {c.completion.waived} waived · {c.completion.pending} waiting
                  </span>
                  <span className="font-medium tabular-nums text-ink">{c.completion.pct}%</span>
                </div>
                <ProgressBar percent={c.completion.pct} hideLabel label="Signed" className="mt-1" />
                {c.lastReminderAt && <div className="mt-1 text-xs text-ink-muted">Last reminder {fmtDateTime(c.lastReminderAt)}</div>}
              </div>
            )}
            {canManage && c.status === 'DRAFT' && (
              <Button onClick={onLaunch} loading={launch.isPending}>
                <Send className="h-4 w-4" />
                Send to {c.audienceSize} {c.audienceSize === 1 ? 'person' : 'people'}
              </Button>
            )}
            {canManage && c.status === 'ACTIVE' && (
              <Button variant="outline" onClick={() => close.mutate()} loading={close.isPending}>
                Close campaign
              </Button>
            )}
            <details className="rounded-md border border-line p-3">
              <summary className="cursor-pointer text-sm text-ink">The policy text</summary>
              <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-sans text-sm text-ink-muted">{c.body}</pre>
            </details>
            {c.status !== 'DRAFT' && (
              <DataGrid<PolicyRecipient>
                id="policy-campaign-recipients"
                caption="Recipients"
                rows={c.recipients}
                rowKey={(r) => r.id}
                search={{ placeholder: 'Name…' }}
                urlState={false}
                exportCsv={{ filename: `policy-${c.name.replace(/\s+/g, '-').toLowerCase()}` }}
                columns={recipientColumns}
              />
            )}
            {waiveFor && (
              <div className="space-y-2 rounded-md border border-line p-3">
                <div className="text-sm text-ink">Waive {waiveFor.associateName}</div>
                <Textarea value={waiveReason} onChange={(e) => setWaiveReason(e.target.value)} placeholder="Why this person does not need to sign (kept on the record)" rows={2} maxLength={500} />
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setWaiveFor(null)}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={() => waive.mutate(waiveFor)} loading={waive.isPending} disabled={waiveReason.trim().length < 2}>
                    Waive
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>Close</Button>
      </DrawerFooter>
    </Drawer>
  );
}
