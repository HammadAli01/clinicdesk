import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { appointments, services } from "@/server/db/schema";
import { bookAppointment } from "@/server/services/bookings";
import { DEPOSIT_HOLD_MINUTES } from "@/server/services/checkout";
import { releaseExpiredHolds } from "@/server/services/holds";
import { localDayBounds } from "@/server/services/slots";

async function seedService(depositCents = 2000) {
  const [svc] = await db
    .insert(services)
    .values({ name: "Test", durationMinutes: 60, priceCents: 10000, depositCents })
    .returning();
  if (!svc) throw new Error("seedService: insert returned no row");
  return svc;
}

// 30 days out so it's always a future, bookable slot -- same trick bookings.test.ts uses.
function futureLocal(hour: number) {
  const d = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  return new Date(localDayBounds(d).start.getTime() + hour * 60 * 60_000);
}

/** Inserts an appointment directly so its createdAt can be backdated -- releaseExpiredHolds decides purely off createdAt, not off what created the row. */
async function seedAppointment(opts: {
  serviceId: string;
  startsAt: Date;
  status: "pending_payment" | "confirmed";
  createdMinutesAgo: number;
}) {
  const endsAt = new Date(opts.startsAt.getTime() + 60 * 60_000);
  const createdAt = new Date(Date.now() - opts.createdMinutesAgo * 60_000);
  const [row] = await db
    .insert(appointments)
    .values({
      serviceId: opts.serviceId,
      customerName: "Alice",
      customerPhone: "03001234567",
      startsAt: opts.startsAt,
      endsAt,
      status: opts.status,
      source: "web",
      createdAt,
    })
    .returning();
  if (!row) throw new Error("seedAppointment: insert returned no row");
  return row;
}

describe("releaseExpiredHolds", () => {
  it("releases a pending_payment appointment created 45 minutes ago", async () => {
    const svc = await seedService();
    const hold = await seedAppointment({
      serviceId: svc.id,
      startsAt: futureLocal(10),
      status: "pending_payment",
      createdMinutesAgo: 45, // > DEPOSIT_HOLD_MINUTES (35) + 5 min grace = 40
    });

    const { released } = await releaseExpiredHolds(db, { now: new Date() });

    expect(released).toContain(hold.id);
    const [row] = await db.select().from(appointments).where(eq(appointments.id, hold.id));
    expect(row?.status).toBe("cancelled");
  });

  it("does not touch a pending_payment appointment created 5 minutes ago", async () => {
    const svc = await seedService();
    const hold = await seedAppointment({
      serviceId: svc.id,
      startsAt: futureLocal(11),
      status: "pending_payment",
      createdMinutesAgo: 5, // well inside the 40-minute default cutoff
    });

    const { released } = await releaseExpiredHolds(db, { now: new Date() });

    expect(released).not.toContain(hold.id);
    const [row] = await db.select().from(appointments).where(eq(appointments.id, hold.id));
    expect(row?.status).toBe("pending_payment");
  });

  it("never releases a confirmed appointment, even an old one", async () => {
    const svc = await seedService();
    const confirmed = await seedAppointment({
      serviceId: svc.id,
      startsAt: futureLocal(12),
      status: "confirmed",
      createdMinutesAgo: 45,
    });

    const { released } = await releaseExpiredHolds(db, { now: new Date() });

    // The worst bug this sweeper could have is cancelling a paid booking --
    // assert both the return value AND the row itself stayed untouched.
    expect(released).not.toContain(confirmed.id);
    const [row] = await db.select().from(appointments).where(eq(appointments.id, confirmed.id));
    expect(row?.status).toBe("confirmed");
  });

  it("is idempotent: sweeping twice releases nothing the second time", async () => {
    const svc = await seedService();
    const hold = await seedAppointment({
      serviceId: svc.id,
      startsAt: futureLocal(13),
      status: "pending_payment",
      createdMinutesAgo: 45,
    });

    const now = new Date();
    const first = await releaseExpiredHolds(db, { now });
    const second = await releaseExpiredHolds(db, { now });

    expect(first.released).toContain(hold.id);
    expect(second.released).toEqual([]);
    const [row] = await db.select().from(appointments).where(eq(appointments.id, hold.id));
    expect(row?.status).toBe("cancelled");
  });

  it("frees the slot so someone else can book it after release", async () => {
    const svc = await seedService();
    const startsAt = futureLocal(14);
    await seedAppointment({
      serviceId: svc.id,
      startsAt,
      status: "pending_payment",
      createdMinutesAgo: 45,
    });

    await releaseExpiredHolds(db, { now: new Date() });

    // If the release didn't actually free the row, this would throw CONFLICT
    // from the exclusion constraint -- this proves the sweep works against
    // the same guard bookAppointment relies on, not just that a status flag flipped.
    const { appointment } = await bookAppointment(db, {
      serviceId: svc.id,
      startsAt,
      customerName: "Bob",
      customerPhone: "03007654321",
      source: "web",
    });
    expect(appointment.startsAt.getTime()).toBe(startsAt.getTime());
  });

  it("honours an explicit olderThanMinutes instead of the DEPOSIT_HOLD_MINUTES default", async () => {
    const svc = await seedService();
    const hold = await seedAppointment({
      serviceId: svc.id,
      startsAt: futureLocal(15),
      status: "pending_payment",
      createdMinutesAgo: 10,
    });

    // 10 minutes is well within the default (DEPOSIT_HOLD_MINUTES + 5), but
    // an explicit 5-minute threshold should still catch it.
    const { released } = await releaseExpiredHolds(db, {
      now: new Date(),
      olderThanMinutes: 5,
    });

    expect(released).toContain(hold.id);
  });
});

// Sanity check on the constant the default cutoff depends on, so the
// "45 minutes / 5 minutes" fixtures above fail loudly (not silently) if
// DEPOSIT_HOLD_MINUTES ever changes enough to invalidate them.
describe("DEPOSIT_HOLD_MINUTES assumption", () => {
  it("is 35, matching the fixtures used above (40-minute default cutoff)", () => {
    expect(DEPOSIT_HOLD_MINUTES).toBe(35);
  });
});
