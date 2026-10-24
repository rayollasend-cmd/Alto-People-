import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, Plus } from '@/components/ui/icons';
import {
  addEmployerAccount,
  confirmDeposits,
  disableAccount,
  startVerification,
  setFundingAccount,
  type AccountStatus,
  type BankingSummary,
  type EmployerAccount,
} from '@/lib/bankingApi';
import { Badge, type BadgeProps } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SkeletonRows } from '@/components/ui/Skeleton';
import { useConfirm } from '@/lib/confirm';
import { fmtDate } from '@/lib/format';
import { enumWords, known } from '@/lib/known';

/** The employer's operating accounts: add, prove ownership, choose the one payroll pulls from. */

const STATUS: Record<AccountStatus, { label: string; tone: NonNullable<BadgeProps['variant']> }> = {
  UNVERIFIED: { label: 'Not verified', tone: 'pending' },
  MICRODEPOSITS_SENT: { label: 'Deposits sent', tone: 'info' },
  PRENOTE_SENT: { label: 'Test sent', tone: 'info' },
  VERIFIED: { label: 'Verified', tone: 'success' },
  FAILED: { label: 'Couldn’t verify', tone: 'destructive' },
  DISABLED: { label: 'Removed', tone: 'default' },
};
/** STATUS for a value from the server — one this screen doesn't know yet reads as words (lib/known). */
const statusOf = (k: string) => known(STATUS, k, () => ({ label: enumWords(k), tone: 'default' as const }));

/** ABA check digit (3, 7, 1 weights). */
export function routingLooksValid(r: string): boolean {
  if (!/^\d{9}$/.test(r)) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  return r.split('').reduce((s, d, i) => s + Number(d) * w[i]!, 0) % 10 === 0;
}

export function AccountsTab({ summary }: { summary: BankingSummary | undefined }) {
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<EmployerAccount | null>(null);
  if (!summary) return <SkeletonRows count={3} />;
  const accounts = summary.accounts;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-muted">Payroll is pulled from one verified account. A new account is proven with two small deposits or a zero-dollar test.</p>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus className="mr-1.5 h-4 w-4" aria-hidden /> Add account
        </Button>
      </div>
      {accounts.length === 0 ? (
        <EmptyState icon={Building2} title="No operating account yet" description="Add the business checking account payroll should be pulled from." action={<Button size="sm" onClick={() => setAdding(true)}>Add account</Button>} />
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {accounts.map((a) => (
            <AccountCard key={a.id} a={a} isFunding={summary.profile.fundingAccountId === a.id} own={summary.profile.settlement === 'OWN_ACCOUNT'} onConfirm={() => setConfirming(a)} />
          ))}
        </ul>
      )}
      {adding && <AddAccountDialog onClose={() => setAdding(false)} />}
      {confirming && <ConfirmDepositsDialog account={confirming} onClose={() => setConfirming(null)} />}
    </div>
  );
}

