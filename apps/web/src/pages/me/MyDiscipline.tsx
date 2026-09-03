import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  KIND_LABELS,
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

/**
 * The associate's own disciplinary record — the page the "please
 * acknowledge" notification links to (/me/discipline/:id). Before this
 * existed, that link 404'd and the only acknowledge UI lived behind an
 * HR-admin gate, so the signature loop was unreachable for the person
 * legally asked to sign.
 */
export function MyDiscipline() {
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
        title="My record"
        subtitle="Formal notices addressed to you. Acknowledging confirms you received and read a notice — it does not mean you agree with it."
        breadcrumbs={[{ label: 'My profile', to: '/me' }, { label: 'Record' }]}
      />
      {loadError && (
        <ErrorBanner
          action={
            <button
              type="button"
              onClick={() => void refresh()}
              className="underline underline-offset-2 hover:text-white"
            >
              Retry
            </button>
          }
        >
          Couldn&rsquo;t load your record.
        </ErrorBanner>
      )}
      {actions === null && !loadError && <SkeletonRows count={2} />}
      {actions !== null && actions.length === 0 && (
        <EmptyState
          icon={ShieldAlert}
          title="Nothing on file"
          description="You have no disciplinary notices. Keep it that way — we're glad to have you."
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
          ← Back to my profile
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
          <div className="text-white font-medium">{KIND_LABELS[a.kind]}</div>
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
              ? 'Needs your acknowledgment'
              : a.status === 'ACKNOWLEDGED'
                ? 'Acknowledged'
                : 'Rescinded'}
          </Badge>
        </div>
        <div className="text-xs text-silver tabular-nums">
          Incident {fmtDate(parseYmd(a.incidentDate) ?? a.incidentDate)} ·
          Effective {fmtDate(parseYmd(a.effectiveDate) ?? a.effectiveDate)}
          {a.suspensionDays ? ` · ${a.suspensionDays}-day suspension` : ''}
        </div>
        <p className="text-sm text-silver whitespace-pre-wrap">{a.description}</p>
        {a.expectedAction && (
          <div className="text-sm">
            <span className="text-silver/70">What we need from you: </span>
            <span className="text-white">{a.expectedAction}</span>
          </div>
        )}
        {a.rescindedAt && (
          <div className="text-xs text-silver border-t border-navy-secondary pt-2">
            Rescinded {fmtDateTime(a.rescindedAt)}
            {a.rescindedReason ? ` — ${a.rescindedReason}` : ''}
          </div>
        )}
        {a.acknowledgedAt && (
          <div className="text-xs text-silver border-t border-navy-secondary pt-2">
            You acknowledged this {fmtDateTime(a.acknowledgedAt)} —{' '}
            <span className="italic">{a.acknowledgedSig}</span>
          </div>
        )}
        {a.status === 'ACTIVE' && (
          <div className="space-y-2 border-t border-navy-secondary pt-3">
            <Label>Acknowledge with your signature</Label>
            <p className="text-xs text-silver">
              Type your full name exactly as it appears:{' '}
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
                Signature must match your name on file.
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
                  toast.success('Acknowledged — thank you.');
                  onChanged();
                } catch (err) {
                  toast.error(
                    err instanceof ApiError
                      ? err.message
                      : 'Could not record the acknowledgment.',
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              I acknowledge
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
