import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useI18n } from '@/lib/i18n';
import {
  getDirectDeposit,
  submitDirectDeposit,
  type DirectDepositStatus,
} from '@/lib/onboardingApi';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { Field, SubmitRow, TaskShell, inputCls, useNextTask } from './ProfileInfoTask';

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
  const { t } = useI18n();
  const navigate = useNavigate();

  const [status, setStatus] = useState<DirectDepositStatus | null>(null);
  const [type, setType] = useState<'BANK_ACCOUNT' | 'BRANCH_CARD'>('BANK_ACCOUNT');
  const [routingNumber, setRoutingNumber] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountType, setAccountType] = useState<'CHECKING' | 'SAVINGS'>('CHECKING');
  const [bankName, setBankName] = useState('');
  const [branchCardId, setBranchCardId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [replaceMethod, setReplaceMethod] = useState(false);

  const isAssociate = user?.role === 'ASSOCIATE';
  const backTo = isAssociate
    ? `/onboarding/me/${applicationId}`
    : `/onboarding/applications/${applicationId}`;
  const next = useNextTask('DIRECT_DEPOSIT');

  // Hydrate so re-opens show the redacted view rather than blank fields.
  useEffect(() => {
    if (!applicationId) return;
    void getDirectDeposit(applicationId)
      .then((s) => {
        setStatus(s);
        if (s.hasPayoutMethod) {
          if (s.type === 'BANK_ACCOUNT') setType('BANK_ACCOUNT');
          if (s.type === 'BRANCH_CARD') setType('BRANCH_CARD');
          if (s.accountType === 'CHECKING' || s.accountType === 'SAVINGS') {
            setAccountType(s.accountType);
          }
          // Safe to prefill — a bank's name isn't a secret, and retyping it on
          // every edit is how it ends up blank or inconsistent.
          if (s.bankName) setBankName(s.bankName);
        }
      })
      .catch((err) => {
        // A silent failure showed the blank "add a bank account" form to
        // someone with a verified account on file — implying nothing was
        // set up and inviting a re-entry that resets verification.
        setError(
          err instanceof ApiError
            ? t('ob.dd.loadFailedWith', { message: err.message })
            : t('ob.dd.loadFailed'),
        );
      });
  }, [applicationId]);

  const onFile = !!status?.hasPayoutMethod;
  const showForm = !onFile || replaceMethod;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!applicationId || submitting) return;
    setError(null);

    if (type === 'BANK_ACCOUNT' && !isValidAba(routingNumber)) {
      setError(t('ob.dd.routingInvalid'));
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
              ...(bankName.trim() ? { bankName: bankName.trim() } : {}),
            }
          : {
              type: 'BRANCH_CARD' as const,
              branchCardId,
            };
      await submitDirectDeposit(applicationId, body);
      navigate(next?.route ?? backTo, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('ob.dd.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <TaskShell title={t('ob.dd.title')} backTo={backTo}>
      <p className="text-silver text-sm mb-5">{t('ob.dd.intro')}</p>

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
              {t('ob.dd.cancelKeepMethod')}
            </button>
          )}

          <div role="tablist" className="flex gap-2 mb-5">
            <TabButton active={type === 'BANK_ACCOUNT'} onClick={() => setType('BANK_ACCOUNT')}>
              {t('ob.dd.bankAccount')}
            </TabButton>
            <TabButton active={type === 'BRANCH_CARD'} onClick={() => setType('BRANCH_CARD')}>
              {t('ob.dd.branchCard')}
            </TabButton>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {type === 'BANK_ACCOUNT' ? (
              <>
                <Field
                  label={t('ob.dd.routingLabel')}
                  required
                  hint={t('ob.dd.routingHint')}
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
                </Field>
                {routingNumber.length === 9 && (
                  <span
                    role="status"
                    className={cn(
                      'text-xs -mt-2 inline-flex items-center gap-1',
                      isValidAba(routingNumber) ? 'text-success' : 'text-alert'
                    )}
                  >
                    {isValidAba(routingNumber)
                      ? t('ob.dd.routingValid')
                      : t('ob.dd.routingChecksumFailed')}
                  </span>
                )}
                <Field label={t('ob.dd.accountNumber')} required>
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
                <Field label={t('ob.dd.accountType')}>
                  <Select
                    value={accountType}
                    onChange={(e) =>
                      setAccountType(e.target.value as 'CHECKING' | 'SAVINGS')
                    }
                  >
                    <option value="CHECKING">{t('ob.dd.checking')}</option>
                    <option value="SAVINGS">{t('ob.dd.savings')}</option>
                  </Select>
                </Field>
                <Field
                  label={t('ob.dd.bankName')}
                  hint={t('ob.dd.bankNameHint')}
                >
                  <input
                    type="text"
                    value={bankName}
                    onChange={(e) => setBankName(e.target.value.slice(0, 120))}
                    className={inputCls}
                    maxLength={120}
                    autoComplete="off"
                    placeholder={t('ob.dd.bankNamePlaceholder')}
                  />
                </Field>
              </>
            ) : (
              <Field label={t('ob.dd.branchCardId')} required hint={t('ob.dd.branchCardIdHint')}>
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

            <SubmitRow submitting={submitting} backTo={backTo} label={t('ob.dd.save')} next={next} />
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
  const { t } = useI18n();
  return (
    <div className="rounded-md border border-success/30 bg-success/[0.05] p-4 mb-5">
      <div className="flex items-center gap-2 mb-2">
        <CheckCircle2 className="h-4 w-4 text-success" />
        <span className="text-sm text-success font-medium">
          {t('ob.dd.onFileTitle')}
        </span>
      </div>
      {status.type === 'BANK_ACCOUNT' ? (
        <div className="text-sm text-white space-y-1">
          <div>
            <span className="text-silver text-xs uppercase tracking-widest">
              {t('ob.dd.accountShort')}
            </span>
            <div className="font-mono">
              {status.accountType === 'SAVINGS' ? t('ob.dd.savings') : t('ob.dd.checking')} ••••{' '}
              {status.accountLast4 ?? '••••'}
            </div>
          </div>
          <div>
            <span className="text-silver text-xs uppercase tracking-widest">
              {t('ob.dd.routingShort')}
            </span>
            <div className="font-mono">{status.routingMasked ?? '•••••••••'}</div>
          </div>
        </div>
      ) : status.type === 'BRANCH_CARD' ? (
        <div className="text-sm text-white">
          <span className="text-silver text-xs uppercase tracking-widest">
            {t('ob.dd.branchCard')}
          </span>
          <div className="font-mono">{status.branchCardId ?? t('ob.dd.onFileFallback')}</div>
        </div>
      ) : (
        <div className="text-sm text-silver">{t('ob.dd.methodOnFile')}</div>
      )}
      {status.updatedAt && (
        <div className="text-xs text-silver/70 mt-2">
          {t('ob.dd.updated', { date: fmtDateTime(status.updatedAt) })}
          {status.verifiedAt
            ? ` · ${t('ob.dd.verified')}`
            : ` · ${t('ob.dd.pendingVerification')}`}
        </div>
      )}
      <div className="flex items-center gap-3 mt-3">
        <Button type="button" variant="outline" size="sm" onClick={onReplace}>
          {t('ob.dd.replaceMethod')}
        </Button>
        <Button type="button" size="sm" onClick={() => navigate(backTo)}>
          {t('ob.dd.backToChecklist')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Kept as role="tab" (not SegmentedControl's radiogroup) — the task's
 * test suite drives this switcher via getByRole('tab'). Styling matches
 * the app-wide segmented-pill selection language.
 */
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
        'px-3 py-1 rounded-full border text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/40 coarse:min-h-11 inline-flex items-center',
        active
          ? 'bg-gold/15 border-gold/50 text-gold'
          : 'bg-navy-secondary/40 border-navy-secondary text-silver hover:text-white'
      )}
    >
      {children}
    </button>
  );
}

