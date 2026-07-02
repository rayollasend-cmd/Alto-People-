import { useEffect, useState } from 'react';
import { ChevronDown, Download, FileText, Plus, Receipt, Scale } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  build941,
  createGarnishment,
  createTaxForm,
  createW2c,
  deductGarnishment,
  fileTaxForm,
  garnishmentLetterUrl,
  generateW2s,
  generate1099Necs,
  clearAssociateTin,
  getAssociateTin,
  saveAssociateTin,
  getSubmitterProfile,
  listGarnishmentDeductions,
  listGarnishments,
  listTaxForms,
  saveSubmitterProfile,
  setGarnishmentStatus,
  taxFormPdfUrl,
  voidTaxForm,
  w2BulkZipUrl,
  w2Efw2Url,
  w2Efw2cUrl,
  w2PdfUrl,
  f1099NecBulkZipUrl,
  f1099NecFireUrl,
  generate1099Miscs,
  f1099MiscBulkZipUrl,
  f1099MiscFireUrl,
  type Garnishment,
  type GarnishmentDeduction,
  type GarnishmentKind,
  type GarnishmentStatus,
  type SubmitterProfile,
  type SubmitterProfileInput,
  type TaxForm,
  type TaxFormKind,
} from '@/lib/payrollTax91Api';
import { useAuth } from '@/lib/auth';
import { useConfirm, usePrompt } from '@/lib/confirm';
import { hasCapability } from '@/lib/roles';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Drawer,
  DrawerBody,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  Input,
  PageHeader,
  Select,
  SkeletonRows,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { fmtDate } from '@/lib/format';
import { toast } from 'sonner';

type Tab = 'garnishments' | 'taxforms';

export function PayrollTaxHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'process:payroll') : false;
  const [tab, setTab] = useState<Tab>('garnishments');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Payroll tax"
        subtitle="Garnishments and federal tax forms (941, 940, W-2, 1099-NEC)."
        breadcrumbs={[{ label: 'Payroll' }, { label: 'Tax & withholdings' }]}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="garnishments">
            <Scale className="mr-2 h-4 w-4" /> Garnishments
          </TabsTrigger>
          <TabsTrigger value="taxforms">
            <FileText className="mr-2 h-4 w-4" /> Tax forms
          </TabsTrigger>
        </TabsList>
        <TabsContent value="garnishments">
          <GarnishmentsTab canManage={canManage} />
        </TabsContent>
        <TabsContent value="taxforms">
          <TaxFormsTab canManage={canManage} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const GARN_BADGE: Record<GarnishmentStatus, 'success' | 'pending' | 'default' | 'destructive'> = {
  ACTIVE: 'success',
  SUSPENDED: 'pending',
  COMPLETED: 'default',
  TERMINATED: 'destructive',
};

const GARN_KIND_LABEL: Record<GarnishmentKind, string> = {
  CHILD_SUPPORT: 'Child support',
  TAX_LEVY: 'Tax levy',
  STUDENT_LOAN: 'Student loan',
  BANKRUPTCY: 'Bankruptcy',
  CREDITOR: 'Creditor',
  OTHER: 'Other',
};

