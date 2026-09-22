// Connects a REAL MCP client to a REAL server (created by createClinicServer)
// over an in-memory transport, and drives it exactly the way an AI host
// would: list tools, call them, read the errors back as text. No mocking of
// the SDK, Drizzle or the service layer -- same philosophy as tests/bookings.test.ts.
//
// Every booking here uses a zero-deposit service, so bookWithDeposit never
// calls Stripe.

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { db } from "@/server/db";
import { appointments, services } from "@/server/db/schema";
import { localDayBounds } from "@/server/services/slots";
import { stripe } from "@/server/stripe";
import { createClinicServer } from "../mcp/create-server";

// ---- test helpers -----------------------------------------------------

async function seedService(depositCents = 0, durationMinutes = 60) {
  const [svc] = await db
    .insert(services)
    .values({ name: "MCP Test Service", durationMinutes, priceCents: 1000, depositCents })
    .returning();
  if (!svc) throw new Error("seedService: insert returned no row");
  return svc;
}

// A date far enough in the future that "today" vs. "clinic local day" never
// matters, mirroring tests/bookings.test.ts's futureLocal().
function futureDateString(daysAhead = 14): string {
  const iso = new Date(Date.now() + daysAhead * 86_400_000).toISOString();
  const [date] = iso.split("T");
  if (!date) throw new Error(`Could not derive a date from ${iso}`);
  return date;
}

// 3am clinic-local time on a future day: never a bookable slot (opens 9am).
function future3amIso(daysAhead = 14): string {
  const { start } = localDayBounds(futureDateString(daysAhead));
  return new Date(start.getTime() + 3 * 60 * 60_000).toISOString();
}

/** Connects a client to a fresh server in `mode`, runs `fn`, then closes the client. */
async function withClient<T>(
  mode: "customer" | "staff",
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const server = createClinicServer({ db, stripe, mode });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** Calls a tool and unwraps its single text content block. */
async function callTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  // callTool()'s return type is a union with a legacy `{ toolResult }` shape
  // (used only when a client requests CompatibilityCallToolResultSchema,
  // which we never do). Narrow it away by its one distinguishing property
  // instead of checking for "content", which the legacy shape's index
  // signature would satisfy too.
  if ("toolResult" in result) {
    throw new Error(`Tool ${name} returned the legacy toolResult shape, not content`);
  }
  const [first] = result.content;
  if (!first || first.type !== "text") throw new Error(`Tool ${name} returned no text content`);
  return { text: first.text, isError: result.isError === true };
}

// Shapes we expect back from the tools -- parsing with Zod instead of a bare
// JSON.parse() keeps this test file free of `any`, same rule as production code.
const ServiceRow = z.object({
  id: z.uuid(),
  name: z.string(),
  durationMinutes: z.number(),
  priceCents: z.number(),
  depositCents: z.number(),
});
const Slot = z.object({ startsAt: z.string(), label: z.string() });
const BookResult = z.object({
  appointmentId: z.uuid(),
  status: z.string(),
  startsAt: z.string(),
  checkoutUrl: z.union([z.string(), z.null()]),
});

async function bookFirstAvailableSlot(client: Client, serviceId: string, phone: string) {
  const slotsResult = await callTool(client, "find_available_slots", {
    serviceId,
    date: futureDateString(),
  });
  const [slot] = z.array(Slot).parse(JSON.parse(slotsResult.text));
  if (!slot) throw new Error("Expected at least one free slot");

  const bookResult = await callTool(client, "book_appointment", {
    serviceId,
    startsAt: slot.startsAt,
    customerName: "Alice Test",
    customerPhone: phone,
  });
  return { slot, bookResult };
}

// ---- tests -----------------------------------------------------------

describe("createClinicServer: capability set by mode", () => {
  it("customer mode exposes the four customer tools and not list_upcoming_appointments", async () => {
    await withClient("customer", async (client) => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(
        ["book_appointment", "cancel_appointment", "find_available_slots", "list_services"].sort(),
      );
      expect(names).not.toContain("list_upcoming_appointments");
    });
  });

  it("staff mode also exposes list_upcoming_appointments", async () => {
    await withClient("staff", async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("list_upcoming_appointments");
    });
  });
});

describe("book_appointment", () => {
  it("returns isError with BAD_REQUEST for a 3am booking instead of throwing a protocol error", async () => {
    const svc = await seedService();
    await withClient("customer", async (client) => {
      const { isError, text } = await callTool(client, "book_appointment", {
        serviceId: svc.id,
        startsAt: future3amIso(),
        customerName: "Alice Test",
        customerPhone: "03001234567",
      });
      expect(isError).toBe(true);
      expect(text).toMatch(/BAD_REQUEST/);
    });
  });

  it("books through the real tools end-to-end and records source: ai_agent in the database", async () => {
    await seedService();
    await withClient("customer", async (client) => {
      const listed = z
        .array(ServiceRow)
        .parse(JSON.parse((await callTool(client, "list_services")).text));
      const [service] = listed;
      if (!service) throw new Error("Expected at least one service");

      const { bookResult } = await bookFirstAvailableSlot(client, service.id, "03001234567");
      expect(bookResult.isError).toBe(false);

      const booked = BookResult.parse(JSON.parse(bookResult.text));
      expect(booked.status).toBe("confirmed"); // zero deposit -> confirmed immediately
      expect(booked.checkoutUrl).toBeNull();

      const [row] = await db
        .select()
        .from(appointments)
        .where(eq(appointments.id, booked.appointmentId));
      expect(row?.source).toBe("ai_agent");
      expect(row?.status).toBe("confirmed");
    });
  });

  it("returns isError with CONFLICT when the same returned slot is booked twice", async () => {
    const svc = await seedService();
    await withClient("customer", async (client) => {
      const { slot, bookResult: first } = await bookFirstAvailableSlot(client, svc.id, "03001234567");
      expect(first.isError).toBe(false);

      const second = await callTool(client, "book_appointment", {
        serviceId: svc.id,
        startsAt: slot.startsAt,
        customerName: "Bob Test",
        customerPhone: "03007654321",
      });
      expect(second.isError).toBe(true);
      expect(second.text).toMatch(/CONFLICT/);
    });
  });
});

describe("cancel_appointment", () => {
  it("returns isError with NOT_FOUND when the phone number does not match", async () => {
    const svc = await seedService();
    await withClient("customer", async (client) => {
      const { bookResult } = await bookFirstAvailableSlot(client, svc.id, "03001234567");
      const booked = BookResult.parse(JSON.parse(bookResult.text));

      const cancel = await callTool(client, "cancel_appointment", {
        appointmentId: booked.appointmentId,
        customerPhone: "03009999999", // wrong phone -- authorization check, not just an id
      });
      expect(cancel.isError).toBe(true);
      expect(cancel.text).toMatch(/NOT_FOUND/);
    });
  });
});

describe("clinicdesk://appointments/upcoming resource", () => {
  it("can be read and returns the booked appointment as JSON", async () => {
    const svc = await seedService();
    await withClient("customer", async (client) => {
      const { bookResult } = await bookFirstAvailableSlot(client, svc.id, "03001234567");
      const booked = BookResult.parse(JSON.parse(bookResult.text));

      const resource = await client.readResource({ uri: "clinicdesk://appointments/upcoming" });
      const [content] = resource.contents;
      if (!content || !("text" in content)) throw new Error("Expected text resource content");

      const rows = z.array(z.object({ id: z.uuid() })).parse(JSON.parse(content.text));
      expect(rows.some((r) => r.id === booked.appointmentId)).toBe(true);
    });
  });
});
