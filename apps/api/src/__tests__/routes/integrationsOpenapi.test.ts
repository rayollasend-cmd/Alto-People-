import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';
import { integrationsOpenapi } from '../../lib/integrationsOpenapi.js';
import { integrationsV1Router } from '../../routes/integrationsV1.js';

/**
 * The OpenAPI document is hand-authored, so this suite is the drift
 * guard: every documented path must exist on the router, and every
 * router GET must be documented. If someone adds an endpoint without
 * documenting it (or documents one that doesn't exist), this fails.
 */

/** Express route paths registered on the router, normalized to OpenAPI style. */
function routerGetPaths(): string[] {
  const paths: string[] = [];
  for (const layer of integrationsV1Router.stack) {
    const route = (layer as { route?: { path: string; methods: Record<string, boolean> } })
      .route;
    if (route?.methods.get) {
      paths.push(route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}'));
    }
  }
  return paths;
}

describe('GET /integrations/v1/openapi.json', () => {
  it('serves the spec without authentication', async () => {
    const res = await request(createApp()).get('/integrations/v1/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.info.title).toContain('Integration API');
    // Bearer scheme advertised.
    expect(res.body.components.securitySchemes.apiKey.scheme).toBe('bearer');
  });

  it('documents exactly the endpoints the router serves', () => {
    const documented = Object.keys(integrationsOpenapi.paths).sort();
    const served = routerGetPaths()
      .filter((p) => p !== '/openapi.json')
      .sort();
    expect(documented).toEqual(served);
  });

  it('gives every operation an operationId and error responses', () => {
    for (const [path, item] of Object.entries(integrationsOpenapi.paths)) {
      const op = (item as { get: { operationId?: string; responses: Record<string, unknown> } })
        .get;
      expect(op.operationId, `${path} missing operationId`).toBeTruthy();
      expect(op.responses['401'], `${path} missing 401`).toBeTruthy();
      expect(op.responses['429'], `${path} missing 429`).toBeTruthy();
    }
  });
});
