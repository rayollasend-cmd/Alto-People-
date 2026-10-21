import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock3, FileUp, Paperclip, ShieldCheck, SkipForward } from 'lucide-react';
import type { BooksBill, BooksBillInput } from '@alto-people/shared';
import { decideApprovalRequest } from '@/lib/approvalRequestsApi';
import { usePrompt } from '@/lib/confirm';
import { fmtDate, fmtDateTime, ymdLocal } from '@/lib/format';
import {
  billAttachmentUrl,
  createBill,
  getBill,
  listBills,
  listVendors,
  PAYABLES_KEY,
  reopenBill,
  submitBill,
  updateBill,
  uploadBillAttachment,
  voidBill,
  voidBillPayment,
  withdrawBill,
} from '@/lib/books/payablesApi';
import { RecordTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryError } from '@/components/ui/QueryError';
import { toast } from '@/components/ui/Toaster';
import { BillStatusBadge, LinesEditor, METHOD_LABEL, PayBillsDialog, blankLine, dueWords, errText, invalidatePayables, linesTotal, money, toLineInputs, useBooksWrite, type DraftLine } from './payablesKit';

/**
 * One bill: what it's for, line by line; who approves it (never the person
 * who entered it); what's been paid; and the vendor's invoice beside it.
 * /books/bills/new enters one.
 */
export function BillDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  if (id === 'new') return <NewBill />;
  return <ExistingBill id={id} />;
}

const addDaysYmd = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/* ---- The form ------------------------------------------------------------- */

interface FormState {
  vendorId: string;
  billNumber: string;
  billDate: string;
  dueDate: string;
  dueTouched: boolean;
  memo: string;
  lines: DraftLine[];
}

function fromBill(b: BooksBill): FormState {
  return {
    vendorId: b.vendorId,
    billNumber: b.billNumber ?? '',
    billDate: b.billDate,
    dueDate: b.dueDate,
    dueTouched: true,
    memo: b.memo ?? '',
    lines: b.lines.map((l) => ({ ...blankLine(l.accountId), description: l.description ?? '', amount: l.amount.toFixed(2), clientId: l.clientId ?? '', siteId: l.siteId ?? '' })),
  };
}

function toInput(f: FormState): BooksBillInput {
  return { vendorId: f.vendorId, billNumber: f.billNumber.trim() || null, billDate: f.billDate, dueDate: f.dueDate || null, memo: f.memo.trim() || null, lines: toLineInputs(f.lines) };
}

