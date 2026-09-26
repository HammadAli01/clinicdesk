// tRPC adapter tests: call procedures directly through createCallerFactory,
// with no HTTP involved. This exercises the same code path a real request
// takes (input validation -> service call -> mapDomainErrors) without the
// network round-trip, against the real test DB.

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { appointments, services } from "@/server/db/schema";
import { DomainError } from "@/server/errors";
import { localDayBounds } from "@/server/services/slots";
import { stripe } from "@/server/stripe";
import { createCallerFactory, createTRPCRouter, publicProcedure } from "@/server/trpc/init";
import { appRouter } from "@/server/trpc/routers/_app";

const callerFactory = createCallerFactory(appRouter);

// isAdmin is set directly here instead of going through createTRPCContext's
// cookie parsing -- that cookie -> env.ADMIN_TOKEN wiring belongs to the
// route handler, not to these router/service tests.
function callerAs(isAdmin: boolean) {
  return callerFactory({ db, stripe, isAdmin });
}

async function seedService(name: string, durationMinutes = 60, depositCents = 0) {
  const [svc] = await db
    .insert(services)
    .values({ name, durationMinutes, priceCents: 1000, depositCents })
    .returning();
  if (!svc) throw new Error("seedService: insert returned no row");
  return svc;
}

// 30 days out, so it's always in the future regardless of when tests run.
function futureDateStr() {
  return new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
}

function futureLocal(hour: number, minute = 0) {
  return new Date(localDayBounds(futureDateStr()).start.getTime() + (hour * 60 + minute) * 60_000);
}

const alice = { customerName: "Alice", customerPhone: "03001234567" };
const bob = { customerName: "Bob", customerPhone: "03007654321" };

describe("bookings router", () => {
  it("services returns the seeded services in name order", async () => {
    // Inserted out of alphabetical order on purpose.
    await seedService("Zeta Service");
    await seedService("Alpha Service");

    const result = await callerAs(false).bookings.services();

    expect(result.map((s) => s.name)).toEqual(["Alpha Service", "Zeta Service"]);
  });

  it("availableSlots returns slots on an empty day and excludes a time once it's booked", async () => {
    const svc = await seedService("Consult");
    const caller = callerAs(false);
    const date = futureDateStr();

    const before = await caller.bookings.availableSlots({ serviceId: svc.id, date });
    expect(before.length).toBeGreaterThan(0);

    const target = before[0];
    if (!target) throw new Error("expected at least one available slot");

    await caller.bookings.book({ serviceId: svc.id, startsAt: target, ...alice });

    const after = await caller.bookings.availableSlots({ serviceId: svc.id, date });
    expect(after.some((slot) => slot.getTime() === target.getTime())).toBe(false);
  });

  it("book confirms immediately with a null checkoutUrl for a no-deposit service", async () => {
    const svc = await seedService("No Deposit", 60, 0);

    const result = await callerAs(false).bookings.book({
      serviceId: svc.id,
      startsAt: futureLocal(10),
      ...alice,
    });

    expect(result.checkoutUrl).toBeNull();
    expect(result.status).toBe("confirmed");
  });

  it("booking the same slot twice surfaces a CONFLICT tRPC error", async () => {
    const svc = await seedService("Overlap", 60, 0);
    const caller = callerAs(false);
    const startsAt = futureLocal(11);

    await caller.bookings.book({ serviceId: svc.id, startsAt, ...alice });

    await expect(
      caller.bookings.book({ serviceId: svc.id, startsAt, ...bob }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("a 3am booking surfaces BAD_REQUEST", async () => {
    const svc = await seedService("Night Owl", 60, 0);

    await expect(
      callerAs(false).bookings.book({ serviceId: svc.id, startsAt: futureLocal(3), ...alice }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("upcoming throws UNAUTHORIZED for a non-admin context and returns rows for an admin context", async () => {
    const svc = await seedService("Admin View", 60, 0);
    await callerAs(false).bookings.book({ serviceId: svc.id, startsAt: futureLocal(14), ...alice });

    await expect(callerAs(false).bookings.upcoming()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });

    const rows = await callerAs(true).bookings.upcoming();
    expect(rows.some((r) => r.customerName === "Alice")).toBe(true);
  });

  it("cancel is staff-only: UNAUTHORIZED for the public, and cancels for an admin", async () => {
    const svc = await seedService("Staff Cancel", 60, 0);
    const booked = await callerAs(false).bookings.book({
      serviceId: svc.id,
      startsAt: futureLocal(11),
      ...alice,
    });
    const input = { appointmentId: booked.appointmentId, customerPhone: alice.customerPhone };

    await expect(callerAs(false).bookings.cancel(input)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    const [stillBooked] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, booked.appointmentId));
    expect(stillBooked?.status).toBe("confirmed");

    await callerAs(true).bookings.cancel(input);
    const [cancelled] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, booked.appointmentId));
    expect(cancelled?.status).toBe("cancelled");
  });

  it("status is public and returns only status, service and time", async () => {
    const svc = await seedService("Status Check", 60, 0);
    const startsAt = futureLocal(12);
    const booked = await callerAs(false).bookings.book({ serviceId: svc.id, startsAt, ...alice });

    const result = await callerAs(false).bookings.status({ appointmentId: booked.appointmentId });

    expect(result).toEqual({ status: "confirmed", startsAt, serviceName: "Status Check" });
  });

  it("rejects a 3-character phone number before the service runs, creating no appointment", async () => {
    const svc = await seedService("Bad Phone", 60, 0);

    await expect(
      callerAs(false).bookings.book({
        serviceId: svc.id,
        startsAt: futureLocal(15),
        customerName: "Alice",
        customerPhone: "abc",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const rows = await db.select().from(appointments).where(eq(appointments.serviceId, svc.id));
    expect(rows).toHaveLength(0);
  });
});

// Regression test for a real information-disclosure bug found in security review.
//
// tRPC builds an error message as `opts.message ?? cause?.message ?? opts.code`,
// and serialises it to the client unconditionally (only `stack` is dev-gated).
// So before mapDomainErrors sanitised 500s, a plain `throw new Error(...)` inside
// a service -- e.g. "Insert returned no row", a Stripe SDK error, or a driver's
// `connect ECONNREFUSED <host>:<port>` -- was sent verbatim to the browser.
//
// A tiny throwaway router is used rather than forcing a real service to fail,
// because the behaviour under test belongs to the middleware, not to any one
// procedure.
describe("error sanitisation", () => {
  const leakyRouter = createTRPCRouter({
    boom: publicProcedure.query(() => {
      throw new Error("Insert returned no row: secret internal detail");
    }),
    domain: publicProcedure.query(() => {
      throw new DomainError("CONFLICT", "That time was just taken.");
    }),
  });
  const leakyCaller = createCallerFactory(leakyRouter)({ db, stripe, isAdmin: false });

  it("never sends an unexpected error's own message to the caller", async () => {
    const error = await leakyCaller.boom().then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(TRPCError);
    if (!(error instanceof TRPCError)) throw new Error("expected a TRPCError");
    expect(error.code).toBe("INTERNAL_SERVER_ERROR");
    expect(error.message).not.toMatch(/secret internal detail/);
    expect(error.message).toBe("Something went wrong on our side. Please try again.");
    // The real error is still attached for server-side logging (-> Sentry).
    expect(String(error.cause)).toMatch(/secret internal detail/);
  });

  it("still passes an expected DomainError's message through to the caller", async () => {
    const error = await leakyCaller.domain().then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(TRPCError);
    if (!(error instanceof TRPCError)) throw new Error("expected a TRPCError");
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toBe("That time was just taken.");
  });
});
