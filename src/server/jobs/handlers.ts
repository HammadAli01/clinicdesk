// The job registry. Adapters (jobs/run.ts for node-cron, jobs/queue.ts for
// BullMQ) import this list and provide the scheduling -- the SAME handler
// functions run under both, mirroring how tRPC/MCP/webhooks all call one
// service layer. No scheduling logic belongs here, only "what to run".

import type { Db } from "@/server/db";
import { releaseExpiredHolds } from "@/server/services/holds";

export type Job = {
  /** Stable id used as the cron task name / BullMQ job & scheduler name. */
  name: string;
  /** Standard 5-field cron expression, interpreted in server-local time. */
  cron: string;
  run(db: Db): Promise<void>;
};

export const jobs: Job[] = [
  {
    name: "release-expired-holds",
    // Every 5 minutes. releaseExpiredHolds already waits DEPOSIT_HOLD_MINUTES
    // + a grace margin before touching a hold, so this cadence just bounds
    // how stale an undelivered webhook can leave a slot.
    cron: "*/5 * * * *",
    async run(db: Db) {
      const { released } = await releaseExpiredHolds(db);
      // Structured, one line, stderr -- never stdout (see CLAUDE.md: MCP
      // stdio rule applies to this process too, since it can share a
      // terminal/log stream with other stdio tooling).
      console.error(
        JSON.stringify({
          job: "release-expired-holds",
          releasedCount: released.length,
          releasedIds: released,
          at: new Date().toISOString(),
        }),
      );
    },
  },
];
