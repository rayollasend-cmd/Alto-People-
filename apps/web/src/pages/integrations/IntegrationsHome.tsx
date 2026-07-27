import { useEffect, useMemo, useState } from 'react';
import { Copy, Download, Key, Plus, Webhook } from 'lucide-react';
import { ApiError } from '@/lib/api';
import {
  createApiKey,
  createWebhook,
  deleteApiKey,
  deleteWebhook,
  listApiKeys,
  listWebhooks,
  revokeApiKey,
  testWebhook,
  toggleWebhook,
  type ApiKeyRecord,
  type WebhookRecord,
} from '@/lib/apiKeysWebhooks93Api';
import { useClients } from '@/lib/useClients';
import { useAuth } from '@/lib/auth';
import { useConfirm } from '@/lib/confirm';
import { hasCapability, ROLE_CAPABILITIES } from '@/lib/roles';
import { downloadCsv } from '@/lib/csv';
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
  Input,
  PageHeader,
  SegmentedControl,
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
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { fmtDate } from '@/lib/format';
import { toast } from 'sonner';

type Tab = 'keys' | 'webhooks';

/**
 * Known outbound webhook event types. The server exposes no registry
 * endpoint — the only event the emitter dispatches today is `test.ping`
 * (apps/api/src/routes/apiKeysWebhooks93.ts POST /webhooks/:id/test);
 * domain events mirror the workflow trigger enum
 * (apps/api/src/routes/workflows.ts TriggerSchema) in the dotted form the
 * original free-text placeholder documented (`payroll.finalized`,
 * `onboarding.completed`). Keep in sync with that enum.
 */
const WEBHOOK_EVENT_TYPES = [
  'associate.hired',
  'associate.terminated',
  'time_off.requested',
  'time_off.approved',
  'time_off.denied',
  'position.opened',
  'position.filled',
  'payroll.finalized',
  'onboarding.completed',
  'compliance.expiring',
  'test.ping',
] as const;

export function IntegrationsHome() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:integrations') : false;
  const [tab, setTab] = useState<Tab>('keys');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Integrations"
        subtitle="Public API keys for programmatic access and outbound webhooks for event delivery."
        breadcrumbs={[{ label: 'Settings' }, { label: 'Integrations' }]}
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="keys">
            <Key className="mr-2 h-4 w-4" /> API keys
          </TabsTrigger>
          <TabsTrigger value="webhooks">
            <Webhook className="mr-2 h-4 w-4" /> Webhooks
          </TabsTrigger>
        </TabsList>
        <TabsContent value="keys"><KeysTab canManage={canManage} /></TabsContent>
        <TabsContent value="webhooks"><WebhooksTab canManage={canManage} /></TabsContent>
      </Tabs>
    </div>
  );
}

type KeyStatus = 'active' | 'revoked' | 'expired';

function keyStatus(k: ApiKeyRecord): KeyStatus {
  if (k.revokedAt) return 'revoked';
  if (k.expiresAt && new Date(k.expiresAt) < new Date()) return 'expired';
  return 'active';
}

function KeysTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [keys, setKeys] = useState<ApiKeyRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | KeyStatus>('all');
  const [showNew, setShowNew] = useState(false);
  const [showSecret, setShowSecret] = useState<{ plaintext: string; last4: string } | null>(
    null,
  );

  const refresh = () => {
    setKeys(null);
    setLoadError(null);
    listApiKeys()
      .then((r) => setKeys(r.keys))
      .catch((err) =>
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load API keys.'),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    if (!keys) return [];
    const q = search.trim().toLowerCase();
    return keys.filter((k) => {
      if (q && !k.name.toLowerCase().includes(q)) return false;
      if (statusFilter !== 'all' && keyStatus(k) !== statusFilter) return false;
      return true;
    });
  }, [keys, search, statusFilter]);

  const exportCsv = () => {
    downloadCsv('api-key-inventory.csv', [
      ['Name', 'Key', 'Client', 'Capabilities', 'Created by', 'Last used', 'Expires', 'Status', 'Created'],
      ...filtered.map((k) => [
        k.name,
        `altop_…${k.last4}`,
        k.clientName ?? '',
        k.capabilities.length > 0 ? k.capabilities.join(', ') : '(inherits creator)',
        k.createdByEmail,
        fmtDate(k.lastUsedAt),
        fmtDate(k.expiresAt),
        keyStatus(k),
        fmtDate(k.createdAt),
      ]),
    ]);
  };

  const onRevoke = async (id: string) => {
    if (!(await confirm({ title: 'Revoke this key?', description: 'Active integrations will start failing.', destructive: true })))
      return;
    try {
      await revokeApiKey(id);
      toast.success('API key revoked.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Permanently delete this key?', destructive: true }))) return;
    try {
      await deleteApiKey(id);
      toast.success('API key deleted.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-4">
      {keys !== null && keys.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="max-w-xs h-8 text-xs"
            placeholder="Search keys by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search API keys"
          />
          <div className="w-36">
            <Select
              size="sm"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as 'all' | KeyStatus)}
              aria-label="Filter keys by status"
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="revoked">Revoked</option>
              <option value="expired">Expired</option>
            </Select>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={filtered.length === 0}>
              <Download className="mr-1.5 h-3.5 w-3.5" /> Export CSV
            </Button>
            {canManage && (
              <Button size="sm" onClick={() => setShowNew(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" /> New key
              </Button>
            )}
          </div>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6 space-y-3">
              <ErrorBanner>{loadError}</ErrorBanner>
              <Button size="sm" variant="outline" onClick={refresh}>
                Retry
              </Button>
            </div>
          ) : keys === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : keys.length === 0 ? (
            <EmptyState
              icon={Key}
              title="No API keys"
              description="Create a key to call the platform programmatically. The plaintext is shown ONCE."
              action={
                canManage ? (
                  <Button onClick={() => setShowNew(true)}>
                    <Plus className="mr-2 h-4 w-4" /> New key
                  </Button>
                ) : undefined
              }
            />
          ) : filtered.length === 0 ? (
            <div className="p-6 text-sm text-silver">
              No keys match the current search / filter.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">Key</TableHead>
                  <TableHead className="hidden lg:table-cell">Capabilities</TableHead>
                  <TableHead className="hidden md:table-cell">Last used</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((k) => (
                  <TableRow key={k.id} className="group">
                    <TableCell className="font-medium text-white">
                      <div className="truncate">{k.name}</div>
                      <div className="md:hidden text-[11px] text-silver/70 truncate">
                        <span className="sm:hidden font-mono">
                          altop_…{k.last4}
                          {' · '}
                        </span>
                        {fmtDate(k.lastUsedAt)}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs hidden sm:table-cell">altop_…{k.last4}</TableCell>
                    <TableCell className="text-xs text-silver hidden lg:table-cell">
                      {k.capabilities.length > 0
                        ? k.capabilities.join(', ')
                        : '(inherits creator)'}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {fmtDate(k.lastUsedAt)}
                    </TableCell>
                    <TableCell>
                      {keyStatus(k) === 'revoked' ? (
                        <Badge variant="destructive">Revoked</Badge>
                      ) : keyStatus(k) === 'expired' ? (
                        <Badge variant="default">Expired</Badge>
                      ) : (
                        <Badge variant="success">Active</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManage && !k.revokedAt && (
                        <Button size="sm" variant="ghost" onClick={() => onRevoke(k.id)}>
                          Revoke
                        </Button>
                      )}
                      {canManage && (
                        <button
                          onClick={() => onDelete(k.id)}
                          className="opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 text-silver hover:text-alert transition text-xs"
                        >
                          Delete
                        </button>
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
        <NewKeyDrawer
          onClose={() => setShowNew(false)}
          onSaved={(secret) => {
            setShowNew(false);
            setShowSecret(secret);
            refresh();
          }}
        />
      )}
      {showSecret && (
        <SecretRevealDrawer secret={showSecret} onClose={() => setShowSecret(null)} />
      )}
    </div>
  );
}

/**
 * Preset definitions for the AltoHR / ShiftReport Nexus integration. Each
 * preset bundles the right capability set for an ASN role; store-scoped
 * presets also force a clientId selection. Issuing a key via a preset
 * keeps the key surface tight — admins don't free-type capability strings
 * (and can't accidentally over-grant).
 */
const ASN_CAPABILITIES = [
  'asn:read:schedule',
  'asn:read:roster',
  'asn:read:clocked-in',
  'asn:read:kpis',
] as const;

/**
 * Full capability registry for custom-mode keys. Derived from the shared
 * ROLE_CAPABILITIES map (the same registry `hasCapability` reads) plus the
 * key-only ASN capabilities, so the checkbox list can never drift from
 * what the server actually understands.
 */
const ALL_CAPABILITY_OPTIONS: readonly string[] = Array.from(
  new Set<string>([
    ...Object.values(ROLE_CAPABILITIES).flatMap((set) => Array.from(set)),
    ...ASN_CAPABILITIES,
  ]),
).sort();

interface AsnPreset {
  id: 'asn-supervisor' | 'asn-lead' | 'asn-command-desk' | 'asn-ops-mgr';
  label: string;
  description: string;
  /** True when the preset must be bound to a specific store. */
  storeScoped: boolean;
  capabilities: readonly string[];
}

const ASN_PRESETS: readonly AsnPreset[] = [
  {
    id: 'asn-supervisor',
    label: 'ASN Supervisor',
    description:
      'One store. Read schedule, roster, clocked-in roster, and weekly KPIs.',
    storeScoped: true,
    capabilities: ASN_CAPABILITIES,
  },
  {
    id: 'asn-lead',
    label: 'ASN Lead Supervisor',
    description:
      'One store. Same surface as Supervisor — kept distinct for audit-trail clarity.',
    storeScoped: true,
    capabilities: ASN_CAPABILITIES,
  },
  {
    id: 'asn-command-desk',
    label: 'ASN Command Desk',
    description: 'Every store. Live monitoring across all locations.',
    storeScoped: false,
    capabilities: ASN_CAPABILITIES,
  },
  {
    id: 'asn-ops-mgr',
    label: 'ASN Operations Manager',
    description:
      'Every store. Same read surface as Command Desk — kept distinct for audit-trail clarity.',
    storeScoped: false,
    capabilities: ASN_CAPABILITIES,
  },
];

type DrawerMode = 'preset' | 'custom';

function NewKeyDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (s: { plaintext: string; last4: string }) => void;
}) {
  const [mode, setMode] = useState<DrawerMode>('preset');
  const [presetId, setPresetId] = useState<AsnPreset['id']>('asn-supervisor');
  const [storeId, setStoreId] = useState<string>('');
  const [name, setName] = useState('');
  const [capabilities, setCapabilities] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState('');
  const [saving, setSaving] = useState(false);
  // Active stores for the store-scoped presets — served from the app-wide
  // react-query cache (5-minute staleTime), so re-opening the drawer is free.
  const {
    clients: stores,
    isLoading: storesLoading,
    isError: storesError,
    refetch: refetchStores,
  } = useClients();

  const preset = useMemo(
    () => ASN_PRESETS.find((p) => p.id === presetId) ?? ASN_PRESETS[0],
    [presetId],
  );
  const selectedStore = useMemo(
    () => stores.find((s) => s.id === storeId) ?? null,
    [stores, storeId],
  );

  // Auto-suggest the key name from the preset + (if scoped) the store.
  // The admin can still edit it — we only seed the field, we don't
  // overwrite typing in progress.
  useEffect(() => {
    if (mode !== 'preset') return;
    const base = preset.label;
    const tail = preset.storeScoped && selectedStore ? ` — ${selectedStore.name}` : '';
    const suggested = `${base}${tail}`;
    setName((current) => {
      // Only auto-update if the field still matches a previous suggestion
      // (or is empty). Don't clobber the admin's edit.
      if (
        current === '' ||
        ASN_PRESETS.some(
          (p) =>
            current === p.label ||
            current.startsWith(`${p.label} — `),
        )
      ) {
        return suggested;
      }
      return current;
    });
  }, [mode, preset, selectedStore]);

  const toggleCapability = (cap: string) => {
    setCapabilities((cs) =>
      cs.includes(cap) ? cs.filter((c) => c !== cap) : [...cs, cap],
    );
  };

  const canSubmit = (() => {
    if (!name.trim()) return false;
    if (mode === 'preset' && preset.storeScoped && !storeId) return false;
    return true;
  })();

  const onSubmit = async () => {
    if (!canSubmit) {
      toast.error(
        mode === 'preset' && preset.storeScoped && !storeId
          ? 'Pick a store for this preset.'
          : 'Name required.',
      );
      return;
    }
    setSaving(true);
    try {
      const payload =
        mode === 'preset'
          ? {
              name: name.trim(),
              clientId: preset.storeScoped ? storeId : null,
              capabilities: [...preset.capabilities],
              expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
            }
          : {
              name: name.trim(),
              capabilities,
              expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
            };
      const r = await createApiKey(payload);
      toast.success('API key created.');
      onSaved({ plaintext: r.plaintext, last4: r.last4 });
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New API key</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        {/* Mode toggle — preset (curated) vs custom (explicit capability picks) */}
        <SegmentedControl
          ariaLabel="Key mode"
          value={mode}
          onChange={(v) => setMode(v)}
          options={[
            { value: 'preset', label: 'ASN preset' },
            { value: 'custom', label: 'Custom' },
          ]}
        />

        {mode === 'preset' && (
          <>
            <div>
              <Label>Role</Label>
              <Select
                className="mt-1"
                value={presetId}
                onChange={(e) =>
                  setPresetId(e.target.value as AsnPreset['id'])
                }
              >
                {ASN_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </Select>
              <div className="text-xs text-silver mt-1">{preset.description}</div>
            </div>

            {preset.storeScoped && (
              <div>
                <Label required>Store</Label>
                {storesError ? (
                  <div className="mt-1 space-y-2">
                    <ErrorBanner>Failed to load stores.</ErrorBanner>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void refetchStores()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : (
                  <>
                    <Select
                      className="mt-1"
                      value={storeId}
                      onChange={(e) => setStoreId(e.target.value)}
                      disabled={storesLoading}
                    >
                      <option value="">
                        {storesLoading ? 'Loading…' : 'Select a store'}
                      </option>
                      {stores.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                          {s.state ? ` (${s.state})` : ''}
                        </option>
                      ))}
                    </Select>
                    <div className="text-xs text-silver mt-1">
                      This key will only see data for the selected store.
                    </div>
                  </>
                )}
              </div>
            )}

            <div className="rounded-md border border-navy-secondary bg-navy-secondary/20 p-3 text-xs text-silver space-y-1">
              <div className="text-white font-medium">Granted capabilities</div>
              <ul className="font-mono">
                {preset.capabilities.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          </>
        )}

        <div>
          <Label>Name</Label>
          <Input
            className="mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              mode === 'preset'
                ? 'Auto-filled from preset — edit to taste'
                : 'ATS sync — production'
            }
          />
        </div>

        {mode === 'custom' && (
          <div>
            <div className="flex items-center justify-between">
              <Label>Capabilities ({capabilities.length} selected)</Label>
              {capabilities.length > 0 && (
                <Button size="xs" variant="ghost" onClick={() => setCapabilities([])}>
                  Clear
                </Button>
              )}
            </div>
            <div className="mt-1 max-h-48 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1.5 rounded-md border border-navy-secondary bg-navy-secondary/20 p-3">
              {ALL_CAPABILITY_OPTIONS.map((cap) => (
                <label
                  key={cap}
                  className="flex items-center gap-2 text-xs font-mono text-silver hover:text-white cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={capabilities.includes(cap)}
                    onChange={() => toggleCapability(cap)}
                  />
                  {cap}
                </label>
              ))}
            </div>
            <div className="text-xs text-silver mt-1">
              Leave everything unchecked to inherit your own capabilities.
            </div>
          </div>
        )}

        <div>
          <Label>Expires at (optional)</Label>
          <Input
            type="datetime-local"
            className="mt-1"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
          />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving || !canSubmit}>
          {saving ? 'Generating…' : 'Generate'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}

function SecretRevealDrawer({
  secret,
  onClose,
}: {
  secret: { plaintext: string; last4: string };
  onClose: () => void;
}) {
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>Save your API key</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div className="text-sm text-warning">
          This is the only time the full key will be shown. Copy and store it
          securely.
        </div>
        <div className="bg-navy-secondary/40 border border-navy-secondary rounded-md p-3 font-mono text-xs break-all text-white">
          {secret.plaintext}
        </div>
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(secret.plaintext);
            toast.success('Copied to clipboard.');
          }}
        >
          <Copy className="mr-2 h-4 w-4" /> Copy
        </Button>
      </DrawerBody>
      <DrawerFooter>
        <Button onClick={onClose}>I've saved it</Button>
      </DrawerFooter>
    </Drawer>
  );
}

function WebhooksTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [rows, setRows] = useState<WebhookRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [showNew, setShowNew] = useState(false);
  const [showSecret, setShowSecret] = useState<string | null>(null);

  const refresh = () => {
    setRows(null);
    setLoadError(null);
    listWebhooks()
      .then((r) => setRows(r.webhooks))
      .catch((err) =>
        setLoadError(err instanceof ApiError ? err.message : 'Failed to load webhooks.'),
      );
  };
  useEffect(() => {
    refresh();
  }, []);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    return rows.filter((w) => {
      if (q && !w.name.toLowerCase().includes(q)) return false;
      if (statusFilter === 'active' && !w.isActive) return false;
      if (statusFilter === 'paused' && w.isActive) return false;
      return true;
    });
  }, [rows, search, statusFilter]);

  const onTest = async (id: string) => {
    try {
      const r = await testWebhook(id);
      if (r.ok) {
        toast.success(`Test delivered (HTTP ${r.responseStatus}).`);
      } else {
        toast.error(`Failed: ${r.responseBody ?? 'unknown error'}`);
      }
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onToggle = async (id: string) => {
    try {
      const r = await toggleWebhook(id);
      toast.success(r.isActive ? 'Webhook resumed.' : 'Webhook paused.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Delete this webhook?', destructive: true }))) return;
    try {
      await deleteWebhook(id);
      toast.success('Webhook deleted.');
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  return (
    <div className="space-y-4">
      {rows !== null && rows.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="max-w-xs h-8 text-xs"
            placeholder="Search webhooks by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search webhooks"
          />
          <div className="w-36">
            <Select
              size="sm"
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as 'all' | 'active' | 'paused')
              }
              aria-label="Filter webhooks by status"
            >
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
            </Select>
          </div>
          {canManage && (
            <div className="ml-auto">
              <Button size="sm" onClick={() => setShowNew(true)}>
                <Plus className="mr-1.5 h-3.5 w-3.5" /> New webhook
              </Button>
            </div>
          )}
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <div className="p-6 space-y-3">
              <ErrorBanner>{loadError}</ErrorBanner>
              <Button size="sm" variant="outline" onClick={refresh}>
                Retry
              </Button>
            </div>
          ) : rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Webhook}
              title="No webhooks"
              description="Subscribe an HTTPS endpoint to receive payroll, onboarding, and other events."
              action={
                canManage ? (
                  <Button onClick={() => setShowNew(true)}>
                    <Plus className="mr-2 h-4 w-4" /> New webhook
                  </Button>
                ) : undefined
              }
            />
          ) : filtered.length === 0 ? (
            <div className="p-6 text-sm text-silver">
              No webhooks match the current search / filter.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="hidden sm:table-cell">URL</TableHead>
                  <TableHead className="hidden lg:table-cell">Events</TableHead>
                  <TableHead className="hidden md:table-cell">Deliveries</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((w) => (
                  <TableRow key={w.id} className="group">
                    <TableCell className="font-medium text-white">
                      <div className="truncate">{w.name}</div>
                      <div className="md:hidden text-[11px] text-silver/70 truncate">
                        <span className="sm:hidden font-mono">
                          {w.url}
                          {' · '}
                        </span>
                        <span className="tabular-nums">{w.deliveryCount}</span> deliveries
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-xs truncate max-w-[140px] sm:max-w-[200px] md:max-w-[280px] hidden sm:table-cell">
                      {w.url}
                    </TableCell>
                    <TableCell className="text-xs text-silver hidden lg:table-cell">
                      {w.eventTypes.length > 0 ? w.eventTypes.join(', ') : '(all)'}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">{w.deliveryCount}</TableCell>
                    <TableCell>
                      {w.isActive ? (
                        <Badge variant="success">Active</Badge>
                      ) : (
                        <Badge variant="default">Paused</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManage && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => onTest(w.id)}>
                            Test
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => onToggle(w.id)}>
                            {w.isActive ? 'Pause' : 'Resume'}
                          </Button>
                          <button
                            onClick={() => onDelete(w.id)}
                            className="opacity-60 group-hover:opacity-100 group-focus-within:opacity-100 text-silver hover:text-alert transition text-xs"
                          >
                            Delete
                          </button>
                        </>
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
        <NewWebhookDrawer
          onClose={() => setShowNew(false)}
          onSaved={(secret) => {
            setShowNew(false);
            setShowSecret(secret);
            refresh();
          }}
        />
      )}
      {showSecret && (
        <Drawer open={true} onOpenChange={(o) => !o && setShowSecret(null)}>
          <DrawerHeader>
            <DrawerTitle>Save your webhook secret</DrawerTitle>
          </DrawerHeader>
          <DrawerBody className="space-y-4">
            <div className="text-sm text-warning">
              Use this secret to verify the X-Alto-Signature header (HMAC-SHA256
              over the request body). Only shown once.
            </div>
            <div className="bg-navy-secondary/40 border border-navy-secondary rounded-md p-3 font-mono text-xs break-all text-white">
              {showSecret}
            </div>
            <Button
              onClick={() => {
                void navigator.clipboard.writeText(showSecret);
                toast.success('Copied to clipboard.');
              }}
            >
              <Copy className="mr-2 h-4 w-4" /> Copy
            </Button>
          </DrawerBody>
          <DrawerFooter>
            <Button onClick={() => setShowSecret(null)}>Close</Button>
          </DrawerFooter>
        </Drawer>
      )}
    </div>
  );
}

function NewWebhookDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (secret: string) => void;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [allEvents, setAllEvents] = useState(true);
  const [eventTypes, setEventTypes] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const toggleEvent = (ev: string) => {
    setEventTypes((es) =>
      es.includes(ev) ? es.filter((e) => e !== ev) : [...es, ev],
    );
  };

  const onSubmit = async () => {
    if (!name.trim() || !url.trim()) {
      toast.error('Name and URL required.');
      return;
    }
    if (!allEvents && eventTypes.length === 0) {
      toast.error('Pick at least one event, or switch on "All events".');
      return;
    }
    setSaving(true);
    try {
      const r = await createWebhook({
        name: name.trim(),
        url: url.trim(),
        // Empty list = subscribe to everything (server convention).
        eventTypes: allEvents ? [] : eventTypes,
      });
      toast.success('Webhook created.');
      onSaved(r.secret);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer open={true} onOpenChange={(o) => !o && onClose()}>
      <DrawerHeader>
        <DrawerTitle>New webhook</DrawerTitle>
      </DrawerHeader>
      <DrawerBody className="space-y-4">
        <div>
          <Label>Name</Label>
          <Input
            className="mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <Label>URL (HTTPS)</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/webhooks/alto"
          />
        </div>
        <div>
          <Label>Event types</Label>
          <label className="mt-1 flex items-center gap-2 text-sm text-white cursor-pointer">
            <input
              type="checkbox"
              checked={allEvents}
              onChange={(e) => setAllEvents(e.target.checked)}
            />
            All events
          </label>
          {!allEvents && (
            <div className="mt-2 max-h-48 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1.5 rounded-md border border-navy-secondary bg-navy-secondary/20 p-3">
              {WEBHOOK_EVENT_TYPES.map((ev) => (
                <label
                  key={ev}
                  className="flex items-center gap-2 text-xs font-mono text-silver hover:text-white cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={eventTypes.includes(ev)}
                    onChange={() => toggleEvent(ev)}
                  />
                  {ev}
                </label>
              ))}
            </div>
          )}
          <div className="text-xs text-silver mt-1">
            {allEvents
              ? 'The endpoint receives every event the platform emits.'
              : `${eventTypes.length} event type${eventTypes.length === 1 ? '' : 's'} selected.`}
          </div>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={onSubmit} disabled={saving}>
          {saving ? 'Creating…' : 'Create'}
        </Button>
      </DrawerFooter>
    </Drawer>
  );
}
