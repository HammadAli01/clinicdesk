// The MCP server factory. Built as a function that takes its dependencies
// (db, stripe, mode) instead of importing them, so tests can create a server
// wired to the test database and connect a real MCP client to it in memory --
// no mocking, same pattern as the service layer.
//
// This file, mcp/server.ts (the stdio entry point) and the tRPC routers are
// all thin adapters: parse input -> call ONE service -> map errors. The
// business rules themselves live only in src/server/services/*.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Stripe from "stripe";
import { z } from "zod";
import type { Db } from "@/server/db";
import { DomainError } from "@/server/errors";
import {
  cancelAppointment,
  findAvailableSlots,
  listServices,
  listUpcoming,
} from "@/server/services/bookings";
import { bookWithDeposit } from "@/server/services/checkout";
import { formatLocal } from "@/server/services/slots";

type Deps = { db: Db; stripe: Stripe; mode: "customer" | "staff" };

// ---- helpers: every tool returns text; errors come back as isError results,
// never as a thrown protocol error (see `run` below) --------------------------

const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const fail = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof DomainError) return fail(`${e.code}: ${e.message}`);
    // Unexpected error: this is a bug, not a caller mistake. Log it with
    // context on STDERR -- NEVER stdout, which carries the JSON-RPC protocol
    // for the stdio transport (see mcp/server.ts) -- and give the model a
    // safe, generic message instead of leaking internals (stack traces,
    // SQL, etc.) into the conversation.
    console.error("[clinicdesk-mcp] unexpected error", e);
    return fail(
      "INTERNAL: Something went wrong on our side. Tell the caller a staff member will call them back.",
    );
  }
}

// Shared field schemas, reused across tools so the model sees one consistent
// shape for "an id" and "a phone number".
const uuid = z.uuid();
const phone = z
  .string()
  .regex(/^\+?[0-9]{10,15}$/)
  .describe("Caller's phone, digits only, e.g. 03001234567");

export function createClinicServer({ db, stripe, mode }: Deps) {
  const server = new McpServer({ name: "clinicdesk", version: "0.1.0" });

  server.registerTool(
    "list_services",
    {
      title: "List services",
      description:
        "List the clinic's bookable services with duration (minutes), price and deposit (in cents, USD). " +
        "Call this first to get a serviceId.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run(() => listServices(db)),
  );

  server.registerTool(
    "find_available_slots",
    {
      title: "Find available slots",
      description:
        "Get free start times for one service on one date (clinic local time, Asia/Karachi). " +
        "Only ever offer the caller times returned by this tool. Never invent a time.",
      inputSchema: {
        serviceId: uuid.describe("id from list_services"),
        date: z.iso.date().describe("YYYY-MM-DD in clinic local time"),
      },
      annotations: { readOnlyHint: true },
    },
    ({ serviceId, date }) =>
      run(async () => {
        const slots = await findAvailableSlots(db, { serviceId, date });
        // Give the model both: an exact value to pass back to book_appointment,
        // and a human label to read aloud to the caller.
        return slots.map((s) => ({ startsAt: s.toISOString(), label: formatLocal(s) }));
      }),
  );

  server.registerTool(
    "book_appointment",
    {
      title: "Book appointment",
      description:
        "Book an appointment. Before calling, read back the service, time, name and phone to the caller " +
        "and get a clear yes. If the result has a checkoutUrl, a deposit is required: the slot is held " +
        "for about 30 minutes and is released if unpaid. Share the link with the caller.",
      inputSchema: {
        serviceId: uuid.describe("id from list_services"),
        startsAt: z.iso
          .datetime()
          .describe("Exactly one of the startsAt values returned by find_available_slots"),
        customerName: z.string().min(2).max(100),
        customerPhone: phone,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (args) =>
      run(() =>
        bookWithDeposit(
          { db, stripe },
          { ...args, startsAt: new Date(args.startsAt), source: "ai_agent" },
        ),
      ),
  );

  server.registerTool(
    "cancel_appointment",
    {
      title: "Cancel appointment",
      description:
        "Cancel an appointment. Requires the appointment id AND the phone number it was booked with. " +
        "Confirm with the caller before cancelling.",
      inputSchema: { appointmentId: uuid, customerPhone: phone },
      annotations: { destructiveHint: true },
    },
    (args) => run(() => cancelAppointment(db, args)),
  );

  // A resource: read-only context an app can attach (e.g. staff asking "what's my day like?").
  server.registerResource(
    "upcoming-appointments",
    "clinicdesk://appointments/upcoming",
    {
      title: "Upcoming appointments",
      description: "The next 100 non-cancelled appointments",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await listUpcoming(db), null, 2),
        },
      ],
    }),
  );

  // A prompt: a reusable script the user can pick in the host's UI.
  server.registerPrompt(
    "receptionist",
    {
      title: "Act as the clinic receptionist",
      description: "Sets the model up to book appointments politely and safely",
      argsSchema: { clinicName: z.string() },
    },
    ({ clinicName }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `You are the receptionist for ${clinicName}. Be brief and warm. ` +
              "Use list_services, then find_available_slots, and offer at most three times. " +
              "Always confirm details before book_appointment. Never promise a time the tools did not return. " +
              "If a tool returns an error, explain it simply and offer an alternative.",
          },
        },
      ],
    }),
  );

  // Staff-only tool: only registered when the server is started in staff mode.
  // Least privilege -- the customer-facing server can't list other people's
  // bookings, so this tool must not exist at all in customer mode (not just
  // be hidden behind a permission check).
  if (mode === "staff") {
    server.registerTool(
      "list_upcoming_appointments",
      {
        title: "List upcoming appointments (staff)",
        description: "All upcoming appointments with customer details. Staff use only.",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
      () => run(() => listUpcoming(db)),
    );
  }

  return server;
}
