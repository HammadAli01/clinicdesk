"use client";

// Staff-only view of upcoming appointments. Auth here is the demo-grade
// `admin_token` cookie compared in src/server/trpc/init.ts -- see that file's
// comment. This component only decides what to show for each state; it does
// not decide who is an admin.

import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/trpc/client";

const dateTimeFmt = new Intl.DateTimeFormat("en-PK", {
  timeZone: "Asia/Karachi",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

export default function AdminPage() {
  const trpc = useTRPC();
  const upcoming = useQuery(trpc.bookings.upcoming.queryOptions());

  if (upcoming.error?.data?.code === "UNAUTHORIZED") {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <p data-testid="error-message" className="text-zinc-700">
          Not signed in.
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-zinc-900">Upcoming appointments</h1>
        <a
          href="/api/oauth/google/start"
          className="rounded border border-zinc-300 px-3 py-1 text-sm text-zinc-800 hover:border-teal-700"
        >
          Connect Google Calendar
        </a>
      </div>

      {upcoming.isLoading && <p className="text-sm text-zinc-600">Loading…</p>}

      {upcoming.error && (
        <p role="alert" className="text-sm text-red-700" data-testid="error-message">
          {upcoming.error.message}
        </p>
      )}

      {upcoming.data?.length === 0 && (
        <p className="text-sm text-zinc-600">No upcoming appointments.</p>
      )}

      {upcoming.data && upcoming.data.length > 0 && (
        <ul className="divide-y divide-zinc-200">
          {upcoming.data.map((a) => (
            <li key={a.id} className="py-2 text-sm text-zinc-800">
              {dateTimeFmt.format(a.startsAt)} — {a.service.name} — {a.customerName}{" "}
              <span className="text-zinc-500">
                ({a.status} via {a.source})
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
