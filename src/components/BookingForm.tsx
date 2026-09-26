"use client"; // Next.js directive: this component runs in the browser (it uses state and hooks)

// Service -> date -> slot -> contact details -> submit. Reads and writes go
// through tRPC only; the server decides what is bookable (see
// src/server/services/bookings.ts). This component just displays state and
// forwards input.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CircleAlert, CircleCheck } from "lucide-react"; // icons (shadcn's default icon set)
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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

  const field = "grid gap-2"; // label above input, same spacing everywhere

  return (
    <Card className="mx-auto w-full max-w-lg">
      <CardHeader>
        <CardTitle>Your appointment</CardTitle>
        <CardDescription>All times are clinic time (Asia/Karachi).</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault(); // stop the browser's full-page form submit
            // `!slot` is repeated on purpose: TypeScript can't see through `canSubmit`,
            // so this check narrows `slot` from `Date | null` to `Date`.
            if (!canSubmit || !slot) return;
            book.mutate({ serviceId, startsAt: slot, customerName: name, customerPhone: phone });
          }}
        >
          <div className={field}>
            <Label htmlFor="service-select">Service</Label>
            {/* Conditional rendering: `cond && <jsx/>` renders the JSX only when cond is truthy. */}
            {services.error && (
              <p role="alert" className="text-sm text-destructive" data-testid="services-error-message">
                {services.error.message}
              </p>
            )}
            {/* shadcn Select = Radix Select + Tailwind. Not a native <select>: it renders a
                button (role="combobox") and a popup list of role="option" items. */}
            <Select
              value={serviceId}
              disabled={services.isLoading}
              onValueChange={(value) => {
                setServiceId(value);
                setSlot(null);
              }}
            >
              <SelectTrigger id="service-select" data-testid="service-select" className="w-full">
                <SelectValue
                  placeholder={services.isLoading ? "Loading services…" : "Choose a service"}
                />
              </SelectTrigger>
              <SelectContent>
                {/* `data?.map`: data is undefined while loading. `key` lets React track each item. */}
                {services.data?.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} — {s.durationMinutes} min — {moneyFmt(s.priceCents)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {services.data?.length === 0 && (
              <p className="text-sm text-muted-foreground">No services are available right now.</p>
            )}
          </div>

          <div className={field}>
            <Label htmlFor="date-input">Date</Label>
            <Input
              id="date-input"
              data-testid="date-input"
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setSlot(null);
              }}
            />
          </div>

          <div className={field}>
            <span className="text-sm font-medium">Available times</span>
            {serviceId === "" && (
              <p className="text-sm text-muted-foreground">Choose a service to see available times.</p>
            )}
            {slots.isLoading && (
              // Skeleton: grey placeholder blocks shaped like the buttons that are coming.
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label="Loading slots…">
                {Array.from({ length: 8 }, (_, i) => (
                  <Skeleton key={i} className="h-8" />
                ))}
              </div>
            )}
            {slots.error && (
              <p role="alert" className="text-sm text-destructive" data-testid="slots-error-message">
                {slots.error.message}
              </p>
            )}
            {slots.data?.length === 0 && (
              <p className="text-sm text-muted-foreground">No free slots that day. Try another date.</p>
            )}
            {slots.data && slots.data.length > 0 && (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {slots.data.map((s) => {
                  const selected = slot?.getTime() === s.getTime();
                  return (
                    <Button
                      type="button"
                      key={s.toISOString()}
                      data-testid="slot-button"
                      aria-pressed={selected}
                      // cva variants: the same component, two looks.
                      variant={selected ? "default" : "outline"}
                      onClick={() => setSlot(s)}
                    >
                      {timeFmt.format(s)}
                    </Button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className={field}>
              <Label htmlFor="name-input">Your name</Label>
              <Input
                id="name-input"
                data-testid="name-input"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className={field}>
              <Label htmlFor="phone-input">Phone number</Label>
              <Input
                id="phone-input"
                data-testid="phone-input"
                type="tel"
                autoComplete="tel"
                placeholder="03001234567"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>
          </div>

          {book.error && (
            <Alert variant="destructive" data-testid="error-message">
              <CircleAlert />
              <AlertTitle>Couldn&apos;t book that</AlertTitle>
              <AlertDescription>{book.error.message}</AlertDescription>
            </Alert>
          )}
          {book.data && !book.data.checkoutUrl && confirmation && (
            <Alert data-testid="success-message" className="border-primary/40">
              <CircleCheck className="text-primary" />
              <AlertTitle>Booked!</AlertTitle>
              <AlertDescription>
                Your {confirmation.serviceName} is confirmed for{" "}
                {dateTimeFmt.format(confirmation.startsAt)}, under the name{" "}
                {confirmation.customerName}. See you then.
              </AlertDescription>
            </Alert>
          )}

          <Button
            type="submit"
            size="lg"
            data-testid="submit-button"
            disabled={!canSubmit || book.isPending}
          >
            {book.isPending ? "Booking…" : "Book appointment"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
