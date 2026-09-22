"use client";

// Service -> date -> slot -> contact details -> submit. Reads and writes go
// through tRPC only; the server decides what is bookable (see
// src/server/services/bookings.ts). This component just displays state and
// forwards input.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTRPC } from "@/trpc/client";

const timeFmt = new Intl.DateTimeFormat("en-PK", {
  timeZone: "Asia/Karachi",
  hour: "numeric",
  minute: "2-digit",
});

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
  const year = parts.find((p) => p.type === "year")?.value ?? "1970";
  const month = parts.find((p) => p.type === "month")?.value ?? "01";
  const day = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

export function BookingForm() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const [serviceId, setServiceId] = useState("");
  const [date, setDate] = useState(todayInKarachi);
  const [slot, setSlot] = useState<Date | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");

  const services = useQuery(trpc.bookings.services.queryOptions());
  const slots = useQuery(
    trpc.bookings.availableSlots.queryOptions(
      { serviceId, date },
      { enabled: serviceId !== "" },
    ),
  );

  const book = useMutation(
    trpc.bookings.book.mutationOptions({
      onSuccess: async (result) => {
        await queryClient.invalidateQueries(trpc.bookings.availableSlots.queryFilter());
        if (result.checkoutUrl) {
          window.location.assign(result.checkoutUrl); // off to pay the deposit
        } else {
          setSlot(null);
          setName("");
          setPhone("");
        }
      },
    }),
  );

  const canSubmit = serviceId !== "" && slot !== null && name.trim() !== "" && phone.trim() !== "";

  return (
    <form
      className="mx-auto grid max-w-md gap-4 p-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit || !slot) return;
        book.mutate({ serviceId, startsAt: slot, customerName: name, customerPhone: phone });
      }}
    >
      <div className="grid gap-1">
        <label htmlFor="service-select" className="text-sm font-medium text-zinc-700">
          Service
        </label>
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
      {book.data && !book.data.checkoutUrl && (
        <p className="text-sm text-green-700" data-testid="success-message">
          Booked! See you then.
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
