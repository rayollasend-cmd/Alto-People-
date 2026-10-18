import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { updateBankingProfile, type AchSpeed, type BankRail, type BankingProfile, type BankingSummary, type KybStatus } from '@/lib/bankingApi';
import { Button } from '@/components/ui/Button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/Card';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { routingLooksValid } from './AccountsTab';

/**
 * How bank-account pay moves, the identifiers the bank gave you, and the
 * controls on how much can be pulled. Raising a limit goes to a second
 * person; lowering one applies now.
 */

type Draft = {
  bankRail: BankRail;
  achSpeed: AchSpeed;
  submitCutoffEt: string;
  companyName: string;
  companyId: string;
  companyEntryDescription: string;
  immediateDestination: string;
  immediateDestinationName: string;
  immediateOrigin: string;
  immediateOriginName: string;
  originatingDfi: string;
  kybStatus: KybStatus;
  kybNote: string;
  perRun: string;
  perDay: string;
  requirePrenote: boolean;
  collectTaxes: boolean;
  collectGarnishments: boolean;
};

const fromProfile = (p: BankingProfile): Draft => ({
  bankRail: p.bankRail,
  achSpeed: p.achSpeed,
  submitCutoffEt: p.submitCutoffEt,
  companyName: p.companyName ?? '',
  companyId: p.companyId ?? '',
  companyEntryDescription: p.companyEntryDescription,
  immediateDestination: p.immediateDestination ?? '',
  immediateDestinationName: p.immediateDestinationName ?? '',
  immediateOrigin: p.immediateOrigin ?? '',
  immediateOriginName: p.immediateOriginName ?? '',
  originatingDfi: p.originatingDfi ?? '',
  kybStatus: p.kybStatus,
  kybNote: p.kybNote ?? '',
  perRun: p.perRunLimitCents == null ? '' : String(p.perRunLimitCents / 100),
  perDay: p.perDayLimitCents == null ? '' : String(p.perDayLimitCents / 100),
  requirePrenote: p.requirePrenote,
  collectTaxes: p.collectTaxes,
  collectGarnishments: p.collectGarnishments,
});

const toCents = (v: string) => (v.trim() === '' ? null : Math.round(Number(v.replace(/[^0-9.]/g, '')) * 100));