function AccountCard({ a, isFunding, own, onConfirm }: { a: EmployerAccount; isFunding: boolean; own: boolean; onConfirm: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['payroll-banking'] });
  const verify = useMutation({
    mutationFn: (method: 'MICRODEPOSITS' | 'PRENOTE') => startVerification(a.id, method),
    onSuccess: (r) => {
      toast.success(r.status === 'PRENOTE_SENT' ? 'Test sent. The account verifies itself in two banking days if the bank doesn’t send it back.' : 'Two small deposits are on their way. They show on the statement in one to two banking days.');
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const use = useMutation({ mutationFn: () => setFundingAccount(a.id), onSuccess: () => { toast.success(own ? `Payroll is drawn on ····${a.accountLast4}; a balanced file debits it for the total.` : `Payroll will be pulled from ····${a.accountLast4}.`); refresh(); }, onError: (e: Error) => toast.error(e.message) });
  const remove = useMutation({ mutationFn: () => disableAccount(a.id), onSuccess: () => { toast.success('Account removed.'); refresh(); }, onError: (e: Error) => toast.error(e.message) });
  const s = statusOf(a.status);
  return (
    <li>
      <Card className={isFunding ? 'border-gold/50' : undefined}>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium text-ink">{a.label}</p>
              <p className="text-sm text-ink-muted">{`${a.bankName ? `${a.bankName} · ` : ''}${a.accountType === 'SAVINGS' ? 'Savings' : 'Checking'} ····${a.accountLast4} · routing ${a.routingNumber}`}</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {isFunding && <Badge variant="accent">{own ? 'Payroll is drawn on this account' : 'Payroll pulls from here'}</Badge>}
              <Badge variant={s.tone}>{s.label}</Badge>
            </div>
          </div>
          <p className="text-xs text-ink-muted">
            {a.status === 'VERIFIED' && a.verifiedAt
              ? `Verified ${fmtDate(a.verifiedAt)}.`
              : a.status === 'MICRODEPOSITS_SENT'
                ? `Two deposits under $1 sent ${a.microDepositSentAt ? fmtDate(a.microDepositSentAt) : ''}. ${a.attemptsLeft} tries left to enter them.`
                : a.status === 'PRENOTE_SENT'
                  ? 'A zero-dollar test is out. It verifies two banking days after it settles unless the bank sends it back.'
                  : a.status === 'FAILED'
                    ? 'The bank sent the test back or the amounts didn’t match. Check the numbers and add the account again.'
                    : `Added ${fmtDate(a.createdAt)}. Verify it before payroll can pull from it.`}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {a.status === 'UNVERIFIED' && (
              <>
                <Button size="sm" onClick={() => verify.mutate('MICRODEPOSITS')} loading={verify.isPending && verify.variables === 'MICRODEPOSITS'}>
                  Send two small deposits
                </Button>
                <Button size="sm" variant="outline" onClick={() => verify.mutate('PRENOTE')} loading={verify.isPending && verify.variables === 'PRENOTE'}>
                  Send a zero-dollar test
                </Button>
              </>
            )}
            {a.status === 'MICRODEPOSITS_SENT' && (
              <Button size="sm" onClick={onConfirm}>
                Enter the amounts
              </Button>
            )}
            {a.status === 'VERIFIED' && !isFunding && (
              <Button size="sm" onClick={() => use.mutate()} loading={use.isPending}>
                {own ? 'Draw payroll on this account' : 'Pull payroll from this account'}
              </Button>
            )}
            {!isFunding && (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (await confirm({ title: `Remove ····${a.accountLast4}?`, description: 'Payroll stops using it. Files already sent aren’t affected.', confirmLabel: 'Remove', cancelLabel: 'Keep it', destructive: true })) remove.mutate();
                }}
              >
                Remove
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </li>
  );
}

function AddAccountDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [label, setLabel] = useState('Operating account');
  const [bankName, setBankName] = useState('');
  const [routing, setRouting] = useState('');
  const [account, setAccount] = useState('');
  const [again, setAgain] = useState('');
  const [type, setType] = useState<'CHECKING' | 'SAVINGS'>('CHECKING');
  const routingError = routing.length === 9 && !routingLooksValid(routing) ? 'That isn’t a valid routing number. Check the nine digits at the bottom left of a check.' : null;
  const againError = again && again !== account ? 'The account numbers don’t match.' : null;
  const ready = label.trim() && routingLooksValid(routing) && /^\d{4,17}$/.test(account) && again === account;
  const save = useMutation({
    mutationFn: () => addEmployerAccount({ label: label.trim(), bankName: bankName.trim() || null, routingNumber: routing, accountNumber: account, accountType: type }),
    onSuccess: () => {
      toast.success('Account added. Verify it next.');
      void qc.invalidateQueries({ queryKey: ['payroll-banking'] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const digits = (v: string, n: number) => v.replace(/\D/g, '').slice(0, n);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an operating account</DialogTitle>
          <DialogDescription>The business account payroll is pulled from. The account number is stored encrypted.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) save.mutate();
          }}
        >
          <Field label="Name" required>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
          </Field>
          <Field label="Bank" hint="Optional, for your reference.">
            <Input value={bankName} onChange={(e) => setBankName(e.target.value)} maxLength={120} />
          </Field>
          <Field label="Routing number" required error={routingError}>
            <Input value={routing} onChange={(e) => setRouting(digits(e.target.value, 9))} inputMode="numeric" autoComplete="off" />
          </Field>
          <Field label="Account number" required>
            <Input value={account} onChange={(e) => setAccount(digits(e.target.value, 17))} inputMode="numeric" autoComplete="off" />
          </Field>
          <Field label="Account number again" required error={againError}>
            <Input value={again} onChange={(e) => setAgain(digits(e.target.value, 17))} inputMode="numeric" autoComplete="off" />
          </Field>
          <Field label="Account type">
            <Select value={type} onChange={(e) => setType(e.target.value as 'CHECKING' | 'SAVINGS')}>
              <option value="CHECKING">Checking</option>
              <option value="SAVINGS">Savings</option>
            </Select>
          </Field>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={save.isPending} disabled={!ready}>
              Add account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmDepositsDialog({ account, onClose }: { account: EmployerAccount; onClose: () => void }) {
  const qc = useQueryClient();
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const cents = (v: string) => Math.round(Number(v.replace(/[^0-9.]/g, '')) * (v.includes('.') ? 100 : 1));
  const valid = (v: string) => cents(v) >= 1 && cents(v) <= 99;
  const save = useMutation({
    mutationFn: () => confirmDeposits(account.id, [cents(a), cents(b)]),
    onSuccess: (r) => {
      if (r.status === 'VERIFIED') toast.success(`····${account.accountLast4} is verified.`);
      else if (r.status === 'FAILED') toast.error('Those didn’t match five times, so the account is locked. Add it again to start over.');
      else toast.error(`Those don’t match. ${r.attemptsLeft} tr${r.attemptsLeft === 1 ? 'y' : 'ies'} left.`);
      void qc.invalidateQueries({ queryKey: ['payroll-banking'] });
      if (r.status !== 'MICRODEPOSITS_SENT') onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{`Enter the two deposits to ····${account.accountLast4}`}</DialogTitle>
          <DialogDescription>{`Find two deposits under $1 from “ACCTVERIFY” on the statement. Enter each in cents or dollars, in any order. ${account.attemptsLeft} tries left.`}</DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-2 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid(a) && valid(b)) save.mutate();
          }}
        >
          <Field label="First deposit" required hint="For example 0.32">
            <Input value={a} onChange={(e) => setA(e.target.value)} inputMode="decimal" autoComplete="off" />
          </Field>
          <Field label="Second deposit" required hint="For example 0.07">
            <Input value={b} onChange={(e) => setB(e.target.value)} inputMode="decimal" autoComplete="off" />
          </Field>
          <DialogFooter className="col-span-2">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" loading={save.isPending} disabled={!valid(a) || !valid(b)}>
              Verify account
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
