// The HTTP adapter behind GET /api/cron/release-holds, against the real test DB.
// The handler is built with an explicit secret, so the test doesn't depend on
// whether .env.test defines CRON_SECRET.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { db } from "@/server/db";
import { appointments, services } from "@/server/db/schema";
import { createReleaseHoldsHandler } from "@/server/cron";
import { localDayBounds } from "@/server/services/slots";

const SECRET = "test-cron-secret-that-is-at-least-32-chars";
const URL_ = "http://localhost:3000/api/cron/release-holds";

function request(authorization?: string) {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request(URL_, { headers });
}

/**
 * A pending_payment hold created `createdMinutesAgo` minutes ago, 30 days out at `hour`:00 clinic time.
 * Each call gets its own service (names are unique) and its own hour (the exclusion constraint forbids overlaps).
 */
async function seedHold(createdMinutesAgo: number, hour = 10) {
  const [svc] = await db
    .insert(services)
    .values({ name: `Cron Test ${hour}`, durationMinutes: 60, priceCents: 10000, depositCents: 2000 })
    .returning();
  if (!svc) throw new Error("seedHold: service insert returned no row");

  const day = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const startsAt = new Date(localDayBounds(day).start.getTime() + hour * 60 * 60_000);
  const [row] = await db
    .insert(appointments)
    .values({
      serviceId: svc.id,
      customerName: "Alice",
      customerPhone: "03001234567",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 60 * 60_000),
      status: "pending_payment",
      source: "web",
      createdAt: new Date(Date.now() - createdMinutesAgo * 60_000),
    })
    .returning();
  if (!row) throw new Error("seedHold: appointment insert returned no row");
  return row;
}

async function statusOf(id: string) {
  const [row] = await db.select().from(appointments).where(eq(appointments.id, id));
  return row?.status;
}

const Body = z.object({ released: z.array(z.string()) });

describe("GET /api/cron/release-holds", () => {
  it("returns 404 and changes nothing when CRON_SECRET is not configured", async () => {
    const hold = await seedHold(45);
    const handler = createReleaseHoldsHandler({ db, secret: undefined });

    const res = await handler(request(`Bearer ${SECRET}`));

    expect(res.status).toBe(404);
    expect(await statusOf(hold.id)).toBe("pending_payment");
  });

  it("returns 401 and changes nothing without an Authorization header", async () => {
    const hold = await seedHold(45);
    const handler = createReleaseHoldsHandler({ db, secret: SECRET });

    const res = await handler(request());

    expect(res.status).toBe(401);
    expect(await statusOf(hold.id)).toBe("pending_payment");
  });

  it("returns 401 and changes nothing with the wrong token", async () => {
    const hold = await seedHold(45);
    const handler = createReleaseHoldsHandler({ db, secret: SECRET });

    const res = await handler(request("Bearer not-the-secret"));

    expect(res.status).toBe(401);
    expect(await statusOf(hold.id)).toBe("pending_payment");
  });

  it("releases an expired hold and leaves a fresh one alone", async () => {
    const expired = await seedHold(45); // > 35 min hold + 5 min grace
    const fresh = await seedHold(5, 12);
    const handler = createReleaseHoldsHandler({ db, secret: SECRET });

    const res = await handler(request(`Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(Body.parse(await res.json()).released).toEqual([expired.id]);
    expect(await statusOf(expired.id)).toBe("cancelled");
    expect(await statusOf(fresh.id)).toBe("pending_payment");
  });

  it("is safe to call twice: the second call releases nothing", async () => {
    await seedHold(45);
    const handler = createReleaseHoldsHandler({ db, secret: SECRET });

    await handler(request(`Bearer ${SECRET}`));
    const second = await handler(request(`Bearer ${SECRET}`));

    expect(second.status).toBe(200);
    expect(Body.parse(await second.json()).released).toEqual([]);
  });
});
