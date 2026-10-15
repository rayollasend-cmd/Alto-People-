import { API_SCOPES, API_SCOPE_LABELS, type ApiClientIssued, type ApiClientSummary, type ApiScope } from '@alto-people/shared';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, ExternalLink, Plus, ShieldCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { createApiClient, listApiClients, revokeApiClient, rotateApiClient } from '@/lib/apiClientsApi';
import { listAdminUsers } from '@/lib/usersAdminApi';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { fmtDate } from '@/lib/format';
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
  ErrorBanner,
  Field,
  Input,
  Select,
  SkeletonRows,
} from '@/components/ui';
import { DataGrid } from '@/components/ui/DataGrid';

/**
 * Brief 2-4 — OAuth clients for the public API, beside the API keys.
 *
 *   A client has a name, named scopes and an accountable owner (every write
 *   it makes is audited under them). The secret is shown once, at creation
 *   and at rotation; rotation keeps the old secret working five minutes so
 *   an integration can switch without an outage. Revoke stops it at once,
 *   tokens already issued included.
 */

const ERRORS: Record<string, string> = {
  owner_not_found: 'Choose an active account of this organization as the owner.',
  api_client_not_found: 'That client is no longer active.',
};

const message = (err: unknown) =>
  err instanceof ApiError ? (ERRORS[err.code ?? ''] ?? err.message) : 'Something went wrong.';