function BillForm({ value, onChange }: { value: FormState; onChange: (f: FormState) => void }) {
  const vendors = useQuery({ queryKey: [...PAYABLES_KEY, 'vendors', 'active'], queryFn: () => listVendors() });
  const vendor = vendors.data?.vendors.find((v) => v.id === value.vendorId);
  const set = (patch: Partial<FormState>) => onChange({ ...value, ...patch });
  // The due date follows the vendor's terms until someone picks one.
  useEffect(() => {
    if (!value.dueTouched && vendor && value.billDate) {
      const due = addDaysYmd(value.billDate, vendor.termsDays);
      if (due !== value.dueDate) onChange({ ...value, dueDate: due });
    }
  }, [vendor, value, onChange]);
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0">
        <Field label="Vendor" className="lg:col-span-2">
          {(p) => (
            <Select
              value={value.vendorId}
              onChange={(e) => {
                const v = vendors.data?.vendors.find((x) => x.id === e.target.value);
                const lines = v?.defaultExpenseAccountId ? value.lines.map((l, i) => (i === 0 && !l.accountId ? { ...l, accountId: v.defaultExpenseAccountId! } : l)) : value.lines;
                set({ vendorId: e.target.value, lines });
              }}
              disabled={vendors.isPending}
              {...p}
            >
              <option value="">{vendors.isPending ? 'Getting the vendors…' : 'Choose a vendor…'}</option>
              {(vendors.data?.vendors ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Invoice number">{(p) => <Input value={value.billNumber} maxLength={60} onChange={(e) => set({ billNumber: e.target.value })} {...p} />}</Field>
        <Field label="Invoice date">{(p) => <Input type="date" value={value.billDate} onChange={(e) => set({ billDate: e.target.value })} {...p} />}</Field>
        <Field label="Due" hint={vendor && !value.dueTouched ? `${vendor.termsDays} days on ${vendor.name}’s terms` : undefined}>
          {(p) => <Input type="date" value={value.dueDate} min={value.billDate} onChange={(e) => set({ dueDate: e.target.value, dueTouched: true })} {...p} />}
        </Field>
        <Field label="Memo" className="sm:col-span-2 lg:col-span-3">
          {(p) => <Input value={value.memo} maxLength={500} placeholder="What it’s for, in a few words" onChange={(e) => set({ memo: e.target.value })} {...p} />}
        </Field>
      </div>
      {vendors.data && vendors.data.vendors.length === 0 && (
        <p className="text-sm text-ink-muted">
          <Link to="/books/vendors/new" className="text-gold hover:underline">
            Add the vendor
          </Link>{' '}
          first.
        </p>
      )}
      <LinesEditor lines={value.lines} onChange={(lines) => set({ lines })} />
    </div>
  );
}

const formReady = (f: FormState) => !!f.vendorId && !!f.billDate && linesTotal(f.lines) > 0 && f.lines.every((l) => !l.amount || l.accountId);

function NewBill() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [form, setForm] = useState<FormState>({ vendorId: params.get('vendorId') ?? '', billNumber: '', billDate: ymdLocal(), dueDate: '', dueTouched: false, memo: '', lines: [blankLine()] });
  const [file, setFile] = useState<File | null>(null);
  const [entered, setEntered] = useState(0);
  const save = useMutation({
    mutationFn: async (how: 'draft' | 'submit' | 'another') => {
      const { bill } = await createBill(toInput(form));
      if (file) await uploadBillAttachment(bill.id, file);
      if (how !== 'draft') await submitBill(bill.id);
      return { bill, how };
    },
    onSuccess: ({ bill, how }) => {
      toast.success(how !== 'draft' ? `${money(bill.total)} bill from ${bill.vendorName} sent for approval.` : 'Saved as a draft.');
      invalidatePayables(qc);
      if (how === 'another') {
        // The next one from the same vendor: keep the vendor and its account, clear the rest.
        setForm((f) => ({ vendorId: f.vendorId, billNumber: '', billDate: ymdLocal(), dueDate: '', dueTouched: false, memo: '', lines: [blankLine(f.lines[0]?.accountId)] }));
        setFile(null);
        setEntered((n) => n + 1);
        window.scrollTo?.({ top: 0 });
        return;
      }
      navigate(`/books/bills/${bill.id}`, { replace: true });
    },
    onError: (err) => toast.error(errText(err, 'Could not save the bill.')),
  });
  return (
    <RecordTemplate
      breadcrumbs={[{ label: 'Books', to: '/books' }, { label: 'Bills', to: '/books/bills' }, { label: 'New bill' }]}
      title="New bill"
      subtitle={entered > 0 ? `${entered} sent for approval this sitting. Enter it as the vendor sent it.` : 'Enter it as the vendor sent it. It’s owed — on the books — once a second person approves it.'}
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => save.mutate('draft')} loading={save.isPending && save.variables === 'draft'} disabled={!formReady(form) || save.isPending}>
            Save draft
          </Button>
          <Button variant="secondary" onClick={() => save.mutate('another')} loading={save.isPending && save.variables === 'another'} disabled={!formReady(form) || save.isPending}>
            Send & enter another
          </Button>
          <Button onClick={() => save.mutate('submit')} loading={save.isPending && save.variables === 'submit'} disabled={!formReady(form) || save.isPending}>
            Send for approval
          </Button>
        </div>
      }
      tabs={[
        {
          key: 'bill',
          label: 'Bill',
          content: (
            <Card>
              <CardContent className="space-y-5 p-5">
                <BillForm value={form} onChange={setForm} />
                <FilePick key={entered} file={file} onFile={setFile} />
              </CardContent>
            </Card>
          ),
        },
      ]}
    />
  );
}

function FilePick({ file, onFile }: { file: File | null; onFile: (f: File | null) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-line p-3 text-sm">
      <Paperclip className="h-4 w-4 text-ink-muted" aria-hidden="true" />
      <span className="min-w-0 flex-1 text-ink-muted">{file ? file.name : 'Attach the vendor’s invoice — a PDF or a photo.'}</span>
      <input ref={ref} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="sr-only" aria-label="Invoice file" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
      <Button type="button" size="sm" variant="secondary" onClick={() => ref.current?.click()}>
        {file ? 'Choose another' : 'Choose a file'}
      </Button>
    </div>
  );
}

/* ---- An existing bill ----------------------------------------------------- */

