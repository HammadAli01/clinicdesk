# 10 · Background jobs

## Why this exists at all

`bookWithDeposit` holds a slot in `pending_payment` and asks Stripe to expire the Checkout
session after 35 minutes. When it expires, Stripe sends `checkout.session.expired` and the
webhook releases the hold.

**But a webhook is a network delivery, and network deliveries are lost.** Stripe retries for three
days, but the event can still never land: your endpoint was misconfigured, the deploy was down
past the retry window, someone rotated the signing secret, the event was marked failed and never
reclaimed. When that happens the slot stays blocked *forever*. Nobody gets an error. The failure
surfaces weeks later as "why is Tuesday always full?".

So there are two mechanisms, and the relationship between them is the lesson:

> **The webhook is the fast path. The job is the guarantee.**

That shape recurs everywhere in production systems — cache plus origin, optimistic UI plus
reconciliation, event stream plus nightly rebuild. One path is quick and usually right; the other
is slow and always right.

## The rule lives in a service, the schedule lives in an adapter

Exactly the same split as everywhere else in this codebase:

```
services/holds.ts       ← the business rule. Takes db. Knows nothing about cron.
      ↑                    ↑
jobs/handlers.ts        ← the registry: name, schedule, what to call
      ↑              ↑
jobs/run.ts      jobs/queue.ts
  (node-cron)      (BullMQ + Redis)
```

The runner is just a fourth caller of the service layer, alongside tRPC, MCP and the webhook.
That is why swapping node-cron for BullMQ changes no business logic at all.

### The rule

```ts
export async function releaseExpiredHolds(
  db: Db,
  opts?: { now?: Date; olderThanMinutes?: number },
): Promise<{ released: string[] }> {
  const cutoff = new Date(now.getTime() - olderThanMinutes * 60_000);

  const rows = await db.update(appointments)
    .set({ status: 'cancelled' })
    .where(and(
      eq(appointments.status, 'pending_payment'),   // ← never touches confirmed bookings
      lt(appointments.createdAt, cutoff),
    ))
    .returning({ id: appointments.id });

  return { released: rows.map((r) => r.id) };
}
```

Four decisions:

**One statement, not select-then-update-in-a-loop.** A loop is slower *and* racy: a row can be
paid between the select and the update. The conditional `WHERE` makes the check and the write
atomic — the same pattern as `confirmPayment` (chapter 04).

**`status = 'pending_payment'` is the safety property.** A sweeper that cancels *confirmed*
bookings is the worst possible bug in this file: money taken, appointment silently deleted. There
is a test that exists purely to pin it — *"a confirmed appointment created 45 minutes ago is NOT
touched"* — and it should be the last test anyone deletes.

**The grace margin.** `olderThanMinutes` defaults to `DEPOSIT_HOLD_MINUTES + 5`, so the sweep
never races the webhook. It only cleans up holds the webhook has already had a fair chance at.
A sweeper that fires at the same moment as the fast path will eventually cancel a booking a
customer is mid-way through paying for.

**`now` is a parameter.** Time is an input, which means the tests control it by passing a `Date`
instead of using fake timers or `sleep`. Any function whose behaviour depends on the clock should
take the clock as an argument — the same reason `computeFreeSlots` takes `now`.

### The adapter (node-cron, the default)

```ts
schedule(job.cron, () => runOnce(job), {
  name: job.name,
  noOverlap: true,   // previous tick still running? skip this one rather than pile up
});
```

Three things a real runner needs that a naive one forgets:

**Overlap protection.** If a sweep takes longer than the interval, ticks queue up behind each
other until the process dies. `noOverlap: true` skips instead.

**A `try/catch` per job.** `runOnce` swallows and logs, so one failing job cannot kill the process
and take the other jobs with it. An unhandled rejection in a timer callback terminates Node.

**Graceful shutdown.** `SIGINT`/`SIGTERM` call `shutdown()`, which waits for an in-flight run to
finish before exiting. Without it a container restart can kill a sweep halfway through — which is
survivable here only *because* the job is idempotent, and you should not rely on that.

Plus `--once`, which runs every job a single time and exits with a non-zero code if any failed.
That is the form a Kubernetes `CronJob`, a GitHub Actions schedule, or a Vercel Cron wants — and
it makes the job trivially testable from a shell.

