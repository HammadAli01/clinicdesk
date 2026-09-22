// The actual booking endpoints. Every procedure is: validate input -> call
// ONE service -> map errors (the mapping happens once, in init.ts). No
// business logic lives here -- see src/server/services/bookings.ts for that.

import { z } from "zod";
import {
  BookInput,
  CancelInput,
  cancelAppointment,
  findAvailableSlots,
  listServices,
  listUpcoming,
} from "@/server/services/bookings";
import { bookWithDeposit } from "@/server/services/checkout";
import { adminProcedure, createTRPCRouter, publicProcedure } from "../init";

export const bookingsRouter = createTRPCRouter({
  services: publicProcedure.query(({ ctx }) => listServices(ctx.db)),

  availableSlots: publicProcedure
    .input(z.object({ serviceId: z.uuid(), date: z.iso.date() }))
    .query(({ ctx, input }) => findAvailableSlots(ctx.db, input)),

  // The client can't choose `source` -- the server sets it. This is why the
  // input schema OMITS the field instead of just trusting the client to send
  // "web": an AI agent or malicious client could otherwise claim to be staff.
  book: publicProcedure
    .input(BookInput.omit({ source: true }))
    .mutation(({ ctx, input }) => bookWithDeposit(ctx, { ...input, source: "web" })),

  // Public on purpose: the phone number in the input IS the authorization
  // check (see cancelAppointment), not a session or a cookie.
  cancel: publicProcedure
    .input(CancelInput)
    .mutation(({ ctx, input }) => cancelAppointment(ctx.db, input)),

  upcoming: adminProcedure.query(({ ctx }) => listUpcoming(ctx.db)),
});
