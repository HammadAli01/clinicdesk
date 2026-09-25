---
name: frontend
description: Procedure for building or changing ClinicDesk UI — a page, form or component that reads or writes data through tRPC. Use when a task involves anything the user sees in the browser.
---

# Building UI in ClinicDesk

## 1. Check the data exists first
- Find the tRPC procedure you need in `src/server/trpc/routers/*`.
- Missing? Stop. That's backend work (service + procedure + test) before any UI.

## 2. Build the component
- `"use client"` at the top if it uses hooks or events. Pages stay server components where possible
  and render client components.
- Data:
  ```tsx
  const trpc = useTRPC();
  const list = useQuery(trpc.bookings.services.queryOptions());
  const save = useMutation(trpc.bookings.book.mutationOptions({
    onSuccess: () => queryClient.invalidateQueries(trpc.bookings.availableSlots.queryFilter()),
  }));
  ```
  (v11 API. Not `trpc.x.useQuery()`.)
- Import only `type AppRouter` / hooks from `@/trpc/client`. Nothing from `@/server/*`.
- Use Tailwind; follow `src/components/BookingForm.tsx` for spacing and patterns.

## 3. States (all required)
- Loading: a short "Loading…" or skeleton.
- Empty: say what's empty and what to do ("No free slots that day. Try another date").
- Error: show `error.message` (server messages are written for users).
- Pending mutation: disable the button, change its label ("Booking…").
- Success: confirm what happened.

## 4. Details that matter here
- Times: `Intl.DateTimeFormat("en-PK", { timeZone: "Asia/Karachi", ... })`.
- Money: cents → display with `(cents / 100).toFixed(2)`.
- Forms: labels for inputs, `type="tel"` for phone, submit on Enter.
- Validation errors from Zod arrive in `error.data.zodError.fieldErrors`. Show them next to fields.

## 5. Verify
- `pnpm typecheck && pnpm lint`.
- Tell the user exactly what to click in `pnpm dev` to see it working, including one failure case
  (e.g. book the same slot in two tabs).
