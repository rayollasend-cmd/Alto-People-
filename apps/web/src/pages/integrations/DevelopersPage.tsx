import { ListTemplate } from '@/components/templates';
import { WEBHOOK_EVENTS } from '@alto-people/shared';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, Download, Key, ShieldCheck, Webhook } from '@/components/ui/icons';
import { apiFetch, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { hasCapability } from '@/lib/roles';
import { useUrlParam } from '@/lib/useUrlState';
import { Badge, Button, Card, CardContent, ErrorBanner, SkeletonRows, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui';
import { SearchInput } from '@/components/ui/FilterBar';
import { ApiClientsTab } from './ApiClientsTab';
import { KeysTab, WebhooksTab } from './ApiAccessTabs';

const TABS = ['apps', 'keys', 'webhooks', 'reference'] as const;
type Tab = (typeof TABS)[number];

/**
 * Settings & trust › API & webhooks (F500 G4): everything that calls the
 * API or is called by it — the OAuth apps, the legacy keys, the outbound
 * webhooks (moved here from Integrations, which keeps the business
 * connections) — and the reference. The tab is in the URL; the old
 * /integrations?tab=… links land on the same tab here.
 */
export function DevelopersPage() {
  const { user } = useAuth();
  const canManage = user ? hasCapability(user.role, 'manage:integrations') : false;
  const [tab, setTab] = useUrlParam<Tab>('tab', 'apps', TABS, { history: 'push' });
  return (
    <ListTemplate
      title="API & webhooks"
      subtitle="The public API: OAuth 2 client credentials, cursor pagination, an Idempotency-Key on every POST, signed webhooks."
      related={[{ label: 'Integrations', to: '/integrations' }]}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="apps">
            <ShieldCheck className="mr-2 h-4 w-4" aria-hidden="true" /> API apps
          </TabsTrigger>
          <TabsTrigger value="keys">
            <Key className="mr-2 h-4 w-4" aria-hidden="true" /> API keys
          </TabsTrigger>
          <TabsTrigger value="webhooks">
            <Webhook className="mr-2 h-4 w-4" aria-hidden="true" /> Webhooks
          </TabsTrigger>
          <TabsTrigger value="reference">
            <BookOpen className="mr-2 h-4 w-4" aria-hidden="true" /> Reference
          </TabsTrigger>
        </TabsList>
        <TabsContent value="apps"><ApiClientsTab canManage={canManage} /></TabsContent>
        <TabsContent value="keys"><KeysTab canManage={canManage} /></TabsContent>
        <TabsContent value="webhooks"><WebhooksTab canManage={canManage} /></TabsContent>
        <TabsContent value="reference"><ApiReference /></TabsContent>
      </Tabs>
    </ListTemplate>
  );
}

/**
 * Brief 2-4 step 6 — the developer reference, read from the generated spec
 * at /api/v1/openapi.json, so it can never describe a route the API does
 * not serve. The quick start, the signature check and the event list sit
 * above the operations; the raw document downloads for code generators.
 */

interface SchemaObject {
  type?: string | string[];
  properties?: Record<string, SchemaObject>;
  required?: string[];
  items?: SchemaObject;
  enum?: unknown[];
  format?: string;
  description?: string;
  $ref?: string;
  anyOf?: SchemaObject[];
  nullable?: boolean;
}

interface Operation {
  tags?: string[];
  summary?: string;
  description?: string;
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{ name: string; in: string; required?: boolean; schema?: SchemaObject; description?: string }>;
  requestBody?: { content?: Record<string, { schema?: SchemaObject }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: SchemaObject }> }>;
}

interface OpenApiDoc {
  info: { title: string; version: string; description?: string };
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, SchemaObject> };
}

const METHOD_TONE: Record<string, 'success' | 'accent' | 'pending' | 'destructive'> = {
  get: 'success',
  post: 'accent',
  patch: 'pending',
  delete: 'destructive',
};

function typeOf(s: SchemaObject | undefined, doc: OpenApiDoc): string {
  if (!s) return '';
  if (s.$ref) return s.$ref.split('/').pop() ?? '';
  if (s.anyOf) return s.anyOf.map((x) => typeOf(x, doc)).join(' | ');
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ');
  const t = Array.isArray(s.type) ? s.type.join(' | ') : (s.type ?? 'object');
  if (t === 'array') return `${typeOf(s.items, doc)}[]`;
  return s.format ? `${t} (${s.format})` : t;
}

