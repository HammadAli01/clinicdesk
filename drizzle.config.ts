import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs OUTSIDE Next.js, so nothing loads .env.local for us.
// `quiet: true` is required on dotenv v17+ — older versions printed a banner to
// stdout, which is harmless here but fatal for anything speaking a protocol on
// stdout (see mcp/server.ts). Load it the same way everywhere out of habit.
config({ path: '.env.local', quiet: true });

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set (check .env.local)');

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/server/db/schema.ts', // the TypeScript description of our tables
  out: './drizzle', // generated .sql migrations — COMMITTED, never edited
  dbCredentials: { url },
  // `strict: true` asks for confirmation before destructive statements and
  // `verbose: true` prints the SQL. Both are great for `generate`/`push`, but
  // drizzle-kit 0.31 tries to open an interactive prompt for them during
  // `migrate` as well, which dies silently in a non-TTY shell (CI, an agent's
  // shell, a Docker build). See docs/03-migrations.md — this cost us 20 minutes.
  strict: false,
  verbose: false,
});