export function SetupTab({ summary }: { summary: BankingSummary }) {
  const qc = useQueryClient();
  const [d, setD] = useState<Draft>(() => fromProfile(summary.profile));
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const destError = d.immediateDestination && (d.immediateDestination.length !== 9 || !routingLooksValid(d.immediateDestination)) ? 'Your bank’s nine-digit routing number.' : null;
  const save = useMutation({
    mutationFn: () =>
      updateBankingProfile({
        bankRail: d.bankRail,
        achSpeed: d.achSpeed,
        submitCutoffEt: d.submitCutoffEt,
        companyName: d.companyName.trim() || null,
        companyId: d.companyId.trim() || null,
        companyEntryDescription: d.companyEntryDescription.trim() || 'PAYROLL',
        immediateDestination: d.immediateDestination || null,
        immediateDestinationName: d.immediateDestinationName.trim() || null,
        immediateOrigin: d.immediateOrigin.trim() || null,
        immediateOriginName: d.immediateOriginName.trim() || null,
        originatingDfi: d.originatingDfi || null,
        kybStatus: d.kybStatus,
        kybNote: d.kybNote.trim() || null,
        perRunLimitCents: toCents(d.perRun),
        perDayLimitCents: toCents(d.perDay),
        requirePrenote: d.requirePrenote,
        collectTaxes: d.collectTaxes,
        collectGarnishments: d.collectGarnishments,
      }),
    onSuccess: (r) => {
      toast.success(r.pending ? 'Saved. The higher limit waits for a second person to approve.' : 'Payroll banking saved.');
      setD(fromProfile(r.profile));
      void qc.invalidateQueries({ queryKey: ['payroll-banking'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const ach = d.bankRail === 'ACH';
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!destError) save.mutate();
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>How pay moves</CardTitle>
          <CardDescription>Cards always load through Branch. People with no account on file get a check.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <Field label="Bank accounts are paid by">
            <Select value={d.bankRail} onChange={(e) => set('bankRail', e.target.value as BankRail)}>
              <option value="PLATFORM">The platform’s payout provider</option>
              <option value="ACH">Our own ACH</option>
              <option value="BRANCH">Branch</option>
              <option value="WISE">Wise</option>
              <option value="CHECK">Paper check</option>
            </Select>
          </Field>
          <Field label="ACH speed" hint="How many banking days before pay day the paychecks go to the bank.">
            <Select value={d.achSpeed} onChange={(e) => set('achSpeed', e.target.value as AchSpeed)} disabled={!ach}>
              <option value="SAME_DAY">Same day</option>
              <option value="NEXT_DAY">Next day</option>
              <option value="TWO_DAY">Two days</option>
            </Select>
          </Field>
          <Field label="Your bank’s cutoff (ET)" hint="Files after this go the next banking day.">
            <Input type="time" value={d.submitCutoffEt} onChange={(e) => set('submitCutoffEt', e.target.value)} disabled={!ach} />
          </Field>
        </CardContent>
      </Card>

      {ach && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>What your bank assigned</CardTitle>
              <CardDescription>
                From your bank’s ACH origination agreement. With a bank partner connected in{' '}
                <Link to="/integrations" className="text-accent underline underline-offset-2">
                  Integrations
                </Link>
                , these still label every entry.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Field label="Company name on statements" hint="Up to 16 characters.">
                <Input value={d.companyName} onChange={(e) => set('companyName', e.target.value.slice(0, 16))} />
              </Field>
              <Field label="Company ID" hint="10 characters, often 1 followed by your EIN.">
                <Input value={d.companyId} onChange={(e) => set('companyId', e.target.value.slice(0, 10))} />
              </Field>
              <Field label="Entry description" hint="Up to 10 characters, shown on statements.">
                <Input value={d.companyEntryDescription} onChange={(e) => set('companyEntryDescription', e.target.value.slice(0, 10).toUpperCase())} />
              </Field>
              <Field label="Originating bank ID" hint="The first 8 digits of your bank’s routing number.">
                <Input value={d.originatingDfi} onChange={(e) => set('originatingDfi', e.target.value.replace(/\D/g, '').slice(0, 8))} inputMode="numeric" />
              </Field>
              <Field label="Immediate destination" hint="Your bank’s routing number." error={destError}>
                <Input value={d.immediateDestination} onChange={(e) => set('immediateDestination', e.target.value.replace(/\D/g, '').slice(0, 9))} inputMode="numeric" />
              </Field>
              <Field label="Destination name">
                <Input value={d.immediateDestinationName} onChange={(e) => set('immediateDestinationName', e.target.value.slice(0, 23))} />
              </Field>
              <Field label="Immediate origin" hint="The 10-character ID your bank gave you.">
                <Input value={d.immediateOrigin} onChange={(e) => set('immediateOrigin', e.target.value.slice(0, 10))} />
              </Field>
              <Field label="Origin name">
                <Input value={d.immediateOriginName} onChange={(e) => set('immediateOriginName', e.target.value.slice(0, 23))} />
              </Field>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>What the debit covers</CardTitle>
              <CardDescription>Net pay to bank accounts is always pulled. Add what we pay on your behalf.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              <Check label="Payroll taxes (employee and employer)" checked={d.collectTaxes} onChange={(v) => set('collectTaxes', v)} />
              <Check label="Garnishments we send to agencies" checked={d.collectGarnishments} onChange={(v) => set('collectGarnishments', v)} />
              <Check label="Send a zero-dollar test to each new employee account" checked={d.requirePrenote} onChange={(v) => set('requirePrenote', v)} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Controls</CardTitle>
              <CardDescription>A pull over a limit waits for a second person. Raising a limit does too.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Field label="Most for one run ($)" hint="Leave blank for no limit.">
                <Input value={d.perRun} onChange={(e) => set('perRun', e.target.value)} inputMode="decimal" />
              </Field>
              <Field label="Most in one day ($)" hint="Leave blank for no limit.">
                <Input value={d.perDay} onChange={(e) => set('perDay', e.target.value)} inputMode="decimal" />
              </Field>
              <Field label="Bank’s business check (KYB)" hint="Live pulls need it approved.">
                <Select value={d.kybStatus} onChange={(e) => set('kybStatus', e.target.value as KybStatus)}>
                  <option value="NOT_STARTED">Not started</option>
                  <option value="PENDING">With the bank</option>
                  <option value="APPROVED">Approved</option>
                  <option value="REJECTED">Declined</option>
                </Select>
              </Field>
              <Field label="KYB note">
                <Input value={d.kybNote} onChange={(e) => set('kybNote', e.target.value)} maxLength={500} />
              </Field>
            </CardContent>
          </Card>
        </>
      )}

      <div className="flex justify-end">
        <Button type="submit" loading={save.isPending} disabled={!!destError}>
          Save
        </Button>
      </div>
    </form>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm text-ink">
      <input type="checkbox" className="h-4 w-4 accent-[var(--color-gold,currentColor)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}
