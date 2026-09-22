import { z } from 'zod';
const EnvSchema = z.object({
  DATABASE_URL: z.url(),
  APP_URL: z.url(),
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN must be at least 16 characters'),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  STRIPE_SECRET_KEY: z.string().startsWith('sk_'),
  STRIPE_WEBHOOK_SECRET: z.string().startsWith('whsec_'),
  REDIS_URL: z.url().optional(),
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
});
// Throws at startup with a readable list of what's missing or wrong.
export const env = EnvSchema.parse(process.env);
