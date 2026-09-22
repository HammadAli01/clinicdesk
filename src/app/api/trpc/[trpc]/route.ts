// Connects Next.js requests to the tRPC router. A catch-all route: every
// procedure (bookings.services, bookings.book, ...) goes through this one
// file. Queries arrive as GET, mutations as POST.

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createTRPCContext } from "@/server/trpc/init";
import { appRouter } from "@/server/trpc/routers/_app";

const handler = (req: Request) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createTRPCContext({ headers: req.headers }),
    onError({ path, error }) {
      // Expected failures (DomainError -> NOT_FOUND/CONFLICT/BAD_REQUEST/
      // FORBIDDEN/UNAUTHORIZED) are normal control flow -- don't log them.
      // Only log what nobody expected.
      if (error.code === "INTERNAL_SERVER_ERROR") {
        console.error(`tRPC error on ${path ?? "unknown"}:`, error.cause ?? error); // TODO: Sentry in prod
      }
    },
  });

export { handler as GET, handler as POST };
