import { sql } from 'drizzle-orm';
import { beforeEach } from 'vitest';
import { db } from '@/server/db';

// Every test starts from empty tables.
//
// ⚠️ ONE SUITE AT A TIME, PER DATABASE.
//
// `fileParallelism: false` in vitest.config.ts serialises test FILES inside one
// Vitest process. It cannot know about a second process. If two runs share this
// database — two agents, two terminals, two CI jobs on one box — this TRUNCATE
// lands in the middle of the other run's test and you get symptoms that look
// impossible and send you hunting for a bug that isn't there:
//
//   • a row vanishing between its own INSERT and a later query in the SAME test
//   • `duplicate key value violates unique constraint` on a table you just truncated
//   • foreign-key violations against an id inserted moments earlier
//   • everything passing again when you re-run the file on its own
//
// If you need concurrent runs (a worktree per agent, say), give each one its own
// database and point DATABASE_URL at it — vitest.config.ts and global-setup.ts
// both prefer a shell DATABASE_URL over .env.test precisely so you can:
//
//   createdb -U clinic clinicdesk_test_myfeature
//   $env:DATABASE_URL="postgres://clinic:clinic@localhost:5433/clinicdesk_test_myfeature"
//
// This has cost real debugging time; see AI_LOG.md.
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE appointments, services, webhook_events, oauth_accounts CASCADE`,
  );
});
