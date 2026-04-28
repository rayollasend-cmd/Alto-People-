import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import {
  getDirectDeposit,
  submitDirectDeposit,
  type DirectDepositStatus,
} from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { Field, SubmitRow, TaskShell, inputCls } from './ProfileInfoTask';

// ABA mod-10 checksum — same one the API enforces. Keeping client-side too
// gives instant validation feedback before they hit submit.
function isValidAba(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = routing.split('').map(Number);
  const sum =
    3 * (d[0] + d[3] + d[6]) +
    7 * (d[1] + d[4] + d[7]) +
    1 * (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

export function DirectDepositTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [status, setStatus] = useState<DirectDepositStatus | null>(null);
  const [type, setType] = useState<'BANK_ACCOUNT' | 'BRANCH_CARD'>('BANK_ACCOUNT');
  const [routingNumber, setRoutingNumber] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountType, setAccountType] = useState<'CHECKING' | 'SAVINGS'>('CHECKING');
  const [branchCardId, setBranchCardId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [replaceMethod, setReplaceMethod] = useState(false);

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;

  // Hydrate so re-opens show the redacted view rather than blank fields.
  useEffect(() => {
    if (!applicationId) return;
    void getDirectDeposit(applicationId).then((s) => {
      setStatus(s);
      if (s.hasPayoutMethod) {
        if (s.type === 'BANK_ACCOUNT') setType('BANK_ACCOUNT');
        if (s.type === 'BRANCH_CARD') setType('BRANCH_CARD');
        if (s.accountType === 'CHECKING' || s.accountType === 'SAVINGS') {
          setAccountType(s.accountType);
        }
      }
    });
  }, [applicationId]);

  const onFile = !!status?.hasPayoutMethod;
  const showForm = !onFile || replaceMethod;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!applicationId || submitting) return;
    setError(null);

    if (type === 'BANK_ACCOUNT' && !isValidAba(routingNumber)) {
      setError(
        'Routing number is invalid — please check the 9 digits printed on your check or shown in your bank app.'
      );
      return;
    }

    setSubmitting(true);
    try {
      const body =
        type === 'BANK_ACCOUNT'
          ? {
              type: 'BANK_ACCOUNT' as const,
              routingNumber,
              accountNumber,
              accountType,
            }
          : {
              type: 'BRANCH_CARD' as const,
              branchCardId,
            };
      await submitDirectDeposit(applicationId, body);
      navigate(backTo, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Submission failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <TaskShell title="Direct deposit" backTo={backTo}>
      <p className="text-silver text-sm mb-5">
        Net pay is sent to the method you choose. Account numbers are encrypted
        at rest the moment you submit; only the last 4 digits are ever shown
        back.
      </p>

      {onFile && !replaceMethod && (
        <PayoutOnFileCard
          status={status!}
          onReplace={() => setReplaceMethod(true)}
          backTo={backTo}
          navigate={navigate}
        />
      )}

      {showForm && (
        <>
          {onFile && (
            <button
              type="button"
              onClick={() => setReplaceMethod(false)}
              className="text-xs text-silver hover:text-white mb-3"
            >
              ← Cancel — keep existing method
            </button>
          )}

          <div role="tablist" className="flex gap-2 mb-5">
            <TabButton active={type === 'BANK_ACCOUNT'} onClick={() => setType('BANK_ACCOUNT')}>
              Bank account
            </TabButton>
            <TabButton active={type === 'BRANCH_CARD'} onClick={() => setType('BRANCH_CARD')}>
              Branch card
            </TabButton>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {type === 'BANK_ACCOUNT' ? (
              <>
                <Field
                  label="Routing number"
                  hint="9 digits, printed on your check or in your bank app. We validate the ABA checksum to catch typos."
                >
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="\d{9}"
                    required
                    value={routingNumber}
                    onChange={(e) => setRoutingNumber(e.target.value.replace(/\D/g, '').slice(0, 9))}
                    className={inputCls}
                    maxLength={9}
                  />
                  {routingNumber.length === 9 && (
                    <span
                      className={cn(
                        'text-xs mt-1 inline-flex items-center gap-1',
                        isValidAba(routingNumber) ? 'text-success' : 'text-alert'
                      )}
                    >
                      {isValidAba(routingNumber)
                        ? '✓ Valid routing number format'
                        : '✗ ABA checksum failed — please re-check'}
                    </span>
                  )}
                </Field>
                <Field label="Account number">
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="\d{4,17}"
                    required
                    value={accountNumber}
                    onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 17))}
                    className={inputCls}
                    maxLength={17}
                    autoComplete="off"
                  />
                </Field>
                <Field label="Account type">
                  <select
                    value={accountType}
                    onChange={(e) =>
                      setAccountType(e.target.value as 'CHECKING' | 'SAVINGS')
                    }
                    className={inputCls}
                  >
                    <option value="CHECKING">Checking</option>
                    <option value="SAVINGS">Savings</option>
                  </select>
                </Field>
              </>
            ) : (
              <Field label="Branch card ID" hint="Provided when you receive your Branch card.">
                <input
                  type="text"
                  required
                  value={branchCardId}
                  onChange={(e) => setBranchCardId(e.target.value)}
                  className={inputCls}
                />
              </Field>
            )}

            {error && (
              <p role="alert" className="text-sm text-alert">
                {error}
              </p>
            )}

            <SubmitRow submitting={submitting} backTo={backTo} label="Save payout method" />
          </form>
        </>
      )}
    </TaskShell>
  );
}

