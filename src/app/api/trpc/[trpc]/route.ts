// Connects Next.js requests to the tRPC router. A catch-all route: every
// procedure (bookings.services, bookings.book, ...) goes through this one
// file. Queries arrive as GET, mutations as POST.
//
// Next.js App Router convention: a file at app/api/.../route.ts is an HTTP
// endpoint, and the folder `[trpc]` is a dynamic segment. So
// /api/trpc/bookings.book and /api/trpc/bookings.services,bookings.availableSlots
// (a batch) both land here, and tRPC reads the procedure path from the URL.

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createTRPCContext } from "@/server/trpc/init";
import { appRouter } from "@/server/trpc/routers/_app";

/**
 * One function handles every tRPC request. `fetchRequestHandler` is tRPC's
 * adapter for the web-standard Request/Response API that Next.js route
 * handlers use. It parses the URL and body, builds the context, runs
 * middleware -> input validation -> procedure, and serialises the result
 * (with superjson) into a Response.
 *
 * `(req: Request) => fetchRequestHandler({...})` is an arrow function that
 * returns the call's result directly (no braces, so no `return` needed).
 */
const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc", // the URL prefix to strip to get the procedure path
    req,
    router: appRouter,
    // Called once per HTTP request (once per batch, not once per procedure).
    // Passing only the headers keeps init.ts independent of Next.js.
    createContext: () => createTRPCContext({ headers: req.headers }),
    onError({ path, error }) {
      // Expected failures (DomainError -> NOT_FOUND/CONFLICT/BAD_REQUEST/
      // FORBIDDEN, plus UNAUTHORIZED from adminProcedure) are normal control
      // flow -- don't log them. Only log what nobody expected.
      // `error.cause` is the ORIGINAL error: the client only ever got the
      // generic message (see mapDomainErrors in init.ts).
      if (error.code === "INTERNAL_SERVER_ERROR") {
        console.error(`tRPC error on ${path ?? "unknown"}:`, error.cause ?? error); // TODO: Sentry in prod
      }
    },
  });

// Next.js looks for exports named after HTTP methods. The same handler serves
// both; `handler as GET` exports the one function under two names.
export { handler as GET, handler as POST };
