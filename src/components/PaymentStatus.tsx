"use client";

// Shown on /book?paid=<id> after Stripe sends the patient back.
// Returning from Stripe does NOT prove the booking is confirmed: only the
// webhook does that (docs/08). So we ask the server for the real status and
// poll every 2s while it's still pending_payment (the webhook usually lands
// within seconds). We stop after ~1 minute and ask them to call instead.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";

const POLL_MS = 2_000;
const MAX_POLLS = 30;

const dateTimeFmt = new Intl.DateTimeFormat("en-PK", {
  timeZone: "Asia/Karachi",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

export function PaymentStatus({ appointmentId }: { appointmentId: string }) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const status = useQuery(
    trpc.bookings.status.queryOptions(
      { appointmentId },
      {
        retry: false, // a NOT_FOUND won't fix itself
        // TanStack Query v5: a function decides the next interval, `false` stops polling.
        refetchInterval: (query) =>
          query.state.data?.status === "pending_payment" &&
          query.state.dataUpdateCount < MAX_POLLS
            ? POLL_MS
            : false,
      },
    ),
  );

  const box = "mx-auto mt-6 max-w-md rounded border p-4 text-sm";

  if (status.isLoading) return null;
  if (status.error || !status.data) {
    return (
      <p role="alert" className={`${box} border-red-200 text-red-700`} data-testid="payment-status">
        We couldn&apos;t find that booking. Please contact the clinic.
      </p>
    );
  }

  const { status: state, serviceName, startsAt } = status.data;
  const when = dateTimeFmt.format(startsAt);

  if (state === "confirmed") {
    return (
      <p className={`${box} border-green-200 text-green-700`} data-testid="payment-status">
        Payment received. Your {serviceName} on {when} is confirmed. See you then!
      </p>
    );
  }
  if (state === "pending_payment") {
    // The same counter refetchInterval looks at: how many answers we've had so far.
    const polls =
      queryClient.getQueryState(trpc.bookings.status.queryKey({ appointmentId }))
        ?.dataUpdateCount ?? 0;
    const gaveUp = polls >= MAX_POLLS; // polling has stopped
    return (
      <p className={`${box} border-zinc-200 text-zinc-700`} data-testid="payment-status">
        {gaveUp
          ? `We're still confirming your payment for ${serviceName} on ${when}. If this page doesn't update, please call the clinic.`
          : `Payment received. Confirming your ${serviceName} on ${when}…`}
      </p>
    );
  }
  return (
    <p role="alert" className={`${box} border-red-200 text-red-700`} data-testid="payment-status">
      This booking is no longer active (the payment window expired). Please book again or call the
      clinic.
    </p>
  );
}
