import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ClipboardCheck, Download, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth, useRoleLabel } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { fmtDate } from '@/lib/format';
import { INBOX_QUERY_KEY } from '@/lib/inboxApi';
import { useUrlParam } from '@/lib/useUrlState';
import {
  certificationExportUrl,
  closeCertification,
  decideCertificationItem,
  getCertification,
  listCertifications,
  openCertification,
  type CertificationDecision,
  type CertificationItem,
  type CertificationScope,
  type CertificationSummary,
} from '@/lib/accessCertificationsApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { FilterChip } from '@/components/ui/FilterBar';
import { Input, Textarea } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/Tabs';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { AccessReport } from './AccessReport';
import type { Role } from '@alto-people/shared';

/**
 * Access review (Settings & trust) — the one home for "who can get in, and
 * should they?" (F500 G4: it used to live in three places with three names).
 *
 *   Campaigns: every certification the organization has run, open ones
 *   first, with how far along each is and what the signed-in person owes.
 *   Access report: every account with its flags, the counts first, and the
 *   reversible bulk deactivation (moved here from Users & access; its old
 *   link, /admin/users?view=report, lands on this tab).
 *
 *   A campaign: one row per account in scope — what it held when the
 *   campaign opened — decided by its reviewer (the manager of the person
 *   behind the account, else the owner) as keep, revoke or change, with a
 *   note. Closing needs every row decided; a REVOKE or CHANGE is a finding
 *   applied in Users & access (each finding links to that account), so the
 *   certification and the change stay two attributable steps.
 */

const message = (err: unknown) => (err instanceof ApiError ? err.message : 'Something went wrong.');

const SCOPE_LABEL: Record<CertificationScope, string> = {
  ALL: 'Every account',
  INTERNAL: 'Staff accounts',
  CLIENT: 'Client accounts',
  ASSOCIATE: 'Worker accounts',
};

const DECISION_LABEL: Record<CertificationDecision, string> = { KEEP: 'Keep', REVOKE: 'Revoke', CHANGE: 'Change' };
const DECISION_VARIANT: Record<CertificationDecision, 'success' | 'destructive' | 'pending'> = { KEEP: 'success', REVOKE: 'destructive', CHANGE: 'pending' };
/** An account's status in words — never the enum lower-cased. */
const ACCOUNT_STATUS_LABEL: Record<string, string> = { ACTIVE: 'Active', INVITED: 'Invited', DISABLED: 'Disabled' };

const CERTS_KEY = ['access-certifications'] as const;
const TABS = ['campaigns', 'report'] as const;
type Tab = (typeof TABS)[number];