export function ApiClientsTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [showNew, setShowNew] = useState(false);
  const [issued, setIssued] = useState<ApiClientIssued | null>(null);

  const q = useQuery({ queryKey: ['ApiClientsTab', 'clients'], queryFn: () => listApiClients() });
  const clients = q.data?.clients ?? null;
  const refresh = () => void q.refetch();

  const onRotate = async (c: ApiClientSummary) => {
    if (!(await confirm({ title: `Rotate the secret of ${c.name}?`, description: 'A new secret is shown once. The current one keeps working for five minutes, then stops.' }))) return;
    try {
      setIssued(await rotateApiClient(c.id));
      refresh();
    } catch (err) {
      toast.error(message(err));
    }
  };

  const onRevoke = async (c: ApiClientSummary) => {
    if (!(await confirm({ title: `Revoke ${c.name}?`, description: 'It stops at once, including tokens it already holds. This cannot be undone.', destructive: true }))) return;
    try {
      await revokeApiClient(c.id);
      toast.success('Client revoked.');
      refresh();
    } catch (err) {
      toast.error(message(err));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-silver">
          OAuth clients call the public API at <span className="font-mono text-xs text-white">/api/v1</span> with 15-minute tokens.
        </p>
        <div className="ml-auto flex items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link to="/developers">
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> API reference
            </Link>
          </Button>
          {canManage && clients !== null && clients.length > 0 && (
            <Button size="sm" onClick={() => setShowNew(true)}>
              <Plus className="mr-1.5 h-3.5 w-3.5" /> New client
            </Button>
          )}
        </div>
      </div>
      <Card>
        <CardContent className="p-0">
          {q.error ? (
            <div className="p-6">
              <ErrorBanner action={<Button size="sm" variant="secondary" onClick={refresh}>Retry</Button>}>{message(q.error)}</ErrorBanner>
            </div>
          ) : clients === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : clients.length === 0 ? (
            <EmptyState
              icon={ShieldCheck}
              title="No API clients"
              description="Create a client for a system that calls Alto: it gets only the scopes you grant, and an owner who answers for it."
              action={canManage ? <Button onClick={() => setShowNew(true)}><Plus className="mr-2 h-4 w-4" /> New client</Button> : undefined}
            />
          ) : (
            <DataGrid<ApiClientSummary>
              id="api-clients"
              caption="API clients"
              rows={clients}
              rowKey={(c) => c.id}
              search={false}
              urlState={false}
              exportCsv={{ filename: 'api-clients' }}
              columns={[
                { key: 'name', header: 'Name', accessor: (c) => c.name, sortable: true, primary: true, className: 'font-medium text-white' },
                { key: 'clientId', header: 'Client ID', accessor: (c) => c.clientId, cardMeta: true, className: 'font-mono text-xs' },
                { key: 'owner', header: 'Owner', accessor: (c) => c.owner?.name ?? '', sortable: true },
                { key: 'scopes', header: 'Scopes', accessor: (c) => c.scopes.join(' '), className: 'font-mono text-xs text-silver' },
                { key: 'lastUsed', header: 'Last used', accessor: (c) => c.lastUsedAt, sortable: true, searchable: false, cardMeta: true, cell: (c) => fmtDate(c.lastUsedAt) },
                {
                  key: 'status',
                  header: 'Status',
                  accessor: (c) => c.status,
                  sortable: true,
                  cell: (c) => <Badge variant={c.status === 'ACTIVE' ? 'success' : 'destructive'}>{c.status === 'ACTIVE' ? 'Active' : 'Revoked'}</Badge>,
                },
                ...(canManage
                  ? [
                      {
                        key: 'actions',
                        header: 'Actions',
                        accessor: () => null,
                        searchable: false,
                        csv: () => '',
                        align: 'right' as const,
                        stopRowClick: true,
                        className: 'space-x-2',
                        cell: (c: ApiClientSummary) =>
                          c.status === 'ACTIVE' ? (
                            <>
                              <Button size="sm" variant="ghost" onClick={() => void onRotate(c)}>Rotate secret</Button>
                              <Button size="sm" variant="ghost" className="text-silver hover:text-alert" onClick={() => void onRevoke(c)}>Revoke</Button>
                            </>
                          ) : null,
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </CardContent>
      </Card>
      {showNew && (
        <NewClientDrawer
          onClose={() => setShowNew(false)}
          onSaved={(r) => {
            setShowNew(false);
            setIssued(r);
            refresh();
          }}
        />
      )}
      {issued && <IssuedDrawer issued={issued} onClose={() => setIssued(null)} />}
    </div>
  );
}

function NewClientDrawer({ onClose, onSaved }: { onClose: () => void; onSaved: (r: ApiClientIssued) => void }) {
  const { user } = useAuth();
  const [name, setName] = useState('');
  const [ownerUserId, setOwnerUserId] = useState(user?.id ?? '');
  const [scopes, setScopes] = useState<ApiScope[]>(['workers:read']);
  const [saving, setSaving] = useState(false);
  // Every active internal account may own a client; the list needs user admin, so it may not load.
  const owners = useQuery({
    queryKey: ['admin', 'users', 'api-client-owners'],
    queryFn: () => listAdminUsers({ status: 'ACTIVE' }),
    select: (d) => d.users.filter((u) => u.role !== 'CLIENT_PORTAL'),
    retry: false,
  });

  const toggle = (s: ApiScope) => setScopes((xs) => (xs.includes(s) ? xs.filter((x) => x !== s) : [...xs, s]));

  const onSubmit = async () => {
    if (name.trim().length < 2) return toast.error('Name the client.');
    if (!scopes.length) return toast.error('Grant at least one scope.');
    setSaving(true);
    try {
      onSaved(await createApiClient({ name: name.trim(), scopes, ownerUserId }));
    } catch (err) {
      toast.error(message(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New API client</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <Field label="Name" required hint="What calls Alto with it, e.g. “Payroll sync”.">
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />}
        </Field>
        <Field label="Owner" required hint="Answers for the client; every change it makes is audited under them.">
          {(p) =>
            owners.data ? (
              <Select {...p} value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)}>
                {owners.data.map((u) => (
                  <option key={u.id} value={u.id}>{u.associateName ? `${u.associateName} — ${u.email}` : u.email}</option>
                ))}
              </Select>
            ) : (
              <Input {...p} value={user?.email ?? ''} readOnly />
            )
          }
        </Field>
        <fieldset>
          <legend className="text-sm font-medium text-white">Scopes</legend>
          <div className="mt-2 grid grid-cols-1 gap-y-1.5 rounded-md border border-navy-secondary bg-navy-secondary/20 p-3">
            {API_SCOPES.map((s) => (
              <label key={s} className="flex cursor-pointer items-center gap-2 text-sm text-silver hover:text-white">
                <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} />
                <span className="font-mono text-xs">{s}</span>
                <span className="text-xs">— {API_SCOPE_LABELS[s]}</span>
              </label>
            ))}
          </div>
          {scopes.includes('pay:read') && <p className="mt-1 text-xs text-warning">pay:read shows pay rates on shifts and time entries.</p>}
        </fieldset>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={() => void onSubmit()} disabled={saving}>{saving ? 'Creating…' : 'Create'}</Button>
      </DrawerFooter>
    </Drawer>
  );
}

function IssuedDrawer({ issued, onClose }: { issued: ApiClientIssued; onClose: () => void }) {
  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard.');
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Save the client secret</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <p className="text-sm text-warning">This is the only time the secret is shown. Store it with the client ID in the calling system’s secret store.</p>
        {[
          ['Client ID', issued.client.clientId],
          ['Client secret', issued.clientSecret],
        ].map(([label, value]) => (
          <div key={label} className="space-y-1">
            <div className="text-xs text-silver">{label}</div>
            <div className="flex items-start gap-2">
              <div className="flex-1 break-all rounded-md border border-navy-secondary bg-navy-secondary/40 p-3 font-mono text-xs text-white">{value}</div>
              <Button size="sm" variant="outline" onClick={() => copy(value!)} aria-label={`Copy ${label}`}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>I’ve saved it</Button>
      </DrawerFooter>
    </Drawer>
  );
}
