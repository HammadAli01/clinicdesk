import { eq } from "drizzle-orm";
import type { Db } from "@/server/db";
import { appointments } from "@/server/db/schema";
import { getGoogleAccessToken, googleFetch } from "@/server/integrations/google";

/**
 * Copy a CONFIRMED appointment into the clinic's Google Calendar. Called by the
 * Stripe webhook handler after confirmPayment. Safe to call twice (idempotent).
 * Returns `{ skipped: ... }` or `{ synced: eventId }`: a union of two object
 * shapes, which callers tell apart with `"synced" in result`.
 */
export async function syncToGoogleCalendar(db: Db, appointmentId: string) {
  // `as const` keeps the literal type "google_not_connected" instead of widening to `string`.
  if (!(await getGoogleAccessToken(db))) return { skipped: "google_not_connected" as const };

  const appt = await db.query.appointments.findFirst({
    where: eq(appointments.id, appointmentId),
    with: { service: true },
  });
  // Guard clause: bail out early. `||` short-circuits, so `appt.status` is only
  // read once `!appt` has ruled out undefined.
  if (!appt || appt.status !== "confirmed" || appt.googleEventId) {
    return { skipped: "not_needed" as const };
  }

  // Idempotency trick: WE choose the Google event id (derived from our appointment id).
  // If this runs twice (webhook retry), Google answers 409 instead of creating a duplicate.
  const eventId = appt.id.replaceAll("-", ""); // Google allows lowercase a-v and 0-9

  // googleFetch adds the OAuth token, refreshes on 401, and retries 429/5xx with backoff.
  const res = await googleFetch(db, "/calendar/v3/calendars/primary/events", {
    method: "POST",
    body: JSON.stringify({
      id: eventId,
      summary: `${appt.service.name} -- ${appt.customerName}`,
      description: `Phone: ${appt.customerPhone}\nBooked via: ${appt.source}`,
      start: { dateTime: appt.startsAt.toISOString() },
      end: { dateTime: appt.endsAt.toISOString() },
    }),
  });
  // 409 = "event id already exists" = a previous run already did it: treat as success.
  if (!res.ok && res.status !== 409) {
    throw new Error(`Calendar insert failed: ${res.status} ${await res.text()}`);
  }
  await db.update(appointments).set({ googleEventId: eventId }).where(eq(appointments.id, appt.id));
  return { synced: eventId };
}
