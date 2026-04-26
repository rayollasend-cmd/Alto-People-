import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../app.js';

describe('GET /health', () => {
  it('returns 200 with ok=true and an ISO timestamp', async () => {
    const res = await request(createApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.ts).toBe('string');
    expect(() => new Date(res.body.ts).toISOString()).not.toThrow();
  });
});
