import { ListTemplate } from '@/components/templates';
import { WEBHOOK_EVENTS } from '@alto-people/shared';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardContent, ErrorBanner, SkeletonRows } from '@/components/ui';
import { SearchInput } from '@/components/ui/FilterBar';

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

export function DevelopersPage() {
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

  return (
    // Design system §4.2 (UX upgrade step 6, the sweep): the List template.
    <ListTemplate
        title="API reference"
        subtitle="The public API: OAuth 2 client credentials, cursor pagination, an Idempotency-Key on every POST, signed webhooks."
        breadcrumbs={[{ label: 'Settings' }, { label: 'Integrations', to: '/integrations' }, { label: 'API reference' }]}
        primaryAction={
          <Button size="sm" variant="outline" onClick={download} disabled={!doc}>
            <Download className="mr-1.5 h-3.5 w-3.5" /> OpenAPI document
          </Button>
        }
    >

      <Card>
        <CardContent className="space-y-3">
          <h2 className="text-base font-semibold text-white">Quick start</h2>
          <p className="text-sm text-silver">
            Create a client on the Integrations page, grant it only the scopes it needs, and name its owner. Tokens last 15 minutes; ask for a new one when a call answers 401. Limits: 600 requests a minute per client, 3,000 per organization.
          </p>
          <pre className="overflow-x-auto rounded-md bg-navy-secondary/40 p-3 text-xs text-white">{QUICK_START}</pre>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <h2 className="text-base font-semibold text-white">Webhooks</h2>
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

      <div className="flex items-center gap-2">
        <SearchInput wrapperClassName="max-w-sm" className="h-8 text-xs" placeholder="Search operations…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search operations" />
      </div>

      {spec.error ? (
        <ErrorBanner action={<Button size="sm" variant="secondary" onClick={() => void spec.refetch()}>Retry</Button>}>
          {spec.error instanceof ApiError ? spec.error.message : 'The API reference did not load.'}
        </ErrorBanner>
      ) : !doc ? (
        <SkeletonRows count={6} />
      ) : (
        [...byTag.entries()].map(([tag, ops]) => (
          <section key={tag} className="space-y-2" aria-labelledby={`tag-${tag}`}>
            <h2 id={`tag-${tag}`} className="text-base font-semibold text-white">{tag}</h2>
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
    </ListTemplate>
  );
}
