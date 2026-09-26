import { describe, expect, it } from "vitest";
import { db } from "@/server/db";
import { appointments, services } from "@/server/db/schema";
import { eq } from "drizzle-orm";
import {
  bookAppointment,
  cancelAppointment,
  confirmPayment,
  getBookingStatus,
} from "@/server/services/bookings";
import { localDayBounds } from "@/server/services/slots";

async function seedService(durationMinutes = 60, depositCents = 0) {
  const [svc] = await db
    .insert(services)
    .values({ name: "Test", durationMinutes, priceCents: 1000, depositCents })
    .returning();
  if (!svc) throw new Error("seedService: insert returned no row");
  return svc;
}

// 10:00 local, 30 days from now (always in the future, always a bookable slot)
function futureLocal(hour: number, minute = 0) {
  const d = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  return new Date(localDayBounds(d).start.getTime() + (hour * 60 + minute) * 60_000);
}

const alice = { customerName: "Alice", customerPhone: "03001234567", source: "web" as const };
const bob = { customerName: "Bob", customerPhone: "03007654321", source: "web" as const };

describe("bookAppointment", () => {
  it("confirms immediately when the service has no deposit", async () => {
    const svc = await seedService(60);
    const { appointment } = await bookAppointment(db, {
      serviceId: svc.id,
      startsAt: futureLocal(10),
      ...alice,
    });
    expect(appointment.status).toBe("confirmed");
    expect(appointment.endsAt.getTime() - appointment.startsAt.getTime()).toBe(60 * 60_000);
  });

  it("rejects an overlapping booking with CONFLICT", async () => {
    const svc = await seedService(60);
    await bookAppointment(db, { serviceId: svc.id, startsAt: futureLocal(10), ...alice });
    await expect(
      bookAppointment(db, { serviceId: svc.id, startsAt: futureLocal(10, 30), ...bob }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("lets exactly one of two simultaneous bookings win", async () => {
    const svc = await seedService();
    const results = await Promise.allSettled([
      bookAppointment(db, { serviceId: svc.id, startsAt: futureLocal(11), ...alice }),
      bookAppointment(db, { serviceId: svc.id, startsAt: futureLocal(11), ...bob }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("refuses times outside opening hours (e.g. an AI inventing 3am)", async () => {
    const svc = await seedService();
    await expect(
      bookAppointment(db, { serviceId: svc.id, startsAt: futureLocal(3), ...alice }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("frees the slot after cancellation, and needs the right phone to cancel", async () => {
    const svc = await seedService();
    const { appointment } = await bookAppointment(db, {
      serviceId: svc.id,
      startsAt: futureLocal(12),
      ...alice,
    });

    await expect(
      cancelAppointment(db, { appointmentId: appointment.id, customerPhone: bob.customerPhone }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await cancelAppointment(db, {
      appointmentId: appointment.id,
      customerPhone: alice.customerPhone,
    });

    const again = await bookAppointment(db, {
      serviceId: svc.id,
      startsAt: futureLocal(12),
      ...bob,
    });
    expect(again.appointment.customerName).toBe("Bob");
  });

  it("leaves the appointment pending_payment when the service has a deposit", async () => {
    const svc = await seedService(60, 2000);
    const { appointment } = await bookAppointment(db, {
      serviceId: svc.id,
      startsAt: futureLocal(13),
      ...alice,
    });
    expect(appointment.status).toBe("pending_payment");
  });
});

describe("confirmPayment", () => {
  it("is idempotent: the first call confirms, the second is a no-op", async () => {
    const svc = await seedService(60, 2000);
    const { appointment } = await bookAppointment(db, {
      serviceId: svc.id,
      startsAt: futureLocal(14),
      ...alice,
    });

    const first = await confirmPayment(db, appointment.id);
    const second = await confirmPayment(db, appointment.id);
    expect(first).toBe(true);
    expect(second).toBe(false);

    const [row] = await db.select().from(appointments).where(eq(appointments.id, appointment.id));
    expect(row?.status).toBe("confirmed");
  });
});

describe("getBookingStatus", () => {
  it("reports pending_payment, then confirmed after the payment lands, with no customer details", async () => {
    const svc = await seedService(60, 2000);
    const startsAt = futureLocal(15);
    const { appointment } = await bookAppointment(db, { serviceId: svc.id, startsAt, ...alice });

    const before = await getBookingStatus(db, appointment.id);
    expect(before).toEqual({ status: "pending_payment", startsAt, serviceName: "Test" });

    await confirmPayment(db, appointment.id);
    const after = await getBookingStatus(db, appointment.id);
    expect(after.status).toBe("confirmed");
    // Public endpoint: exactly these three fields, never the name or phone.
    expect(Object.keys(after).sort()).toEqual(["serviceName", "startsAt", "status"]);
  });

  it("throws NOT_FOUND for an unknown id", async () => {
    await expect(
      getBookingStatus(db, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
