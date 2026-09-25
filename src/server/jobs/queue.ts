// The BullMQ + Redis adapter for the job registry in jobs/handlers.ts. Used
// only when REDIS_URL is set -- the zero-infrastructure default is the
// node-cron runner in jobs/run.ts. Both adapters call the SAME handler
// functions from jobs/handlers.ts, the same way tRPC/MCP/webhooks all call
// one service layer; this file is scheduling only, no business rules.
//
// Never connects to Redis at import time -- only inside the functions below,
// when a caller actually invokes them.

import { Queue, Worker } from "bullmq";
import { env } from "@/env";
import { db } from "@/server/db";
import { jobs } from "./handlers";

export const QUEUE_NAME = "clinicdesk-jobs";

// env.REDIS_URL is `string | undefined` (optional in env.ts). The throw narrows
// it, so the return below is a guaranteed `string`, with no `!` needed.
function connectionOptions(): { url: string } {
  if (!env.REDIS_URL) {
    throw new Error("REDIS_URL must be set to use the BullMQ jobs adapter");
  }
  return { url: env.REDIS_URL };
}

/** Creates a Queue connected to REDIS_URL. Caller owns its lifecycle (close it when done). Pattern: FACTORY FUNCTION. */
export function createQueue(): Queue {
  return new Queue(QUEUE_NAME, { connection: connectionOptions() });
}

/**
 * Creates a Worker that processes queued/repeatable jobs by looking up their
 * name in the SAME registry jobs/run.ts uses, and calling that handler's
 * run(db) -- a missing handler is a programmer error (a job was scheduled
 * under a name nothing implements), so it throws rather than silently
 * skipping the job.
 */
export function createWorker(): Worker {
  return new Worker(
    QUEUE_NAME,
    // An async arrow function passed as a callback; BullMQ calls it once per job.
    async (job) => {
      // .find returns `Job | undefined`; the `if (!handler)` below narrows it.
      const handler = jobs.find((j) => j.name === job.name);
      if (!handler) {
        throw new Error(`No handler registered for job "${job.name}"`);
      }
      await handler.run(db);
    },
    { connection: connectionOptions() },
  );
}

/**
 * Registers every job in the registry as a BullMQ job scheduler using the
 * same cron expression jobs/run.ts uses, so switching adapters doesn't
 * change cadence. upsertJobScheduler is idempotent -- calling this again
 * (e.g. on every deploy) updates the existing scheduler instead of creating
 * a duplicate.
 */
// `queue: Queue = createQueue()` is a DEFAULT PARAMETER: evaluated only if the
// caller passes nothing, so a caller can inject its own queue instead.
export async function scheduleRepeatableJobs(queue: Queue = createQueue()): Promise<void> {
  // for...of + await: registers the jobs one after another, not in parallel.
  for (const job of jobs) {
    await queue.upsertJobScheduler(job.name, { pattern: job.cron }, { name: job.name });
  }
}
