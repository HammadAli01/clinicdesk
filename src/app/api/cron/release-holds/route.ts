// GET /api/cron/release-holds: frees slots whose deposit was never paid.
// Called every 5 minutes by .github/workflows/sweep-holds.yml (Vercel's free plan
// only allows daily crons). All logic lives in src/server/cron.ts and the holds service.
import { env } from "@/env";
import { db } from "@/server/db";
import { createReleaseHoldsHandler } from "@/server/cron";

export const runtime = "nodejs"; // node:crypto + the Postgres driver, not the edge runtime
export const dynamic = "force-dynamic"; // never cache: every call must hit the database

export const GET = createReleaseHoldsHandler({ db, secret: env.CRON_SECRET });
