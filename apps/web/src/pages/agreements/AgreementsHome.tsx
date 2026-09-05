import { useEffect, useState } from 'react';
import { safeHref } from '@alto-people/shared';
import { FileSignature, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtDate, parseYmd } from '@/lib/format';
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
import { useI18n } from '@/lib/i18n';
import { hasCapability } from '@/lib/roles';
import { statusTone } from '@/lib/status';
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
  ErrorBanner,
  Input,
  PageHeader,
  SegmentedControl,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@/components/ui';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { FormHint, Label } from '@/components/ui/Label';

// Domain-only codes the shared vocabulary doesn't carry: PENDING_SIGNATURE
// awaits the associate's signature (amber), SIGNED is terminal-good, and a
// SUPERSEDED agreement was deliberately replaced (muted). EXPIRED comes from
// the shared status vocabulary.
const AGREEMENT_STATUS_TONES = {
  PENDING_SIGNATURE: 'pending',
  SIGNED: 'success',
  SUPERSEDED: 'outline',
} as const;

function daysSince(iso: string): number {
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000),
  );
}

/** Local-midnight comparison for the YYYY-MM-DD expiry date. */
function isPastYmd(s: string): boolean {
  const d = parseYmd(s);
  return d !== null && d.getTime() < Date.now();
}

/** Translated display label for an agreement kind (falls back to the
 *  associate-visible custom label for OTHER at the call sites). */
function kindText(
  t: ReturnType<typeof useI18n>['t'],
  kind: AgreementKind,
): string {
  switch (kind) {
    case 'NDA':
      return t('agr.kind.nda');
    case 'NON_COMPETE':
      return t('agr.kind.nonCompete');
    case 'IP_ASSIGNMENT':
      return t('agr.kind.ipAssignment');
    case 'ARBITRATION':
      return t('agr.kind.arbitration');
    case 'EMPLOYMENT_OFFER':
      return t('agr.kind.employmentOffer');
    case 'SEPARATION_AGREEMENT':
      return t('agr.kind.separationAgreement');
    case 'EQUITY_GRANT':
      return t('agr.kind.equityGrant');
    case 'OTHER':
      return t('agr.kind.other');
    default:
      return KIND_LABELS[kind];
  }
}

/** Translated display label for an agreement status badge. */
function statusText(
  t: ReturnType<typeof useI18n>['t'],
  status: AgreementStatus,
): string {
  switch (status) {
    case 'PENDING_SIGNATURE':
      return t('agr.status.pendingSignature');
    case 'SIGNED':
      return t('agr.status.signed');
    case 'EXPIRED':
      return t('agr.status.expired');
    case 'SUPERSEDED':
      return t('agr.status.superseded');
    default:
      return STATUS_LABELS[status];
  }
}

