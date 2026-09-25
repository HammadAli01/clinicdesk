// The one database client for the whole server (pattern: SINGLETON).
// Services never import this `db` directly; adapters pass it in as an argument.

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres'; // DEFAULT import: the module's `export default`
import { env } from '@/env'; // importing env validates all env vars first (fail fast)
import * as schema from './schema'; // NAMESPACE import: every export of schema.ts as one object

// In dev, Next.js hot-reloads modules. Without this, every reload opens a new
// connection pool until Postgres runs out of connections. We keep one pool on
// globalThis. This is the ONE deliberate cast in the codebase (see CLAUDE.md).
const globalForDb = globalThis as unknown as { pgClient?: ReturnType<typeof postgres> };

// `??`: reuse the existing pool if there is one, otherwise create it (max 10 connections).
const client = globalForDb.pgClient ?? postgres(env.DATABASE_URL, { max: 10 });
if (env.NODE_ENV !== 'production') globalForDb.pgClient = client;

export const db = drizzle(client, { schema }); // passing schema enables db.query.*
// `typeof db` in a TYPE position = "the type of this value". We never write the
// big Drizzle type by hand; services use `Db` for their first parameter.
export type Db = typeof db;
