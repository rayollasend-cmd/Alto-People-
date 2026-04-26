import { useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { submitDirectDeposit } from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Field, SubmitRow, TaskShell, inputCls } from './ProfileInfoTask';

export function DirectDepositTask() {
  const { applicationId } = useParams<{ applicationId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();

  const [type, setType] = useState<'BANK_ACCOUNT' | 'BRANCH_CARD'>('BANK_ACCOUNT');
  const [routingNumber, setRoutingNumber] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountType, setAccountType] = useState<'CHECKING' | 'SAVINGS'>('CHECKING');
  const [branchCardId, setBranchCardId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!applicationId || submitting) return;
    setError(null);
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
        at rest.
      </p>

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
              hint="9 digits. Routing numbers are public; not encrypted."
            >
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{9}"
                required
                value={routingNumber}
                onChange={(e) => setRoutingNumber(e.target.value)}
                className={inputCls}
                maxLength={9}
              />
            </Field>
            <Field label="Account number">
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{4,17}"
                required
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value)}
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
    </TaskShell>
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
