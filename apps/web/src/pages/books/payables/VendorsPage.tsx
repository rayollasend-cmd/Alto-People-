import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import type { BooksVendor } from '@alto-people/shared';
import { listVendors, PAYABLES_KEY } from '@/lib/books/payablesApi';
import { ListTemplate } from '@/components/templates';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataGrid, type GridColumn } from '@/components/ui/DataGrid';
import { MetricCard } from '@/components/ui/MetricCard';
import { METHOD_LABEL, errText, money, useBooksWrite } from './payablesKit';

/** Vendors: who the company pays, what it owes each, and who gets a 1099. */
export function VendorsPage() {
  const navigate = useNavigate();
  const write = useBooksWrite();
  const q = useQuery({ queryKey: [...PAYABLES_KEY, 'vendors', 'all'], queryFn: () => listVendors({ active: 'all' }) });
  const vendors = q.data?.vendors ?? [];
  const active = vendors.filter((v) => v.isActive);
  const owed = vendors.reduce((s, v) => s + v.balance, 0);
  const pendingBank = vendors.filter((v) => v.pendingBankChange).length;
  const columns: GridColumn<BooksVendor>[] = [
    { key: 'name', header: 'Vendor', accessor: (v) => v.name, sortable: true, primary: true, cell: (v) => <span className="font-medium text-ink">{v.name}</span> },
    { key: 'owed', header: 'Owed', accessor: (v) => v.balance, sortable: true, searchable: false, align: 'right', className: 'tabular-nums', cardMeta: true, cell: (v) => (v.balance ? money(v.balance) : '—') },
    { key: 'pay', header: 'Paid by', accessor: (v) => METHOD_LABEL[v.paymentMethod], sortable: true, cell: (v) => `${METHOD_LABEL[v.paymentMethod]}${v.paymentMethod === 'ACH' ? (v.hasBank ? ` · ••• ${v.accountLast4}` : ' · no bank on file') : ''}` },
    { key: 'terms', header: 'Terms', accessor: (v) => v.termsDays, sortable: true, searchable: false, cell: (v) => (v.termsDays ? `Net ${v.termsDays}` : 'Due on receipt') },
    { key: '1099', header: '1099', accessor: (v) => (v.is1099 ? 'Yes' : ''), sortable: true, cell: (v) => (v.is1099 ? <Badge size="sm" variant={v.hasTaxId ? 'info' : 'pending'}>{v.hasTaxId ? '1099' : '1099 · no tax ID'}</Badge> : '—') },
    {
      key: 'status',
      header: 'Status',
      accessor: (v) => (v.pendingBankChange ? 'Bank change waiting' : v.isActive ? 'Active' : 'Inactive'),
      sortable: true,
      cell: (v) => (v.pendingBankChange ? <Badge size="sm" variant="pending">Bank change waiting</Badge> : v.isActive ? <Badge size="sm" variant="success">Active</Badge> : <Badge size="sm">Inactive</Badge>),
    },
    { key: 'email', header: 'Email', accessor: (v) => v.email ?? '', defaultHidden: true },
  ];
  return (
    <ListTemplate
      title="Vendors"
      subtitle="The people and companies the company pays — their terms, how they’re paid, and who gets a 1099."
      breadcrumbs={[{ label: 'Books', to: '/books' }, { label: 'Vendors' }]}
      primaryAction={
        write ? (
          <Button asChild>
            <Link to="/books/vendors/new">
              <Plus className="h-4 w-4" aria-hidden="true" />
              New vendor
            </Link>
          </Button>
        ) : undefined
      }
      secondaryActions={
        <Button asChild variant="secondary">
          <Link to="/books/bills">Bills</Link>
        </Button>
      }
      summary={
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard label="Active vendors" value={active.length} />
          <MetricCard label="Owed to vendors" value={money(owed)} />
          <MetricCard label="Bank changes waiting" value={pendingBank} accent={pendingBank > 0} hint="A second person confirms each one" />
        </div>
      }
    >
      <DataGrid
        id="books-vendors"
        caption="Vendors"
        noun={{ one: 'vendor', many: 'vendors' }}
        rows={q.data?.vendors}
        loading={q.isPending}
        error={q.error ? errText(q.error, 'Could not load the vendors.') : null}
        onRetry={() => void q.refetch()}
        columns={columns}
        rowKey={(v) => v.id}
        defaultSort={{ key: 'name', direction: 'asc' }}
        onRowClick={(v) => navigate(`/books/vendors/${v.id}`)}
        rowActionLabel={(v) => `Open ${v.name}`}
        empty={{ title: 'No vendors yet', description: 'Add the companies you pay — rent, insurance, utilities, software — and enter their bills.' }}
      />
    </ListTemplate>
  );
}
