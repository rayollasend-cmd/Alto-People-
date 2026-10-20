# Payroll on the company's own bank account (own-account ACH)

*Written 2026-10-20. Bank: Capital City Bank (ccbg.com). Builds on the payroll banking module (`apps/api/src/lib/banking`), which already writes NACHA files, reads the bank's returns and runs the Payroll banking screens.*

## What changed

Payroll banking had one way to pay bank accounts over our own ACH: **pull the employer's money first** (a CCD debit from the operating account, settling a banking day ahead), then send the paychecks from the platform's account. That is the right shape for a platform paying on behalf of many employers.

Capital City Bank is the company's own bank, so the money does not need to be pulled anywhere. The new **settlement** setting on the payroll banking profile:

| Setting | What happens |
| --- | --- |
| `PREFUND` (default, unchanged) | Funding debit a day ahead; disbursement refuses an unfunded run; the paychecks go out once the debit settles. |
| `OWN_ACCOUNT` (new) | Nothing is pulled. The paychecks are drawn on the company's own account at the originating bank. The NACHA file is the money. |

With `OWN_ACCOUNT`:

- **File format** picks `UNBALANCED` (credits only, service class 220; the bank books the offset to the company's account) or `BALANCED` (one debit entry to the company's verified account for the paychecks' total, service class 200, so the file nets to zero). Both are built; the bank's origination letter says which it accepts.
- **No same-day ACH.** A file a person uploads cannot promise the same-day window, so with no bank partner connected the effective date is always the next banking day or later (the ACH speed setting hides "Same day" without a partner). Weekends and Federal Reserve holidays are skipped, as before.
- **A paycheck reads paid only when a person says the file reached the bank.** Disburse writes the file and the paychecks wait (PENDING, each carrying its trace number). On the ACH files tab, or on the run's guided close, *Mark uploaded to Capital City Bank* flips them to DISBURSED, dated then, emails the paystubs, settles the run when nothing is left pending or held, and accrues the tax deposit, the tax liabilities and the garnishment remittances. A file nobody marked never settles on its own, and the hourly sweep leaves it alone.
- Funding routes answer that there is nothing to pull (`own_account`), the Funding tab says so and points at ACH files, the go-live checklist's "Funding account" line becomes "Company account at the bank" (unbalanced) or "Offset account" (balanced, which must be a verified account).
- Returns and notifications of change come back through the same return-file upload as before and apply the same way (a returned paycheck re-pays to the last verified other account or a check; a correction becomes a new payout method).

## The flow, as Finance sees it

1. **Setup** (Pay & finance → Payroll banking → Setup): bank accounts are paid by *Our own ACH*; *Where the money comes from* = *Our own account at the bank (no pull)*; *File format* per the bank's letter; the bank's routing number as immediate destination (Capital City Bank's primary number is listed as 063100688 by routing directories; **confirm it on the bank's letter**), the originating bank ID (its first eight digits), the company name, the ten-character company ID and the immediate origin the bank assigned (being issued now).
2. **Bank accounts**: add the operating account at Capital City Bank and verify it (micro-deposits or a prenote). For a balanced file, *Draw payroll on this account* marks it as the offset account.
3. **Run payroll** as usual: finalize, sign off the review, **Disburse**. The run stays finalized; the guided close's Disburse step says the file is ready.
4. **ACH files**: *Download*, upload it in the bank's portal before the cutoff, then **Mark uploaded**. Now the paychecks read paid and the run settles.
5. **Returns**: upload the bank's return file when it comes; returned paychecks land in the failure queue with the bank's reason.

## Where it lives

- `apps/api/src/lib/banking/ach.ts` — `ownAccount(profile)`, the `OFFSET` entry kind, the balanced-file gap in `originationGaps`.
- `apps/api/src/lib/banking/directDeposit.ts` — the offset entry and the PENDING-until-uploaded rule in `AchRailAdapter.finalize()`, `markFileUploaded()`, same-day only with a partner in `creditEffectiveDate()`, the sweep that settles only marked files.
- `apps/api/src/lib/banking/funding.ts` — nothing to pull / nothing to assert on the own account.
- `apps/api/src/routes/banking.ts` — profile fields, `POST /payroll-banking/files/:id/uploaded`, `uploadable` on the file list, funding routes answering "does not apply".
- `apps/api/src/routes/payroll.ts` — the guided close carries `bankFile` and the Disburse step's note.
- `apps/api/src/lib/payrollGoLive.ts` — the checklist lines.
- Web: `pages/payrollBanking/SetupTab.tsx` (the two settings, same-day hidden without a partner), `FilesTab.tsx` (Mark uploaded), `AccountsTab.tsx` (wording), `PayrollBankingPage.tsx` (banner and Funding tab copy), `pages/payroll/PayrollClosePage.tsx` (the file on the Disburse step).
- Migration `20270124100000_own_account_ach`: two columns on `PayrollBankingProfile`.
- Tests: `apps/api/src/__tests__/routes/ownAccountAch.test.ts` (balanced and unbalanced files, no pull, never same-day, mark uploaded, the sweep, the go-live line).

## Owner-side before the first live run

1. The originator letter from Capital City Bank: originator id (immediate origin), company ID, which file format, cutoff time, how they want the file delivered (portal upload or SFTP) and how they return the return file.
2. Enter those on the Setup tab; the banner goes from *Finish setup* to *Files for your own bank*.
3. A prenote or a one-cent test file in the first week is wise; the bank will say.
