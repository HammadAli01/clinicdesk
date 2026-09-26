// Business rules for booking, cancelling, and paying for appointments.
// Adapters (tRPC, MCP, webhooks) call these functions and only translate
// their return values / DomainErrors into their own protocol.
//
// Pattern: SERVICE LAYER + DEPENDENCY INJECTION. Every function takes `db` as
// its first argument instead of importing it, so tests can pass the test DB.

import { and, asc, eq, gt, gte, lt, ne } from "drizzle-orm"; // named imports: query-condition helpers
import { z } from "zod";
// `import type` = used only as a type; erased at compile time, adds no runtime code.
import type { Db } from "@/server/db";
import { appointments, services } from "@/server/db/schema";
import { DomainError, pgErrorCode } from "@/server/errors";
import { computeFreeSlots, localDateString, localDayBounds } from "./slots";

// ---- Input schemas live next to the functions that use them ----

// Validation at the boundary: adapters call BookInput.parse(...) (tRPC does it
// via .input()), so this service only ever receives already-checked data.
export const BookInput = z.object({
  serviceId: z.uuid(),
  startsAt: z.coerce.date(), // "coerce": accepts an ISO string and turns it into a Date
  // "trim().min(2)" = method chaining; each call returns a new, stricter schema.
  customerName: z.string().trim().min(2).max(100),
  customerPhone: z.string().regex(/^\+?[0-9]{10,15}$/, "Phone must be 10-15 digits"),
  source: z.enum(["web", "ai_agent", "staff"]), // becomes the union type "web" | "ai_agent" | "staff"
});
// Same name for the value (the schema) and the type: TypeScript keeps values and
// types in separate namespaces. z.infer derives the type FROM the schema, so the
// two can never drift apart. Single source of truth.
export type BookInput = z.infer<typeof BookInput>;

export const CancelInput = z.object({
  appointmentId: z.uuid(),
  customerPhone: z.string().regex(/^\+?[0-9]{10,15}$/, "Phone must be 10-15 digits"),
});
export type CancelInput = z.infer<typeof CancelInput>;

// ---- Reads ----

/**
 * All services, alphabetically. Not `async`: it returns the Drizzle query
 * itself, which is "thenable", so callers can still `await` it.
 * The return type is inferred from the `.select({...})` shape.
 */
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

// Not exported = private to this module (module scope is JS's "private").
async function getService(db: Db, id: string) {
  // findFirst returns `Service | undefined`.
  const service = await db.query.services.findFirst({ where: eq(services.id, id) });
  // Narrowing: after this throw, TypeScript knows `service` is defined below.
  // DomainError = an EXPECTED failure; each adapter maps it (tRPC -> 404, MCP -> text).
  if (!service) throw new DomainError("NOT_FOUND", "That service does not exist");
  return service;
}

// Appointments that overlap [from, to). Overlap test: starts before `to` AND ends after `from`.
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

/**
 * Free start times for one service on one clinic-local date ("YYYY-MM-DD").
 * Reads from the DB, then hands the pure maths to computeFreeSlots (slots.ts).
 * `input: { serviceId: string; date: string }` is an inline object type.
 */
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

/** Staff view: next 100 non-cancelled appointments, each joined to its service name. */
export function listUpcoming(db: Db) {
  // Relational query API: `with` does the join using the relations in schema.ts.
  return db.query.appointments.findMany({
    where: and(gte(appointments.startsAt, new Date()), ne(appointments.status, "cancelled")),
    orderBy: [asc(appointments.startsAt)],
    with: { service: { columns: { name: true } } },
    limit: 100,
  });
}

/**
 * Public status of one booking, for the "payment received" message after Stripe
 * redirects back to /book?paid=<id>. Deliberately returns NO customer name or
 * phone: anyone holding the link (an unguessable UUID) sees only what they booked.
 * Throws NOT_FOUND for an unknown id.
 */
export async function getBookingStatus(db: Db, appointmentId: string) {
  const [row] = await db
    .select({
      status: appointments.status,
      startsAt: appointments.startsAt,
      serviceName: services.name,
    })
    .from(appointments)
    .innerJoin(services, eq(appointments.serviceId, services.id))
    .where(eq(appointments.id, appointmentId));

  if (!row) throw new DomainError("NOT_FOUND", "No booking with that id");
  return row;
}

// ---- Writes ----

/**
 * Book one appointment. The core business rule of the app.
 * Returns `{ appointment, service }`; throws DomainError BAD_REQUEST (not a
 * bookable time) or CONFLICT (someone else got the slot first).
 * Status is `pending_payment` if the service needs a deposit, else `confirmed`.
 */
export async function bookAppointment(db: Db, input: BookInput) {
  const service = await getService(db, input.serviceId);
  // 60_000 = ms per minute (the `_` is a digit separator, just for readability).
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
  }).some((s) => s.getTime() === input.startsAt.getTime()); // compare ms, not Date objects (=== on objects compares identity)
  if (!bookable) {
    throw new DomainError(
      "BAD_REQUEST",
      "That is not a bookable time. Ask for available slots first.",
    );
  }

  try {
    // Array destructuring: `.returning()` gives an array of rows; take the first.
    // tsconfig has `noUncheckedIndexedAccess`, so `row` is `Appointment | undefined`: hence the check below.
    const [row] = await db
      .insert(appointments)
      .values({
        serviceId: service.id,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        startsAt: input.startsAt,
        endsAt,
        source: input.source,
        status: service.depositCents > 0 ? "pending_payment" : "confirmed", // ternary: cond ? a : b
      })
      .returning();
    // A plain Error (not DomainError): this "can't happen", so it's a bug, and
    // the adapters hide its message from callers.
    if (!row) throw new Error("Insert returned no row");
    return { appointment: row, service }; // property shorthand: `service` means `service: service`
  } catch (e) {
    // `e` is `unknown` in a catch block: we must inspect it before using it (see pgErrorCode).
    // 23P01 = exclusion constraint violation from drizzle/0001: two
    // non-cancelled appointments overlap. This is the race-safe guard --
    // Postgres, not a check-then-insert in this function, decides who wins.
    if (pgErrorCode(e) === "23P01") {
      throw new DomainError("CONFLICT", "That time was just taken. Please pick another slot.");
    }
    throw e; // anything else is unexpected: rethrow it untouched
  }
}

/**
 * Customer-initiated cancel: must know the phone number that booked it.
 * Pattern: CONDITIONAL UPDATE. The WHERE clause does the auth check, the
 * "exists?" check and the "not already cancelled" check in ONE atomic
 * statement, so there's no read-then-write race.
 */
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

/**
 * Called by the Stripe webhook. Idempotent: a second call changes nothing.
 * `WHERE status = 'pending_payment'` is what makes it idempotent: once the row
 * is confirmed, the same UPDATE matches zero rows. Returns true if it changed a row.
 */
export async function confirmPayment(db: Db, appointmentId: string) {
  const rows = await db
    .update(appointments)
    .set({ status: "confirmed" })
    .where(and(eq(appointments.id, appointmentId), eq(appointments.status, "pending_payment")))
    .returning({ id: appointments.id });
  return rows.length > 0; // false = already confirmed/cancelled -- fine
}

/**
 * Release a slot whose deposit was never paid. Also idempotent.
 * If the payment already confirmed the row, the WHERE matches nothing, so a
 * late "expired" webhook can never cancel a paid booking.
 */
export async function releaseUnpaidHold(db: Db, appointmentId: string) {
  await db
    .update(appointments)
    .set({ status: "cancelled" })
    .where(and(eq(appointments.id, appointmentId), eq(appointments.status, "pending_payment")));
}
