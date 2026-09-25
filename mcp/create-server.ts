// The MCP server factory. Built as a function that takes its dependencies
// (db, stripe, mode) instead of importing them, so tests can create a server
// wired to the test database and connect a real MCP client to it in memory --
// no mocking, same pattern as the service layer.
//
// This file, mcp/server.ts (the stdio entry point) and the tRPC routers are
// all thin adapters: parse input -> call ONE service -> map errors. The
// business rules themselves live only in src/server/services/*.
//
// Read top to bottom:
//   1. helpers `ok` / `fail` / `run`  -- turn service results and errors into
//      MCP tool results.
//   2. shared Zod field schemas       -- `uuid`, `phone`.
//   3. createClinicServer()           -- registers 4 tools, 1 resource,
//      1 prompt, and (staff mode only) a 5th tool.

// McpServer is the SDK's high-level server: you register tools/resources/
// prompts on it, and it answers the JSON-RPC requests (tools/list,
// tools/call, ...) for you, including validating tool input with Zod.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// `import type` = only the TypeScript type, erased at runtime. This file never
// creates a Stripe client itself; it is handed one (dependency injection).
import type Stripe from "stripe";
import { z } from "zod";
import type { Db } from "@/server/db";
import { DomainError } from "@/server/errors";
// The services: the ONLY place business rules live. Each tool below calls
// exactly one of these.
import {
  cancelAppointment,
  findAvailableSlots,
  listServices,
  listUpcoming,
} from "@/server/services/bookings";
import { bookWithDeposit } from "@/server/services/checkout";
import { formatLocal } from "@/server/services/slots";

/**
 * Everything the server needs from the outside world. Passing these in
 * (rather than importing them) is dependency injection: mcp/server.ts passes
 * the real db and Stripe client, tests/mcp.test.ts passes the test db.
 * `mode` decides which tools exist at all (see the staff-only tool below).
 */
type Deps = { db: Db; stripe: Stripe; mode: "customer" | "staff" };

// ---- helpers: every tool returns text; errors come back as isError results,
// never as a thrown protocol error (see `run` below) --------------------------

/**
 * Success result. An MCP tool result is `{ content: [...] }`, a list of
 * content blocks; we always return one text block holding pretty-printed JSON,
 * which the model can read and which tests can JSON.parse.
 * `"text" as const` keeps the type as the literal "text" (not just `string`),
 * which is what the SDK's CallToolResult type requires. `as const` is a
 * literal-type annotation, not a cast, so it is allowed by CLAUDE.md.
 */
const ok = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

/**
 * Failure result. `isError: true` tells the host/model "the tool ran but the
 * action failed" -- the model reads the message and can recover (e.g. offer
 * another time slot) instead of seeing a crash.
 */
const fail = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});

/**
 * Runs one service call and converts the outcome into a tool result.
 *
 * - success        -> ok(result)
 * - DomainError    -> fail("CODE: message"), e.g. "CONFLICT: That time was just taken..."
 *                     (an EXPECTED failure: bad slot, not found, etc.)
 * - anything else  -> a bug: log it to stderr, return a safe generic message.
 *
 * `fn` is a function (not a Promise) so the service call only starts INSIDE
 * the try block, and any error it throws is caught here.
 */
async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (e) {
    // `instanceof` narrows `e` from `unknown` to DomainError, so `e.code` is typed.
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
// The SDK turns these Zod schemas into JSON Schema for `tools/list` (what the
// model sees) AND validates incoming arguments against them before our
// handler runs -- a bad argument never reaches a service.
// `.describe()` text is shown to the model as the field's description.
const uuid = z.uuid();
const phone = z
  .string()
  .regex(/^\+?[0-9]{10,15}$/)
  .describe("Caller's phone, digits only, e.g. 03001234567");

/**
 * Factory function: builds and returns a fully configured McpServer, but does
 * NOT connect it to any transport. The caller decides how it is reached:
 * stdio in mcp/server.ts, an in-memory pair in tests/mcp.test.ts, or (later)
 * Streamable HTTP for a remote deployment.
 *
 * `{ db, stripe, mode }: Deps` destructures the single argument object, so
 * the body can say `db` instead of `deps.db`.
 */
export function createClinicServer({ db, stripe, mode }: Deps) {
  // name/version are sent to the host during the `initialize` handshake.
  const server = new McpServer({ name: "clinicdesk", version: "0.1.0" });

  // registerTool(name, config, handler):
  //   name    -- what the model calls. snake_case verb_noun by convention.
  //   config  -- title (for humans), description (for the MODEL -- it is prompt
  //              text, write it carefully), inputSchema (Zod fields),
  //              annotations (hints to the host, e.g. "this only reads").
  //   handler -- receives the already-validated, typed arguments and returns
  //              a tool result. Ours all delegate to run(() => someService(...)).
  server.registerTool(
    "list_services",
    {
      title: "List services",
      description:
        "List the clinic's bookable services with duration (minutes), price and deposit (in cents, USD). " +
        "Call this first to get a serviceId.",
      // No arguments: an empty shape.
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    // Arrow function with no parameters (there is no input to receive).
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
        // .describe() tells the model WHERE the value comes from, so it chains
        // list_services -> find_available_slots instead of guessing an id.
        serviceId: uuid.describe("id from list_services"),
        date: z.iso.date().describe("YYYY-MM-DD in clinic local time"),
      },
      annotations: { readOnlyHint: true },
    },
    // The handler's argument is typed from inputSchema: serviceId and date are
    // both `string` here, and already validated. We destructure them directly.
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
      // Not read-only (it writes a row), not destructive (it doesn't delete or
      // overwrite anything), not idempotent (calling twice is not a no-op --
      // the second call gets CONFLICT).
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (args) =>
      run(() =>
        bookWithDeposit(
          { db, stripe },
          // Spread the validated args, then override two things: startsAt
          // arrives as an ISO string over JSON but the service wants a Date,
          // and `source` is set HERE, by the adapter -- the model can't claim
          // to be the web form or staff.
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
      // The phone acts as a lightweight authorization check: knowing an id
      // alone is not enough to cancel someone's appointment.
      inputSchema: { appointmentId: uuid, customerPhone: phone },
      // destructiveHint lets the host ask the human to confirm before running it.
      annotations: { destructiveHint: true },
    },
    // args already has exactly the shape cancelAppointment expects.
    (args) => run(() => cancelAppointment(db, args)),
  );

  // A resource: read-only context an app can attach (e.g. staff asking "what's my day like?").
  // registerResource(name, uri, metadata, readCallback). The host chooses when
  // to read it; the model does not "call" it like a tool.
  // Note: this resource is registered in BOTH modes, so a customer-mode host
  // could read it -- see docs/09-mcp.md, "Tool design tips".
  server.registerResource(
    "upcoming-appointments",
    "clinicdesk://appointments/upcoming",
    {
      title: "Upcoming appointments",
      description: "The next 100 non-cancelled appointments",
      mimeType: "application/json",
    },
    // `uri` is a URL object for the requested address; we echo it back.
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
  // registerPrompt(name, config, callback). argsSchema lists what the user
  // fills in (here, the clinic name); the callback returns chat messages.
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

  // Return the configured-but-unconnected server; the caller calls
  // server.connect(transport).
  return server;
}
