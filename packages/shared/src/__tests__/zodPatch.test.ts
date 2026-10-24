import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { patchSchema } from '../zodPatch.js';

const Create = z
  .object({
    name: z.string().min(2),
    enabled: z.boolean().default(true),
    policy: z.enum(['NONE', 'INVITED_ONLY']).default('INVITED_ONLY'),
    tags: z.array(z.string()).optional().default([]),
    note: z.string().nullable().default(null),
    label: z.string().optional(),
  })
  .strict();

describe('patchSchema — the PATCH form of a create schema', () => {
  it('leaves out what the request leaves out (zod 4 .partial() would fill every default)', () => {
    expect(Create.partial().parse({})).toEqual({ enabled: true, policy: 'INVITED_ONLY', tags: [], note: null });
    expect(patchSchema(Create).parse({})).toEqual({});
    expect(patchSchema(Create).parse({ name: 'Okta' })).toEqual({ name: 'Okta' });
  });

  it('still validates what is sent, null included where the field allows it', () => {
    const p = patchSchema(Create);
    expect(p.parse({ enabled: false, note: null })).toEqual({ enabled: false, note: null });
    expect(p.safeParse({ name: 'x' }).success).toBe(false);
    expect(p.safeParse({ policy: 'ALL' }).success).toBe(false);
    expect(p.safeParse({ enabled: null }).success).toBe(false);
  });

  it('keeps the object mode (strict stays strict) and chains like .partial()', () => {
    expect(patchSchema(Create).safeParse({ extra: 1 }).success).toBe(false);
    const withStatus = patchSchema(Create).extend({ status: z.enum(['ACTIVE', 'CLOSED']).optional() });
    expect(withStatus.parse({ status: 'CLOSED' })).toEqual({ status: 'CLOSED' });
  });
});
