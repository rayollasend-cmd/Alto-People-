import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';

// Load .env.test before any test imports the api source — those imports
// pull in `config/env.ts`, which validates env at module load time.
// `override: true` so test values win over an existing dev `.env`.
loadDotenv({ path: resolve(__dirname, '../.env.test'), override: true });

if (process.env.NODE_ENV !== 'test') {
  throw new Error('test/setup.ts: NODE_ENV is not "test"; check apps/api/.env.test');
}