function OpenDrawer({ onClose, onOpened }: { onClose: () => void; onOpened: (id: string) => void }) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<CertificationScope>('INTERNAL');
  const inTwoWeeks = useMemo(() => new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10), []);
  const [due, setDue] = useState(inTwoWeeks);
  const open = useMutation({
    mutationFn: () => openCertification({ name: name.trim(), scope, dueAt: new Date(`${due}T23:59:59`).toISOString() }),
    onSuccess: (r) => {
      toast.success(`Opened. ${r.items} ${r.items === 1 ? 'account' : 'accounts'} to certify.`);
      onOpened(r.id);
    },
    onError: (err) => toast.error(message(err)),
  });
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Open a certification</DrawerTitle>
        <DrawerDescription>Every active account in scope gets a row; its reviewer is the manager of the person behind it, or you.</DrawerDescription>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <Field label="Name" required>{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder="Q4 access certification" />}</Field>
        <Field label="Scope">
          {(p) => (
            <Select {...p} value={scope} onChange={(e) => setScope(e.target.value as CertificationScope)}>
              {(Object.keys(SCOPE_LABEL) as CertificationScope[]).map((k) => (
                <option key={k} value={k}>{SCOPE_LABEL[k]}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Due" hint="Overdue campaigns remind their reviewers once a day.">{(p) => <Input {...p} type="date" value={due} min={new Date().toISOString().slice(0, 10)} onChange={(e) => setDue(e.target.value)} />}</Field>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button loading={open.isPending} disabled={name.trim().length < 3 || !due} onClick={() => open.mutate()}>Open</Button>
      </DrawerFooter>
    </Drawer>
  );
}

function CampaignRow({ c }: { c: CertificationSummary }) {
  const pct = c.items ? Math.round((c.decided / c.items) * 100) : 100;
  return (
    <li className="flex flex-wrap items-center gap-4 p-[var(--d-card)]">
      <div className="min-w-0 flex-1">
        <Link to={`/admin/access-certifications/${c.id}`} className="text-base font-medium text-ink hover:text-accent">
          {c.name}
        </Link>
        <p className="mt-0.5 text-sm text-ink-muted">
          {SCOPE_LABEL[c.scope]} · {c.items} {c.items === 1 ? 'account' : 'accounts'} · {c.status === 'CLOSED' ? `closed ${fmtDate(c.closedAt)}` : `due ${fmtDate(c.dueAt)}`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {c.mine > 0 && <Badge variant="pending">{c.mine} for you</Badge>}
        {c.revoke > 0 && <Badge variant="destructive">{c.revoke} to revoke</Badge>}
        {c.change > 0 && <Badge variant="pending">{c.change} to change</Badge>}
        <Badge variant={c.status === 'CLOSED' ? 'success' : 'info'}>{c.status === 'CLOSED' ? 'Closed' : `${pct}% decided`}</Badge>
      </div>
    </li>
  );
}

function Campaigns({ opening, setOpening }: { opening: boolean; setOpening: (v: boolean) => void }) {
  const q = useQuery({ queryKey: CERTS_KEY, queryFn: listCertifications });
  const qc = useQueryClient();
  const rows = q.data?.certifications ?? [];
  return (
    <>
      {q.isPending && <SkeletonRows count={4} rowHeight="h-16" />}
      {q.isError && <QueryError what="access certifications" query={q} />}
      {q.data && rows.length === 0 && (
        <EmptyState icon={ClipboardCheck} title="No certification yet." description="Open one to have every account in scope reviewed by its manager, with a record the trust center can show." />
      )}
      {q.data && rows.length > 0 && (
        <Card animate={false}>
          <ul className="divide-y divide-line" aria-label="Access certifications">
            {rows.map((c) => (
              <CampaignRow key={c.id} c={c} />
            ))}
          </ul>
        </Card>
      )}
      {opening && (
        <OpenDrawer
          onClose={() => setOpening(false)}
          onOpened={() => {
            setOpening(false);
            void qc.invalidateQueries({ queryKey: CERTS_KEY });
            void qc.invalidateQueries({ queryKey: INBOX_QUERY_KEY });
          }}
        />
      )}
    </>
  );
}

export function AccessCertifications() {
  const { can } = useAuth();
  // The access report reads every account: HR administration only.
  const seesReport = can('view:hr-admin');
  const [tab, setTab] = useUrlParam<Tab>('tab', 'campaigns', TABS, { history: 'push' });
  const shown: Tab = tab === 'report' && seesReport ? 'report' : 'campaigns';
  const [opening, setOpening] = useState(false);
  return (
    <ListTemplate
      title="Access certifications"
      subtitle="Who can get in, and should they: every account reviewed by the person accountable for it, on a campaign with a due date and a record."
      actions={[{ label: 'Open a certification', icon: Plus, primary: true, onSelect: () => setOpening(true), hidden: !can('manage:org') }]}
      related={[{ label: 'Users & access', to: '/admin/users' }]}
    >
      {seesReport ? (
        <Tabs value={shown} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList>
            <TabsTrigger value="campaigns">Campaigns</TabsTrigger>
            <TabsTrigger value="report">Access report</TabsTrigger>
          </TabsList>
          <TabsContent value="campaigns" className="space-y-[var(--d-stack)]">
            <Campaigns opening={opening} setOpening={setOpening} />
          </TabsContent>
          <TabsContent value="report">
            <AccessReport />
          </TabsContent>
        </Tabs>
      ) : (
        <Campaigns opening={opening} setOpening={setOpening} />
      )}
    </ListTemplate>
  );
}

function snapshotLine(item: CertificationItem, roleLabel: (r: Role) => string): string {
  const s = item.snapshot;
  const parts: string[] = [];
  if (s.role) parts.push(roleLabel(s.role as Role));
  if (s.additionalRoles?.length) parts.push(`also ${s.additionalRoles.map((r) => roleLabel(r as Role)).join(', ')}`);
  const places = (s.scopeSiteIds?.length ?? 0) + (s.scopeRegionIds?.length ?? 0);
  if (places) parts.push(`scoped to ${places} ${places === 1 ? 'place' : 'places'}`);
  if (s.breakGlass) parts.push('break-glass owner');
  parts.push(s.lastSeenAt ? `last seen ${fmtDate(s.lastSeenAt)}` : 'never signed in');
  return parts.join(' · ');
}

/** Revoke or change: the reviewer says why before it is recorded. */
function NoteDialog({ decision, name, busy, onClose, onRecord }: { decision: 'REVOKE' | 'CHANGE'; name: string; busy: boolean; onClose: () => void; onRecord: (note: string) => void }) {
  const [note, setNote] = useState('');
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()} confirmDiscard={() => note.trim().length > 0}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {decision === 'REVOKE' ? 'Revoke' : 'Change'} {name}'s access?
          </DialogTitle>
          <DialogDescription>The finding is applied in Users & access after the campaign closes; nothing changes on the account now.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (note.trim()) onRecord(note.trim());
          }}
        >
          <Field label={decision === 'REVOKE' ? 'Why revoke' : 'What should change'} required>
            {(p) => <Textarea {...p} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={decision === 'REVOKE' ? 'Left the team in September.' : 'Should hold Workforce Manager, not Operations Manager.'} autoFocus />}
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" variant={decision === 'REVOKE' ? 'destructive' : 'primary'} disabled={!note.trim()} loading={busy}>
              Record {DECISION_LABEL[decision].toLowerCase()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const SHOW = ['all', 'mine', 'undecided', 'KEEP', 'REVOKE', 'CHANGE'] as const;
type Show = (typeof SHOW)[number];

export function AccessCertificationPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const roleLabel = useRoleLabel();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: [...CERTS_KEY, id], queryFn: () => getCertification(id), enabled: !!id });
  // What the reviewer is looking at: everything, theirs, the undecided, or one decision. In the URL.
  const [show, setShow] = useUrlParam<Show>('show', 'all', SHOW);
  const [noting, setNoting] = useState<{ item: CertificationItem; decision: 'REVOKE' | 'CHANGE' } | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: CERTS_KEY });
    void qc.invalidateQueries({ queryKey: INBOX_QUERY_KEY });
  };
  const decide = async (item: CertificationItem, decision: CertificationDecision, note?: string) => {
    setDeciding(item.id);
    try {
      await decideCertificationItem(id, item.id, { decision, ...(note ? { note } : {}) });
      setNoting(null);
      refresh();
    } catch (err) {
      toast.error(message(err));
    } finally {
      setDeciding(null);
    }
  };
  const close = useMutation({
    mutationFn: () => closeCertification(id),
    onSuccess: (t) => {
      toast.success(`Closed: ${t.keep} kept, ${t.revoke} to revoke, ${t.change} to change.`);
      void qc.invalidateQueries({ queryKey: CERTS_KEY });
    },
    onError: (err) => toast.error(message(err)),
  });
  // Loading or failed, the page still has its header (and the top bar its name).
  if (q.isPending || q.isError || !q.data) {
    return (
      <div className="space-y-[var(--d-stack)]">
        <PageHeader title="Access certification" breadcrumbs={[{ label: 'Access certifications', to: '/admin/access-certifications' }, { label: 'Access certification' }]} />
        {q.isPending ? <SkeletonRows count={6} /> : <QueryError what="this certification" query={q} />}
      </div>
    );
  }
  const c = q.data;
  const closed = c.status === 'CLOSED';
  const undecided = c.items.filter((i) => !i.decision).length;
  const mine = c.items.filter((i) => i.mine && !i.decision).length;
  const canDecide = (i: CertificationItem) => !closed && !i.decision && (i.mine || c.runs);
  const count: Record<Show, number> = {
    all: c.items.length,
    mine,
    undecided,
    KEEP: c.items.filter((i) => i.decision === 'KEEP').length,
    REVOKE: c.items.filter((i) => i.decision === 'REVOKE').length,
    CHANGE: c.items.filter((i) => i.decision === 'CHANGE').length,
  };
  const rows = [...c.items]
    .filter((i) => (show === 'all' ? true : show === 'mine' ? i.mine && !i.decision : show === 'undecided' ? !i.decision : i.decision === show))
    .sort((a, b) => Number(!!a.decision) - Number(!!b.decision) || Number(b.mine) - Number(a.mine));
  const findings = c.items.filter((i) => i.decision === 'REVOKE' || i.decision === 'CHANGE');

  const keepMany = async (ids: string[], clear: () => void) => {
    setBulkBusy(true);
    try {
      const results = await Promise.allSettled(ids.map((itemId) => decideCertificationItem(id, itemId, { decision: 'KEEP' })));
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      if (ok === ids.length) toast.success(`${ok} kept.`);
      else toast.error(`${ok} kept, ${ids.length - ok} failed.`);
      clear();
      refresh();
    } finally {
      setBulkBusy(false);
    }
  };

  const columns: GridColumn<CertificationItem>[] = [
    {
      key: 'account',
      header: 'Account',
      primary: true,
      sortable: true,
      accessor: (i) => i.subject?.name ?? i.subject?.email ?? '',
      csv: (i) => i.subject?.email ?? '',
      cell: (i) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{i.subject?.name ?? i.subject?.email ?? 'An account'}</span>
            {i.subject?.status && i.subject.status !== 'ACTIVE' && (
              <Badge variant="default" size="sm">
                {ACCOUNT_STATUS_LABEL[i.subject.status] ?? i.subject.status}
              </Badge>
            )}
          </div>
          {i.subject?.email && i.subject.name && <div className="text-xs text-ink-muted">{i.subject.email}</div>}
        </div>
      ),
    },
    { key: 'held', header: 'What it held', accessor: (i) => snapshotLine(i, roleLabel), className: 'text-sm text-ink-muted' },
    { key: 'reviewer', header: 'Reviewer', sortable: true, cardMeta: true, accessor: (i) => i.reviewer?.name ?? i.reviewer?.email ?? '—', className: 'text-sm text-ink-muted' },
    {
      key: 'decision',
      header: 'Decision',
      sortable: true,
      accessor: (i) => (i.decision ? DECISION_LABEL[i.decision] : ''),
      stopRowClick: true,
      cell: (i) =>
        i.decision ? (
          <div className="space-y-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge variant={DECISION_VARIANT[i.decision]} size="sm">
                {DECISION_LABEL[i.decision]}
              </Badge>
              <span className="text-xs text-ink-muted">
                by {i.decidedBy?.name ?? i.decidedBy?.email ?? '—'}
                {i.decidedAt ? `, ${fmtDate(i.decidedAt)}` : ''}
              </span>
            </span>
            {i.note && <p className="text-sm text-ink">{i.note}</p>}
          </div>
        ) : closed ? null : canDecide(i) ? (
          <span className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="outline" onClick={() => void decide(i, 'KEEP')} loading={deciding === i.id}>
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Keep
            </Button>
            <Button size="sm" variant="outline" onClick={() => setNoting({ item: i, decision: 'CHANGE' })}>
              Change
            </Button>
            <Button size="sm" variant="outline" onClick={() => setNoting({ item: i, decision: 'REVOKE' })}>
              Revoke
            </Button>
          </span>
        ) : (
          <Badge variant="pending" size="sm">
            Waiting on reviewer
          </Badge>
        ),
    },
  ];

  return (
    <div className="space-y-[var(--d-stack)]">
      <PageHeader
        title={c.name}
        subtitle={`${SCOPE_LABEL[c.scope]} · ${closed ? `closed ${fmtDate(c.closedAt)}` : `due ${fmtDate(c.dueAt)}`}`}
        breadcrumbs={[{ label: 'Access certifications', to: '/admin/access-certifications' }, { label: c.name }]}
        status={<Badge variant={closed ? 'success' : 'info'}>{closed ? 'Closed' : 'Open'}</Badge>}
        facts={[
          { label: 'Decided', value: `${c.items.length - undecided} of ${c.items.length}` },
          { label: 'Waiting on you', value: mine > 0 ? mine : null },
          { label: 'To revoke', value: c.revoke > 0 ? c.revoke : null },
          { label: 'To change', value: c.change > 0 ? c.change : null },
        ]}
        actions={[
          {
            label: 'Close certification',
            primary: true,
            hidden: !c.runs || closed,
            disabled: undecided > 0,
            hint: undecided > 0 ? `${undecided} ${undecided === 1 ? 'account still waits' : 'accounts still wait'} on a decision.` : undefined,
            loading: close.isPending,
            onSelect: async () => {
              if (await confirm({ title: `Close “${c.name}”?`, description: 'The tally is recorded in the audit log. Revoke and change findings are then applied in Users & access.', confirmLabel: 'Close certification' })) close.mutate();
            },
          },
          { label: 'Export CSV', icon: Download, href: certificationExportUrl(c.id), download: true, hidden: !c.runs },
        ]}
      />

      {closed && findings.length > 0 && (
        <Card animate={false}>
          <CardContent className="space-y-3">
            <SectionTitle title="Findings to apply" description="Each revoke or change, with the account to open in Users & access." wrap />
            <ul className="divide-y divide-line" aria-label="Findings to apply">
              {findings.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-3 py-2">
                  <Badge variant={DECISION_VARIANT[i.decision!]} size="sm">
                    {DECISION_LABEL[i.decision!]}
                  </Badge>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-ink">{i.subject?.name ?? i.subject?.email ?? 'An account'}</span>
                    {i.note && <span className="block text-xs text-ink-muted">{i.note}</span>}
                  </span>
                  {i.subject?.id && (
                    <Button asChild size="sm" variant="outline">
                      <Link to={`/admin/users?status=all&user=${i.subject.id}`}>Apply</Link>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card animate={false}>
        <CardContent className="p-0">
          <div className="flex flex-wrap gap-1.5 border-b border-line p-3" role="group" aria-label="Show">
            {(
              [
                ['all', 'All'],
                ['mine', 'Waiting on me'],
                ['undecided', 'Undecided'],
                ['KEEP', 'Keep'],
                ['REVOKE', 'Revoke'],
                ['CHANGE', 'Change'],
              ] as Array<[Show, string]>
            ).map(([k, label]) => (
              <FilterChip key={k} active={show === k} count={count[k]} onClick={() => setShow(show === k ? 'all' : k)}>
                {label}
              </FilterChip>
            ))}
          </div>
          <DataGrid<CertificationItem>
            id="access-certification-items"
            caption="Accounts to certify"
            noun={{ one: 'account', many: 'accounts' }}
            rows={rows}
            columns={columns}
            rowKey={(i) => i.id}
            urlKey="items"
            toolbar="inline"
            search={{ placeholder: 'Find an account or reviewer' }}
            exportCsv={false}
            activeFilters={show === 'all' ? 0 : 1}
            onClearFilters={() => setShow('all')}
            rowClassName={(i) => (i.mine && !i.decision && !closed ? 'bg-surface-raised/40' : undefined)}
            empty={{ title: 'No account to certify', description: 'This campaign had nobody in scope.' }}
            selectable={
              closed
                ? undefined
                : {
                    disabled: (i) => !canDecide(i),
                    selectAllLabel: 'Select every account you can decide',
                    actions: (ids, clear) => (
                      <Button size="sm" onClick={() => void keepMany(ids, clear)} loading={bulkBusy} disabled={bulkBusy}>
                        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Keep selected
                      </Button>
                    ),
                  }
            }
          />
        </CardContent>
      </Card>

      {noting && (
        <NoteDialog
          decision={noting.decision}
          name={noting.item.subject?.name ?? noting.item.subject?.email ?? 'this account'}
          busy={deciding === noting.item.id}
          onClose={() => setNoting(null)}
          onRecord={(note) => void decide(noting.item, noting.decision, note)}
        />
      )}
    </div>
  );
}
