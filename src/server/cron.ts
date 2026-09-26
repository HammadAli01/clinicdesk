// HTTP adapter for scheduled jobs on serverless hosting (Vercel), where there is
// no long-running process for node-cron to live in. Something external (a GitHub
// Actions schedule, or Vercel Cron on a paid plan) calls the route on a timer.
//
// Thin adapter, like the tRPC routers: check the caller → call ONE service → map to HTTP.
// Built as a factory (deps passed in) so tests can supply their own secret and db.
import type { Db } from "@/server/db";
import { safeEqual } from "@/server/safe-equal";
import { releaseExpiredHolds } from "@/server/services/holds";

type Deps = {
  db: Db;
  /** From env.CRON_SECRET. `undefined` = this environment doesn't expose the route. */
  secret: string | undefined;
};

/**
 * Returns a route handler for `GET /api/cron/release-holds`.
 *
 * - no secret configured        → 404 (the route doesn't exist in this environment)
 * - missing/wrong bearer token  → 401
 * - OK                          → 200 { released: string[] }
 *
 * Safe to call as often as you like: releaseExpiredHolds is one conditional
 * UPDATE, so a duplicate or overlapping call releases nothing new.
 */
export function createReleaseHoldsHandler({ db, secret }: Deps) {
  return async (req: Request): Promise<Response> => {
    if (secret === undefined) {
      return new Response("Not found", { status: 404 });
    }
    // Same header convention Vercel Cron uses: `Authorization: Bearer <CRON_SECRET>`.
    const auth = req.headers.get("authorization") ?? "";
    if (!safeEqual(auth, `Bearer ${secret}`)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const { released } = await releaseExpiredHolds(db);
    // stdout is fine here (this is a web route, not the MCP stdio server).
    console.log(JSON.stringify({ job: "release-expired-holds", releasedCount: released.length }));
    return Response.json({ released });
  };
}
