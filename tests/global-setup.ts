import { config } from 'dotenv';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

// Runs once before all tests: bring the test DB schema up to date
// using the SAME migration files production uses.
export default async function setup() {
  // Same precedence rule as vitest.config.ts: an explicit shell DATABASE_URL
  // wins, otherwise fall back to .env.test.
  const url =
    process.env.DATABASE_URL ?? config({ path: '.env.test', quiet: true }).parsed?.DATABASE_URL;
  if (!url) throw new Error('.env.test must define DATABASE_URL');
  const client = postgres(url, { max: 1, onnotice: () => {} });
  await migrate(drizzle(client), { migrationsFolder: './drizzle' });
  await client.end();
}
