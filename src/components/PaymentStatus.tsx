"use client";

// Shown on /book?paid=<id> after Stripe sends the patient back.
// Returning from Stripe does NOT prove the booking is confirmed: only the
// webhook does that (docs/08). So we ask the server for the real status and
// poll every 2s while it's still pending_payment (the webhook usually lands
// within seconds). We stop after ~1 minute and ask them to call instead.

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Clock } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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

  const box = "mx-auto w-full max-w-lg"; // same width as the booking card below

  if (status.isLoading) return null;
  if (status.error || !status.data) {
    return (
      <Alert variant="destructive" className={box} data-testid="payment-status">
        <CircleAlert />
        <AlertTitle>Booking not found</AlertTitle>
        <AlertDescription>We couldn&apos;t find that booking. Please contact the clinic.</AlertDescription>
      </Alert>
    );
  }

  const { status: state, serviceName, startsAt } = status.data;
  const when = dateTimeFmt.format(startsAt);

  if (state === "confirmed") {
    return (
      <Alert className={`${box} border-primary/40`} data-testid="payment-status">
        <CircleCheck className="text-primary" />
        <AlertTitle>Payment received</AlertTitle>
        <AlertDescription>
          Your {serviceName} on {when} is confirmed. See you then!
        </AlertDescription>
      </Alert>
    );
  }
  if (state === "pending_payment") {
    // The same counter refetchInterval looks at: how many answers we've had so far.
    const polls =
      queryClient.getQueryState(trpc.bookings.status.queryKey({ appointmentId }))
        ?.dataUpdateCount ?? 0;
    const gaveUp = polls >= MAX_POLLS; // polling has stopped
    return (
      <Alert className={box} data-testid="payment-status">
        <Clock className={gaveUp ? undefined : "animate-spin"} />
        <AlertTitle>{gaveUp ? "Still confirming your payment" : "Payment received"}</AlertTitle>
        <AlertDescription>
          {gaveUp
            ? `We're still confirming your payment for ${serviceName} on ${when}. If this page doesn't update, please call the clinic.`
            : `Confirming your ${serviceName} on ${when}…`}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive" className={box} data-testid="payment-status">
      <CircleAlert />
      <AlertTitle>Booking expired</AlertTitle>
      <AlertDescription>
        This booking is no longer active (the payment window expired). Please book again or call
        the clinic.
      </AlertDescription>
    </Alert>
  );
}
