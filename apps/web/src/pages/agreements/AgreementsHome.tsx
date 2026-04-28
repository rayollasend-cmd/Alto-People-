import { useEffect, useState } from 'react';
import { FileSignature, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import {
  deleteAgreement,
  expireAgreement,
  issueAgreement,
  KIND_LABELS,
  listAgreements,
  listMyAgreements,
  signAgreement,
  STATUS_LABELS,
  type AgreementKind,
  type AgreementRow,
  type AgreementStatus,
  type MyAgreement,
} from '@/lib/agreements122Api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
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
  EmptyState,
  Input,
  PageHeader,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';

const STATUS_VARIANT: Record<
  AgreementStatus,
  'pending' | 'success' | 'destructive' | 'outline'
> = {
  PENDING_SIGNATURE: 'pending',
  SIGNED: 'success',
  EXPIRED: 'destructive',
  SUPERSEDED: 'outline',
};

export function AgreementsHome() {
  const { user } = useAuth();
  const confirm = useConfirm();
  const canManage = user ? hasCapability(user.role, 'manage:documents') : false;
  const [tab, setTab] = useState<'all' | 'mine'>('mine');
  const [rows, setRows] = useState<AgreementRow[] | null>(null);
  const [mine, setMine] = useState<MyAgreement[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<AgreementStatus | 'ALL'>(
    'PENDING_SIGNATURE',
  );
  const [showNew, setShowNew] = useState(false);
  const [signRow, setSignRow] = useState<MyAgreement | null>(null);

  const refresh = () => {
    if (tab === 'all') {
      setRows(null);
      listAgreements({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
      })
        .then((r) => setRows(r.agreements))
        .catch(() => setRows([]));
    } else {
      setMine(null);
      listMyAgreements()
        .then((r) => setMine(r.agreements))
        .catch(() => setMine([]));
    }
  };
  useEffect(() => {
    refresh();
  }, [tab, statusFilter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Agreements"
        subtitle="NDAs, non-competes, IP assignments, arbitration, equity grants. Per-associate one-off legal documents."
        breadcrumbs={[{ label: 'Compliance' }, { label: 'Agreements' }]}
      />

      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          <Button
            size="sm"
            variant={tab === 'mine' ? 'primary' : 'ghost'}
            onClick={() => setTab('mine')}
          >
            Mine
          </Button>
          {canManage && (
            <Button
              size="sm"
              variant={tab === 'all' ? 'primary' : 'ghost'}
              onClick={() => setTab('all')}
            >
              All
            </Button>
          )}
        </div>
        {canManage && tab === 'all' && (
          <div className="flex gap-2">
            <select
              className="text-xs bg-midnight border border-navy-secondary rounded p-1.5 text-white"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as AgreementStatus | 'ALL')
              }
            >
              <option value="ALL">All statuses</option>
              {(Object.keys(STATUS_LABELS) as AgreementStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> Issue
            </Button>
          </div>
        )}
      </div>

      {tab === 'mine' ? (
        <Card>
          <CardContent className="p-0">
            {mine === null ? (
              <div className="p-6">
                <SkeletonRows count={3} />
              </div>
            ) : mine.length === 0 ? (
              <EmptyState
                icon={FileSignature}
                title="No agreements"
                description="You haven't been issued any agreements yet."
              />
            ) : (
              <div className="divide-y divide-navy-secondary">
                {mine.map((a) => (
                  <div key={a.id} className="p-4 flex items-center gap-3">
                    <div className="flex-1">
                      <div className="text-sm font-medium text-white">
                        {a.kind === 'OTHER' && a.customLabel
                          ? a.customLabel
                          : KIND_LABELS[a.kind]}
                      </div>
                      <div className="text-xs text-silver">
                        {a.signedAt
                          ? `Signed ${new Date(a.signedAt).toLocaleDateString()}`
                          : 'Awaiting your signature'}
                        {a.expiresOn && ` · expires ${a.expiresOn}`}
                      </div>
                    </div>
                    <Badge variant={STATUS_VARIANT[a.status]}>
                      {STATUS_LABELS[a.status]}
                    </Badge>
                    {a.documentUrl && (
                      <a
                        href={a.documentUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-blue-300 hover:underline"
                      >
                        Read ↗
                      </a>
                    )}
                    {a.status === 'PENDING_SIGNATURE' && (
                      <Button size="sm" onClick={() => setSignRow(a)}>
                        Sign
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            {rows === null ? (
              <div className="p-6">
                <SkeletonRows count={4} />
              </div>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={FileSignature}
                title="No agreements"
                description="Nothing matches this filter."
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Associate</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Signed</TableHead>
                    <TableHead>Expires</TableHead>
                    <TableHead className="text-right"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((a) => (
                    <TableRow key={a.id} className="group">
                      <TableCell>
                        <div className="font-medium text-white">
                          {a.associateName}
                        </div>
                        <div className="text-xs text-silver">
                          {a.associateEmail}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {a.kind === 'OTHER' && a.customLabel
                          ? a.customLabel
                          : KIND_LABELS[a.kind]}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[a.status]}>
                          {STATUS_LABELS[a.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-silver">
                        {a.signedAt
                          ? new Date(a.signedAt).toLocaleDateString()
                          : '—'}
                      </TableCell>
                      <TableCell className="text-sm">
                        {a.expiresOn ? (
                          <span
                            className={
                              new Date(a.expiresOn) < new Date()
                                ? 'text-destructive'
                                : 'text-silver'
                            }
                          >
                            {a.expiresOn}
                          </span>
                        ) : (
                          <span className="text-silver">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right space-x-2">
                        {canManage &&
                          a.status !== 'EXPIRED' &&
                          a.status !== 'SUPERSEDED' && (
                            <button
                              onClick={async () => {
                                if (!(await confirm({ title: 'Mark this agreement expired?', destructive: true })))
                                  return;
                                try {
                                  await expireAgreement(a.id);
                                  refresh();
                                } catch (err) {
                                  toast.error(
                                    err instanceof ApiError
                                      ? err.message
                                      : 'Failed.',
                                  );
                                }
                              }}
                              className="text-xs text-silver hover:text-amber-400 opacity-60 group-hover:opacity-100"
                            >
                              Expire
                            </button>
                          )}
                        {canManage && (
                          <button
                            onClick={async () => {
                              if (!(await confirm({ title: 'Delete this agreement record?', destructive: true })))
                                return;
                              try {
                                await deleteAgreement(a.id);
                                refresh();
                              } catch (err) {
                                toast.error(
                                  err instanceof ApiError
                                    ? err.message
                                    : 'Failed.',
                                );
                              }
                            }}
                            className="text-silver hover:text-destructive opacity-60 group-hover:opacity-100"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {showNew && (
        <NewAgreementDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {signRow && (
        <SignDrawer
          row={signRow}
          onClose={() => setSignRow(null)}
          onSaved={() => {
            setSignRow(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewAgreementDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [associateId, setAssociateId] = useState('');
  const [kind, setKind] = useState<AgreementKind>('NDA');
  const [customLabel, setCustomLabel] = useState('');
  const [documentUrl, setDocumentUrl] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!associateId.trim()) {
      toast.error('Associate ID required.');
      return;
    }
    if (kind === 'OTHER' && !customLabel.trim()) {
      toast.error('Custom label required for OTHER.');
      return;
    }
    setSaving(true);
    try {
      await issueAgreement({
        associateId: associateId.trim(),
        kind,
        customLabel: kind === 'OTHER' ? customLabel.trim() : null,
        documentUrl: documentUrl.trim() || null,
        effectiveDate: effectiveDate || null,
        expiresOn: expiresOn || null,
        notes: notes.trim() || null,
      });
      toast.success('Issued.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Issue agreement</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Associate ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={associateId}
            onChange={(e) => setAssociateId(e.target.value)}
          />
        </div>
        <div>
          <Label>Kind</Label>
          <select
            className="mt-1 w-full bg-midnight border border-navy-secondary rounded p-2 text-white text-sm"
            value={kind}
            onChange={(e) => setKind(e.target.value as AgreementKind)}
          >
            {(Object.keys(KIND_LABELS) as AgreementKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        {kind === 'OTHER' && (
          <div>
            <Label>Custom label</Label>
            <Input
              className="mt-1"
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
              placeholder="e.g. Mutual confidentiality side letter"
            />
          </div>
        )}
        <div>
          <Label>Document URL</Label>
          <Input
            type="url"
            className="mt-1"
            value={documentUrl}
            onChange={(e) => setDocumentUrl(e.target.value)}
            placeholder="https://…"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Effective</Label>
            <Input
              type="date"
              className="mt-1"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
          </div>
          <div>
            <Label>Expires</Label>
            <Input
              type="date"
              className="mt-1"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label>Notes</Label>
          <textarea
            className="mt-1 w-full h-20 rounded-md border border-navy-secondary bg-midnight p-2 text-white text-sm"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Issue'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function SignDrawer({
  row,
  onClose,
  onSaved,
}: {
  row: MyAgreement;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [signature, setSignature] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!signature.trim()) {
      toast.error('Type your full name to sign.');
      return;
    }
    setSaving(true);
    try {
      await signAgreement(row.id, signature.trim());
      toast.success('Signed.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>
          Sign — {row.kind === 'OTHER' && row.customLabel ? row.customLabel : KIND_LABELS[row.kind]}
        </DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {row.documentUrl ? (
          <a
            href={row.documentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-blue-300 hover:underline"
          >
            Read the document →
          </a>
        ) : (
          <div className="text-sm text-silver">
            No document URL provided. Ask HR for the file before signing.
          </div>
        )}
        {row.notes && (
          <div className="text-sm text-silver italic">{row.notes}</div>
        )}
        <div>
          <Label>Type your full legal name to sign</Label>
          <Input
            className="mt-1"
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            placeholder="Jane Q. Smith"
          />
        </div>
        <div className="text-xs text-silver">
          By signing, you agree this is a legally binding electronic signature.
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Signing…' : 'Sign'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