function resolve(s: SchemaObject | undefined, doc: OpenApiDoc): SchemaObject | undefined {
  if (s?.$ref) return doc.components?.schemas?.[s.$ref.split('/').pop() ?? ''];
  return s;
}

function Fields({ schema, doc }: { schema: SchemaObject | undefined; doc: OpenApiDoc }) {
  const s = resolve(schema, doc);
  const props = s?.properties;
  if (!props) return <p className="font-mono text-xs text-silver">{typeOf(schema, doc)}</p>;
  return (
    <div className="overflow-x-auto">
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="text-silver">
          <th className="py-1 pr-3 font-medium">Field</th>
          <th className="py-1 pr-3 font-medium">Type</th>
          <th className="py-1 font-medium">Notes</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(props).map(([name, p]) => (
          <tr key={name} className="border-t border-navy-secondary/60 align-top">
            <td className="py-1 pr-3 font-mono text-white">
              {name}
              {s?.required?.includes(name) ? '' : '?'}
            </td>
            <td className="py-1 pr-3 font-mono text-silver">{typeOf(p, doc)}</td>
            <td className="py-1 text-silver">{resolve(p, doc)?.description ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

const QUICK_START = `# 1. A 15-minute token (client credentials)
curl -s -u "$ALTO_CLIENT_ID:$ALTO_CLIENT_SECRET" \\
  -d grant_type=client_credentials https://people.altohr.com/api/v1/oauth/token

# 2. Call with it
curl -s -H "Authorization: Bearer $TOKEN" https://people.altohr.com/api/v1/workers?limit=50

# 3. Every POST names an Idempotency-Key; a repeat returns the first answer
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H "Idempotency-Key: $(uuidgen)" \\
  -H "Content-Type: application/json" -d '{"siteId":"…","position":"Housekeeper","startsAt":"…","endsAt":"…"}' \\
  https://people.altohr.com/api/v1/shifts`;

const VERIFY = `// Node: verify Alto-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyAlto(secret, rawBody, header, toleranceSeconds = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest('hex');
  return expected.length === parts.v1?.length && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}`;

function ApiReference() {
  const [q, setQ] = useState('');
  const spec = useQuery({ queryKey: ['developers', 'openapi'], queryFn: () => apiFetch<OpenApiDoc>('/v1/openapi.json'), staleTime: 10 * 60_000 });
  const doc = spec.data;

  const byTag = useMemo(() => {
    const out = new Map<string, Array<{ method: string; path: string; op: Operation }>>();
    if (!doc) return out;
    const needle = q.trim().toLowerCase();
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        if (needle && !`${method} ${path} ${op.summary ?? ''} ${op.description ?? ''}`.toLowerCase().includes(needle)) continue;
        const tag = op.tags?.[0] ?? 'Other';
        out.set(tag, [...(out.get(tag) ?? []), { method, path, op }]);
      }
    }
    return out;
  }, [doc, q]);

  const download = () => {
    if (!doc) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'alto-people-openapi.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const slug = (tag: string) => `tag-${tag.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <div className="lg:grid lg:grid-cols-[11rem_minmax(0,1fr)] lg:gap-6">
      {/* A sticky index on wide screens: the long operation list has a map (F500 G4). */}
      <nav aria-label="Reference sections" className="hidden lg:block">
        <ul className="sticky top-20 space-y-1 text-sm">
          <li><a href="#quick-start" className="text-ink-muted hover:text-ink">Quick start</a></li>
          <li><a href="#webhook-signatures" className="text-ink-muted hover:text-ink">Webhook signatures</a></li>
          {[...byTag.keys()].map((tag) => (
            <li key={tag}>
              <a href={`#${slug(tag)}`} className="text-ink-muted hover:text-ink">{tag}</a>
            </li>
          ))}
        </ul>
      </nav>
    <div className="min-w-0 space-y-[var(--d-stack)]">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput wrapperClassName="min-w-0 flex-1 sm:max-w-sm" className="h-8 text-xs" placeholder="Search operations…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search operations" />
        <Button size="sm" variant="outline" onClick={download} disabled={!doc} className="ml-auto">
          <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> OpenAPI document
        </Button>
      </div>

      <Card>
        <CardContent className="space-y-3">
          <h2 id="quick-start" className="scroll-mt-20 text-base font-semibold text-white">Quick start</h2>
          <p className="text-sm text-silver">
            Create an app on the API apps tab, grant it only the scopes it needs, and name its owner. Tokens last 15 minutes; ask for a new one when a call answers 401. Limits: 600 requests a minute per client, 3,000 per organization.
          </p>
          <pre className="overflow-x-auto rounded-md bg-navy-secondary/40 p-3 text-xs text-white">{QUICK_START}</pre>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h2 id="webhook-signatures" className="scroll-mt-20 text-base font-semibold text-white">Webhook signatures</h2>
          <p className="text-sm text-silver">
            Each delivery is a POST of <span className="font-mono text-xs">{'{ event, timestamp, data }'}</span> with the same shapes the API returns. Verify the signature on the raw body and refuse a timestamp older than five minutes. Failed deliveries retry for about 15 hours; any one can be sent again from <span className="font-mono text-xs">/v1/webhooks/{'{id}'}/deliveries</span>.
          </p>
          <pre className="overflow-x-auto rounded-md bg-navy-secondary/40 p-3 text-xs text-white">{VERIFY}</pre>
          <div className="flex flex-wrap gap-1.5">
            {WEBHOOK_EVENTS.filter((e) => e !== 'test.ping').map((e) => (
              <span key={e} className="rounded border border-navy-secondary px-1.5 py-0.5 font-mono text-xs text-silver">{e}</span>
            ))}
          </div>
        </CardContent>
      </Card>

      {spec.error ? (
        <ErrorBanner action={<Button size="sm" variant="secondary" onClick={() => void spec.refetch()}>Retry</Button>}>
          {spec.error instanceof ApiError ? spec.error.message : 'The API reference did not load.'}
        </ErrorBanner>
      ) : !doc ? (
        <SkeletonRows count={6} />
      ) : (
        [...byTag.entries()].map(([tag, ops]) => (
          <section key={tag} className="space-y-2" aria-labelledby={slug(tag)}>
            <h2 id={slug(tag)} className="scroll-mt-20 text-base font-semibold text-white">{tag}</h2>
            {ops.map(({ method, path, op }) => {
              const scopes = op.security?.flatMap((s) => Object.values(s).flat()) ?? [];
              const okCode = Object.keys(op.responses ?? {}).find((c) => c.startsWith('2'));
              const ok = okCode ? op.responses?.[okCode] : undefined;
              const body = op.requestBody?.content?.['application/json']?.schema;
              const params = (op.parameters ?? []).filter((p) => p.in !== 'header');
              return (
                <details key={`${method} ${path}`} className="rounded-md border border-navy-secondary bg-navy-secondary/10">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2">
                    <Badge variant={METHOD_TONE[method] ?? 'default'} withDot={false}>{method.toUpperCase()}</Badge>
                    <span className="font-mono text-xs text-white">/v1{path}</span>
                    <span className="text-sm text-silver">{op.summary}</span>
                  </summary>
                  <div className="space-y-3 border-t border-navy-secondary px-3 py-3">
                    {op.description && <p className="text-sm text-silver">{op.description}</p>}
                    <p className="text-xs text-silver">
                      {scopes.length ? <>Scopes: <span className="font-mono text-white">{scopes.join(' ')}</span></> : 'No token.'}
                      {method === 'post' && scopes.length ? ' · Idempotency-Key required' : ''}
                    </p>
                    {params.length > 0 && (
                      <div>
                        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-silver">Parameters</h3>
                        <ul className="space-y-0.5 text-xs">
                          {params.map((p) => (
                            <li key={`${p.in}-${p.name}`}>
                              <span className="font-mono text-white">{p.name}{p.required ? '' : '?'}</span>{' '}
                              <span className="text-silver">({p.in}, {typeOf(p.schema, doc)})</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {body && (
                      <div>
                        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-silver">Body</h3>
                        <Fields schema={body} doc={doc} />
                      </div>
                    )}
                    {ok && (
                      <div>
                        <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-silver">Response {okCode}</h3>
                        <Fields schema={ok.content?.['application/json']?.schema} doc={doc} />
                      </div>
                    )}
                  </div>
                </details>
              );
            })}
          </section>
        ))
      )}
    </div>
    </div>
  );
}
