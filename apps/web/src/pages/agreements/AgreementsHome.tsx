import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { safeHref } from '@alto-people/shared';
import { FileSignature, Plus, Trash2 } from '@/components/ui/icons';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { fmtDate, parseYmd } from '@/lib/format';
import {
  deleteAgreement,
  expireAgreement,
  issueAgreement,
  KIND_LABELS,
  getAgreementsSummary,
  listAgreements,
  listMyAgreements,
  signAgreement,
  STATUS_LABELS,
  type AgreementKind,
  type AgreementRow,
  type AgreementStatus,
  type MyAgreement,
} from '@/lib/agreements122Api';
import { useAuth, useTerm } from '@/lib/auth';
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
  SegmentedControl,
  Select,
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { MetricCard } from '@/components/ui/MetricCard';
import { MetricStrip } from '@/components/ui/MetricStrip';
import { useUrlParam } from '@/lib/useUrlState';
import { AssociatePicker, type PickedAssociate } from '@/components/ui/AssociatePicker';
import { ListTemplate } from '@/components/templates';
import { FormHint, Label } from '@/components/ui/Label';
import { MyPolicies } from './MyPolicies';
import '@/lib/i18n/en/agr';
import '@/lib/i18n/en/agreementsPage';

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

const TABS = ['mine', 'policies', 'all'] as const;
type Tab = (typeof TABS)[number];
/** The All view's filter: one status, every status, or the rows behind a tile. */
type ViewFilter = AgreementStatus | 'ALL' | 'SIGNED30' | 'EXPIRING30';
const VIEW_FILTERS: readonly ViewFilter[] = ['ALL', 'PENDING_SIGNATURE', 'SIGNED', 'EXPIRED', 'SUPERSEDED', 'SIGNED30', 'EXPIRING30'];

