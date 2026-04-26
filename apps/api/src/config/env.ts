import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  // DIRECT_URL is consumed by Prisma migrate, not by app code — but we
  // still validate it's present so devs aren't surprised.
  DIRECT_URL: z.string().min(1).optional(),
  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 chars (use openssl rand -base64 48)'),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  PAYOUT_ENCRYPTION_KEY: z
    .string()
    .min(44, 'PAYOUT_ENCRYPTION_KEY must be base64-encoded 32 bytes (use openssl rand -base64 32)'),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('[alto-people/api] invalid environment:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env: Env = parsed.data;
