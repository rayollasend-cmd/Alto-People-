import type { ReactNode } from 'react';
import { useConfirm, useConfirmIfMounted, type ConfirmOptions } from '@/lib/confirm';
import { fmtMoney } from '@/lib/format';

/**
 * THE RULE (deep audit MONEY-10 / MONEY-21): every button that moves money —
 * pulls it from the company's account, pays people, sends a tax payment or a
 * remittance, retries one that failed — asks first, and the question names
 * the amount, where it comes from or goes to, and when. One click never
 * moves money.
 *
 *   const confirmMoney = useMoneyConfirm();
 *   if (!(await confirmMoney({ title: 'Pull payroll funds?', amount: 35493.65,
 *     from: 'Operating ····1234', when: 'Settles Wed, Oct 28', confirmLabel: 'Pull $35,493.65' }))) return;
 *
 * Built on the shared confirm (lib/confirm), so it is one dialog for the app.
 * `moneyConfirmGuard.test.ts` holds the payroll pages to it.
 */
export interface MoneyConfirmOptions {
  /** What happens, as a question ("Pull payroll funds?"). */
  title: string;
  /** The money, in dollars. */
  amount: number;
  /** The amount's label when it is a ceiling, not an exact figure ("Up to"). Defaults to "Amount". */
  amountLabel?: string;
  /** Where it comes from ("Operating ····1234"). */
  from?: string | null;
  /** Where it goes ("IRS", "12 bank accounts"). */
  to?: string | null;
  /** When it moves or lands ("Settles Wed, Oct 28"). */
  when?: string | null;
  /** One more line that matters at this moment (why the last try failed). */
  note?: ReactNode;
  /** The button; defaults to "Send $X". Say the verb and the amount. */
  confirmLabel?: string;
  destructive?: boolean;
  /** The line labels and the cancel button in the reader's language (a translated screen passes them; English by default). */
  labels?: { amount?: string; from?: string; to?: string; when?: string; cancel?: string };
}

/** The facts the dialog shows, as plain lines (also what a test reads). */
export function moneyConfirmLines(o: Pick<MoneyConfirmOptions, 'amount' | 'amountLabel' | 'from' | 'to' | 'when' | 'labels'>): Array<{ label: string; value: string }> {
  const lines: Array<{ label: string; value: string }> = [{ label: o.amountLabel ?? o.labels?.amount ?? 'Amount', value: fmtMoney(o.amount) }];
  if (o.from) lines.push({ label: o.labels?.from ?? 'From', value: o.from });
  if (o.to) lines.push({ label: o.labels?.to ?? 'To', value: o.to });
  if (o.when) lines.push({ label: o.labels?.when ?? 'When', value: o.when });
  return lines;
}

/** The dialog body: the amount and its route, then the note. Inline elements only — it renders inside the dialog's description paragraph. */
export function MoneyConfirmFacts({ amount, amountLabel, from, to, when, note, labels }: Pick<MoneyConfirmOptions, 'amount' | 'amountLabel' | 'from' | 'to' | 'when' | 'note' | 'labels'>) {
  return (
    <span className="mt-1 block space-y-1" data-testid="money-confirm-facts">
      {moneyConfirmLines({ amount, amountLabel, from, to, when, labels }).map((l, i) => (
        <span key={l.label} className="flex justify-between gap-4">
          <span className="text-ink-muted">{l.label}</span>
          <span className={i === 0 ? 'font-semibold tabular-nums text-ink' : 'text-right text-ink'}>{l.value}</span>
        </span>
      ))}
      {note ? <span className="block pt-1 text-ink-muted">{note}</span> : null}
    </span>
  );
}

/** The money confirm: resolves true only when the person presses the button that names the amount. */
export function useMoneyConfirm(): (o: MoneyConfirmOptions) => Promise<boolean> {
  const confirm = useConfirm();
  return (o) => confirm(moneyConfirmOptions(o));
}

/**
 * The same, for a card that can render outside the app shell (a page test, an
 * embed): with no confirm dialog mounted it never says yes — money still
 * never moves on one click.
 */
export function useMoneyConfirmIfMounted(): (o: MoneyConfirmOptions) => Promise<boolean> {
  const confirm = useConfirmIfMounted();
  return (o) => (confirm ? confirm(moneyConfirmOptions(o)) : Promise.resolve(false));
}

function moneyConfirmOptions(o: MoneyConfirmOptions): ConfirmOptions {
  return {
    title: o.title,
    description: <MoneyConfirmFacts amount={o.amount} amountLabel={o.amountLabel} from={o.from} to={o.to} when={o.when} note={o.note} labels={o.labels} />,
    confirmLabel: o.confirmLabel ?? `Send ${fmtMoney(o.amount)}`,
    cancelLabel: o.labels?.cancel ?? 'Not now',
    destructive: o.destructive,
  };
}

/** "Operating at First Bank ····1234" — an account as a money confirm names it. */
export function accountName(a: { label?: string | null; bankName?: string | null; accountLast4?: string | null } | null | undefined): string | null {
  if (!a || !a.accountLast4) return null;
  const name = a.label?.trim() || a.bankName?.trim() || 'Account';
  const bank = a.bankName?.trim() && a.label?.trim() && a.bankName.trim() !== a.label.trim() ? ` at ${a.bankName.trim()}` : '';
  return `${name}${bank} ····${a.accountLast4}`;
}
