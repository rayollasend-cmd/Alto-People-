import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, ClipboardCheck, Download, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth, useRoleLabel } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { fmtDate } from '@/lib/format';
import { INBOX_QUERY_KEY } from '@/lib/inboxApi';
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
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input, Textarea } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui';
import { Drawer, DrawerBody, DrawerDescription, DrawerFooter, DrawerHeader, DrawerTitle } from '@/components/ui/Drawer';
import { cn } from '@/lib/cn';
import type { Role } from '@alto-people/shared';

/**
 * Access pack — access certification campaigns (Settings & trust).
 *
 *   The list: every campaign the organization has run, open ones first,
 *   with how far along each is and what the signed-in person still owes.
 *   The campaign: one row per account in scope — what it held when the
 *   campaign opened — decided by its reviewer (the manager of the person
 *   behind the account, else the owner) as keep, revoke or change, with a
 *   note. Closing needs every row decided; a REVOKE or CHANGE is a finding
 *   the owner acts on in Users & access, so the certification and the
 *   change stay two attributable steps.
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

const CERTS_KEY = ['access-certifications'] as const;

function OpenDrawer({ onClose, onOpened }: { onClose: () => void; onOpened: (id: string) => void }) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<CertificationScope>('INTERNAL');
  const inTwoWeeks = useMemo(() => new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10), []);
  const [due, setDue] = useState(inTwoWeeks);
  const open = useMutation({
    mutationFn: () => openCertification({ name: name.trim(), scope, dueAt: new Date(`${due}T23:59:59`).toISOString() }),
    onSuccess: (r) => {
      toast.success(`Opened. ${r.items} account${r.items === 1 ? '' : 's'} to certify.`);
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
          {SCOPE_LABEL[c.scope]} · {c.items} account{c.items === 1 ? '' : 's'} · {c.status === 'CLOSED' ? `closed ${fmtDate(c.closedAt)}` : `due ${fmtDate(c.dueAt)}`}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {c.mine > 0 && <Badge variant="pending">{c.mine} for you</Badge>}
        {c.revoke > 0 && <Badge variant="destructive">{c.revoke} to revoke</Badge>}
        {c.change > 0 && <Badge variant="pending">{c.change} to change</Badge>}
        <Badge variant={c.status === 'CLOSED' ? 'success' : 'info'}>{c.status === 'CLOSED' ? 'Closed' : `${pct}% decided`}</Badge>
      </div>
    </li>
  );
}

export function AccessCertifications() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: CERTS_KEY, queryFn: listCertifications });
  const [opening, setOpening] = useState(false);
  const qc = useQueryClient();
  const rows = q.data?.certifications ?? [];
  return (
    <ListTemplate
      title="Access certifications"
      subtitle="Every account reviewed by the person accountable for it — keep, revoke or change — on a campaign with a due date and a record."
      primaryAction={
        can('manage:org') ? (
          <Button onClick={() => setOpening(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" /> Open a certification
          </Button>
        ) : undefined
      }
    >
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
    </ListTemplate>
  );
}

function snapshotLine(item: CertificationItem, roleLabel: (r: Role) => string): string {
  const s = item.snapshot;
  const parts: string[] = [];
  if (s.role) parts.push(roleLabel(s.role as Role));
  if (s.additionalRoles?.length) parts.push(`also ${s.additionalRoles.map((r) => roleLabel(r as Role)).join(', ')}`);
  if (s.scopeSiteIds?.length || s.scopeRegionIds?.length) parts.push(`scoped to ${(s.scopeSiteIds?.length ?? 0) + (s.scopeRegionIds?.length ?? 0)} place(s)`);
  if (s.breakGlass) parts.push('break-glass owner');
  parts.push(s.lastSeenAt ? `last seen ${fmtDate(s.lastSeenAt)}` : 'never signed in');
  return parts.join(' · ');
}

function DecideRow({ certId, item, closed, canDecide }: { certId: string; item: CertificationItem; closed: boolean; canDecide: boolean }) {
  const qc = useQueryClient();
  const roleLabel = useRoleLabel();
  const [decision, setDecision] = useState<CertificationDecision | null>(null);
  const [note, setNote] = useState('');
  const decide = useMutation({
    mutationFn: (d: CertificationDecision) => decideCertificationItem(certId, item.id, { decision: d, ...(note.trim() ? { note: note.trim() } : {}) }),
    onSuccess: () => {
      setDecision(null);
      setNote('');
      void qc.invalidateQueries({ queryKey: CERTS_KEY });
      void qc.invalidateQueries({ queryKey: INBOX_QUERY_KEY });
    },
    onError: (err) => toast.error(message(err)),
  });
  const subject = item.subject;
  const name = subject?.name ?? subject?.email ?? 'An account';
  return (
    <li className={cn('p-[var(--d-card)]', item.mine && !item.decision && !closed && 'bg-surface-raised/60')}>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink">{name}</span>
            {subject?.email && subject.name && <span className="text-xs text-ink-muted">{subject.email}</span>}
            {subject?.status && subject.status !== 'ACTIVE' && <Badge variant="default" size="sm">{subject.status.toLowerCase()}</Badge>}
          </div>
          <p className="mt-0.5 text-sm text-ink-muted">{snapshotLine(item, roleLabel)}</p>
          <p className="mt-0.5 text-xs text-ink-muted">Reviewer: {item.reviewer?.name ?? item.reviewer?.email ?? '—'}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {item.decision ? (
            <>
              <Badge variant={DECISION_VARIANT[item.decision]} size="sm">{DECISION_LABEL[item.decision]}</Badge>
              <span className="text-xs text-ink-muted">by {item.decidedBy?.name ?? item.decidedBy?.email ?? '—'}{item.decidedAt ? `, ${fmtDate(item.decidedAt)}` : ''}</span>
            </>
          ) : closed ? null : canDecide ? (
            <>
              <Button size="sm" variant={decision === 'KEEP' ? 'primary' : 'outline'} onClick={() => decide.mutate('KEEP')} loading={decide.isPending && decision === null}>
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Keep
              </Button>
              <Button size="sm" variant={decision === 'CHANGE' ? 'primary' : 'outline'} onClick={() => setDecision(decision === 'CHANGE' ? null : 'CHANGE')}>
                Change
              </Button>
              <Button size="sm" variant={decision === 'REVOKE' ? 'destructive' : 'outline'} onClick={() => setDecision(decision === 'REVOKE' ? null : 'REVOKE')}>
                Revoke
              </Button>
            </>
          ) : (
            <Badge variant="pending" size="sm">Waiting on reviewer</Badge>
          )}
        </div>
      </div>
      {item.decision && item.note && <p className="mt-2 text-sm text-ink">{item.note}</p>}
      {decision && !item.decision && (
        <form
          className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            decide.mutate(decision);
          }}
        >
          <Field label={decision === 'REVOKE' ? 'Why revoke' : 'What should change'} required className="flex-1">
            {(p) => <Textarea {...p} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={decision === 'REVOKE' ? 'Left the team in September.' : 'Should hold Workforce Manager, not Operations Manager.'} />}
          </Field>
          <Button type="submit" size="sm" variant={decision === 'REVOKE' ? 'destructive' : 'primary'} disabled={!note.trim()} loading={decide.isPending}>
            Record {DECISION_LABEL[decision].toLowerCase()}
          </Button>
        </form>
      )}
    </li>
  );
}

export function AccessCertificationPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: [...CERTS_KEY, id], queryFn: () => getCertification(id), enabled: !!id });
  const close = useMutation({
    mutationFn: () => closeCertification(id),
    onSuccess: (t) => {
      toast.success(`Closed: ${t.keep} kept, ${t.revoke} to revoke, ${t.change} to change.`);
      void qc.invalidateQueries({ queryKey: CERTS_KEY });
    },
    onError: (err) => toast.error(message(err)),
  });
  if (q.isPending) return <SkeletonRows count={6} />;
  if (q.isError || !q.data) return <QueryError what="this certification" query={q} />;
  const c = q.data;
  const closed = c.status === 'CLOSED';
  const undecided = c.items.filter((i) => !i.decision).length;
  const mine = c.items.filter((i) => i.mine && !i.decision).length;
  return (
    <div className="space-y-[var(--d-stack)]">
      <PageHeader
        title={c.name}
        subtitle={`${SCOPE_LABEL[c.scope]} · ${c.items.length} account${c.items.length === 1 ? '' : 's'} · ${closed ? `closed ${fmtDate(c.closedAt)}` : `due ${fmtDate(c.dueAt)}`}`}
        breadcrumbs={[{ label: 'Access certifications', to: '/admin/access-certifications' }, { label: c.name }]}
        secondaryActions={
          <>
            <Button asChild variant="ghost" size="sm">
              <Link to="/admin/access-certifications">
                <ArrowLeft className="h-4 w-4" aria-hidden="true" /> All certifications
              </Link>
            </Button>
            {c.runs && (
              <Button asChild variant="outline" size="sm">
                <a href={certificationExportUrl(c.id)} download>
                  <Download className="h-4 w-4" aria-hidden="true" /> Export CSV
                </a>
              </Button>
            )}
          </>
        }
        primaryAction={
          c.runs && !closed ? (
            <Button
              disabled={undecided > 0}
              title={undecided > 0 ? `${undecided} account(s) still wait on a decision.` : undefined}
              loading={close.isPending}
              onClick={async () => {
                if (await confirm({ title: `Close “${c.name}”?`, description: 'The tally is recorded in the audit log. Revoke and change findings are acted on in Users & access.', confirmLabel: 'Close certification' })) close.mutate();
              }}
            >
              Close certification
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-wrap gap-2">
        <Badge variant={closed ? 'success' : 'info'}>{closed ? 'Closed' : `${c.items.length - undecided} of ${c.items.length} decided`}</Badge>
        {mine > 0 && <Badge variant="pending">{mine} waiting on you</Badge>}
        {c.revoke > 0 && <Badge variant="destructive">{c.revoke} to revoke</Badge>}
        {c.change > 0 && <Badge variant="pending">{c.change} to change</Badge>}
      </div>
      <Card animate={false}>
        <CardContent className="p-0">
          <ul className="divide-y divide-line" aria-label="Accounts to certify">
            {[...c.items]
              .sort((a, b) => Number(!!a.decision) - Number(!!b.decision) || Number(b.mine) - Number(a.mine))
              .map((item) => (
                <DecideRow key={item.id} certId={c.id} item={item} closed={closed} canDecide={item.mine || c.runs} />
              ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
