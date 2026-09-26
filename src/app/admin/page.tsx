"use client";

// Staff-only view of upcoming appointments, with a Cancel button per row.
// Auth: signing in at /admin/login sets an httpOnly `staff_session` cookie; the
// server looks the session up in src/server/trpc/init.ts. This component only
// decides what to show for each state; the SERVER decides who is an admin (adminProcedure).

import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, CircleAlert, LogOut } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTRPC } from "@/trpc/client";

const dateTimeFmt = new Intl.DateTimeFormat("en-PK", {
  timeZone: "Asia/Karachi",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "numeric",
  minute: "2-digit",
});

// Lookup tables instead of if/else chains: status/source value -> what staff see.
const STATUS_LABEL = { confirmed: "Confirmed", pending_payment: "Awaiting deposit", cancelled: "Cancelled" };
const SOURCE_LABEL = { web: "Website", ai_agent: "AI receptionist", staff: "Staff" };

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
      <main className="flex flex-1 items-center justify-center bg-muted/40 p-6">
        <Card className="w-full max-w-sm text-center">
          <CardHeader>
            <CardTitle>Staff area</CardTitle>
            <CardDescription data-testid="error-message">
              Not signed in. Sign in to see and manage appointments.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link href="/admin/login" data-testid="admin-login-link">
                Sign in
              </Link>
            </Button>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex-1 bg-muted/40 px-4 py-8">
      <Card className="mx-auto w-full max-w-5xl">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="text-lg">Upcoming appointments</CardTitle>
            <CardDescription>The next 100 bookings, in clinic time.</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {/* A plain <a>: this route redirects the browser to Google (not a client route). */}
            <Button asChild variant="outline" size="sm">
              <a href="/api/oauth/google/start">
                <CalendarCheck /> Connect Google Calendar
              </a>
            </Button>
            {/* A plain form POST: the server clears the httpOnly cookie (JS can't). */}
            <form method="post" action="/api/admin/logout">
              <Button type="submit" variant="ghost" size="sm">
                <LogOut /> Sign out
              </Button>
            </form>
          </div>
        </CardHeader>

        <CardContent className="grid gap-4">
          {upcoming.error && (
            <Alert variant="destructive" data-testid="error-message">
              <CircleAlert />
              <AlertDescription>{upcoming.error.message}</AlertDescription>
            </Alert>
          )}
          {cancel.error && (
            <Alert variant="destructive" data-testid="cancel-error">
              <CircleAlert />
              <AlertDescription>Could not cancel: {cancel.error.message}</AlertDescription>
            </Alert>
          )}

          {upcoming.isLoading && (
            <div className="grid gap-2" aria-label="Loading appointments…">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          )}

          {upcoming.data?.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No upcoming appointments.
            </p>
          )}

          {upcoming.data && upcoming.data.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Service</TableHead>
                  <TableHead>Patient</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Booked via</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {upcoming.data.map((a) => {
                  const when = dateTimeFmt.format(a.startsAt);
                  return (
                    <TableRow key={a.id}>
                      <TableCell className="font-medium">{when}</TableCell>
                      <TableCell>{a.service.name}</TableCell>
                      <TableCell>
                        {a.customerName}
                        <div className="text-xs text-muted-foreground">{a.customerPhone}</div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={a.status === "confirmed" ? "default" : "secondary"}>
                          {STATUS_LABEL[a.status]}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{SOURCE_LABEL[a.source]}</Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        {/* AlertDialog: an accessible "are you sure?" modal (focus is trapped,
                            Escape closes it), replacing the browser's window.confirm(). */}
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="destructive"
                              size="sm"
                              data-testid="cancel-button"
                              disabled={cancel.isPending}
                            >
                              Cancel
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Cancel this appointment?</AlertDialogTitle>
                              <AlertDialogDescription>
                                {a.customerName}&apos;s {a.service.name} on {when}. The slot
                                becomes free for other patients. This can&apos;t be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Keep it</AlertDialogCancel>
                              <AlertDialogAction
                                variant="destructive"
                                data-testid="confirm-cancel-button"
                                // The service still requires id + the phone it was booked
                                // with; staff have both from the row.
                                onClick={() =>
                                  cancel.mutate({
                                    appointmentId: a.id,
                                    customerPhone: a.customerPhone,
                                  })
                                }
                              >
                                Yes, cancel it
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
