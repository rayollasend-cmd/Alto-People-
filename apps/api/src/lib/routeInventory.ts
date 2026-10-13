import type { Express } from 'express';

/**
 * Every route the Express app mounts, read from the router itself, so a
 * suite built on it cannot miss a route that was added later (Brief 2-1,
 * the cross-tenant suite).
 */
export interface RouteEntry {
  method: string;
  path: string;
}

interface Layer {
  route?: { path: string | string[]; methods: Record<string, boolean> };
  name?: string;
  handle?: { stack?: Layer[] };
  regexp?: RegExp & { fast_slash?: boolean };
  keys?: Array<{ name: string }>;
}

/** The mount path of a `app.use(path, router)` layer, back from its regexp. */
function mountPath(layer: Layer): string {
  const re = layer.regexp;
  if (!re || re.fast_slash) return '';
  let keyIndex = 0;
  const keys = layer.keys ?? [];
  const p = re.source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)\$?$/, '')
    .replace(/\$$/, '')
    .replace(/\(\?:\(\[\^\\\/]\+\?\)\)/g, () => `:${keys[keyIndex++]?.name ?? 'param'}`)
    .replace(/\\\//g, '/')
    .replace(/\\\./g, '.');
  if (p === '/' || p === '') return '';
  return p.startsWith('/') ? p : `/${p}`;
}

export function listRoutes(app: Express): RouteEntry[] {
  const out = new Map<string, RouteEntry>();
  const walk = (stack: Layer[] | undefined, prefix: string) => {
    for (const layer of stack ?? []) {
      if (layer.route) {
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        for (const p of paths) {
          const full = (prefix + p).replace(/\/{2,}/g, '/') || '/';
          for (const [m, on] of Object.entries(layer.route.methods)) {
            if (!on || m === '_all') continue;
            const method = m.toUpperCase();
            out.set(`${method} ${full}`, { method, path: full });
          }
        }
      } else if (layer.name === 'router' && layer.handle?.stack) {
        walk(layer.handle.stack, prefix + mountPath(layer));
      }
    }
  };
  walk((app as unknown as { _router?: { stack: Layer[] } })._router?.stack, '');
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}
