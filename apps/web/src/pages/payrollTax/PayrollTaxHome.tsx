import { useEffect, useState } from 'react';
import { Download, FileText, Plus, Receipt, Scale } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  build941,
  createGarnishment,
  createTaxForm,
  fileTaxForm,
  generateW2s,
  getSubmitterProfile,
  listGarnishments,
  listTaxForms,
  saveSubmitterProfile,
  setGarnishmentStatus,
  taxFormPdfUrl,
  voidTaxForm,
  w2BulkZipUrl,
  w2Efw2Url,
  type Garnishment,
  type GarnishmentKind,
  type GarnishmentStatus,
  type SubmitterProfile,
  type SubmitterProfileInput,
  type TaxForm,
  type TaxFormKind,
} from '@/lib/payrollTax91Api';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
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
  EmptyState,
  Input,
  PageHeader,
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

  const refresh = () => {
    setRows(null);
    listGarnishments()
      .then((r) => setRows(r.garnishments))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const onStatus = async (id: string, status: GarnishmentStatus) => {
    try {
      await setGarnishmentStatus(id, status);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
                  <TableHead>Kind</TableHead>
                  <TableHead>Withhold</TableHead>
                  <TableHead>Cap / progress</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="font-medium text-white">
                      {g.associateName}
                    </TableCell>
                    <TableCell>{GARN_KIND_LABEL[g.kind]}</TableCell>
                    <TableCell>
                      {g.amountPerRun
                        ? `$${g.amountPerRun}/run`
                        : g.percentOfDisp
                          ? `${(Number(g.percentOfDisp) * 100).toFixed(2)}% of disp.`
                          : '—'}
                    </TableCell>
                    <TableCell>
                      {g.totalCap
                        ? `$${g.amountWithheld} / $${g.totalCap}`
                        : `$${g.amountWithheld}`}
                    </TableCell>
                    <TableCell>
                      <Badge variant={GARN_BADGE[g.status]}>{g.status}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage && (g.status === 'ACTIVE' || g.status === 'SUSPENDED') && (
                        <select
                          className="bg-navy-secondary/40 border border-navy-secondary text-xs rounded px-2 py-1 text-white"
                          value={g.status}
                          onChange={(e) => onStatus(g.id, e.target.value as GarnishmentStatus)}
                        >
                          <option value="ACTIVE">ACTIVE</option>
                          <option value="SUSPENDED">SUSPENDED</option>
                          <option value="TERMINATED">TERMINATED</option>
                        </select>
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
        <NewGarnishmentDrawer
          onClose={() => setShowNew(false)}
          onSaved={() => {
            setShowNew(false);
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
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
            value={kind}
            onChange={(e) => setKind(e.target.value as GarnishmentKind)}
          >
            {(Object.keys(GARN_KIND_LABEL) as GarnishmentKind[]).map((k) => (
              <option key={k} value={k}>
                {GARN_KIND_LABEL[k]}
              </option>
            ))}
          </select>
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

// ----- Tax forms --------------------------------------------------------

const FORM_KIND_LABEL: Record<TaxFormKind, string> = {
  F941: 'Form 941 (Quarterly federal)',
  F940: 'Form 940 (Annual FUTA)',
  W2: 'W-2 (Annual employee)',
  F1099_NEC: '1099-NEC (Annual contractor)',
};

const FORM_STATUS_BADGE: Record<TaxForm['status'], 'pending' | 'success' | 'default' | 'destructive'> = {
  DRAFT: 'pending',
  FILED: 'success',
  AMENDED: 'default',
  VOIDED: 'destructive',
};

function TaxFormsTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<TaxForm[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [show941Builder, setShow941Builder] = useState(false);
  const [showW2Generate, setShowW2Generate] = useState(false);
  const [showSubmitter, setShowSubmitter] = useState(false);

  const refresh = () => {
    setRows(null);
    listTaxForms()
      .then((r) => setRows(r.forms))
      .catch(() => setRows([]));
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
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onVoid = async (id: string) => {
    if (!(await confirm({ title: 'Void this form?', destructive: true }))) return;
    try {
      await voidTaxForm(id);
      toast.success('Form voided.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-4">
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
                  <TableHead>Recipient</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Filed</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((f) => (
                  <TableRow key={f.id}>
                    <TableCell className="font-medium text-white">
                      {FORM_KIND_LABEL[f.kind]}
                    </TableCell>
                    <TableCell>
                      {f.taxYear}
                      {f.quarter ? ` Q${f.quarter}` : ''}
                    </TableCell>
                    <TableCell>{f.associateName ?? 'Aggregate'}</TableCell>
                    <TableCell>
                      <Badge variant={FORM_STATUS_BADGE[f.status]}>{f.status}</Badge>
                    </TableCell>
                    <TableCell>
                      {f.filedAt ? new Date(f.filedAt).toLocaleDateString() : '—'}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {f.kind === 'W2' && f.status !== 'VOIDED' && (
                        <Button size="sm" variant="ghost" asChild>
                          <a href={taxFormPdfUrl(f.id)} download>
                            <Download className="mr-1 h-3 w-3" /> PDF
                          </a>
                        </Button>
                      )}
                      {canManage && f.status === 'DRAFT' && (
                        <Button size="sm" onClick={() => onFile(f.id)}>
                          File
                        </Button>
                      )}
                      {canManage && f.status === 'FILED' && (
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
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
                  <Button asChild variant="ghost" size="sm">
                    <a
                      href={w2Efw2Url(Number(taxYear), clientId.trim())}
                      download
                    >
                      <Download className="mr-1 h-3 w-3" /> Download EFW2 e-file
                    </a>
                  </Button>
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

function NewTaxFormDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<TaxFormKind>('F941');
  const [taxYear, setTaxYear] = useState(String(new Date().getFullYear() - 1));
  const [quarter, setQuarter] = useState('1');
  const [associateId, setAssociateId] = useState('');
  const [amountsJson, setAmountsJson] = useState('{\n}');
  const [ein, setEin] = useState('');
  const [saving, setSaving] = useState(false);

  const needsQuarter = kind === 'F941';
  const needsAssociate = kind === 'W2' || kind === 'F1099_NEC';

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
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
          <select
            className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
            value={kind}
            onChange={(e) => setKind(e.target.value as TaxFormKind)}
          >
            {(Object.keys(FORM_KIND_LABEL) as TaxFormKind[]).map((k) => (
              <option key={k} value={k}>
                {FORM_KIND_LABEL[k]}
              </option>
            ))}
          </select>
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
              <select
                className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
                value={quarter}
                onChange={(e) => setQuarter(e.target.value)}
              >
                <option value="1">Q1</option>
                <option value="2">Q2</option>
                <option value="3">Q3</option>
                <option value="4">Q4</option>
              </select>
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
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
            <select
              className="mt-1 flex h-10 w-full rounded-md border border-navy-secondary bg-navy-secondary/40 px-3 text-sm text-white"
              value={quarter}
              onChange={(e) => setQuarter(e.target.value)}
            >
              <option value="1">Q1</option>
              <option value="2">Q2</option>
              <option value="3">Q3</option>
              <option value="4">Q4</option>
            </select>
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
      });
      setProfile(r.profile);
      toast.success('Submitter profile saved.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
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
