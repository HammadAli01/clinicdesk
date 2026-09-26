// The actual booking endpoints. Every procedure is: validate input -> call
// ONE service -> map errors (the mapping happens once, in init.ts). No
// business logic lives here -- see src/server/services/bookings.ts for that.
//
// Anatomy of one procedure (a chain of method calls on a builder):
//   publicProcedure              <- template: which middlewares run (init.ts)
//     .input(zodSchema)          <- optional: validate + type the input
//     .query(fn) | .mutation(fn) <- the handler; query = read, mutation = write
// The handler receives one object; `({ ctx, input }) => ...` destructures it.
// Its return value is the response, and its TYPE is what the browser sees.
// There's no separate output type to write.

import { z } from "zod";
import {
  BookInput,
  CancelInput,
  cancelAppointment,
  findAvailableSlots,
  getBookingStatus,
  listServices,
  listUpcoming,
} from "@/server/services/bookings";
import { bookWithDeposit } from "@/server/services/checkout";
import { adminProcedure, createTRPCRouter, publicProcedure } from "../init";

// Each key below (services, availableSlots, ...) becomes a procedure name:
// trpc.bookings.<key> in the browser, /api/trpc/bookings.<key> over HTTP.
export const bookingsRouter = createTRPCRouter({
  // Query with no input. `ctx` comes from createTRPCContext in init.ts.
  services: publicProcedure.query(({ ctx }) => listServices(ctx.db)),

  // Query with input. If the input doesn't match the schema, tRPC rejects it
  // with BAD_REQUEST before the handler runs. `input` is typed
  // { serviceId: string; date: string } automatically, inferred from the schema.
  availableSlots: publicProcedure
    .input(z.object({ serviceId: z.uuid(), date: z.iso.date() }))
    .query(({ ctx, input }) => findAvailableSlots(ctx.db, input)),

  // The client can't choose `source` -- the server sets it. This is why the
  // input schema OMITS the field instead of just trusting the client to send
  // "web": an AI agent or malicious client could otherwise claim to be staff.
  // `{ ...input, source: "web" }` copies every field of input, then adds source.
  // bookWithDeposit takes `ctx` whole because it needs both db and stripe.
  book: publicProcedure
    .input(BookInput.omit({ source: true }))
    .mutation(({ ctx, input }) => bookWithDeposit(ctx, { ...input, source: "web" })),

  // Public, read-only: the "payment received" message polls this after Stripe.
  // Returns status + service + time only (no customer details); see getBookingStatus.
  status: publicProcedure
    .input(z.object({ appointmentId: z.uuid() }))
    .query(({ ctx, input }) => getBookingStatus(ctx.db, input.appointmentId)),

  // Staff only: cancelling happens from /admin. (Callers can still cancel via
  // the AI receptionist, whose MCP tool requires the id AND the booking phone.)
  cancel: adminProcedure
    .input(CancelInput)
    .mutation(({ ctx, input }) => cancelAppointment(ctx.db, input)),

  // adminProcedure: the guard in init.ts throws UNAUTHORIZED before this runs
  // unless the caller has the admin cookie.
  upcoming: adminProcedure.query(({ ctx }) => listUpcoming(ctx.db)),
});
