import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * .env.example is the documentation of the environment: every key the
 * schema in config/env.ts reads is listed there (set or commented out), and
 * nothing is listed that the schema does not read. The audit of 2026-10-21
 * found ~100 of 163 keys missing, every provider key among them.
 */

const root = resolve(__dirname, '../../..');

function schemaKeys(): string[] {
  const src = readFileSync(resolve(root, 'src/config/env.ts'), 'utf8').split('\n');
  const start = src.findIndex((l) => l.startsWith('const EnvSchema = z.object({'));
  const end = src.findIndex((l, i) => i > start && l === '});');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src
    .slice(start + 1, end)
    .map((l) => /^ {2}([A-Z][A-Z0-9_]+):/.exec(l)?.[1])
    .filter((k): k is string => !!k);
}

function exampleKeys(): string[] {
  return readFileSync(resolve(root, '.env.example'), 'utf8')
    .split('\n')
    .map((l) => /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(l)?.[1])
    .filter((k): k is string => !!k);
}

describe('.env.example matches config/env.ts', () => {
  it('lists every key the schema reads, once, and nothing else', () => {
    const schema = schemaKeys();
    const example = exampleKeys();
    expect(schema.length).toBeGreaterThan(150);
    const missing = schema.filter((k) => !example.includes(k));
    const extra = example.filter((k) => !schema.includes(k));
    const dupes = example.filter((k, i) => example.indexOf(k) !== i);
    expect(missing, `keys read by config/env.ts but absent from .env.example: ${missing.join(', ')}`).toEqual([]);
    expect(extra, `keys in .env.example that config/env.ts does not read: ${extra.join(', ')}`).toEqual([]);
    expect(dupes, `keys listed twice in .env.example: ${dupes.join(', ')}`).toEqual([]);
  });

  it('leaves every secret blank', () => {
    const lines = readFileSync(resolve(root, '.env.example'), 'utf8').split('\n');
    const secretWithValue = lines.filter((l) => /^[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY)[A-Z0-9_]*=.+/.test(l) && !/replace-me/.test(l));
    expect(secretWithValue).toEqual([]);
  });
});
