"use client"; // Next.js directive: this component runs in the browser (it uses state and hooks)

// Service -> date -> slot -> contact details -> submit. Reads and writes go
// through tRPC only; the server decides what is bookable (see
// src/server/services/bookings.ts). This component just displays state and
// forwards input.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client"; // client-side only; this file never imports server code

// Created once at module load and reused on every render (building a formatter is not free).
const timeFmt = new Intl.DateTimeFormat("en-PK", {
  timeZone: "Asia/Karachi",
  hour: "numeric",
  minute: "2-digit",
});

// Date + time, for the confirmation message ("Mon 5 Oct, 10:00 am").
const dateTimeFmt = new Intl.DateTimeFormat("en-PK", {
  timeZone: "Asia/Karachi",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

/** What the patient just booked, kept after the form is cleared so we can show it. */
type Confirmation = { serviceName: string; startsAt: Date; customerName: string };

// Arrow function + template literal. Money stays in integer cents everywhere;
// it is only divided by 100 here, at the very last moment, for display.
const moneyFmt = (cents: number) => `Rs ${(cents / 100).toFixed(2)}`;

function todayInKarachi(): string {
  // The clinic's local "today" as YYYY-MM-DD, used as the default date
  // picked in the form -- purely a UI default, not a bookability decision.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Karachi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  // `.find` may return undefined -> `?.value` safely yields undefined -> `??` supplies a fallback.
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

/** The booking form: a React function component (a function that returns JSX). */
export function BookingForm() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  // useState returns a pair; array destructuring names them [value, setter].
  const [serviceId, setServiceId] = useState("");
  // Passing the FUNCTION (not calling it) = lazy initial state: runs only on first render.
  const [date, setDate] = useState(todayInKarachi);
  // Generic type argument <Date | null>: without it TS would infer the type `null` forever.
  const [slot, setSlot] = useState<Date | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  // tRPC v11 style: useQuery(trpc.x.queryOptions()). The result type comes all the
  // way from the server's listServices return type, with no hand-written API types.
  const services = useQuery(trpc.bookings.services.queryOptions());
  // `enabled: false` until a service is picked, so no request goes out with an empty id.
  const slots = useQuery(
    trpc.bookings.availableSlots.queryOptions(
      { serviceId, date },
      { enabled: serviceId !== "" },
    ),
  );

  const book = useMutation(
    trpc.bookings.book.mutationOptions({
      onSuccess: async (result, variables) => {
        // Mark cached slot lists stale so they refetch: the slot just booked disappears.
        await queryClient.invalidateQueries(trpc.bookings.availableSlots.queryFilter());
        if (result.checkoutUrl) {
          window.location.assign(result.checkoutUrl); // off to pay the deposit
        } else {
          // Remember what was booked BEFORE clearing the form, so we can show it.
          // `variables` = exactly what was submitted to book.mutate(...).
          setConfirmation({
            serviceName:
              services.data?.find((s) => s.id === variables.serviceId)?.name ?? "appointment",
            startsAt: result.startsAt,
            customerName: variables.customerName,
          });
          setSlot(null);
          setName("");
          setPhone("");
        }
      },
    }),
  );

  // Derived state: computed on every render, not stored in useState (so it can't go stale).
  // This is only a UX hint; the server re-validates everything with Zod.
  const canSubmit = serviceId !== "" && slot !== null && name.trim() !== "" && phone.trim() !== "";

  return (
    <form
      className="mx-auto grid max-w-md gap-4 p-6"
      onSubmit={(e) => {
        e.preventDefault(); // stop the browser's full-page form submit
        // `!slot` is repeated on purpose: TypeScript can't see through `canSubmit`,
        // so this check narrows `slot` from `Date | null` to `Date`.
        if (!canSubmit || !slot) return;
        book.mutate({ serviceId, startsAt: slot, customerName: name, customerPhone: phone });
      }}
    >
      <div className="grid gap-1">
        <label htmlFor="service-select" className="text-sm font-medium text-zinc-700">
          Service
        </label>
        {/* Conditional rendering: `cond && <jsx/>` renders the JSX only when cond is truthy. */}
        {services.error && (
          <p role="alert" className="text-sm text-red-700" data-testid="services-error-message">
            {services.error.message}
          </p>
        )}
        <select
          id="service-select"
          data-testid="service-select"
          value={serviceId}
          disabled={services.isLoading}
          onChange={(e) => {
            setServiceId(e.target.value);
            setSlot(null);
          }}
          className="rounded border border-zinc-300 p-2"
        >
          <option value="">
            {services.isLoading ? "Loading services…" : "Choose a service"}
          </option>
          {/* `data?.map`: data is undefined while loading. `key` lets React track each item. */}
          {services.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.durationMinutes} min — {moneyFmt(s.priceCents)}
            </option>
          ))}
        </select>
        {services.data?.length === 0 && (
          <p className="text-sm text-zinc-600">No services are available right now.</p>
        )}
      </div>

      <div className="grid gap-1">
        <label htmlFor="date-input" className="text-sm font-medium text-zinc-700">
          Date
        </label>
        <input
          id="date-input"
          data-testid="date-input"
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
            setSlot(null);
          }}
          className="rounded border border-zinc-300 p-2"
        />
      </div>

      <div className="grid gap-2">
        <span className="text-sm font-medium text-zinc-700">Available times</span>
        <div className="flex flex-wrap gap-2">
          {serviceId === "" && (
            <p className="text-sm text-zinc-600">Choose a service to see available times.</p>
          )}
          {slots.isLoading && <p className="text-sm text-zinc-600">Loading slots…</p>}
          {slots.error && (
            <p role="alert" className="text-sm text-red-700" data-testid="slots-error-message">
              {slots.error.message}
            </p>
          )}
          {slots.data?.length === 0 && (
            <p className="text-sm text-zinc-600">No free slots that day. Try another date.</p>
          )}
          {slots.data?.map((s) => (
            <button
              type="button"
              key={s.toISOString()}
              data-testid="slot-button"
              aria-pressed={slot?.getTime() === s.getTime()}
              onClick={() => setSlot(s)}
              className={`rounded border px-3 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700 ${
                slot?.getTime() === s.getTime()
                  ? "border-teal-700 bg-teal-700 text-white"
                  : "border-zinc-300 text-zinc-800 hover:border-teal-700"
              }`}
            >
              {timeFmt.format(s)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-1">
        <label htmlFor="name-input" className="text-sm font-medium text-zinc-700">
          Your name
        </label>
        <input
          id="name-input"
          data-testid="name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded border border-zinc-300 p-2"
        />
      </div>

      <div className="grid gap-1">
        <label htmlFor="phone-input" className="text-sm font-medium text-zinc-700">
          Phone number
        </label>
        <input
          id="phone-input"
          data-testid="phone-input"
          type="tel"
          placeholder="03001234567"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="rounded border border-zinc-300 p-2"
        />
      </div>

      {book.error && (
        <p role="alert" className="text-sm text-red-700" data-testid="error-message">
          {book.error.message}
        </p>
      )}
      {book.data && !book.data.checkoutUrl && confirmation && (
        <p className="text-sm text-green-700" data-testid="success-message">
          Booked! Your {confirmation.serviceName} is confirmed for{" "}
          {dateTimeFmt.format(confirmation.startsAt)}, under the name{" "}
          {confirmation.customerName}. See you then.
        </p>
      )}

      <button
        type="submit"
        data-testid="submit-button"
        disabled={!canSubmit || book.isPending}
        className="rounded bg-teal-700 p-2 text-white disabled:opacity-50"
      >
        {book.isPending ? "Booking…" : "Book appointment"}
      </button>
    </form>
  );
}
