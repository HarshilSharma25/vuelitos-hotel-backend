import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';

// Try loading .env if not loaded
if (fs.existsSync('.env')) {
  const content = fs.readFileSync('.env', 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx !== -1) {
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z
    .string()
    .default('postgresql://pavitrasharmna@localhost:5432/hotel_backend?schema=public'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  SESSION_SECRET: z
    .string()
    .default('dev-session-secret-must-be-at-least-32-chars-long!'),
  PUBLIC_API_ORIGIN: z.string().default('http://localhost:3000'),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000,http://localhost:3001'),
  PAYMENT_WINDOW_HOURS: z.coerce.number().default(48),
  GROUP_MIN_ROOMS: z.coerce.number().default(5),
  GROUP_MIN_GUESTS: z.coerce.number().default(12),
  FEATURE_STRIPE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  FILES_DRIVER: z.enum(['local', 'http']).default('local'),
  FILES_ROOT: z.string().default('./uploads'),
  FILES_PUBLIC_BASE_URL: z.string().default('http://localhost:3000/files'),
  FILES_SERVER_URL: z.string().optional(),
  FILES_TOKEN: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
  PRICING_NOW: z.string().optional(), // Non-production only
  JWT_PUBLIC_KEY: z.string().optional(),
  JWT_PUBLIC_KEY_PATH: z.string().optional(),
  JWT_SECRET: z.string().default('travelCaribProdSecretKey'),
  JWT_ISSUER: z.string().default('vuelitos-auth'),
  JWT_AUDIENCE: z.string().default('vuelitos-platform'),
  JWT_ALGORITHM: z.string().default('auto'),
});

export type Env = z.infer<typeof envSchema>;

let parsedEnv: Env;
try {
  parsedEnv = envSchema.parse(process.env);
  if (parsedEnv.NODE_ENV === 'production') {
    delete parsedEnv.PRICING_NOW;
  }
} catch (err: any) {
  console.error('Invalid environment configuration:', err.errors || err);
  if (process.env.NODE_ENV !== 'test') {
    process.exit(1);
  }
  parsedEnv = envSchema.parse({});
}

export const env = parsedEnv;
