// These tests hit the REAL webhook route with a REAL Stripe-signed request (never mock
// Drizzle, never mock `constructEvent`). Signing with `stripe.webhooks.generateTestHeaderString`
// is the whole point: a mocked verifier would happily accept a bad payload, and only a real
// signature check catches a route that (say) parses JSON before verifying.
import { eq } from "drizzle-orm";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/webhooks/stripe/route";
import { env } from "@/env";
import { db } from "@/server/db";
import { appointments, services, webhookEvents } from "@/server/db/schema";

const stripe = new Stripe(env.STRIPE_SECRET_KEY);

function signedRequest(payload: string, secret = env.STRIPE_WEBHOOK_SECRET) {
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return new Request("http://localhost/api/webhooks/stripe", {
    method: "POST",
    body: payload,
    headers: { "stripe-signature": header },
  });
}

async function pendingAppointment() {
  const [svc] = await db
    .insert(services)
    .values({ name: "Facial", durationMinutes: 60, priceCents: 12000, depositCents: 2000 })
    .returning();
  if (!svc) throw new Error("seed insert did not return a row");
  const startsAt = new Date(Date.now() + 7 * 86_400_000);
  const [appt] = await db
    .insert(appointments)
    .values({
      serviceId: svc.id,
      customerName: "Sara",
      customerPhone: "03001112223",
      startsAt,
      endsAt: new Date(startsAt.getTime() + 3_600_000),
      source: "web",
      status: "pending_payment",
    })
    .returning();
  if (!appt) throw new Error("seed insert did not return a row");
  return appt;
}

function completedEvent(eventId: string, appointmentId: string, sessionId = "cs_test_1") {
  return JSON.stringify({
    id: eventId,
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: sessionId,
        object: "checkout.session",
        payment_status: "paid",
        metadata: { appointmentId },
      },
    },
  });
}

function expiredEvent(eventId: string, appointmentId: string, sessionId = "cs_test_1") {
  return JSON.stringify({
    id: eventId,
    object: "event",
    type: "checkout.session.expired",
    data: {
      object: { id: sessionId, object: "checkout.session", metadata: { appointmentId } },
    },
  });
}

function ignoredEvent(eventId: string) {
  return JSON.stringify({
    id: eventId,
    object: "event",
    type: "payment_intent.created",
    data: { object: { id: "pi_test_1", object: "payment_intent" } },
  });
}

async function appointmentStatus(id: string) {
  const row = await db.query.appointments.findFirst({ where: eq(appointments.id, id) });
  return row?.status;
}

describe("POST /api/webhooks/stripe", () => {
  it("confirms the appointment once, even when delivered twice", async () => {
    const appt = await pendingAppointment();
    const payload = completedEvent("evt_test_dup_1", appt.id);
    const first = await POST(signedRequest(payload));
    const second = await POST(signedRequest(payload));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.text()).toMatch(/Duplicate/);
    expect(await appointmentStatus(appt.id)).toBe("confirmed");

    const events = await db.select().from(webhookEvents);
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("processed");
  });

  it("rejects a request signed with the wrong secret and changes nothing", async () => {
    const appt = await pendingAppointment();
    const res = await POST(signedRequest(completedEvent("evt_test_wrong_secret", appt.id), "whsec_wrong"));

    expect(res.status).toBe(400);
    expect(await appointmentStatus(appt.id)).toBe("pending_payment");
    expect(await db.select().from(webhookEvents)).toHaveLength(0);
  });

  it("rejects a request with no stripe-signature header", async () => {
    const appt = await pendingAppointment();
    const req = new Request("http://localhost/api/webhooks/stripe", {
      method: "POST",
      body: completedEvent("evt_test_no_header", appt.id),
    });

    const res = await POST(req);

    expect(res.status).toBe(400);
    expect(await appointmentStatus(appt.id)).toBe("pending_payment");
  });

  it("acknowledges an event type it doesn't handle without touching any appointment", async () => {
    const appt = await pendingAppointment();
    const res = await POST(signedRequest(ignoredEvent("evt_test_ignored")));

    expect(res.status).toBe(200);
    expect(await appointmentStatus(appt.id)).toBe("pending_payment"); // untouched

    const events = await db.select().from(webhookEvents);
    expect(events).toHaveLength(1);
    expect(events[0]?.status).toBe("processed");
  });

  it("cancels a pending appointment when its checkout session expires", async () => {
    const appt = await pendingAppointment();
    const res = await POST(signedRequest(expiredEvent("evt_test_expired_1", appt.id)));

    expect(res.status).toBe(200);
    expect(await appointmentStatus(appt.id)).toBe("cancelled");
  });

  it("does not cancel an appointment whose payment already confirmed before the expired event arrives", async () => {
    const appt = await pendingAppointment();

    // Deliver `completed` first (confirms it) ...
    const confirmRes = await POST(signedRequest(completedEvent("evt_test_order_completed", appt.id)));
    expect(confirmRes.status).toBe(200);
    expect(await appointmentStatus(appt.id)).toBe("confirmed");

    // ... then deliver `expired` for the same session, arriving late. Out-of-order delivery
    // must not undo the confirmation: releaseUnpaidHold only cancels a `pending_payment` row.
    const expireRes = await POST(signedRequest(expiredEvent("evt_test_order_expired", appt.id)));
    expect(expireRes.status).toBe(200);
    expect(await appointmentStatus(appt.id)).toBe("confirmed");
  });
});