function PayoutOnFileCard({
  status,
  onReplace,
  backTo,
  navigate,
}: {
  status: DirectDepositStatus;
  onReplace: () => void;
  backTo: string;
  navigate: (to: string) => void;
}) {
  return (
    <div className="rounded-md border border-success/30 bg-success/[0.05] p-4 mb-5">
      <div className="flex items-center gap-2 mb-2">
        <CheckCircle2 className="h-4 w-4 text-success" />
        <span className="text-sm text-success font-medium">
          Payout method on file
        </span>
      </div>
      {status.type === 'BANK_ACCOUNT' ? (
        <div className="text-sm text-white space-y-1">
          <div>
            <span className="text-silver text-xs uppercase tracking-widest">
              Account
            </span>
            <div className="font-mono">
              {status.accountType ?? 'CHECKING'} ••••{' '}
              {status.accountLast4 ?? '••••'}
            </div>
          </div>
          <div>
            <span className="text-silver text-xs uppercase tracking-widest">
              Routing
            </span>
            <div className="font-mono">{status.routingMasked ?? '•••••••••'}</div>
          </div>
        </div>
      ) : status.type === 'BRANCH_CARD' ? (
        <div className="text-sm text-white">
          <span className="text-silver text-xs uppercase tracking-widest">
            Branch card
          </span>
          <div className="font-mono">{status.branchCardId ?? '(on file)'}</div>
        </div>
      ) : (
        <div className="text-sm text-silver">Method on file.</div>
      )}
      {status.updatedAt && (
        <div className="text-xs text-silver/70 mt-2">
          Updated {new Date(status.updatedAt).toLocaleString()}
          {status.verifiedAt
            ? ' · Verified'
            : ' · Pending verification'}
        </div>
      )}
      <div className="flex items-center gap-3 mt-3">
        <Button type="button" variant="outline" size="sm" onClick={onReplace}>
          Replace method
        </Button>
        <Button type="button" size="sm" onClick={() => navigate(backTo)}>
          Back to checklist
        </Button>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'px-4 py-2 rounded text-sm border',
        active
          ? 'border-gold text-gold bg-gold/10'
          : 'border-navy-secondary text-silver hover:text-white'
      )}
    >
      {children}
    </button>
  );
}
