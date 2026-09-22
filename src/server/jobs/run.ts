// The node-cron runner: the default, zero-infrastructure adapter for the job
// registry in jobs/handlers.ts. This file is scheduling only -- no business
// rules live here, see src/server/services/holds.ts for those.
//
// Run with `pnpm jobs` (persistent scheduler) or `pnpm jobs -- --once` (run
// every job a single time and exit -- what a Kubernetes CronJob or a CI
// smoke test would call).
//
// This project has no "type": "module" in package.json, so tsx compiles this
// file to CommonJS, where top-level await is not available. An async main()
// with a .catch() is the CJS-compatible equivalent (same pattern as
// mcp/server.ts).

import { schedule, shutdown } from "node-cron";
import { db } from "@/server/db";
import { jobs, type Job } from "./handlers";

/**
 * Runs one job's handler, catching anything it throws so that one failing
 * job never takes down the process or blocks the others. Returns whether it
 * succeeded, for --once to report a useful exit code.
 */
async function runOnce(job: Job): Promise<boolean> {
  try {
    await job.run(db);
    return true;
  } catch (e) {
    console.error(`[jobs] "${job.name}" failed`, e);
    return false;
  }
}

async function runAllOnce(): Promise<void> {
  let allSucceeded = true;
  for (const job of jobs) {
    const succeeded = await runOnce(job);
    allSucceeded = allSucceeded && succeeded;
  }
  // Let the caller (CI, a CronJob) see a non-zero exit if any job failed,
  // without throwing -- we still want to have attempted every job above.
  if (!allSucceeded) process.exitCode = 1;
}

function startScheduler(): void {
  console.error(
    `[jobs] starting ${jobs.length} job(s): ` +
      jobs.map((j) => `${j.name} (${j.cron})`).join(", "),
  );

  for (const job of jobs) {
    schedule(job.cron, () => runOnce(job), {
      name: job.name,
      // node-cron's built-in overlap guard: if the previous tick of this
      // job is still running when the next one is due, this tick is
      // skipped (logged by node-cron itself) instead of piling up
      // concurrent sweeps of the same job.
      noOverlap: true,
    });
  }

  const onSignal = (signal: NodeJS.Signals) => {
    console.error(`[jobs] received ${signal}, stopping...`);
    // Stops every registered task and waits for any execution in progress
    // to finish before resolving, so we don't exit mid-sweep.
    shutdown()
      .then(() => process.exit(0))
      .catch((e) => {
        console.error("[jobs] error while stopping", e);
        process.exit(1);
      });
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

async function main(): Promise<void> {
  if (process.argv.includes("--once")) {
    await runAllOnce();
    return;
  }
  startScheduler();
}

main().catch((e) => {
  console.error("[jobs] fatal error starting runner", e);
  process.exit(1);
});