function GarnishmentsTab({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<Garnishment[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [historyTarget, setHistoryTarget] = useState<Garnishment | null>(null);
  const [deductTarget, setDeductTarget] = useState<Garnishment | null>(null);

  const refresh = () => {
    setRows(null);
    listGarnishments()
      .then((r) => setRows(r.garnishments))
      .catch((err) => {
        setRows([]);
        toast.error(err instanceof ApiError ? err.message : "Couldn't load garnishments.");
      });
  };
  useEffect(() => {
    refresh();
  }, []);

  const onStatus = async (id: string, status: GarnishmentStatus) => {
    try {
      await setGarnishmentStatus(id, status);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't update garnishment status. Try again.");
    }
  };

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New garnishment
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Scale}
              title="No garnishments"
              description="Court-ordered withholdings (child support, tax levies, etc) appear here."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Associate</TableHead>
                  <TableHead className="hidden md:table-cell">Kind</TableHead>
                  <TableHead className="hidden sm:table-cell">Withhold</TableHead>
                  <TableHead className="hidden lg:table-cell">Cap / progress</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="font-medium text-white">
                      <div className="min-w-0">
                        <div className="truncate">{g.associateName}</div>
                        <div className="md:hidden text-[11px] text-silver/70 truncate font-normal">
                          {GARN_KIND_LABEL[g.kind]}
                          <span className="sm:hidden">
                            {g.amountPerRun
                              ? ` · $${g.amountPerRun}/run`
                              : g.percentOfDisp
                                ? ` · ${(Number(g.percentOfDisp) * 100).toFixed(2)}% of disp.`
                                : ''}
                          </span>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{GARN_KIND_LABEL[g.kind]}</TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {g.amountPerRun
                        ? `$${g.amountPerRun}/run`
                        : g.percentOfDisp
                          ? `${(Number(g.percentOfDisp) * 100).toFixed(2)}% of disp.`
                          : '—'}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {g.totalCap
                        ? `$${g.amountWithheld} / $${g.totalCap}`
                        : `$${g.amountWithheld}`}
                    </TableCell>
                    <TableCell>
                      <Badge variant={GARN_BADGE[g.status]}>{g.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          asChild
                          size="sm"
                          variant="ghost"
                          title="Download employer acknowledgment letter PDF"
                        >
                          <a href={garnishmentLetterUrl(g.id)} target="_blank" rel="noreferrer">
                            <Download className="mr-1 h-3 w-3" />
                            Letter
                          </a>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setHistoryTarget(g)}
                        >
                          History
                        </Button>
                        {canManage && g.status === 'ACTIVE' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setDeductTarget(g)}
                          >
                            Manual deduct
                          </Button>
                        )}
                        {canManage && (g.status === 'ACTIVE' || g.status === 'SUSPENDED') && (
                          <Select
                            size="sm"
                            value={g.status}
                            onChange={(e) => onStatus(g.id, e.target.value as GarnishmentStatus)}
                          >
                            <option value="ACTIVE">ACTIVE</option>
                            <option value="SUSPENDED">SUSPENDED</option>
                            <option value="TERMINATED">TERMINATED</option>
                          </Select>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewGarnishmentDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {historyTarget && (
        <GarnishmentHistoryDrawer
          garnishment={historyTarget}
          onClose={() => setHistoryTarget(null)}
        />
      )}
      {deductTarget && (
        <GarnishmentManualDeductDrawer
          garnishment={deductTarget}
          onClose={() => setDeductTarget(null)}
          onSaved={() => {
            setDeductTarget(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function NewGarnishmentDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [associateId, setAssociateId] = useState('');
  const [kind, setKind] = useState<GarnishmentKind>('CHILD_SUPPORT');
  const [caseNumber, setCaseNumber] = useState('');
  const [agencyName, setAgencyName] = useState('');
  const [mode, setMode] = useState<'AMOUNT' | 'PERCENT'>('AMOUNT');
  const [amount, setAmount] = useState('');
  const [percent, setPercent] = useState('');
  const [totalCap, setTotalCap] = useState('');
  const [startDate, setStartDate] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!associateId || !startDate) {
      toast.error('Associate and start date required.');
      return;
    }
    if (mode === 'AMOUNT' && !amount) {
      toast.error('Amount required.');
      return;
    }
    if (mode === 'PERCENT' && !percent) {
      toast.error('Percent required.');
      return;
    }
    setSaving(true);
    try {
      await createGarnishment({
        associateId: associateId.trim(),
        kind,
        caseNumber: caseNumber.trim() || null,
        agencyName: agencyName.trim() || null,
        amountPerRun: mode === 'AMOUNT' ? Number(amount) : null,
        percentOfDisp: mode === 'PERCENT' ? Number(percent) / 100 : null,
        totalCap: totalCap ? Number(totalCap) : null,
        startDate,
        notes: notes.trim() || null,
      });
      toast.success('Garnishment created.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't save garnishment. Try again.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-2xl">
      <DrawerHeader>
        <DrawerTitle>New garnishment</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Associate ID</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={associateId}
            onChange={(e) => setAssociateId(e.target.value)}
          />
        </div>
        <div>
          <Label>Kind</Label>
          <Select
            className="mt-1"
            value={kind}
            onChange={(e) => setKind(e.target.value as GarnishmentKind)}
          >
            {(Object.keys(GARN_KIND_LABEL) as GarnishmentKind[]).map((k) => (
              <option key={k} value={k}>
                {GARN_KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Case number</Label>
            <Input
              className="mt-1"
              value={caseNumber}
              onChange={(e) => setCaseNumber(e.target.value)}
            />
          </div>
          <div>
            <Label>Agency</Label>
            <Input
              className="mt-1"
              value={agencyName}
              onChange={(e) => setAgencyName(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label>Withholding mode</Label>
          <div className="flex gap-3 mt-1">
            <label className="flex items-center gap-2 text-sm text-white">
              <input
                type="radio"
                checked={mode === 'AMOUNT'}
                onChange={() => setMode('AMOUNT')}
              />
              Fixed $/run
            </label>
            <label className="flex items-center gap-2 text-sm text-white">
              <input
                type="radio"
                checked={mode === 'PERCENT'}
                onChange={() => setMode('PERCENT')}
              />
              % of disposable
            </label>
          </div>
        </div>
        {mode === 'AMOUNT' ? (
          <div>
            <Label>Amount per pay run</Label>
            <Input
              type="number"
              step="0.01"
              className="mt-1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        ) : (
          <div>
            <Label>Percent of disposable earnings (%)</Label>
            <Input
              type="number"
              step="0.01"
              max="100"
              className="mt-1"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
              placeholder="25"
            />
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Total cap (optional)</Label>
            <Input
              type="number"
              step="0.01"
              className="mt-1"
              value={totalCap}
              onChange={(e) => setTotalCap(e.target.value)}
            />
          </div>
          <div>
            <Label>Start date</Label>
            <Input
              type="date"
              className="mt-1"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label>Notes</Label>
          <Textarea
            className="mt-1"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Create'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function GarnishmentHistoryDrawer({
  garnishment,
  onClose,
}: {
  garnishment: Garnishment;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<GarnishmentDeduction[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listGarnishmentDeductions(garnishment.id)
      .then((r) => !cancelled && setRows(r.deductions))
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : "Couldn't load history.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [garnishment.id]);

  return (
    <Drawer open onOpenChange={(v) => !v && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Deduction history — {garnishment.associateName}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className="space-y-3 text-sm">
          <div className="text-xs text-silver/70">
            {GARN_KIND_LABEL[garnishment.kind]} · case {garnishment.caseNumber ?? '—'} ·
            withheld ${garnishment.amountWithheld}
            {garnishment.totalCap && <> of ${garnishment.totalCap}</>}
          </div>
          {error && <div className="text-alert">{error}</div>}
          {rows === null && !error && <SkeletonRows count={4} />}
          {rows && rows.length === 0 && (
            <EmptyState
              icon={Receipt}
              title="No deductions yet"
              description="Garnishment deductions appear here as payroll runs are processed or you record them manually."
            />
          )}
          {rows && rows.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Run</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell>{new Date(d.deductedOn).toLocaleString()}</TableCell>
                    <TableCell className="text-xs text-silver/70">
                      {d.payrollRunId ? d.payrollRunId.slice(0, 8) : 'Manual'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">${d.amount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function GarnishmentManualDeductDrawer({
  garnishment,
  onClose,
  onSaved,
}: {
  garnishment: Garnishment;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error('Amount must be a positive number.');
      return;
    }
    setSaving(true);
    try {
      const r = await deductGarnishment(garnishment.id, n, null);
      toast.success(
        r.completed
          ? 'Deduction recorded. Garnishment cap reached → status COMPLETED.'
          : 'Deduction recorded.',
      );
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't record deduction.");
      setSaving(false);
    }
  };

  return (
    <Drawer open onOpenChange={(v) => !v && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Manual deduction — {garnishment.associateName}</DrawerTitle>
      </DrawerHeader>
      <DrawerBody>
        <div className="space-y-3 text-sm">
          <p className="text-xs text-silver/70">
            Use this when a deduction needs to be recorded outside a payroll run (e.g.
            retroactive correction). The garnishment's amountWithheld is incremented and the
            status flips to COMPLETED if the cap is reached.
          </p>
          <Label htmlFor="manual-deduct-amount">Amount</Label>
          <Input
            id="manual-deduct-amount"
            type="number"
            min="0.01"
            step="0.01"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="e.g. 150.00"
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={saving}>
          {saving ? 'Saving…' : 'Record deduction'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

// ----- Tax forms --------------------------------------------------------

const FORM_KIND_LABEL: Record<TaxFormKind, string> = {
  F941: 'Form 941 (Quarterly federal)',
  F940: 'Form 940 (Annual FUTA)',
  W2: 'W-2 (Annual employee)',
  W2C: 'W-2c (Correction)',
  F1099_NEC: '1099-NEC (Annual contractor)',
  F1099_MISC: '1099-MISC (Annual miscellaneous)',
};

const FORM_STATUS_BADGE: Record<TaxForm['status'], 'pending' | 'success' | 'default' | 'destructive'> = {
  DRAFT: 'pending',
  FILED: 'success',
  AMENDED: 'default',
  VOIDED: 'destructive',
};

/**
 * Five-step pipeline header. Each step is "done" once any row in the
 * current list reaches that stage. Helps cold-start operators understand
 * the order: review eligibility → generate → sign → file → distribute.
 */
function TaxFormsWorkflowSteps({ rows }: { rows: TaxForm[] | null }) {
  const steps = [
    {
      key: 'review',
      label: '1. Review eligibility',
      done: rows !== null,
      hint: 'Confirm who needs a form. The generators skip anyone already on file.',
    },
    {
      key: 'generate',
      label: '2. Generate',
      done: !!rows && rows.some((r) => r.status === 'DRAFT' || r.status === 'FILED'),
      hint: 'Bulk-create W-2 / 1099-NEC / 1099-MISC drafts.',
    },
    {
      key: 'sign',
      label: '3. Review drafts',
      done: !!rows && rows.some((r) => r.status === 'FILED' || r.status === 'AMENDED'),
      hint: 'Open each draft, verify totals, and download the PDF for the signatory.',
    },
    {
      key: 'file',
      label: '4. File',
      done: !!rows && rows.some((r) => r.status === 'FILED'),
      hint: 'Mark forms FILED. Filed forms are immutable; corrections require a W-2c or 1099-MISC amendment.',
    },
    {
      key: 'distribute',
      label: '5. Distribute',
      done: !!rows && rows.some((r) => r.status === 'FILED'),
      hint: 'Send recipient copies (Copy B/2 for 1099, Copy B/C/2 for W-2). Bulk ZIP available per form type.',
    },
  ];
  return (
    <ol className="grid grid-cols-1 gap-2 rounded-lg border border-navy-secondary bg-navy-secondary/30 p-3 sm:grid-cols-5">
      {steps.map((s) => (
        <li
          key={s.key}
          className={`rounded-md border p-2 text-xs ${
            s.done
              ? 'border-success/40 bg-success/10 ring-1 ring-success/30'
              : 'border-navy-secondary bg-navy'
          }`}
          title={s.hint}
        >
          <div
            className={`font-semibold ${s.done ? 'text-success' : 'text-silver'}`}
          >
            {s.done ? '✓ ' : ''}
            {s.label}
          </div>
          <div className="mt-0.5 text-silver leading-snug">{s.hint}</div>
        </li>
      ))}
    </ol>
  );
}

function TaxFormsTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [rows, setRows] = useState<TaxForm[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [show941Builder, setShow941Builder] = useState(false);
  const [showW2Generate, setShowW2Generate] = useState(false);
  const [showF1099NecGenerate, setShowF1099NecGenerate] = useState(false);
  const [showF1099MiscGenerate, setShowF1099MiscGenerate] = useState(false);
  const [showSubmitter, setShowSubmitter] = useState(false);

  const refresh = () => {
    setRows(null);
    listTaxForms()
      .then((r) => setRows(r.forms))
      .catch((err) => {
        setRows([]);
        toast.error(err instanceof ApiError ? err.message : "Couldn't load tax forms.");
      });
  };
  useEffect(() => {
    refresh();
  }, []);

  const onFile = async (id: string) => {
    if (!(await confirm({ title: 'File this form?', description: 'Filed forms are immutable.' }))) return;
    try {
      await fileTaxForm(id);
      toast.success('Form filed.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't file the form. Try again.");
    }
  };

  const onVoid = async (id: string) => {
    if (!(await confirm({ title: 'Void this form?', destructive: true }))) return;
    try {
      await voidTaxForm(id);
      toast.success('Form voided.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't void the form. Try again.");
    }
  };

  const onCorrect = async (originalW2FormId: string) => {
    const reason = await prompt({
      title: 'Correct this W-2 (W-2c)',
      description:
        'Reason is required and appears on the W-2c the employee receives. The route ' +
        'recomputes the corrected totals from current payroll items — run any AMENDMENT ' +
        'pay runs first.',
      reasonLabel: 'Reason for correction',
      confirmLabel: 'Create W-2c',
    });
    if (!reason) return;
    try {
      const r = await createW2c({ originalW2FormId, correctionReason: reason });
      toast.success(
        `W-2c created. Box 1 delta: ${r.delta.box1.toFixed(2)}, Box 2 delta: ${r.delta.box2.toFixed(2)}.`,
      );
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't create W-2c. Try again.");
    }
  };

  return (
    <div className="space-y-4">
      <TaxFormsWorkflowSteps rows={rows} />
      {canManage && (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setShowSubmitter(true)}>
            Submitter profile
          </Button>
          <Button variant="ghost" onClick={() => setShow941Builder(true)}>
            Build 941
          </Button>
          <Button variant="ghost" onClick={() => setShowW2Generate(true)}>
            Generate W-2s
          </Button>
          <Button variant="ghost" onClick={() => setShowF1099NecGenerate(true)}>
            Generate 1099-NECs
          </Button>
          <Button variant="ghost" onClick={() => setShowF1099MiscGenerate(true)}>
            Generate 1099-MISCs
          </Button>
          <Button onClick={() => setShowNew(true)}>
            <Plus className="mr-2 h-4 w-4" /> New form
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Receipt}
              title="No tax forms"
              description="Drafted and filed federal tax forms appear here."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Kind</TableHead>
                  <TableHead>Year / Q</TableHead>
                  <TableHead className="hidden md:table-cell">Recipient</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden lg:table-cell">Filed</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell className="font-medium text-white">
                      <div className="min-w-0">
                        <div className="truncate">{FORM_KIND_LABEL[f.kind]}</div>
                        <div className="md:hidden text-[11px] text-silver/70 truncate font-normal">
                          {f.associateName ?? 'Aggregate'}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {f.taxYear}
                      {f.quarter ? ` Q${f.quarter}` : ''}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{f.associateName ?? 'Aggregate'}</TableCell>
                    <TableCell>
                      <Badge variant={FORM_STATUS_BADGE[f.status]}>{f.status}</Badge>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {fmtDate(f.filedAt)}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {(f.kind === 'W2' || f.kind === 'W2C') && f.status !== 'VOIDED' && (
                        <span className="inline-flex">
                          <Button size="sm" variant="ghost" asChild className="rounded-r-none">
                            <a href={taxFormPdfUrl(f.id)} download>
                              <Download className="mr-1 h-3 w-3" /> PDF
                            </a>
                          </Button>
                          {f.kind === 'W2' && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="rounded-l-none border-l border-navy-secondary px-2"
                                  aria-label="More PDF formats"
                                >
                                  <ChevronDown className="h-3 w-3" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Single copy</DropdownMenuLabel>
                                <DropdownMenuItem asChild>
                                  <a href={w2PdfUrl(f.id, { copy: 'C' })} download>
                                    Copy C — Employee record
                                  </a>
                                </DropdownMenuItem>
                                <DropdownMenuItem asChild>
                                  <a href={w2PdfUrl(f.id, { copy: 'D' })} download>
                                    Copy D — Employer record
                                  </a>
                                </DropdownMenuItem>
                                <DropdownMenuItem asChild>
                                  <a href={w2PdfUrl(f.id, { copy: '2' })} download>
                                    Copy 2 — State / local
                                  </a>
                                </DropdownMenuItem>
                                <DropdownMenuItem asChild>
                                  <a href={w2PdfUrl(f.id, { copy: 'A' })} download>
                                    Copy A — SSA (paper)
                                  </a>
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuLabel>Multi-copy paper</DropdownMenuLabel>
                                <DropdownMenuItem asChild>
                                  <a href={w2PdfUrl(f.id, { layout: '4up' })} download>
                                    4-up sheet (B / C / 2 / 2)
                                  </a>
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </span>
                      )}
                      {canManage &&
                        f.kind === 'W2' &&
                        (f.status === 'FILED' || f.status === 'AMENDED') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => onCorrect(f.id)}
                          >
                            Correct (W-2c)
                          </Button>
                        )}
                      {canManage && f.status === 'DRAFT' && (
                        <Button size="sm" onClick={() => onFile(f.id)}>
                          File
                        </Button>
                      )}
                      {canManage && f.status === 'FILED' && f.kind !== 'W2' && (
                        <Button size="sm" variant="ghost" onClick={() => onVoid(f.id)}>
                          Void
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewTaxFormDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
            refresh();
          }}
        />
      )}
      {show941Builder && (
        <Form941BuilderDrawer onClose={() => setShow941Builder(false)} />
      )}
      {showW2Generate && (
        <W2GenerateDrawer
          onClose={() => setShowW2Generate(false)}
          onDone={() => {
            setShowW2Generate(false);
            refresh();
          }}
        />
      )}
      {showF1099NecGenerate && (
        <F1099NecGenerateDrawer
          onClose={() => setShowF1099NecGenerate(false)}
          onDone={() => {
            setShowF1099NecGenerate(false);
            refresh();
          }}
        />
      )}
      {showF1099MiscGenerate && (
        <F1099MiscGenerateDrawer
          onClose={() => setShowF1099MiscGenerate(false)}
          onDone={() => {
            setShowF1099MiscGenerate(false);
            refresh();
          }}
        />
      )}
      {showSubmitter && (
        <SubmitterProfileDrawer onClose={() => setShowSubmitter(false)} />
      )}
    </div>
  );
}

function W2GenerateDrawer({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [taxYear, setTaxYear] = useState(String(new Date().getFullYear() - 1));
  const [clientId, setClientId] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof generateW2s>> | null>(null);

  const onGenerate = async () => {
    setRunning(true);
    try {
      const r = await generateW2s({
        taxYear: Number(taxYear),
        clientId: clientId.trim() || null,
      });
      setResult(r);
      toast.success(
        `Created ${r.createdCount} W-2(s); skipped ${r.skippedCount} (already on file).`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't generate W-2s. Try again.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Generate W-2s</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm text-silver">
          Walks every associate with at least one disbursed paystub in the
          year and creates a DRAFT W-2. Idempotent — already-generated forms
          are skipped. Void an existing W-2 first to force regeneration.
        </div>
        <div>
          <Label>Tax year</Label>
          <Input
            type="number"
            className="mt-1"
            value={taxYear}
            onChange={(e) => setTaxYear(e.target.value)}
          />
        </div>
        <div>
          <Label>Client ID (optional — leave blank for all clients)</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="UUID"
          />
        </div>
        <Button onClick={onGenerate} disabled={running}>
          {running ? 'Generating…' : 'Generate'}
        </Button>
        {result && (
          <div className="space-y-2 rounded-md border border-navy-secondary bg-navy-secondary/40 p-3 text-sm text-white">
            <div>Eligible associates: {result.eligibleAssociateCount}</div>
            <div>Created: {result.createdCount}</div>
            <div>Skipped (already on file): {result.skippedCount}</div>
            {result.createdCount > 0 && (
              <div className="flex flex-wrap gap-2 mt-1">
                <Button asChild variant="ghost" size="sm">
                  <a
                    href={w2BulkZipUrl(Number(taxYear), clientId.trim() || null)}
                    download
                  >
                    <Download className="mr-1 h-3 w-3" /> Download all as ZIP
                  </a>
                </Button>
                {clientId.trim() && (
                  <>
                    <Button asChild variant="ghost" size="sm">
                      <a
                        href={w2Efw2Url(Number(taxYear), clientId.trim())}
                        download
                      >
                        <Download className="mr-1 h-3 w-3" /> Download EFW2 e-file
                      </a>
                    </Button>
                    <Button asChild variant="ghost" size="sm">
                      <a
                        href={w2Efw2cUrl(Number(taxYear), clientId.trim())}
                        download
                      >
                        <Download className="mr-1 h-3 w-3" /> EFW2C corrections
                      </a>
                    </Button>
                  </>
                )}
              </div>
            )}
            {result.createdCount > 0 && !clientId.trim() && (
              <div className="text-xs text-silver">
                EFW2 e-file requires a specific clientId — pick one client
                and re-generate to enable the e-file download.
              </div>
            )}
          </div>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onDone}>Done</Button>
      </DrawerFooter>
    </Drawer>
  );
}

/**
 * Inline TIN capture for the 1099-NEC drawer. Without a per-associate
 * detail page in this app yet, HR copies the contractor's UUID from the
 * People Directory, pastes it here, and enters the 9-digit TIN. The
 * server checks employmentType + encrypts at rest. Lookup-then-save
 * keeps us from clobbering a TIN already on file by accident.
 */
function TinCaptureBlock() {
  const [associateId, setAssociateId] = useState('');
  const [tin, setTin] = useState('');
  const [summary, setSummary] = useState<{
    employmentType: string;
    hasTin: boolean;
    tinLast4: string | null;
  } | null>(null);
  const [working, setWorking] = useState(false);

  const onLookup = async () => {
    if (!associateId.trim()) return;
    setWorking(true);
    try {
      const r = await getAssociateTin(associateId.trim());
      setSummary({
        employmentType: r.employmentType,
        hasTin: r.hasTin,
        tinLast4: r.tinLast4,
      });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Lookup failed.');
      setSummary(null);
    } finally {
      setWorking(false);
    }
  };
  const onSave = async () => {
    if (!associateId.trim() || !tin.trim()) return;
    setWorking(true);
    try {
      const r = await saveAssociateTin(associateId.trim(), tin.trim());
      setSummary({
        employmentType: summary?.employmentType ?? '',
        hasTin: true,
        tinLast4: r.tinLast4,
      });
      setTin('');
      toast.success(`TIN saved (last 4: ${r.tinLast4}).`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Save failed.');
    } finally {
      setWorking(false);
    }
  };
  const onClear = async () => {
    if (!associateId.trim()) return;
    if (
      !window.confirm(
        'Remove the encrypted TIN from this associate? This is destructive — the next 1099-NEC generation will fail until a new TIN is captured. Continue?',
      )
    ) {
      return;
    }
    setWorking(true);
    try {
      await clearAssociateTin(associateId.trim());
      setSummary({
        employmentType: summary?.employmentType ?? '',
        hasTin: false,
        tinLast4: null,
      });
      toast.success('TIN cleared.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't clear TIN.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <details className="rounded-md border border-navy-secondary bg-navy-secondary/40 p-3 text-sm">
      <summary className="cursor-pointer text-white">
        Capture contractor TIN (W-9)
      </summary>
      <div className="mt-3 space-y-2">
        <p className="text-xs text-silver">
          Required before the 1099-NEC PDF or IRS FIRE e-file can render
          for a contractor. Copy the contractor's ID from the People
          Directory; the TIN is stored encrypted (AES-GCM via
          PAYOUT_ENCRYPTION_KEY).
        </p>
        <div>
          <Label>Contractor associate ID (UUID)</Label>
          <div className="flex gap-2 mt-1">
            <Input
              className="font-mono text-xs"
              value={associateId}
              onChange={(e) => setAssociateId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
            />
            <Button variant="ghost" size="sm" onClick={onLookup} disabled={working}>
              Look up
            </Button>
          </div>
        </div>
        {summary && (
          <div className="text-xs text-silver">
            employmentType: <span className="text-white">{summary.employmentType}</span>
            {' · '}
            on file:{' '}
            <span className="text-white">
              {summary.hasTin ? `yes (****${summary.tinLast4})` : 'no'}
            </span>
          </div>
        )}
        <div>
          <Label>TIN (9 digits, dashes optional)</Label>
          <div className="flex gap-2 mt-1">
            <Input
              className="font-mono"
              value={tin}
              onChange={(e) => setTin(e.target.value)}
              placeholder="123-45-6789"
              maxLength={11}
            />
            <Button size="sm" onClick={onSave} disabled={working || !associateId.trim() || !tin.trim()}>
              Save
            </Button>
          </div>
        </div>
        {summary?.hasTin && (
          <div className="border-t border-navy-secondary/60 pt-2">
            <p className="text-xs text-silver/70">
              Admin recovery — clears the encrypted TIN entirely. Use only if a TIN was
              entered for the wrong associate or is no longer valid.
            </p>
            <Button
              variant="destructive"
              size="sm"
              onClick={onClear}
              disabled={working}
              className="mt-1"
            >
              Clear TIN
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}

function F1099NecGenerateDrawer({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [taxYear, setTaxYear] = useState(String(new Date().getFullYear() - 1));
  const [clientId, setClientId] = useState('');
  const [cfsfStates, setCfsfStates] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof generate1099Necs>> | null>(null);

  const cfsfList = cfsfStates
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const onGenerate = async () => {
    setRunning(true);
    try {
      const r = await generate1099Necs({
        taxYear: Number(taxYear),
        clientId: clientId.trim() || null,
      });
      setResult(r);
      toast.success(
        `Created ${r.createdCount} 1099-NEC(s); skipped ${r.skippedCount} (already on file).`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't generate 1099-NEC forms. Try again.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Generate 1099-NECs</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm text-silver">
          Walks every contractor (CONTRACTOR_1099_INDIVIDUAL or
          CONTRACTOR_1099_BUSINESS) with at least one disbursed paystub
          in the year. Includes those that meet the IRS reporting
          threshold: Box 1 ≥ $600 OR any backup-withholding amount.
          Idempotent — already-generated forms are skipped.
        </div>
        <TinCaptureBlock />
        <div>
          <Label>Tax year</Label>
          <Input
            type="number"
            className="mt-1"
            value={taxYear}
            onChange={(e) => setTaxYear(e.target.value)}
          />
        </div>
        <div>
          <Label>Client ID (optional — leave blank for all clients)</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="UUID"
          />
        </div>
        <div>
          <Label>
            CF/SF states (optional — CSV of USPS codes for Combined
            Federal/State Filing)
          </Label>
          <Input
            className="mt-1 font-mono text-xs uppercase"
            value={cfsfStates}
            onChange={(e) => setCfsfStates(e.target.value)}
            placeholder="FL, CA, NY"
          />
          <p className="mt-1 text-xs text-silver">
            Pass only states that participate in CF/SF in the filing year.
            Listed states get K records appended; the IRS forwards to
            them so a separate state filing isn't needed.
          </p>
        </div>
        <Button onClick={onGenerate} disabled={running}>
          {running ? 'Generating…' : 'Generate'}
        </Button>
        {result && (
          <div className="space-y-2 rounded-md border border-navy-secondary bg-navy-secondary/40 p-3 text-sm text-white">
            <div>Eligible contractors: {result.eligibleAssociateCount}</div>
            <div>Created: {result.createdCount}</div>
            <div>Skipped (already on file): {result.skippedCount}</div>
            {result.createdCount > 0 && (
              <div className="flex flex-wrap gap-2 mt-1">
                <Button asChild variant="ghost" size="sm">
                  <a
                    href={f1099NecBulkZipUrl(Number(taxYear), clientId.trim() || null)}
                    download
                  >
                    <Download className="mr-1 h-3 w-3" /> Download all as ZIP
                  </a>
                </Button>
                {clientId.trim() && (
                  <Button asChild variant="ghost" size="sm">
                    <a
                      href={f1099NecFireUrl(
                        Number(taxYear),
                        clientId.trim(),
                        cfsfList.length > 0 ? cfsfList : undefined,
                      )}
                      download
                    >
                      <Download className="mr-1 h-3 w-3" />
                      {cfsfList.length > 0
                        ? `IRS FIRE e-file (CF/SF: ${cfsfList.join(', ')})`
                        : 'IRS FIRE e-file'}
                    </a>
                  </Button>
                )}
              </div>
            )}
            {result.createdCount > 0 && !clientId.trim() && (
              <div className="text-xs text-silver">
                IRS FIRE e-file requires a per-client scope. Re-open this
                drawer with a single Client ID to generate that download.
              </div>
            )}
          </div>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onDone}>Done</Button>
      </DrawerFooter>
    </Drawer>
  );
}

function F1099MiscGenerateDrawer({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [taxYear, setTaxYear] = useState(String(new Date().getFullYear() - 1));
  const [clientId, setClientId] = useState('');
  const [cfsfStates, setCfsfStates] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Awaited<ReturnType<typeof generate1099Miscs>> | null>(
    null,
  );

  const cfsfList = cfsfStates
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

  const onGenerate = async () => {
    setRunning(true);
    try {
      const r = await generate1099Miscs({
        taxYear: Number(taxYear),
        clientId: clientId.trim() || null,
      });
      setResult(r);
      toast.success(
        `Created ${r.createdCount} 1099-MISC(s); skipped ${r.skippedCount} (already on file).`,
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't generate 1099-MISC forms. Try again.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Drawer open onOpenChange={(open) => !open && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Generate 1099-MISCs</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <p className="text-xs text-silver">
          One 1099-MISC per contractor that meets the per-box reporting bar
          (Royalties $10, Box 4 backup withholding any amount, others
          $600). Until per-payment box-mapping lands, gross pay routes to
          Box 3 (Other income). Re-runs are idempotent — only newly-
          eligible contractors get a new draft.
        </p>
        <div>
          <Label>Tax year</Label>
          <Input
            type="number"
            className="mt-1"
            value={taxYear}
            onChange={(e) => setTaxYear(e.target.value)}
          />
        </div>
        <div>
          <Label>Client ID (optional — leave blank for all clients)</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="UUID"
          />
        </div>
        <div>
          <Label>
            CF/SF states (optional — CSV of USPS codes for Combined
            Federal/State Filing)
          </Label>
          <Input
            className="mt-1 font-mono text-xs uppercase"
            value={cfsfStates}
            onChange={(e) => setCfsfStates(e.target.value)}
            placeholder="FL, CA, NY"
          />
          <p className="mt-1 text-xs text-silver">
            Pass only states that participate in CF/SF in the filing year.
          </p>
        </div>
        <Button onClick={onGenerate} disabled={running}>
          {running ? 'Generating…' : 'Generate'}
        </Button>
        {result && (
          <div className="space-y-2 rounded-md border border-navy-secondary bg-navy-secondary/40 p-3 text-sm text-white">
            <div>Eligible contractors: {result.eligibleAssociateCount}</div>
            <div>Created: {result.createdCount}</div>
            <div>Skipped (already on file): {result.skippedCount}</div>
            {result.createdCount > 0 && (
              <div className="flex flex-wrap gap-2 mt-1">
                <Button asChild variant="ghost" size="sm">
                  <a
                    href={f1099MiscBulkZipUrl(Number(taxYear), clientId.trim() || null)}
                    download
                  >
                    <Download className="mr-1 h-3 w-3" /> Download all as ZIP
                  </a>
                </Button>
                {clientId.trim() && (
                  <Button asChild variant="ghost" size="sm">
                    <a
                      href={f1099MiscFireUrl(
                        Number(taxYear),
                        clientId.trim(),
                        cfsfList.length > 0 ? cfsfList : undefined,
                      )}
                      download
                    >
                      <Download className="mr-1 h-3 w-3" />
                      {cfsfList.length > 0
                        ? `IRS FIRE e-file (CF/SF: ${cfsfList.join(', ')})`
                        : 'IRS FIRE e-file'}
                    </a>
                  </Button>
                )}
              </div>
            )}
            {result.createdCount > 0 && !clientId.trim() && (
              <div className="text-xs text-silver">
                IRS FIRE e-file requires a per-client scope. Re-open this
                drawer with a single Client ID to generate that download.
              </div>
            )}
          </div>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onDone}>Done</Button>
      </DrawerFooter>
    </Drawer>
  );
}

function NewTaxFormDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<TaxFormKind>('F941');
  const [taxYear, setTaxYear] = useState(String(new Date().getFullYear() - 1));
  const [quarter, setQuarter] = useState('1');
  const [associateId, setAssociateId] = useState('');
  const [amountsJson, setAmountsJson] = useState('{\n}');
  const [ein, setEin] = useState('');
  const [saving, setSaving] = useState(false);

  const needsQuarter = kind === 'F941';
  const needsAssociate = kind === 'W2' || kind === 'F1099_NEC' || kind === 'F1099_MISC';

  const onSubmit = async () => {
    let amounts: Record<string, unknown>;
    try {
      amounts = JSON.parse(amountsJson);
    } catch {
      toast.error('Amounts must be valid JSON.');
      return;
    }
    if (needsAssociate && !associateId) {
      toast.error('Associate ID required for W-2/1099.');
      return;
    }
    setSaving(true);
    try {
      await createTaxForm({
        kind,
        taxYear: Number(taxYear),
        quarter: needsQuarter ? Number(quarter) : null,
        associateId: needsAssociate ? associateId.trim() : null,
        amounts,
        ein: ein.trim() || null,
      });
      toast.success('Form drafted.');
      onSaved();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't draft the form. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-2xl">
      <DrawerHeader>
        <DrawerTitle>New tax form</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Kind</Label>
          <Select
            className="mt-1"
            value={kind}
            onChange={(e) => setKind(e.target.value as TaxFormKind)}
          >
            {(Object.keys(FORM_KIND_LABEL) as TaxFormKind[]).map((k) => (
              <option key={k} value={k}>
                {FORM_KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Tax year</Label>
            <Input
              type="number"
              className="mt-1"
              value={taxYear}
              onChange={(e) => setTaxYear(e.target.value)}
            />
          </div>
          {needsQuarter && (
            <div>
              <Label>Quarter</Label>
              <Select
                className="mt-1"
                value={quarter}
                onChange={(e) => setQuarter(e.target.value)}
              >
                <option value="1">Q1</option>
                <option value="2">Q2</option>
                <option value="3">Q3</option>
                <option value="4">Q4</option>
              </Select>
            </div>
          )}
        </div>
        {needsAssociate && (
          <div>
            <Label>Associate ID</Label>
            <Input
              className="mt-1 font-mono text-xs"
              value={associateId}
              onChange={(e) => setAssociateId(e.target.value)}
            />
          </div>
        )}
        <div>
          <Label>EIN (optional)</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={ein}
            onChange={(e) => setEin(e.target.value)}
            placeholder="XX-XXXXXXX"
          />
        </div>
        <div>
          <Label>Amounts (JSON)</Label>
          <Textarea
            className="mt-1 min-h-40 font-mono text-xs"
            value={amountsJson}
            onChange={(e) => setAmountsJson(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Saving…' : 'Create draft'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function Form941BuilderDrawer({ onClose }: { onClose: () => void }) {
  const [taxYear, setTaxYear] = useState(String(new Date().getFullYear() - 1));
  const [quarter, setQuarter] = useState('1');
  const [result, setResult] = useState<Awaited<ReturnType<typeof build941>> | null>(
    null,
  );
  const [loading, setLoading] = useState(false);

  const onBuild = async () => {
    setLoading(true);
    try {
      const r = await build941(Number(taxYear), Number(quarter));
      setResult(r);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't build the 941. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>941 builder</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm text-silver">
          Aggregates finalized payroll runs in the period to suggest 941 line
          amounts. Copy into a draft 941 and edit as needed.
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Tax year</Label>
            <Input
              type="number"
              className="mt-1"
              value={taxYear}
              onChange={(e) => setTaxYear(e.target.value)}
            />
          </div>
          <div>
            <Label>Quarter</Label>
            <Select
              className="mt-1"
              value={quarter}
              onChange={(e) => setQuarter(e.target.value)}
            >
              <option value="1">Q1</option>
              <option value="2">Q2</option>
              <option value="3">Q3</option>
              <option value="4">Q4</option>
            </Select>
          </div>
        </div>
        <Button onClick={onBuild} disabled={loading}>
          {loading ? 'Building…' : 'Build'}
        </Button>
        {result && (
          <pre className="mt-2 whitespace-pre-wrap text-xs text-white bg-navy-secondary/40 border border-navy-secondary rounded-md p-3">
{JSON.stringify(result, null, 2)}
          </pre>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function SubmitterProfileDrawer({ onClose }: { onClose: () => void }) {
  const [profile, setProfile] = useState<SubmitterProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<SubmitterProfileInput>({
    ein: '',
    userId: '',
    name: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: '',
    zip5: '',
    zip4: '',
    contactName: '',
    contactPhone: '',
    contactEmail: '',
    irsTcc: '',
  });

  useEffect(() => {
    getSubmitterProfile()
      .then((r) => {
        if (r.profile) {
          setProfile(r.profile);
          setForm({
            ein: r.profile.ein,
            userId: r.profile.userId,
            name: r.profile.name,
            addressLine1: r.profile.addressLine1,
            addressLine2: r.profile.addressLine2 ?? '',
            city: r.profile.city,
            state: r.profile.state,
            zip5: r.profile.zip5,
            zip4: r.profile.zip4 ?? '',
            contactName: r.profile.contactName,
            contactPhone: r.profile.contactPhone,
            contactEmail: r.profile.contactEmail,
            irsTcc: r.profile.irsTcc ?? '',
          });
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const onSave = async () => {
    setSaving(true);
    try {
      const r = await saveSubmitterProfile({
        ...form,
        addressLine2: form.addressLine2?.trim() || null,
        zip4: form.zip4?.trim() || null,
        irsTcc: form.irsTcc?.trim().toUpperCase() || null,
      });
      setProfile(r.profile);
      toast.success('Submitter profile saved.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Couldn't save submitter profile. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const update = (k: keyof SubmitterProfileInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()} width="max-w-2xl">
      <DrawerHeader>
        <DrawerTitle>SSA submitter profile</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm text-silver">
          Used as the RA submitter record at the top of every EFW2 e-file.
          The BSO User ID is assigned by SSA during Business Services Online
          enrollment and is required to submit electronically.
        </div>
        {loading ? (
          <SkeletonRows count={3} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>EIN (9 digits, no dashes)</Label>
                <Input
                  className="mt-1 font-mono"
                  value={form.ein}
                  onChange={update('ein')}
                  placeholder="123456789"
                />
              </div>
              <div>
                <Label>BSO User ID</Label>
                <Input
                  className="mt-1 font-mono"
                  value={form.userId}
                  onChange={update('userId')}
                />
              </div>
            </div>
            <div>
              <Label>IRS FIRE TCC (5 chars, optional)</Label>
              <Input
                className="mt-1 font-mono"
                maxLength={5}
                value={form.irsTcc ?? ''}
                onChange={update('irsTcc')}
                placeholder="e.g. AB123"
              />
              <p className="mt-1 text-xs text-silver">
                Required to e-file 1099-NECs via IRS FIRE. Distinct from
                the SSA BSO User ID; left blank for W-2-only filers.
              </p>
            </div>
            <div>
              <Label>Submitter name (max 57 chars)</Label>
              <Input className="mt-1" value={form.name} onChange={update('name')} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Address line 1</Label>
                <Input
                  className="mt-1"
                  value={form.addressLine1}
                  onChange={update('addressLine1')}
                />
              </div>
              <div>
                <Label>Address line 2 (optional)</Label>
                <Input
                  className="mt-1"
                  value={form.addressLine2 ?? ''}
                  onChange={update('addressLine2')}
                />
              </div>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div className="col-span-2">
                <Label>City</Label>
                <Input className="mt-1" value={form.city} onChange={update('city')} />
              </div>
              <div>
                <Label>State</Label>
                <Input
                  className="mt-1"
                  maxLength={2}
                  value={form.state}
                  onChange={update('state')}
                />
              </div>
              <div>
                <Label>ZIP</Label>
                <Input
                  className="mt-1"
                  maxLength={5}
                  value={form.zip5}
                  onChange={update('zip5')}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label>Contact name</Label>
                <Input
                  className="mt-1"
                  value={form.contactName}
                  onChange={update('contactName')}
                />
              </div>
              <div>
                <Label>Contact phone</Label>
                <Input
                  className="mt-1"
                  value={form.contactPhone}
                  onChange={update('contactPhone')}
                />
              </div>
              <div>
                <Label>Contact email</Label>
                <Input
                  className="mt-1"
                  type="email"
                  value={form.contactEmail}
                  onChange={update('contactEmail')}
                />
              </div>
            </div>
            {profile && (
              <div className="text-xs text-silver">
                Last updated: {new Date(profile.updatedAt).toLocaleString()}
              </div>
            )}
          </>
        )}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
        <Button onClick={onSave} disabled={saving || loading}>
          {saving ? 'Saving…' : profile ? 'Save changes' : 'Create profile'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
