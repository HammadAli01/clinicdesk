// Business rules for booking, cancelling, and paying for appointments.
// Adapters (tRPC, MCP, webhooks) call these functions and only translate
// their return values / DomainErrors into their own protocol.

import { and, asc, eq, gt, gte, lt, ne } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/server/db";
import { appointments, services } from "@/server/db/schema";
import { DomainError, pgErrorCode } from "@/server/errors";
import { computeFreeSlots, localDateString, localDayBounds } from "./slots";

// ---- Input schemas live next to the functions that use them ----

export const BookInput = z.object({
  serviceId: z.uuid(),
  startsAt: z.coerce.date(),
  customerName: z.string().trim().min(2).max(100),
  customerPhone: z.string().regex(/^\+?[0-9]{10,15}$/, "Phone must be 10-15 digits"),
  source: z.enum(["web", "ai_agent", "staff"]),
});
export type BookInput = z.infer<typeof BookInput>;

export const CancelInput = z.object({
  appointmentId: z.uuid(),
  customerPhone: z.string().regex(/^\+?[0-9]{10,15}$/, "Phone must be 10-15 digits"),
});
export type CancelInput = z.infer<typeof CancelInput>;

// ---- Reads ----

export function listServices(db: Db) {
  return db
    .select({
      id: services.id,
      name: services.name,
      durationMinutes: services.durationMinutes,
      priceCents: services.priceCents,
      depositCents: services.depositCents,
    })
    .from(services)
    .orderBy(asc(services.name));
}

async function getService(db: Db, id: string) {
  const service = await db.query.services.findFirst({ where: eq(services.id, id) });
  if (!service) throw new DomainError("NOT_FOUND", "That service does not exist");
  return service;
}

async function busyIntervals(db: Db, from: Date, to: Date) {
  return db
    .select({ start: appointments.startsAt, end: appointments.endsAt })
    .from(appointments)
    .where(
      and(
        ne(appointments.status, "cancelled"),
        lt(appointments.startsAt, to),
        gt(appointments.endsAt, from),
      ),
    );
}

export async function findAvailableSlots(db: Db, input: { serviceId: string; date: string }) {
  const service = await getService(db, input.serviceId);
  const day = localDayBounds(input.date);
  const busy = await busyIntervals(db, day.start, day.end);
  return computeFreeSlots({
    date: input.date,
    durationMinutes: service.durationMinutes,
    busy,
    now: new Date(),
  });
}

export function listUpcoming(db: Db) {
  return db.query.appointments.findMany({
    where: and(gte(appointments.startsAt, new Date()), ne(appointments.status, "cancelled")),
    orderBy: [asc(appointments.startsAt)],
    with: { service: { columns: { name: true } } },
    limit: 100,
  });
}

// ---- Writes ----

export async function bookAppointment(db: Db, input: BookInput) {
  const service = await getService(db, input.serviceId);
  const endsAt = new Date(input.startsAt.getTime() + service.durationMinutes * 60_000);

  // The SERVER decides what is bookable -- not the browser, not the AI agent.
  // Checking membership against computeFreeSlots with busy: [] confirms the
  // requested time is on the 30-minute grid, inside opening hours, and not in
  // the past -- without doing a check-then-insert "is it free?" query (that
  // race is handled below by the exclusion constraint, not by app code).
  const bookable = computeFreeSlots({
    date: localDateString(input.startsAt),
    durationMinutes: service.durationMinutes,
    busy: [],
    now: new Date(),
  }).some((s) => s.getTime() === input.startsAt.getTime());
  if (!bookable) {
    throw new DomainError(
      "BAD_REQUEST",
      "That is not a bookable time. Ask for available slots first.",
    );
  }

  try {
    const [row] = await db
      .insert(appointments)
      .values({
        serviceId: service.id,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        startsAt: input.startsAt,
        endsAt,
        source: input.source,
        status: service.depositCents > 0 ? "pending_payment" : "confirmed",
      })
      .returning();
    if (!row) throw new Error("Insert returned no row");
    return { appointment: row, service };
  } catch (e) {
    // 23P01 = exclusion constraint violation from drizzle/0001: two
    // non-cancelled appointments overlap. This is the race-safe guard --
    // Postgres, not a check-then-insert in this function, decides who wins.
    if (pgErrorCode(e) === "23P01") {
      throw new DomainError("CONFLICT", "That time was just taken. Please pick another slot.");
    }
    throw e;
  }
}

/** Customer-initiated cancel: must know the phone number that booked it. */
export async function cancelAppointment(db: Db, input: CancelInput) {
  const [row] = await db
    .update(appointments)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(appointments.id, input.appointmentId),
        eq(appointments.customerPhone, input.customerPhone),
        ne(appointments.status, "cancelled"),
      ),
    )
    .returning({ id: appointments.id, startsAt: appointments.startsAt });

  // Same message whether the id is wrong or the phone is wrong: don't leak
  // which appointment ids exist to a caller probing at random.
  if (!row) {
    throw new DomainError("NOT_FOUND", "No active appointment matches that id and phone number");
  }

  return row;
}

/** Called by the Stripe webhook. Idempotent: a second call changes nothing. */
export async function confirmPayment(db: Db, appointmentId: string) {
  const rows = await db
    .update(appointments)
    .set({ status: "confirmed" })
    .where(and(eq(appointments.id, appointmentId), eq(appointments.status, "pending_payment")))
    .returning({ id: appointments.id });
  return rows.length > 0; // false = already confirmed/cancelled -- fine
}

/** Release a slot whose deposit was never paid. Also idempotent. */
export async function releaseUnpaidHold(db: Db, appointmentId: string) {
  await db
    .update(appointments)
    .set({ status: "cancelled" })
    .where(and(eq(appointments.id, appointmentId), eq(appointments.status, "pending_payment")));
}
