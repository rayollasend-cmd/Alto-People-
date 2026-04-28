import { useEffect, useState } from 'react';
import { Copy, Key, Plus, Webhook } from 'lucide-react';
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
} from '@/components/ui';
import { Label } from '@/components/ui/Label';
import { toast } from 'sonner';

type Tab = 'keys' | 'webhooks';

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

function KeysTab({ canManage }: { canManage: boolean }) {
  const confirm = useConfirm();
  const [keys, setKeys] = useState<ApiKeyRecord[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showSecret, setShowSecret] = useState<{ plaintext: string; last4: string } | null>(
    null,
  );

  const refresh = () => {
    setKeys(null);
    listApiKeys()
      .then((r) => setKeys(r.keys))
      .catch(() => setKeys([]));
  };
  useEffect(() => {
    refresh();
  }, []);

  const onRevoke = async (id: string) => {
    if (!(await confirm({ title: 'Revoke this key?', description: 'Active integrations will start failing.', destructive: true })))
      return;
    try {
      await revokeApiKey(id);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Permanently delete this key?', destructive: true }))) return;
    try {
      await deleteApiKey(id);
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
            <Plus className="mr-2 h-4 w-4" /> New key
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {keys === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : keys.length === 0 ? (
            <EmptyState
              icon={Key}
              title="No API keys"
              description="Create a key to call the platform programmatically. The plaintext is shown ONCE."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Key</TableHead>
                  <TableHead>Capabilities</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => (
                  <TableRow key={k.id} className="group">
                    <TableCell className="font-medium text-white">{k.name}</TableCell>
                    <TableCell className="font-mono text-xs">altop_…{k.last4}</TableCell>
                    <TableCell className="text-xs text-silver">
                      {k.capabilities.length > 0
                        ? k.capabilities.join(', ')
                        : '(inherits creator)'}
                    </TableCell>
                    <TableCell>
                      {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleDateString() : '—'}
                    </TableCell>
                    <TableCell>
                      {k.revokedAt ? (
                        <Badge variant="destructive">Revoked</Badge>
                      ) : k.expiresAt && new Date(k.expiresAt) < new Date() ? (
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
                          className="opacity-0 group-hover:opacity-100 text-silver hover:text-destructive transition text-xs"
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

function NewKeyDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (s: { plaintext: string; last4: string }) => void;
}) {
  const [name, setName] = useState('');
  const [capabilities, setCapabilities] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!name.trim()) {
      toast.error('Name required.');
      return;
    }
    setSaving(true);
    try {
      const r = await createApiKey({
        name: name.trim(),
        capabilities: capabilities
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean),
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
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
        <div>
          <Label>Name</Label>
          <Input
            className="mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="ATS sync — production"
          />
        </div>
        <div>
          <Label>Capabilities (comma separated)</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={capabilities}
            onChange={(e) => setCapabilities(e.target.value)}
            placeholder="view:clients, view:onboarding"
          />
          <div className="text-xs text-silver mt-1">
            Leave empty to inherit your own capabilities.
          </div>
        </div>
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
        <Button onClick={onSubmit} disabled={saving}>
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
        <div className="text-sm text-amber-400">
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
  const [showNew, setShowNew] = useState(false);
  const [showSecret, setShowSecret] = useState<string | null>(null);

  const refresh = () => {
    setRows(null);
    listWebhooks()
      .then((r) => setRows(r.webhooks))
      .catch(() => setRows([]));
  };
  useEffect(() => {
    refresh();
  }, []);

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
      await toggleWebhook(id);
      refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Failed.');
    }
  };

  const onDelete = async (id: string) => {
    if (!(await confirm({ title: 'Delete this webhook?', destructive: true }))) return;
    try {
      await deleteWebhook(id);
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
            <Plus className="mr-2 h-4 w-4" /> New webhook
          </Button>
        </div>
      )}
      <Card>
        <CardContent className="p-0">
          {rows === null ? (
            <div className="p-6"><SkeletonRows count={3} /></div>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Webhook}
              title="No webhooks"
              description="Subscribe an HTTPS endpoint to receive payroll, onboarding, and other events."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>Deliveries</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((w) => (
                  <TableRow key={w.id} className="group">
                    <TableCell className="font-medium text-white">{w.name}</TableCell>
                    <TableCell className="font-mono text-xs truncate max-w-[280px]">
                      {w.url}
                    </TableCell>
                    <TableCell className="text-xs text-silver">
                      {w.eventTypes.length > 0 ? w.eventTypes.join(', ') : '(all)'}
                    </TableCell>
                    <TableCell>{w.deliveryCount}</TableCell>
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
                            className="opacity-0 group-hover:opacity-100 text-silver hover:text-destructive transition text-xs"
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
            <div className="text-sm text-amber-400">
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
  const [eventTypes, setEventTypes] = useState('');
  const [saving, setSaving] = useState(false);

  const onSubmit = async () => {
    if (!name.trim() || !url.trim()) {
      toast.error('Name and URL required.');
      return;
    }
    setSaving(true);
    try {
      const r = await createWebhook({
        name: name.trim(),
        url: url.trim(),
        eventTypes: eventTypes
          .split(',')
          .map((e) => e.trim())
          .filter(Boolean),
      });
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
          <Label>Event types (comma separated)</Label>
          <Input
            className="mt-1 font-mono text-xs"
            value={eventTypes}
            onChange={(e) => setEventTypes(e.target.value)}
            placeholder="payroll.finalized, onboarding.completed"
          />
          <div className="text-xs text-silver mt-1">
            Leave empty to receive all events.
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
