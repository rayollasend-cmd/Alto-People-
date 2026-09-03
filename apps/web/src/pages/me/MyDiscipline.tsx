import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  acknowledgeDisciplinaryAction,
  listMyDisciplinaryActions,
  type MyDisciplinaryAction,
} from '@/lib/discipline118Api';
import { ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime, parseYmd } from '@/lib/format';
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  ErrorBanner,
  Input,
  PageHeader,
  SkeletonRows,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { useI18n, type MessageKey } from '@/lib/i18n';

/**
 * The associate's own disciplinary record — the page the "please
 * acknowledge" notification links to (/me/discipline/:id). Before this
 * existed, that link 404'd and the only acknowledge UI lived behind an
 * HR-admin gate, so the signature loop was unreachable for the person
 * legally asked to sign.
 */
export function MyDiscipline() {
  const { t } = useI18n();
  const { actionId } = useParams<{ actionId?: string }>();
  const [actions, setActions] = useState<MyDisciplinaryAction[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  const refresh = async () => {
    try {
      setLoadError(false);
      const r = await listMyDisciplinaryActions();
      setActions(r.actions);
    } catch {
      setLoadError(true);
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  // Deep-linked record floats to the top and starts highlighted.
  const ordered =
    actions === null
      ? null
      : [...actions].sort((a, b) =>
          a.id === actionId ? -1 : b.id === actionId ? 1 : 0,
        );

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title={t('record.title')}
        subtitle={t('record.subtitle')}
        breadcrumbs={[{ label: t('record.title') }]}
      />
      {loadError && (
        <ErrorBanner
          action={
            <button
              type="button"
              onClick={() => void refresh()}
              className="underline underline-offset-2 hover:text-white"
            >
              {t('common.retry')}
            </button>
          }
        >
          {t('record.loadFailed')}
        </ErrorBanner>
      )}
      {actions === null && !loadError && <SkeletonRows count={2} />}
      {actions !== null && actions.length === 0 && (
        <EmptyState
          icon={ShieldAlert}
          title={t('record.emptyTitle')}
          description={t('record.emptyDesc')}
        />
      )}
      <div className="space-y-4">
        {ordered?.map((a) => (
          <ActionCard
            key={a.id}
            action={a}
            highlighted={a.id === actionId}
            onChanged={() => void refresh()}
          />
        ))}
      </div>
      <div className="mt-6">
        <Link to="/me" className="text-sm text-silver hover:text-gold">
          {t('record.back')}
        </Link>
      </div>
    </div>
  );
}

function ActionCard({
  action: a,
  highlighted,
  onChanged,
}: {
  action: MyDisciplinaryAction;
  highlighted: boolean;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [signature, setSignature] = useState('');
  const [busy, setBusy] = useState(false);
  const signatureMatches =
    signature.trim().toLowerCase() === a.associateName.trim().toLowerCase();

  return (
    <Card
      className={
        highlighted ? 'border-gold/60 ring-1 ring-gold/30' : undefined
      }
    >
      <CardContent className="space-y-3 pt-5">
        <div className="flex items-center justify-between gap-3">
          <div className="text-white font-medium">{t(('record.kind.' + a.kind) as MessageKey)}</div>
          <Badge
            variant={
              a.status === 'RESCINDED'
                ? 'default'
                : a.status === 'ACKNOWLEDGED'
                  ? 'success'
                  : 'destructive'
            }
          >
            {a.status === 'ACTIVE'
              ? t('record.needsAck')
              : a.status === 'ACKNOWLEDGED'
                ? t('record.acked')
                : t('record.rescinded')}
          </Badge>
        </div>
        <div className="text-xs text-silver tabular-nums">
          {t('record.dates', {
            incident: fmtDate(parseYmd(a.incidentDate) ?? a.incidentDate),
            effective: fmtDate(parseYmd(a.effectiveDate) ?? a.effectiveDate),
          })}
          {a.suspensionDays
            ? t('record.suspensionDays', { days: String(a.suspensionDays) })
            : ''}
        </div>
        <p className="text-sm text-silver whitespace-pre-wrap">{a.description}</p>
        {a.expectedAction && (
          <div className="text-sm">
            <span className="text-silver/70">{t('record.expected')}</span>
            <span className="text-white">{a.expectedAction}</span>
          </div>
        )}
        {a.rescindedAt && (
          <div className="text-xs text-silver border-t border-navy-secondary pt-2">
            {t('record.rescindedAt', { when: fmtDateTime(a.rescindedAt) })}
            {a.rescindedReason ? ` — ${a.rescindedReason}` : ''}
          </div>
        )}
        {a.acknowledgedAt && (
          <div className="text-xs text-silver border-t border-navy-secondary pt-2">
            {t('record.ackedAt', { when: fmtDateTime(a.acknowledgedAt) })}
            <span className="italic">{a.acknowledgedSig}</span>
          </div>
        )}
        {a.status === 'ACTIVE' && (
          <div className="space-y-2 border-t border-navy-secondary pt-3">
            <Label>{t('record.signLabel')}</Label>
            <p className="text-xs text-silver">
              {t('record.signHint')}
              <span className="text-white">{a.associateName}</span>
            </p>
            <Input
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              placeholder={a.associateName}
              invalid={signature.trim().length > 0 && !signatureMatches}
              aria-label="Signature"
            />
            {signature.trim().length > 0 && !signatureMatches && (
              <p role="alert" className="text-xs text-alert">
                {t('record.signMismatch')}
              </p>
            )}
            <Button
              size="sm"
              loading={busy}
              disabled={!signatureMatches || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await acknowledgeDisciplinaryAction(a.id, signature.trim());
                  toast.success(t('record.ackThanks'));
                  onChanged();
                } catch (err) {
                  toast.error(
                    err instanceof ApiError
                      ? err.message
                      : t('record.ackFailed'),
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('record.ackButton')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
