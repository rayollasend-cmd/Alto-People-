import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listProviderConnections, providerCatalog, type ProviderKind, type ProviderKindSummary } from '@/lib/providersApi';
import { getDisbursementWebhookStatus, type DisbursementWebhookStatus } from '@/lib/payrollApi';
import { ApiError } from '@/lib/api';
import { fmtCount, fmtDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/lib/cn';
import { ProviderSetupDrawer } from './ProviderSetupDrawer';
import { ProviderManageDrawer } from './ProviderManageDrawer';
import { CONNECTION_BADGE, HEALTH_WORD, environmentLabel, healthLine, kindLook, titleInSentence, type ConnectionWord } from './providerShared';

const PAYOUT_PROVIDER: Record<DisbursementWebhookStatus['provider'], string> = { STUB: 'the platform', WISE: 'Wise', BRANCH: 'Branch' };

/**
 * The state one card shows — the connection's own health, and for Payouts
 * the disbursement rail's too, so a Wise failure is said ONCE, on the
 * Payouts card, with its Reconnect (F500 G4: it used to appear twice, as
 * "Payroll disbursement · Erroring" and "Payouts · Needs attention").
 */
export function cardState(k: ProviderKindSummary, payout: DisbursementWebhookStatus | null): { word: ConnectionWord; line: string | null; waiting: number } {
  const c = k.active;
  const rail = k.kind === 'PAYOUT' && payout && payout.provider !== 'STUB' ? payout : null;
  const waiting = rail?.pendingFinalizedItems ?? 0;
  if (c?.health === 'failing') return { word: 'Failing', line: healthLine(c), waiting };
  if (rail?.health === 'erroring')
    return { word: 'Failing', line: `Failing since ${fmtDateTime(rail.latestError?.at ?? rail.lastEventAt)}${rail.latestError?.notes ? `: ${rail.latestError.notes}` : '.'}`, waiting };
  if (rail?.health === 'stale')
    return { word: 'Needs attention', line: `No word from ${PAYOUT_PROVIDER[rail.provider]}${rail.lastEventAt ? ` since ${fmtDateTime(rail.lastEventAt)}` : ''}. Payouts may be stuck.`, waiting };
  if (c) return { word: HEALTH_WORD[c.health], line: healthLine(c), waiting };
  return { word: 'Not connected', line: null, waiting };
}

/**
 * Settings & trust → Integrations → Screening, filing and payouts: one card
 * per kind. Not connected says what happens today (the manual path) and
 * offers setup; connected says which provider, sandbox or live, and how it
 * is doing — failing says since when and what it said, and offers the one
 * fix, Reconnect, as the page's only gold button.
 */
export function ProvidersSection({ canManage }: { canManage: boolean }) {
  const list = useQuery({ queryKey: ['providers', 'connections'], queryFn: listProviderConnections });
  const catalog = useQuery({ queryKey: ['providers', 'catalog'], queryFn: providerCatalog, staleTime: 30 * 60_000 });
  // The disbursement rail's health (payroll's endpoint). 403 = this person
  // doesn't hold payroll: the Payouts card then reads the connection alone.
  const rail = useQuery({ queryKey: ['WebhookHealthTile', 'status'], queryFn: getDisbursementWebhookStatus, retry: false, refetchInterval: 60_000 });
  const payout = rail.error instanceof ApiError ? null : (rail.data ?? null);
  const [setupKind, setSetupKind] = useState<ProviderKind | null>(null);
  const [manageId, setManageId] = useState<string | null>(null);

  const kinds = list.data?.kinds ?? null;
  const managed = kinds?.flatMap((k) => k.connections).find((c) => c.id === manageId) ?? null;

  return (
    <section aria-labelledby="providers-title" className="space-y-3">
      <SectionTitle
        id="providers-title"
        wrap
        title="Screening, filing and payouts"
        description="The services that work for you from here. Each one is optional — without it, the work is recorded by hand as it is today."
      />
      {list.isError ? (
        <QueryError what="the provider connections" query={list} />
      ) : kinds === null ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Loading provider connections">
          {Array.from({ length: 5 }, (_, i) => (
            <Card key={i}>
              <CardContent className="space-y-3 p-5">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-8 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label="Provider kinds">
          {kinds.map((k) => (
            <KindCard key={k.kind} k={k} payout={payout} canManage={canManage} onSetup={() => setSetupKind(k.kind)} onManage={(id) => setManageId(id)} />
          ))}
        </ul>
      )}
      <ProviderSetupDrawer
        kind={setupKind}
        providers={(catalog.data?.providers ?? []).filter((p) => p.kind === setupKind)}
        onClose={() => setSetupKind(null)}
        onSaved={(id) => {
          void list.refetch();
          setSetupKind(null);
          setManageId(id);
        }}
      />
      <ProviderManageDrawer
        connection={managed}
        info={(catalog.data?.providers ?? []).find((p) => p.id === managed?.provider) ?? null}
        canManage={canManage}
        onClose={() => setManageId(null)}
        onChanged={() => void list.refetch()}
      />
    </section>
  );
}

function KindCard({ k, payout, canManage, onSetup, onManage }: { k: ProviderKindSummary; payout: DisbursementWebhookStatus | null; canManage: boolean; onSetup: () => void; onManage: (id: string) => void }) {
  const { Icon, copy } = kindLook(k.kind);
  const c = k.active;
  const state = cardState(k, payout);
  const failing = state.word === 'Failing';
  return (
    <li>
      <Card className={cn('h-full', failing && 'border-alert/50')}>
        <CardContent className="flex h-full flex-col gap-3 p-5">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-surface-raised text-ink-muted" aria-hidden="true">
              <Icon className="h-4 w-4" />
            </span>
            {/* The badge sits under the title, so a long provider name never squeezes into a column beside it. */}
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-medium text-ink">{copy.title}</h3>
              {c && <p className="text-xs text-ink-muted">{`${c.providerLabel} · ${environmentLabel(c.environment)}`}</p>}
              <Badge size="sm" variant={CONNECTION_BADGE[state.word]} className="mt-1.5">
                {state.word}
              </Badge>
            </div>
          </div>
          <div className="flex-1 space-y-1 text-sm">
            <p className={failing ? 'text-alert' : 'text-ink-muted'}>{state.line ?? copy.manual}</p>
            {state.waiting > 0 && <p className="text-ink-muted">{fmtCount(state.waiting, 'paycheck')} waiting to pay out.</p>}
          </div>
          <div>
            {c ? (
              failing && canManage ? (
                <Button size="sm" onClick={() => onManage(c.id)}>
                  Reconnect {c.providerLabel}
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => onManage(c.id)}>
                  {canManage ? 'Manage' : 'View'}
                </Button>
              )
            ) : canManage ? (
              <Button size="sm" variant={failing ? 'primary' : 'outline'} onClick={onSetup}>
                Set up {titleInSentence(copy.title)}
              </Button>
            ) : (
              <span className="text-xs text-ink-muted">An integrations admin can connect this.</span>
            )}
          </div>
        </CardContent>
      </Card>
    </li>
  );
}
