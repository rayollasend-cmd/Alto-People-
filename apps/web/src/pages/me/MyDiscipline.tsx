import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { ShieldAlert } from '@/components/ui/icons';
import { toast } from 'sonner';
import {
  acknowledgeDisciplinaryAction,
  listMyDisciplinaryActions,
  respondToDisciplinaryAction,
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
  SkeletonRows,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { ListTemplate } from '@/components/templates';
import { useI18n, type MessageKey } from '@/lib/i18n';
import '@/lib/i18n/en/record';

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
  const actionsQuery = useQuery({
    queryKey: ['MyDiscipline', 'actions'],
    queryFn: () => listMyDisciplinaryActions(),
  });
  const actions: MyDisciplinaryAction[] | null = actionsQuery.data?.actions ?? null;
  const loadError = actionsQuery.isError;
  const refresh = async () => {
    await actionsQuery.refetch();
  };

  // A deep link to a notice that isn't on the record (rescinded and removed,
  // or someone else's) says so instead of quietly showing the list (F500 G5).
  const missingLink = !!actionId && actions !== null && !actions.some((a) => a.id === actionId);
  // Deep-linked record floats to the top and starts highlighted.
  const ordered =
    actions === null
      ? null
      : [...actions].sort((a, b) =>
          a.id === actionId ? -1 : b.id === actionId ? 1 : 0,
        );

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        className="mx-auto max-w-2xl"
        // "Notices on file", under My records — "My record" beside a
        // "My records" group meant two things (F500 G5). The trail comes
        // from the sidebar (My records), not a hand-written one.
        title={t('record.titleNotices')}
        subtitle={t('record.subtitle')}
    >
      {missingLink && (
        <p role="status" className="rounded-md border border-line px-3 py-2 text-sm text-ink-muted" data-testid="record-missing">
          {t('record.missing')}
        </p>
      )}
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
          description={t('record.emptyDesc2')}
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
    </ListTemplate>
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
      <CardContent className="space-y-3">
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
            {/* Said where the signature is, not only in a clamped subtitle. */}
            <p className="text-sm text-ink" data-testid="record-not-agree">{t('record.ackNotAgree')}</p>
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
              aria-label={t('record.signatureAria')}
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
        {a.status !== 'RESCINDED' && <ResponseBlock action={a} onSaved={onChanged} />}
      </CardContent>
    </Card>
  );
}

/** The employee's own side, under the notice: HR reads it on the action (F500 G5). */
function ResponseBlock({ action: a, onSaved }: { action: MyDisciplinaryAction; onSaved: () => void }) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(a.employeeResponse ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await respondToDisciplinaryAction(a.id, text.trim());
      toast.success(t('record.responseSaved'));
      setEditing(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : t('record.responseFailed'));
    } finally {
      setBusy(false);
    }
  };
  if (!editing) {
    return (
      <div className="space-y-1 border-t border-navy-secondary pt-3" data-testid="record-response">
        {a.employeeResponse ? (
          <>
            <div className="text-xs text-silver">
              {t('record.yourResponse')}
              {a.employeeRespondedAt ? ` · ${fmtDateTime(a.employeeRespondedAt)}` : ''}
            </div>
            <p className="whitespace-pre-wrap text-sm text-ink">{a.employeeResponse}</p>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              {t('record.editResponse')}
            </Button>
          </>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            {t('record.addResponse')}
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2 border-t border-navy-secondary pt-3">
      <Label>
        {t('record.responseLabel')}
        <Textarea className="mt-1" rows={5} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
      </Label>
      <p className="text-xs text-silver">{t('record.responseHint', { n: 2000 - text.length })}</p>
      <div className="flex gap-2">
        <Button size="sm" loading={busy} disabled={busy || text.trim().length === 0} onClick={() => void save()}>
          {t('record.saveResponse')}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}
