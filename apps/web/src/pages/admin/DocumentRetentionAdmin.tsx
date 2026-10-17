import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Archive } from 'lucide-react';
import { toast } from 'sonner';
import type { DocumentKind } from '@alto-people/shared';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, parseYmd } from '@/lib/format';
import { getRetentionPolicies, previewRetention, updateRetentionPolicies, type RetentionPolicyRow } from '@/lib/documentRetentionApi';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { QueryError } from '@/components/ui/QueryError';
import { SectionTitle } from '@/components/ui/SectionTitle';
import { AssociateLink } from '@/components/ui/AssociateLink';

/**
 * Document retention (HR pack 2026-10): how many years after a person
 * separates each kind of document is kept. Past that, the daily sweep
 * purges the file (the row stays, with an audit entry). Blank = forever.
 * A preview shows exactly what the next sweep would purge, so no policy is
 * set blind.
 */

const KIND_LABEL: Record<DocumentKind, string> = {
  ID: 'Government ID',
  SSN_CARD: 'Social Security card',
  I9_SUPPORTING: 'I-9 supporting document',
  W4_PDF: 'W-4',
  OFFER_LETTER: 'Offer letter',
  POLICY: 'Policy acknowledgement',
  HOUSING_AGREEMENT: 'Housing agreement',
  TRANSPORT_AGREEMENT: 'Transport agreement',
  J1_DS2019: 'DS-2019',
  J1_VISA: 'J-1 visa',
  SIGNED_AGREEMENT: 'Signed agreement',
  BACKGROUND_CHECK_RESULT: 'Background check result',
  DRUG_TEST_RESULT: 'Drug test result',
  I9_VERIFICATION_RESULT: 'I-9 verification result',
  PAYSTUB: 'Paystub',
  OTHER: 'Other',
};

export function DocumentRetentionAdmin() {
  const { can } = useAuth();
  const canManage = can('manage:org');
  const query = useQuery({ queryKey: ['document-retention'], queryFn: getRetentionPolicies });
  const preview = useQuery({ queryKey: ['document-retention', 'preview'], queryFn: previewRetention });
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (query.data) {
      const next: Record<string, string> = {};
      for (const p of query.data.policies) next[p.kind] = p.retainYearsAfterSeparation === null ? '' : String(p.retainYearsAfterSeparation);
      setDraft(next);
    }
  }, [query.data]);

  const rows = query.data?.policies ?? [];
  const dirty = rows.some((p) => (draft[p.kind] ?? '') !== (p.retainYearsAfterSeparation === null ? '' : String(p.retainYearsAfterSeparation)));
  const invalid = rows.filter((p) => {
    const v = draft[p.kind] ?? '';
    if (v === '') return false;
    const n = Number(v);
    return !Number.isInteger(n) || n < 1 || n > 100 || (p.floorYears !== null && n < p.floorYears);
  });

  const save = useMutation({
    mutationFn: () =>
      updateRetentionPolicies(
        rows
          .filter((p) => (draft[p.kind] ?? '') !== (p.retainYearsAfterSeparation === null ? '' : String(p.retainYearsAfterSeparation)))
          .map((p) => ({ kind: p.kind, retainYearsAfterSeparation: (draft[p.kind] ?? '') === '' ? null : Number(draft[p.kind]) })),
      ),
    onSuccess: () => {
      toast.success('Retention policies saved.');
      void query.refetch();
      void preview.refetch();
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save.'),
  });

  const columns: GridColumn<RetentionPolicyRow>[] = [
    { key: 'kind', header: 'Document kind', accessor: (r) => KIND_LABEL[r.kind], sortable: true, primary: true, className: 'text-ink' },
    {
      key: 'years',
      header: 'Keep for (years after separation)',
      accessor: (r) => r.retainYearsAfterSeparation ?? '',
      searchable: false,
      stopRowClick: true,
      cell: (r) => (
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={r.floorYears ?? 1}
            max={100}
            className="w-24"
            aria-label={`Years to keep ${KIND_LABEL[r.kind]}`}
            value={draft[r.kind] ?? ''}
            placeholder="Forever"
            disabled={!canManage}
            onChange={(e) => setDraft((d) => ({ ...d, [r.kind]: e.target.value }))}
          />
          {(draft[r.kind] ?? '') === '' && <span className="text-xs text-ink-muted">kept forever</span>}
        </div>
      ),
    },
    { key: 'floor', header: 'Legal floor', accessor: (r) => r.floorYears ?? '', searchable: false, className: 'text-xs text-ink-muted', cell: (r) => (r.floorYears ? <Badge variant="outline">At least {r.floorYears} years</Badge> : '—') },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Document retention"
        subtitle="How long each kind of document stays after a person leaves. Files past their policy are purged by the daily sweep; the record of the document, and an audit entry, remain."
        breadcrumbs={[{ label: 'Settings & trust' }, { label: 'Document retention' }]}
        primaryAction={
          canManage ? (
            <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!dirty || invalid.length > 0}>
              Save policies
            </Button>
          ) : undefined
        }
      />
      {query.isError && <QueryError what="the retention policies" query={query} />}
      {invalid.length > 0 && (
        <div role="alert" className="text-sm text-alert">
          {invalid.map((p) => `${KIND_LABEL[p.kind]} must be a whole number of years${p.floorYears ? `, at least ${p.floorYears}` : ''}.`).join(' ')}
        </div>
      )}
      <Card>
        <CardContent className="p-3">
          <DataGrid<RetentionPolicyRow> id="document-retention" caption="Retention by document kind" rows={rows} rowKey={(r) => r.kind} loading={query.isLoading} search={false} urlState={false} columns={columns} />
        </CardContent>
      </Card>
      <section className="space-y-3" aria-labelledby="retention-preview">
        <SectionTitle as="h2" icon={Archive} title={<span id="retention-preview">What the next sweep would purge</span>} description="A dry run against today's policies. Nothing here is deleted until the sweep runs." />
        <Card>
          <CardContent className="p-3">
            {preview.isError ? (
              <QueryError what="the preview" query={preview} />
            ) : (
              <>
                <div className="px-2 pb-2 text-sm text-ink-muted" aria-live="polite">
                  {preview.data ? `${preview.data.count} ${preview.data.count === 1 ? 'file' : 'files'} would be purged.` : 'Checking…'}
                </div>
                <DataGrid<{ id: string; kind: DocumentKind; filename: string; associateId: string; associateName: string; separatedAt: string; retainYears: number }>
                  id="document-retention-preview"
                  caption="Files past their retention"
                  rows={preview.data?.candidates ?? []}
                  rowKey={(r) => r.id}
                  loading={preview.isLoading}
                  search={false}
                  urlState={false}
                  columns={[
                    { key: 'person', header: 'Person', accessor: (r) => r.associateName, primary: true, cell: (r) => <AssociateLink associateId={r.associateId}>{r.associateName}</AssociateLink> },
                    { key: 'kind', header: 'Kind', accessor: (r) => KIND_LABEL[r.kind], cardMeta: true },
                    { key: 'file', header: 'File', accessor: (r) => r.filename, className: 'text-xs text-ink-muted' },
                    { key: 'separated', header: 'Separated', accessor: (r) => r.separatedAt, className: 'text-xs', cell: (r) => fmtDate(parseYmd(r.separatedAt)) },
                    { key: 'years', header: 'Policy', accessor: (r) => r.retainYears, align: 'right', className: 'text-xs tabular-nums', cell: (r) => `${r.retainYears} y` },
                  ]}
                />
              </>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