function ExistingBill({ id }: { id: string }) {
  const qc = useQueryClient();
  const prompt = usePrompt();
  const write = useBooksWrite();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: [...PAYABLES_KEY, 'bill', id], queryFn: () => getBill(id) });
  // The rest of the approval queue, for "Approve & next".
  const deciding = q.data?.bill.status === 'PENDING_APPROVAL' && !!q.data.bill.approval?.mayDecide;
  const queue = useQuery({ queryKey: [...PAYABLES_KEY, 'bills', 'approve'], queryFn: () => listBills({ tab: 'approve' }), enabled: deciding });
  const mine = (queue.data?.bills ?? []).filter((b) => b.approval?.mayDecide);
  const at = mine.findIndex((b) => b.id === id);
  const nextBill = mine.filter((b) => b.id !== id)[at >= 0 ? Math.min(at, mine.length - 2) : 0] ?? null;
  const vendors = useQuery({ queryKey: [...PAYABLES_KEY, 'vendors', 'all'], queryFn: () => listVendors({ active: 'all' }) });
  const bill = q.data?.bill;
  const [editing, setEditing] = useState<FormState | null>(null);
  const [paying, setPaying] = useState(false);
  const [tab, setTab] = useState('lines');
  const done = (msg: string) => {
    toast.success(msg);
    invalidatePayables(qc);
  };
  const act = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onError: (err) => toast.error(errText(err, 'That didn’t work.')),
  });
  if (q.isPending) return <Skeleton className="h-96 w-full" />;
  if (q.error || !bill) return <QueryError what="the bill" query={q} />;
  const vendor = vendors.data?.vendors.find((v) => v.id === bill.vendorId);
  const open = bill.status === 'APPROVED' || bill.status === 'PARTIALLY_PAID';
  const livePayments = bill.payments.filter((p) => p.status !== 'VOID');

  const decide = async (decision: 'APPROVE' | 'REJECT', thenNext = false) => {
    if (!bill.approval) return;
    let reason: string | null = null;
    if (decision === 'REJECT') {
      reason = await prompt({ title: `Reject the ${money(bill.total)} bill from ${bill.vendorName}?`, description: 'It goes back to draft with your reason, for whoever entered it.', reasonLabel: 'Why', confirmLabel: 'Reject', destructive: true });
      if (!reason) return;
    }
    act.mutate(() =>
      decideApprovalRequest(bill.approval!.id, { decision, ...(reason ? { reason } : {}) }).then(() => {
        done(decision === 'APPROVE' ? `Approved — ${money(bill.total)} to ${bill.vendorName} is on the books.` : 'Rejected — it’s back to draft.');
        if (thenNext) navigate(nextBill ? `/books/bills/${nextBill.id}` : '/books/bills?tab=approve');
      }),
    );
  };
  const withReason = async (title: string, description: string, confirmLabel: string, fn: (reason: string) => Promise<unknown>, okMsg: string) => {
    const reason = await prompt({ title, description, reasonLabel: 'Why', confirmLabel, destructive: true });
    if (reason) act.mutate(() => fn(reason).then(() => done(okMsg)));
  };

  const actions = write ? (
    <div className="flex flex-wrap gap-2">
      {bill.status === 'DRAFT' && !editing && (
        <>
          <Button variant="secondary" onClick={() => setEditing(fromBill(bill))}>
            Edit
          </Button>
          <Button onClick={() => act.mutate(() => submitBill(bill.id).then(() => done('Sent for approval.')))} loading={act.isPending}>
            Send for approval
          </Button>
        </>
      )}
      {bill.status === 'PENDING_APPROVAL' && (
        <Button variant="secondary" onClick={() => act.mutate(() => withdrawBill(bill.id).then(() => done('Withdrawn — it’s a draft again.')))}>
          Withdraw
        </Button>
      )}
      {open && vendor && (
        <Button onClick={() => setPaying(true)}>
          Pay {money(bill.balance)}
        </Button>
      )}
      {bill.status === 'APPROVED' && livePayments.length === 0 && (
        <Button variant="ghost" onClick={() => withReason('Reopen this bill?', 'Its entry comes off the books and it goes back to draft — it needs approving again before it’s owed.', 'Reopen', (r) => reopenBill(bill.id, r), 'Reopened as a draft.')}>
          Reopen to change
        </Button>
      )}
      {bill.status !== 'VOID' && bill.status !== 'PAID' && livePayments.length === 0 && (
        <Button variant="ghost" onClick={() => withReason(`Void the bill from ${bill.vendorName}?`, 'It stays on record, marked void, and is no longer owed.', 'Void bill', (r) => voidBill(bill.id, r), 'Voided.')}>
          Void
        </Button>
      )}
    </div>
  ) : undefined;

  return (
    <>
      <RecordTemplate
        breadcrumbs={[{ label: 'Books', to: '/books' }, { label: 'Bills', to: '/books/bills' }, { label: bill.billNumber ? `Invoice ${bill.billNumber}` : 'Bill' }]}
        title={`${money(bill.total)} from ${bill.vendorName}`}
        subtitle={`${bill.billNumber ? `Invoice ${bill.billNumber} · ` : ''}dated ${fmtDate(bill.billDate)} · ${dueWords(bill)}${bill.recurringName ? ` · made by “${bill.recurringName}”` : ''}`}
        status={<BillStatusBadge bill={bill} />}
        actions={actions}
        summary={<ApprovalPanel bill={bill} onDecide={decide} busy={act.isPending} next={nextBill} />}
        activeTab={tab}
        onTabChange={setTab}
        tabs={[
          {
            key: 'lines',
            label: 'Lines',
            count: bill.lines.length,
            content: editing ? (
              <Card>
                <CardContent className="space-y-5 p-5">
                  <BillForm value={editing} onChange={setEditing} />
                  <div className="flex justify-end gap-2">
                    <Button variant="secondary" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                    <Button
                      disabled={!formReady(editing) || act.isPending}
                      loading={act.isPending}
                      onClick={() =>
                        act.mutate(() =>
                          updateBill(bill.id, toInput(editing)).then(() => {
                            setEditing(null);
                            done('Saved.');
                          }),
                        )
                      }
                    >
                      Save
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ) : (
              <Lines bill={bill} />
            ),
          },
          {
            key: 'payments',
            label: 'Payments',
            count: livePayments.length,
            content:
              bill.payments.length === 0 ? (
                <EmptyState title="Not paid yet" description={open ? 'Pay it from here, or from the vendor’s page with their other bills.' : 'Once it’s approved it can be paid.'} />
              ) : (
                <Card>
                  <CardContent className="p-0">
                    <ul className="divide-y divide-line">
                      {bill.payments.map((p) => (
                        <li key={p.paymentId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                          <span className="min-w-0">
                            <span className="block font-medium text-ink">
                              {money(p.amount)} by {METHOD_LABEL[p.method as keyof typeof METHOD_LABEL] ?? p.method}
                            </span>
                            <span className="block text-xs text-ink-muted">
                              {fmtDate(p.paidOn)}
                              {p.reference ? ` · ${p.reference}` : ''}
                            </span>
                          </span>
                          <span className="flex items-center gap-2">
                            {p.status === 'VOID' ? <Badge size="sm" variant="destructive">Void</Badge> : p.status === 'SCHEDULED' ? <Badge size="sm" variant="info">Scheduled</Badge> : <Badge size="sm" variant="success">Paid</Badge>}
                            {write && p.status !== 'VOID' && (
                              <Button
                                size="xs"
                                variant="ghost"
                                onClick={() => withReason(`Void the ${money(p.amount)} payment?`, 'The bill is owed again. A payment already sent to the bank over ACH can’t be voided here.', 'Void payment', (r) => voidBillPayment(p.paymentId, r), 'Payment voided.')}
                              >
                                Void
                              </Button>
                            )}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              ),
          },
          { key: 'invoice', label: 'Invoice', content: <Invoice bill={bill} canUpload={write} onUploaded={() => done('Invoice attached.')} /> },
        ]}
      />
      {paying && vendor && (
        <PayBillsDialog open onOpenChange={setPaying} vendor={{ id: vendor.id, name: vendor.name, hasBank: vendor.hasBank, paymentMethod: vendor.paymentMethod }} bills={[bill]} />
      )}
    </>
  );
}

function ApprovalPanel({ bill, onDecide, busy, next }: { bill: BooksBill; onDecide: (d: 'APPROVE' | 'REJECT', thenNext?: boolean) => void; busy: boolean; next: BooksBill | null }) {
  const a = bill.approval;
  if (bill.status === 'PENDING_APPROVAL' && a) {
    return (
      <Card className="border-warning/40">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex min-w-0 items-start gap-3">
            <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-warning" aria-hidden="true" />
            <div className="min-w-0 text-sm">
              <p className="font-medium text-ink">Waiting for a second person</p>
              <p className="text-ink-muted">
                {a.requesterName ? `${a.requesterName} sent it ${fmtDateTime(a.createdAt)}. ` : ''}
                {a.mayDecide ? 'You can decide it.' : 'Anyone else who keeps the books can approve it — never the person who entered it.'}
              </p>
            </div>
          </div>
          {a.mayDecide && (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => onDecide('REJECT')} disabled={busy}>
                Reject
              </Button>
              <Button variant={next ? 'secondary' : 'primary'} onClick={() => onDecide('APPROVE')} loading={busy}>
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                Approve {money(bill.total)}
              </Button>
              {next && (
                <Button onClick={() => onDecide('APPROVE', true)} disabled={busy} title={`Then open the ${money(next.total)} bill from ${next.vendorName}`}>
                  <SkipForward className="h-4 w-4" aria-hidden="true" />
                  Approve & next
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }
  if (bill.approvedAt) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-ink-muted">
        <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />
        Approved by {bill.approvedByName ?? 'a second person'} {fmtDateTime(bill.approvedAt)}
        {bill.journalEntryId && (
          <>
            {' · '}
            <Link to={`/books/journal/${bill.journalEntryId}`} className="text-gold hover:underline">
              Entry #{bill.journalEntryNumber}
            </Link>
          </>
        )}
      </p>
    );
  }
  if (bill.status === 'DRAFT' && a?.status === 'REJECTED') {
    return (
      <Card className="border-alert/40">
        <CardContent className="p-4 text-sm">
          <p className="font-medium text-ink">Rejected by {a.decidedByName ?? 'the approver'}</p>
          {a.reason && <p className="text-ink-muted">“{a.reason}”</p>}
        </CardContent>
      </Card>
    );
  }
  return null;
}

function Lines({ bill }: { bill: BooksBill }) {
  return (
    <Card>
      <CardContent className="p-0">
        <ul className="divide-y divide-line">
          {bill.lines.map((l) => (
            <li key={l.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
              <span className="min-w-0">
                <span className="block font-medium text-ink">
                  {l.accountCode} {l.accountName}
                </span>
                <span className="block text-xs text-ink-muted">{[l.description, l.clientName].filter(Boolean).join(' · ') || 'Company'}</span>
              </span>
              <span className="tabular-nums text-ink">{money(l.amount)}</span>
            </li>
          ))}
          <li className="flex items-center justify-between px-4 py-3 text-sm">
            <span className="font-medium text-ink">Total</span>
            <span className="font-semibold tabular-nums text-ink">{money(bill.total)}</span>
          </li>
          {bill.memo && <li className="px-4 py-3 text-sm text-ink-muted">{bill.memo}</li>}
        </ul>
      </CardContent>
    </Card>
  );
}

function Invoice({ bill, canUpload, onUploaded }: { bill: BooksBill; canUpload: boolean; onUploaded: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const up = useMutation({
    mutationFn: (f: File) => uploadBillAttachment(bill.id, f),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...PAYABLES_KEY, 'bill', bill.id] });
      onUploaded();
    },
    onError: (err) => toast.error(errText(err, 'Could not attach it.')),
  });
  const url = billAttachmentUrl(bill.id);
  const isPdf = (bill.attachmentName ?? '').toLowerCase().endsWith('.pdf');
  return (
    <div className="space-y-3">
      {canUpload && (
        <div className="flex justify-end">
          <input ref={ref} type="file" accept="application/pdf,image/jpeg,image/png,image/webp" className="sr-only" aria-label="Invoice file" onChange={(e) => e.target.files?.[0] && up.mutate(e.target.files[0])} />
          <Button variant="secondary" onClick={() => ref.current?.click()} loading={up.isPending}>
            <FileUp className="h-4 w-4" aria-hidden="true" />
            {bill.hasAttachment ? 'Replace the invoice' : 'Attach the invoice'}
          </Button>
        </div>
      )}
      {bill.hasAttachment ? (
        <Card>
          <CardContent className="space-y-2 p-3">
            <p className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-ink">{bill.attachmentName}</span>
              <a href={`${url}?download=1`} className="text-gold hover:underline">
                Download
              </a>
            </p>
            {isPdf ? (
              <iframe title={`Invoice ${bill.billNumber ?? ''}`} src={url} className="h-[70vh] w-full rounded-md border border-line bg-surface" />
            ) : (
              <img src={url} alt={`Invoice ${bill.billNumber ?? ''} from ${bill.vendorName}`} className="max-h-[70vh] w-auto rounded-md border border-line" />
            )}
          </CardContent>
        </Card>
      ) : (
        <EmptyState icon={Paperclip} title="No invoice attached" description="Keep the vendor’s invoice with the bill — auditors ask for it." />
      )}
    </div>
  );
}

