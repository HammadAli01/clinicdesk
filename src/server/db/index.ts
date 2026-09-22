import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '@/env';
import * as schema from './schema';

// In dev, Next.js hot-reloads modules. Without this, every reload opens a new
// connection pool until Postgres runs out of connections. We keep one pool on
// globalThis. This is the ONE deliberate cast in the codebase (see CLAUDE.md).
const globalForDb = globalThis as unknown as { pgClient?: ReturnType<typeof postgres> };

const client = globalForDb.pgClient ?? postgres(env.DATABASE_URL, { max: 10 });
if (env.NODE_ENV !== 'production') globalForDb.pgClient = client;

export const db = drizzle(client, { schema }); // passing schema enables db.query.*
export type Db = typeof db;