export function AgreementsHome() {
  const { t } = useI18n();
  const term = useTerm();
  const { user } = useAuth();
  const confirm = useConfirm();
  const canManage = user ? hasCapability(user.role, 'manage:documents') : false;
  // HR lands on every agreement (their own "mine" is rarely the job); the
  // tab is in the URL — ?tab=policies is the Inbox's "Policies to sign".
  const [tabParam, setTab] = useUrlParam<Tab>('tab', canManage ? 'all' : 'mine', TABS, { history: 'push' });
  const tab: Tab = tabParam === 'all' && !canManage ? 'mine' : tabParam === 'policies' && !user?.associateId ? (canManage ? 'all' : 'mine') : tabParam;

  const [statusFilter, setStatusFilter] = useUrlParam<ViewFilter>('status', 'ALL', VIEW_FILTERS);
  const [showNew, setShowNew] = useState(false);
  const [signRow, setSignRow] = useState<MyAgreement | null>(null);
  // Track which row's action is in flight so each Button shows its own
  // spinner. Format: `expire:<id>` or `delete:<id>`.
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const rowsQuery = useQuery({
    queryKey: ['AgreementsHome', 'rows', statusFilter],
    queryFn: () =>
      listAgreements(
        statusFilter === 'SIGNED30'
          ? { window: 'signed30' }
          : statusFilter === 'EXPIRING30'
            ? { window: 'expiring30' }
            : { status: statusFilter === 'ALL' ? undefined : statusFilter },
      ),
    enabled: tab === 'all',
  });
  const summaryQuery = useQuery({ queryKey: ['AgreementsHome', 'summary'], queryFn: getAgreementsSummary, enabled: canManage && tab === 'all' });
  const summary = summaryQuery.data;
  const mineQuery = useQuery({
    queryKey: ['AgreementsHome', 'mine'],
    queryFn: () => listMyAgreements(),
    enabled: tab === 'mine',
  });
  const rows: AgreementRow[] | null = rowsQuery.data?.agreements ?? null;
  const mine: MyAgreement[] | null = mineQuery.data?.agreements ?? null;
  const activeError = tab === 'all' ? rowsQuery.error : mineQuery.error;
  const loadError = activeError
    ? activeError instanceof ApiError
      ? activeError.message
      : t('agr.loadFailed')
    : null;
  // Every write touches both views (an issued agreement is also "mine"),
  // so invalidate the pair: the visible one re-reads now, the other when
  // its tab next opens.
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['AgreementsHome'] });

  const tabOptions = [
    { value: 'mine' as const, label: t('agr.tab.mine') },
    ...(user?.associateId ? [{ value: 'policies' as const, label: t('agr.tab.policies') }] : []),
    ...(canManage ? [{ value: 'all' as const, label: t('agreementsPage.tabAll') }] : []),
  ];

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
      title={t('agr.title')}
      // HR reads what the page holds; an associate reads what's asked of them.
      subtitle={canManage ? t('agr.subtitle') : t('agr.subtitleMine')}
      actions={canManage ? [{ label: t('agreementsPage.issueAgreement'), icon: Plus, primary: true, onSelect: () => setShowNew(true) }] : undefined}
    >
      {tabOptions.length > 1 && (
        <SegmentedControl ariaLabel={t('agr.viewAria')} value={tab} onChange={(v) => setTab(v)} options={tabOptions} />
      )}

      {canManage && tab === 'all' && summary && (
        <MetricStrip label={t('agreementsPage.tilesAria')} empty={summary.awaitingSignature + summary.signed30d + summary.expiring30d === 0 && statusFilter === 'ALL' && rows !== null && rows.length === 0}>
          <MetricCard
            label={t('agreementsPage.tileAwaiting')}
            value={summary.awaitingSignature}
            hint={t('agreementsPage.tileAwaitingHint')}
            tone={summary.awaitingSignature > 0 ? 'warning' : 'default'}
            onClick={() => setStatusFilter(statusFilter === 'PENDING_SIGNATURE' ? 'ALL' : 'PENDING_SIGNATURE')}
            selected={statusFilter === 'PENDING_SIGNATURE'}
          />
          <MetricCard
            label={t('agreementsPage.tileSigned')}
            value={summary.signed30d}
            hint={t('agreementsPage.tileSignedHint')}
            onClick={() => setStatusFilter(statusFilter === 'SIGNED30' ? 'ALL' : 'SIGNED30')}
            selected={statusFilter === 'SIGNED30'}
          />
          <MetricCard
            label={t('agreementsPage.tileExpiring')}
            value={summary.expiring30d}
            hint={t('agreementsPage.tileExpiringHint')}
            tone={summary.expiring30d > 0 ? 'warning' : 'default'}
            onClick={() => setStatusFilter(statusFilter === 'EXPIRING30' ? 'ALL' : 'EXPIRING30')}
            selected={statusFilter === 'EXPIRING30'}
          />
        </MetricStrip>
      )}

      {tab === 'policies' ? (
        <MyPolicies />
      ) : tab === 'mine' ? (
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
            <div className="p-3">
              <DataGrid<AgreementRow>
                id="agreements"
                caption={t('agr.title')}
                rows={rows}
                rowKey={(a) => a.id}
                loading={rows === null && !loadError}
                error={loadError}
                onRetry={refresh}
                search={{ placeholder: t('agreementsPage.searchPlaceholder', { worker: term('worker') }) }}
                urlKey="agreements"
                exportCsv={{ filename: 'agreements' }}
                activeFilters={statusFilter === 'ALL' ? 0 : 1}
                onClearFilters={() => setStatusFilter('ALL')}
                filters={
                  <Select
                    size="sm"
                    aria-label={t('agreementsPage.colStatus')}
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as ViewFilter)}
                  >
                    <option value="ALL">{t('agreementsPage.allStatuses')}</option>
                    {(Object.keys(STATUS_LABELS) as AgreementStatus[]).map((st) => (
                      <option key={st} value={st}>
                        {statusText(t, st)}
                      </option>
                    ))}
                    <option value="SIGNED30">{t('agreementsPage.tileSigned')}</option>
                    <option value="EXPIRING30">{t('agreementsPage.tileExpiring')}</option>
                  </Select>
                }
                empty={{
                  icon: FileSignature,
                  title: t('agr.emptyTitle'),
                  description: t('agreementsPage.emptyAll'),
                }}
                columns={[
                  {
                    key: 'associate',
                    header: term('worker'),
                    accessor: (a) => a.associateName,
                    sortable: true,
                    primary: true,
                    className: 'font-medium text-white',
                  },
                  {
                    key: 'email',
                    header: t('agreementsPage.colEmail'),
                    accessor: (a) => a.associateEmail,
                    sortable: true,
                    cardMeta: true,
                    className: 'text-xs text-silver',
                  },
                  {
                    key: 'kind',
                    header: t('agreementsPage.kind'),
                    accessor: (a) => (a.kind === 'OTHER' && a.customLabel ? a.customLabel : kindText(t, a.kind)),
                    sortable: true,
                    cardMeta: true,
                    className: 'text-sm',
                  },
                  {
                    key: 'status',
                    header: t('agreementsPage.colStatus'),
                    accessor: (a) => statusText(t, a.status),
                    sortable: true,
                    cell: (a) => (
                      <Badge variant={statusTone(a.status, { overrides: AGREEMENT_STATUS_TONES })}>
                        {statusText(t, a.status)}
                      </Badge>
                    ),
                  },
                  {
                    key: 'signed',
                    header: t('agreementsPage.colSigned'),
                    accessor: (a) => a.signedAt,
                    csv: (a) => (a.signedAt ? a.signedAt.slice(0, 10) : a.status === 'PENDING_SIGNATURE' ? `unsigned ${daysSince(a.createdAt)}d` : ''),
                    sortable: true,
                    searchable: false,
                    className: 'text-sm text-silver whitespace-nowrap',
                    cell: (a) =>
                      a.signedAt ? (
                        fmtDate(a.signedAt)
                      ) : a.status === 'PENDING_SIGNATURE' ? (
                        // Seven days unsigned is the point at which someone
                        // should walk over and ask.
                        <span className={daysSince(a.createdAt) >= 7 ? 'text-alert' : 'text-silver'}>
                          {t('agreementsPage.unsignedDays', { days: daysSince(a.createdAt) })}
                        </span>
                      ) : (
                        fmtDate(a.signedAt)
                      ),
                  },
                  {
                    key: 'expires',
                    header: t('agreementsPage.expires'),
                    accessor: (a) => a.expiresOn,
                    sortable: true,
                    searchable: false,
                    className: 'text-sm whitespace-nowrap',
                    cell: (a) =>
                      a.expiresOn ? (
                        <span className={isPastYmd(a.expiresOn) ? 'text-alert' : 'text-silver'}>
                          {fmtDate(parseYmd(a.expiresOn))}
                        </span>
                      ) : (
                        <span className="text-silver">—</span>
                      ),
                  },
                  ...(canManage
                    ? [
                        {
                          key: 'actions',
                          header: t('agreementsPage.colActions'),
                          accessor: () => null,
                          searchable: false,
                          csv: () => '',
                          align: 'right' as const,
                          stopRowClick: true,
                          className: 'whitespace-nowrap space-x-2',
                          cell: (a: AgreementRow) => (
                            <>
                              {a.status !== 'EXPIRED' && a.status !== 'SUPERSEDED' && (
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  loading={pendingKey === `expire:${a.id}`}
                                  onClick={async () => {
                                    if (
                                      !(await confirm({
                                        title: t('agreementsPage.expireTitle'),
                                        description: t('agreementsPage.expireDesc'),
                                        destructive: true,
                                      }))
                                    )
                                      return;
                                    setPendingKey(`expire:${a.id}`);
                                    try {
                                      await expireAgreement(a.id);
                                      refresh();
                                    } catch (err) {
                                      toast.error(err instanceof ApiError ? err.message : t('agr.failed'));
                                    } finally {
                                      setPendingKey(null);
                                    }
                                  }}
                                  className="text-silver hover:text-warning"
                                >
                                  {t('agreementsPage.expire')}
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                loading={pendingKey === `delete:${a.id}`}
                                aria-label={t('agreementsPage.deleteAria')}
                                onClick={async () => {
                                  if (
                                    !(await confirm({
                                      title: t('agreementsPage.deleteTitle'),
                                      description: t('agreementsPage.deleteDesc'),
                                      destructive: true,
                                    }))
                                  )
                                    return;
                                  setPendingKey(`delete:${a.id}`);
                                  try {
                                    await deleteAgreement(a.id);
                                    toast.success(t('agreementsPage.deleted'));
                                    refresh();
                                  } catch (err) {
                                    toast.error(err instanceof ApiError ? err.message : t('agr.failed'));
                                  } finally {
                                    setPendingKey(null);
                                  }
                                }}
                                className="text-silver hover:text-alert"
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </>
                          ),
                        } satisfies GridColumn<AgreementRow>,
                      ]
                    : []),
                ]}
              />
            </div>
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
    </ListTemplate>
  );
}

function NewAgreementDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const term = useTerm();
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
      toast.error(
        t(/^[aeiou]/i.test(term('worker')) ? 'agreementsPage.pickWorkerAn' : 'agreementsPage.pickWorkerA', {
          worker: term('worker').toLowerCase(),
        }),
      );
      return;
    }
    if (kind === 'OTHER' && !customLabel.trim()) {
      toast.error(t('agreementsPage.customLabelRequired'));
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
      toast.success(t('agreementsPage.issuedToast', { worker: term('worker').toLowerCase() }));
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
        <DrawerTitle>{t('agreementsPage.issueTitle')}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>{term('worker')}</Label>
          <div className="mt-1">
            <AssociatePicker value={associate} onChange={setAssociate} />
          </div>
          <FormHint id="issue-agreement-associate-hint">
            {t('agreementsPage.pickerHint')}
          </FormHint>
        </div>
        <div>
          <Label htmlFor="issue-agreement-kind">{t('agreementsPage.kind')}</Label>
          <Select
            id="issue-agreement-kind"
            className="mt-1"
            value={kind}
            onChange={(e) => setKind(e.target.value as AgreementKind)}
          >
            {(Object.keys(KIND_LABELS) as AgreementKind[]).map((k) => (
              <option key={k} value={k}>
                {kindText(t, k)}
              </option>
            ))}
          </Select>
        </div>
        {kind === 'OTHER' && (
          <div>
            <Label htmlFor="issue-agreement-custom-label">{t('agreementsPage.customLabel')}</Label>
            <Input
              id="issue-agreement-custom-label"
              className="mt-1"
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
              aria-describedby="issue-agreement-custom-label-hint"
            />
            <FormHint id="issue-agreement-custom-label-hint">
              {t('agreementsPage.customLabelHint')}
            </FormHint>
          </div>
        )}
        <div>
          <Label htmlFor="issue-agreement-url">{t('agreementsPage.documentUrl')}</Label>
          <Input
            id="issue-agreement-url"
            type="url"
            className="mt-1"
            value={documentUrl}
            onChange={(e) => setDocumentUrl(e.target.value)}
            aria-describedby="issue-agreement-url-hint"
          />
          <FormHint id="issue-agreement-url-hint">
            {t('agreementsPage.documentUrlHint')}
          </FormHint>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="issue-agreement-effective">{t('agreementsPage.effective')}</Label>
            <Input
              id="issue-agreement-effective"
              type="date"
              className="mt-1"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="issue-agreement-expires">{t('agreementsPage.expires')}</Label>
            <Input
              id="issue-agreement-expires"
              type="date"
              className="mt-1"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
              aria-describedby="issue-agreement-expires-hint"
            />
            <FormHint id="issue-agreement-expires-hint">
              {t('agreementsPage.expiresHint')}
            </FormHint>
          </div>
        </div>
        <div>
          <Label htmlFor="issue-agreement-notes">{t('agreementsPage.notes')}</Label>
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
          {t('agr.cancel')}
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? t('agreementsPage.saving') : t('agreementsPage.issue')}
        </Button>
        <p className="w-full text-right text-xs text-silver">
          {t('agreementsPage.notifyNote', { worker: term('worker').toLowerCase() })}
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
