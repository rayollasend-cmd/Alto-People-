import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Recorded vendor responses, one folder per vendor. Sandbox mode replays
 * them so the mapping is proven in CI; they carry invented people only.
 */
const here = dirname(fileURLToPath(import.meta.url));

export function loadFixture<T>(vendor: string, file: string): T {
  return JSON.parse(readFileSync(join(here, 'fixtures', vendor, file), 'utf8')) as T;
}