```bash
pnpm jobs            # long-running scheduler
pnpm jobs -- --once  # one pass, then exit
```

## node-cron vs BullMQ + Redis — the actual decision

I built **both**, with node-cron as the default. Here is the reasoning, because "we use BullMQ"
without the reasoning is cargo cult.

| | node-cron | BullMQ + Redis |
|---|---|---|
| Infrastructure | none | a Redis you must run, monitor and back up |
| Runs where | inside a process you already have | a separate worker process |
| Multiple instances | **every instance runs every tick** ⚠️ | one worker takes each job |
| Retries | you write them | built in, with backoff |
| Per-item jobs | no — it's a clock, not a queue | yes: "send *this* reminder" |
| Visibility | your logs | queue depth, failures, a dashboard |
| Scheduled fan-out | no | delayed jobs, rate limiting, priorities |

**node-cron is right when** the work is one periodic sweep, idempotent, cheap, and you run one
instance. That is exactly `release-expired-holds` today. Adding Redis for it would be
infrastructure you have to operate in exchange for nothing.

**BullMQ becomes right the moment** any of these is true — and for AgentZap, which the job
description says uses BullMQ and Redis, several already are:

- You run more than one instance. With node-cron, three instances means three concurrent sweeps.
  Idempotency saves you here, but it will not save you for "send the reminder SMS" — that sends
  three texts.
- The work is **per item**, not periodic: a reminder 24 hours before *this* appointment, a
  post-call workflow for *this* call. That is a queue, not a clock.
- The work is slow and must not block a request. A webhook that has to do heavy work should
  enqueue and return 200 immediately — Stripe times out slow handlers and retries them, so slow
  work inside a webhook produces duplicate processing.
- You need retries with backoff, a dead-letter queue, and a dashboard to see what is stuck.

The migration cost is deliberately near zero:

```ts
// jobs/queue.ts — the SAME handlers, a different scheduler
const worker = new Worker(QUEUE_NAME, async (job) => {
  const handler = jobs.find((j) => j.name === job.name);
  if (handler) await handler.run(db);
}, { connection });
```

`jobs/handlers.ts` does not change. Neither does `services/holds.ts`. Only the adapter changes —
which is the same claim the architecture makes about tRPC and MCP, demonstrated a second time.

Redis is in `docker-compose.yml` behind a `queue` profile, so it is off by default:

```bash
docker compose --profile queue up -d
# then set REDIS_URL in .env.local
```

`src/env.ts` has `REDIS_URL: z.url().optional()` — optional, so the app runs without Redis and
the queue path activates only when the URL exists. **`jobs/queue.ts` never connects at import
time**, only inside its exported functions, so importing the module in a test or a serverless
function does not open a Redis connection.

## Making a job safe to run twice (because it will be)

Every job runs more than once eventually: a retry, an overlapping tick, two instances, a manual
re-run at 3 a.m. by someone debugging. The defences are the same as chapter 04:

1. **Conditional updates.** `WHERE status = 'pending_payment'` — the second run matches nothing.
2. **A natural key.** For "send a reminder", a unique constraint on
   `(appointment_id, reminder_type)` makes a duplicate send impossible at the database level, not
   at the discipline level.
3. **Small batches with a cursor.** A job that must touch 100k rows should do 500 at a time and
   be resumable, not hold one enormous transaction that blocks writes and times out.
4. **A bounded query.** `lt(createdAt, cutoff)` is indexed and cheap. A sweeper that scans the
   whole table every five minutes is a slow-motion outage as data grows.

## What I would add next

Honest gaps, in the order I would close them:

- **Reminder jobs** — "your appointment is tomorrow at 10:30" 24 hours before, and a follow-up
  after. This is the per-item work that justifies BullMQ, and it is what AgentZap's *"post-call
  workflows"* means.
- **A dead-letter path.** Right now a failed sweep is logged and retried on the next tick forever.
  It should escalate after N failures rather than failing quietly at the same cadence for a week.
- **Metrics, not just logs.** `releasedCount` per run into a counter, and an alert if it is
  suddenly large — a spike means the webhook path has broken, which is exactly the thing the job
  is compensating for. A safety net nobody watches will quietly become the primary path.
- **A leader election** if this ever runs on several instances with node-cron: a Postgres advisory
  lock around the tick (`pg_try_advisory_lock`) is about ten lines and removes the duplicate-tick
  problem without adding Redis.
