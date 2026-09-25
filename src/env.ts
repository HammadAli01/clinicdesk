// Pattern: VALIDATED CONFIG. Every environment variable is checked ONCE, at
// startup, with Zod. The rest of the app imports `env` (fully typed) and never
// reads `process.env` directly, where everything is `string | undefined`.
import { z } from 'zod';
const EnvSchema = z.object({
  DATABASE_URL: z.url(),
  APP_URL: z.url(),
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN must be at least 16 characters'),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  STRIPE_SECRET_KEY: z.string().startsWith('sk_'),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_'),
  REDIS_URL: z.url().optional(), // typed `string | undefined`: code must handle "not set"
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
});
// Throws at startup with a readable list of what's missing or wrong (fail fast).
// .parse returns the typed object, or throws; there's no half-valid state.
export const env = EnvSchema.parse(process.env);