export function AgreementsHome() {
  const { t } = useI18n();
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
  const [loadError, setLoadError] = useState<string | null>(null);
  // Track which row's action is in flight so each Button shows its own
  // spinner. Format: `expire:<id>` or `delete:<id>`.
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const refresh = () => {
    setLoadError(null);
    if (tab === 'all') {
      setRows(null);
      listAgreements({
        status: statusFilter === 'ALL' ? undefined : statusFilter,
      })
        .then((r) => setRows(r.agreements))
        .catch((err) =>
          setLoadError(
            err instanceof ApiError ? err.message : t('agr.loadFailed'),
          ),
        );
    } else {
      setMine(null);
      listMyAgreements()
        .then((r) => setMine(r.agreements))
        .catch((err) =>
          setLoadError(
            err instanceof ApiError ? err.message : t('agr.loadFailed'),
          ),
        );
    }
  };
  useEffect(() => {
    refresh();
  }, [tab, statusFilter]);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('agr.title')}
        subtitle={t('agr.subtitle')}
        breadcrumbs={[{ label: t('agr.crumbSection') }, { label: t('agr.title') }]}
      />

      <div className="flex items-center justify-between">
        <SegmentedControl
          ariaLabel={t('agr.viewAria')}
          value={tab}
          onChange={(v) => setTab(v)}
          options={[
            { value: 'mine' as const, label: t('agr.tab.mine') },
            ...(canManage ? [{ value: 'all' as const, label: 'All' }] : []),
          ]}
        />
        {canManage && tab === 'all' && (
          <div className="flex gap-2">
            <Select
              size="sm"
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
            </Select>
            <Button onClick={() => setShowNew(true)}>
              <Plus className="mr-2 h-4 w-4" /> Issue
            </Button>
          </div>
        )}
      </div>

      {tab === 'mine' ? (
        <Card>
          <CardContent className="p-0">
            {loadError ? (
              <div className="p-6">
                <ErrorBanner
                  action={
                    <Button size="sm" variant="secondary" onClick={refresh}>
                      {t('agr.retry')}
                    </Button>
                  }
                >
                  {loadError}
                </ErrorBanner>
              </div>
            ) : mine === null ? (
              <div className="p-6">
                <SkeletonRows count={3} />
              </div>
            ) : mine.length === 0 ? (
              <EmptyState
                icon={FileSignature}
                title={t('agr.emptyTitle')}
                description={t('agr.emptyDesc')}
              />
            ) : (
              <div className="divide-y divide-navy-secondary">
                {/* flex-wrap on the row: title + badge + Read + Sign were
                    crammed into one non-wrapping line on 360px phones —
                    where NDAs actually get signed. */}
                {mine.map((a) => (
                  <div key={a.id} className="p-4 flex flex-wrap items-center gap-3">
                    <div className="flex-1">
                      <div className="text-sm font-medium text-white">
                        {a.kind === 'OTHER' && a.customLabel
                          ? a.customLabel
                          : kindText(t, a.kind)}
                      </div>
                      <div className="text-xs text-silver">
                        {a.signedAt
                          ? t('agr.signedOn', { date: fmtDate(a.signedAt) })
                          : t('agr.awaitingSignature')}
                        {a.expiresOn &&
                          ` · ${t('agr.expiresOn', { date: fmtDate(parseYmd(a.expiresOn)) })}`}
                      </div>
                    </div>
                    <Badge variant={statusTone(a.status, { overrides: AGREEMENT_STATUS_TONES })}>
                      {statusText(t, a.status)}
                    </Badge>
                    {a.documentUrl && (
                      <Button
                        size="sm"
                        variant="outline"
                        asChild
                        className="coarse:min-h-11"
                      >
                        <a
                          href={safeHref(a.documentUrl)}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {t('agr.read')} ↗
                        </a>
                      </Button>
                    )}
                    {a.status === 'PENDING_SIGNATURE' && (
                      <Button
                        size="sm"
                        onClick={() => setSignRow(a)}
                        className="coarse:min-h-11"
                      >
                        {t('agr.sign')}
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
            {loadError ? (
              <div className="p-6">
                <ErrorBanner
                  action={
                    <Button size="sm" variant="secondary" onClick={refresh}>
                      Retry
                    </Button>
                  }
                >
                  {loadError}
                </ErrorBanner>
              </div>
            ) : rows === null ? (
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
                    <TableHead className="hidden md:table-cell">Signed</TableHead>
                    <TableHead className="hidden md:table-cell">Expires</TableHead>
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
                        <div className="text-xs2 text-silver/70 md:hidden">
                          {a.signedAt
                            ? `Signed ${fmtDate(a.signedAt)}`
                            : 'Not signed'}
                          {a.expiresOn && ` · expires ${fmtDate(parseYmd(a.expiresOn))}`}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm">
                        {a.kind === 'OTHER' && a.customLabel
                          ? a.customLabel
                          : KIND_LABELS[a.kind]}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusTone(a.status, { overrides: AGREEMENT_STATUS_TONES })}>
                          {STATUS_LABELS[a.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm text-silver hidden md:table-cell">
                        {a.signedAt ? (
                          fmtDate(a.signedAt)
                        ) : a.status === 'PENDING_SIGNATURE' ? (
                          <span
                            className={
                              daysSince(a.createdAt) >= 7
                                ? 'text-alert'
                                : 'text-silver'
                            }
                          >
                            Unsigned · {daysSince(a.createdAt)}d
                          </span>
                        ) : (
                          fmtDate(a.signedAt)
                        )}
                      </TableCell>
                      <TableCell className="text-sm hidden md:table-cell">
                        {a.expiresOn ? (
                          <span
                            className={
                              isPastYmd(a.expiresOn)
                                ? 'text-alert'
                                : 'text-silver'
                            }
                          >
                            {fmtDate(parseYmd(a.expiresOn))}
                          </span>
                        ) : (
                          <span className="text-silver">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right space-x-2">
                        {canManage &&
                          a.status !== 'EXPIRED' &&
                          a.status !== 'SUPERSEDED' && (
                            <Button
                              variant="ghost"
                              size="xs"
                              loading={pendingKey === `expire:${a.id}`}
                              onClick={async () => {
                                if (
                                  !(await confirm({
                                    title: 'Expire this agreement now?',
                                    description:
                                      'Agreements past their expiry date are expired automatically by a daily sweep — use this to expire one immediately.',
                                    destructive: true,
                                  }))
                                )
                                  return;
                                setPendingKey(`expire:${a.id}`);
                                try {
                                  await expireAgreement(a.id);
                                  refresh();
                                } catch (err) {
                                  toast.error(
                                    err instanceof ApiError
                                      ? err.message
                                      : 'Failed.',
                                  );
                                } finally {
                                  setPendingKey(null);
                                }
                              }}
                              className="text-silver hover:text-warning can-hover:opacity-60 group-hover:opacity-100 group-focus-within:opacity-100"
                            >
                              Expire
                            </Button>
                          )}
                        {canManage && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            loading={pendingKey === `delete:${a.id}`}
                            aria-label="Delete agreement"
                            onClick={async () => {
                              if (
                                !(await confirm({
                                  title: 'Delete this agreement record?',
                                  description:
                                    'The record is soft-deleted and the deletion is recorded in the audit trail.',
                                  destructive: true,
                                }))
                              )
                                return;
                              setPendingKey(`delete:${a.id}`);
                              try {
                                await deleteAgreement(a.id);
                                toast.success('Agreement deleted.');
                                refresh();
                              } catch (err) {
                                toast.error(
                                  err instanceof ApiError
                                    ? err.message
                                    : 'Failed.',
                                );
                              } finally {
                                setPendingKey(null);
                              }
                            }}
                            className="text-silver hover:text-alert can-hover:opacity-60 group-hover:opacity-100 group-focus-within:opacity-100"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
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
  const [associate, setAssociate] = useState<PickedAssociate | null>(null);
  const [kind, setKind] = useState<AgreementKind>('NDA');
  const [customLabel, setCustomLabel] = useState('');
  const [documentUrl, setDocumentUrl] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!associate) {
      toast.error('Pick an associate.');
      return;
    }
    if (kind === 'OTHER' && !customLabel.trim()) {
      toast.error('Custom label required for OTHER.');
      return;
    }
    setSaving(true);
    try {
      await issueAgreement({
        associateId: associate.id,
        kind,
        customLabel: kind === 'OTHER' ? customLabel.trim() : null,
        documentUrl: documentUrl.trim() || null,
        effectiveDate: effectiveDate || null,
        expiresOn: expiresOn || null,
        notes: notes.trim() || null,
      });
      toast.success('Issued — the associate has been notified.');
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
          <Label>Associate</Label>
          <div className="mt-1">
            <AssociatePicker value={associate} onChange={setAssociate} />
          </div>
          <FormHint id="issue-agreement-associate-hint">
            Search the directory by name.
          </FormHint>
        </div>
        <div>
          <Label htmlFor="issue-agreement-kind">Kind</Label>
          <Select
            id="issue-agreement-kind"
            className="mt-1"
            value={kind}
            onChange={(e) => setKind(e.target.value as AgreementKind)}
          >
            {(Object.keys(KIND_LABELS) as AgreementKind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </div>
        {kind === 'OTHER' && (
          <div>
            <Label htmlFor="issue-agreement-custom-label">Custom label</Label>
            <Input
              id="issue-agreement-custom-label"
              className="mt-1"
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
              aria-describedby="issue-agreement-custom-label-hint"
            />
            <FormHint id="issue-agreement-custom-label-hint">
              Example: "Mutual confidentiality side letter".
            </FormHint>
          </div>
        )}
        <div>
          <Label htmlFor="issue-agreement-url">Document URL</Label>
          <Input
            id="issue-agreement-url"
            type="url"
            className="mt-1"
            value={documentUrl}
            onChange={(e) => setDocumentUrl(e.target.value)}
            aria-describedby="issue-agreement-url-hint"
          />
          <FormHint id="issue-agreement-url-hint">
            Public link to the signed PDF or DocuSign envelope.
          </FormHint>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="issue-agreement-effective">Effective</Label>
            <Input
              id="issue-agreement-effective"
              type="date"
              className="mt-1"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="issue-agreement-expires">Expires</Label>
            <Input
              id="issue-agreement-expires"
              type="date"
              className="mt-1"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
              aria-describedby="issue-agreement-expires-hint"
            />
            <FormHint id="issue-agreement-expires-hint">
              Expires automatically on this date — no manual step needed.
            </FormHint>
          </div>
        </div>
        <div>
          <Label htmlFor="issue-agreement-notes">Notes</Label>
          <Textarea
            id="issue-agreement-notes"
            className="mt-1 h-20"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter className="flex-wrap">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Issue'}
        </Button>
        <p className="w-full text-right text-xs text-silver">
          The associate is notified immediately and reminded weekly until
          signed.
        </p>
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
  const { t } = useI18n();
  const [signature, setSignature] = useState('');
  const [saving, setSaving] = useState(false);
  // No attached document → nothing to read → nothing to legally agree to.
  // Signing is blocked until HR attaches the file.
  const missingDoc = !row.documentUrl;

  const submit = async () => {
    if (missingDoc) return;
    if (!signature.trim()) {
      toast.error(t('agr.signatureRequired'));
      return;
    }
    setSaving(true);
    try {
      await signAgreement(row.id, signature.trim());
      toast.success(t('agr.signedToast'));
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('agr.failed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>
          {t('agr.signTitle', {
            label:
              row.kind === 'OTHER' && row.customLabel
                ? row.customLabel
                : kindText(t, row.kind),
          })}
        </DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {row.documentUrl ? (
          <a
            href={safeHref(row.documentUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-gold hover:underline"
          >
            {t('agr.readDocument')}
          </a>
        ) : (
          <div role="alert" className="text-sm text-alert">
            {t('agr.missingDoc')}
          </div>
        )}
        {row.notes && (
          <div className="text-sm text-silver italic">{row.notes}</div>
        )}
        <div>
          <Label>{t('agr.signatureLabel')}</Label>
          <Input
            className="mt-1"
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            placeholder={t('agr.signaturePlaceholder')}
            disabled={missingDoc}
          />
        </div>
        {!missingDoc && (
          <div className="text-xs text-silver">
            {t('agr.signatureLegal')}
          </div>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          {t('agr.cancel')}
        </Button>
        <Button onClick={submit} disabled={saving || missingDoc}>
          {saving ? t('agr.signing') : t('agr.sign')}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
