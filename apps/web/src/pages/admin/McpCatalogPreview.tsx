import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { QueryError } from '@/components/ui/QueryError';

/**
 * The MCP tool catalog (agent families step 6; Brief 2-7): every tool the
 * MCP server at /api/mcp offers this organization, generated from the
 * capability catalog. Each agent sees only the ones it holds, plus whoami and
 * approval_status. Rendered open on Settings & trust › Agents & gates; nothing here calls a tool.
 */

interface McpToolPreview {
  name: string;
  title: string;
  description: string;
  effect: 'propose' | 'notify' | 'read';
  gate: string | null;
  family: string;
}

const EFFECT: Record<McpToolPreview['effect'], { label: string; variant: 'pending' | 'accent' | 'default' }> = {
  propose: { label: 'Needs approval', variant: 'pending' },
  notify: { label: 'Sends notices', variant: 'accent' },
  read: { label: 'Read only', variant: 'default' },
};

export function McpCatalogPreview() {
  const catalog = useQuery({
    queryKey: ['agents', 'mcp-catalog'],
    queryFn: () => apiFetch<{ preview: true; tools: McpToolPreview[] }>('/agents/mcp-catalog'),
  });
  return (
    <div className="space-y-2" data-testid="mcp-catalog">
      <p className="text-xs2 text-silver">What the MCP server at <code className="text-white">/api/mcp</code> offers, generated from the agents&rsquo; capabilities. An agent connects with its own credential and sees only the tools it holds. A tool that needs approval returns an approval id and does nothing else.</p>
      {catalog.error ? (
        <QueryError what="the MCP catalog" query={catalog} />
      ) : (
        <ul className="mt-2 divide-y divide-navy-secondary">
          {(catalog.data?.tools ?? []).map((t) => (
            <li key={t.name} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <code className="text-white">{t.name}</code>
              <Badge variant={EFFECT[t.effect].variant} size="sm">
                {EFFECT[t.effect].label}
              </Badge>
              <span className="text-silver">{t.title}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
