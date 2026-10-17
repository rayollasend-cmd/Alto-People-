import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Briefcase, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { useAuth, useTenant, useTerm } from '@/lib/auth';
import { createEmployer, listEmployers, updateEmployer, type EmployerFactsInput, type EmployerRow } from '@/lib/orgApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/Dialog';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';

/**
 * Employers of record (Brief 2-1b step 4). The tenant's own row, a
 * customer organization's row when it carries the legal facts, or a
 * third party. The W-2/1099 employer and the pay statement's company
 * block come from here.
 */

const maskEin = (ein: string | null) => (ein ? `••-•••${ein.replace(/\D/g, '').slice(-4)}` : '—');

export function EmployersAdmin() {
  const { can } = useAuth();
  const { moduleOn } = useTenant();
  const term = useTerm();
  const canManage = can('manage:org');
  const [editing, setEditing] = useState<EmployerRow | 'new' | null>(null);
  const query = useQuery({ queryKey: ['org', 'employers'], queryFn: listEmployers });
  const rows = useMemo(() => (query.data?.employers ?? []).filter((r): r is EmployerRow => !!r && typeof r.id === 'string'), [query.data]);
  const clientNoun = term('label.client');

  const kindLabel = (r: EmployerRow) => (r.kind === 'TENANT' ? 'This organization' : r.kind === 'CLIENT' ? clientNoun : 'Third party');
  const address = (r: EmployerRow) => [r.address.line1, r.address.line2, [r.address.city, r.address.state, r.address.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');

  const columns: GridColumn<EmployerRow>[] = [
    {
      key: 'legalName',
      header: 'Legal name',
      accessor: (r) => r.legalName,
      sortable: true,
      primary: true,
      cell: (r) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-white">{r.legalName}</span>
          {r.isDefault && (
            <Badge variant="accent" size="sm" withDot={false}>
              default
            </Badge>
          )}
        </div>
      ),
    },
    { key: 'kind', header: 'Kind', accessor: (r) => kindLabel(r), sortable: true, cardMeta: true, className: 'text-xs' },
    { key: 'ein', header: 'EIN', accessor: (r) => maskEin(r.ein), className: 'tabular-nums text-xs' },
    { key: 'address', header: 'Address', accessor: (r) => address(r) || '—', className: 'text-xs text-silver' },
    ...(moduleOn('clientPortal') ? [{ key: 'client', header: clientNoun, accessor: (r: EmployerRow) => r.clientName ?? '—', className: 'text-xs' } satisfies GridColumn<EmployerRow>] : []),
    { key: 'employments', header: 'People employed', accessor: (r) => r.employments, align: 'right', sortable: true, className: 'tabular-nums' },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Employers of record"
        subtitle="Who legally employs each person. The W-2 or 1099 employer and the pay statement's company block come from here."
        breadcrumbs={[{ label: 'Settings & trust', to: '/admin' }, { label: 'Organization profile', to: '/admin/organization' }, { label: 'Employers of record' }]}
        primaryAction={
          canManage ? (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              Add employer of record
            </Button>
          ) : undefined
        }
      />
      {query.isError ? <QueryError what="the employers of record" query={query} /> : null}
      <DataGrid<EmployerRow>
        id="employers"
        caption="Employers of record"
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        loading={query.isPending}
        urlState={false}
        exportCsv={false}
        search={false}
        onRowClick={canManage ? (r) => setEditing(r) : undefined}
        rowActionLabel={(r) => `Edit ${r.legalName}`}
        empty={{ icon: Briefcase, title: 'No employers on file', description: 'The organization’s own row is written when the first tax form is prepared.' }}
      />
      <p className="text-xs text-silver">
        The W-2/1099 employer and the pay statement’s company block come from here{moduleOn('clientPortal') ? `, never from a ${clientNoun.toLowerCase()} record` : ''}.
      </p>
      {editing && <EmployerDialog employer={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function EmployerDialog({ employer, onClose }: { employer: EmployerRow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [legalName, setLegalName] = useState(employer?.legalName ?? '');
  const [ein, setEin] = useState(employer?.ein ?? '');
  const [line1, setLine1] = useState(employer?.address.line1 ?? '');
  const [line2, setLine2] = useState(employer?.address.line2 ?? '');
  const [city, setCity] = useState(employer?.address.city ?? '');
  const [state, setState] = useState(employer?.address.state ?? '');
  const [zip, setZip] = useState(employer?.address.zip ?? '');
  const dirty = () =>
    legalName !== (employer?.legalName ?? '') || ein !== (employer?.ein ?? '') || line1 !== (employer?.address.line1 ?? '') || city !== (employer?.address.city ?? '');
  const body = (): EmployerFactsInput & { legalName: string } => ({
    legalName: legalName.trim(),
    ein: ein.trim() || null,
    addressLine1: line1.trim() || null,
    addressLine2: line2.trim() || null,
    city: city.trim() || null,
    state: state.trim().toUpperCase() || null,
    zip: zip.trim() || null,
  });
  const save = useMutation({
    mutationFn: () => (employer ? updateEmployer(employer.id, body()) : createEmployer(body())),
    onSuccess: async () => {
      toast.success(employer ? 'Employer updated.' : 'Employer of record added.');
      await qc.invalidateQueries({ queryKey: ['org', 'employers'] });
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save the employer.'),
  });
  const valid = legalName.trim().length > 0 && (ein.trim() === '' || /^\d{2}-?\d{7}$/.test(ein.trim()));
  return (
    <Dialog open onOpenChange={(o) => !o && !save.isPending && onClose()} confirmDiscard={dirty}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{employer ? `Edit ${employer.legalName}` : 'Add an employer of record'}</DialogTitle>
          <DialogDescription>
            {employer ? 'The legal facts the tax forms print.' : 'A third-party employer of record: the legal name and EIN that go on its tax forms.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field label="Legal name">{(p) => <Input {...p} value={legalName} onChange={(e) => setLegalName(e.target.value)} autoFocus />}</Field>
          <Field label="EIN" hint="Nine digits, 12-3456789.">
            {(p) => <Input {...p} value={ein} onChange={(e) => setEin(e.target.value)} inputMode="numeric" placeholder="12-3456789" />}
          </Field>
          <Field label="Address line 1">{(p) => <Input {...p} value={line1} onChange={(e) => setLine1(e.target.value)} />}</Field>
          <Field label="Address line 2">{(p) => <Input {...p} value={line2} onChange={(e) => setLine2(e.target.value)} />}</Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="City">{(p) => <Input {...p} value={city} onChange={(e) => setCity(e.target.value)} />}</Field>
            <Field label="State">{(p) => <Input {...p} value={state} onChange={(e) => setState(e.target.value)} maxLength={2} />}</Field>
            <Field label="ZIP">{(p) => <Input {...p} value={zip} onChange={(e) => setZip(e.target.value)} inputMode="numeric" />}</Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!valid || save.isPending}>
            {employer ? 'Save' : 'Add employer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
