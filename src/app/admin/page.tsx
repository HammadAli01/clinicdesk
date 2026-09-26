"use client";

// Staff-only view of upcoming appointments, with a Cancel button per row.
// Auth: signing in at /admin/login sets an httpOnly `staff_session` cookie; the
// server looks the session up in src/server/trpc/init.ts. This component only decides what to show for each
// state; the SERVER decides who is an admin (adminProcedure).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  const queryClient = useQueryClient();
  // retry: false -- an UNAUTHORIZED answer won't change on retry. (The default of
  // 3 retries with back-off is what made the page sit on "Loading…" for seconds.)
  const upcoming = useQuery(trpc.bookings.upcoming.queryOptions(undefined, { retry: false }));

  const cancel = useMutation(
    trpc.bookings.cancel.mutationOptions({
      // Refetch the list so the cancelled row disappears.
      onSuccess: () => queryClient.invalidateQueries(trpc.bookings.upcoming.queryFilter()),
    }),
  );

  if (upcoming.error?.data?.code === "UNAUTHORIZED") {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <p data-testid="error-message" className="text-zinc-700">
          Not signed in.{" "}
          <a href="/admin/login" className="text-teal-700 underline" data-testid="admin-login-link">
            Sign in
          </a>
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-zinc-900">Upcoming appointments</h1>
        <div className="flex items-center gap-2">
          <a
            href="/api/oauth/google/start"
            className="rounded border border-zinc-300 px-3 py-1 text-sm text-zinc-800 hover:border-teal-700"
          >
            Connect Google Calendar
          </a>
          {/* A plain form POST: the server clears the httpOnly cookie (JS can't). */}
          <form method="post" action="/api/admin/logout">
            <button
              type="submit"
              className="rounded border border-zinc-300 px-3 py-1 text-sm text-zinc-800 hover:border-red-700"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>

      {upcoming.isLoading && <p className="text-sm text-zinc-600">Loading…</p>}

      {upcoming.error && (
        <p role="alert" className="text-sm text-red-700" data-testid="error-message">
          {upcoming.error.message}
        </p>
      )}

      {cancel.error && (
        <p role="alert" className="mb-2 text-sm text-red-700" data-testid="cancel-error">
          Could not cancel: {cancel.error.message}
        </p>
      )}

      {upcoming.data?.length === 0 && (
        <p className="text-sm text-zinc-600">No upcoming appointments.</p>
      )}

      {upcoming.data && upcoming.data.length > 0 && (
        <ul className="divide-y divide-zinc-200">
          {upcoming.data.map((a) => (
            <li
              key={a.id}
              className="flex items-center justify-between gap-2 py-2 text-sm text-zinc-800"
            >
              <span>
                {dateTimeFmt.format(a.startsAt)} — {a.service.name} — {a.customerName}{" "}
                <span className="text-zinc-500">
                  ({a.status} via {a.source})
                </span>
              </span>
              <button
                type="button"
                data-testid="cancel-button"
                disabled={cancel.isPending}
                onClick={() => {
                  const label = `${a.customerName}'s ${a.service.name} on ${dateTimeFmt.format(a.startsAt)}`;
                  if (!window.confirm(`Cancel ${label}?`)) return;
                  // The service still requires id + the phone it was booked with;
                  // staff have both from the row.
                  cancel.mutate({ appointmentId: a.id, customerPhone: a.customerPhone });
                }}
                className="rounded border border-red-300 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                Cancel
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
