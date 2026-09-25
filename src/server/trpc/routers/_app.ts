// The ROOT router: every feature router is mounted here under a name. That
// name becomes the first part of each procedure's path:
//   bookings: bookingsRouter  ->  trpc.bookings.book  ->  POST /api/trpc/bookings.book
// To add a feature, write routers/<feature>.ts and add one line below.

import { createTRPCRouter } from "../init";
import { bookingsRouter } from "./bookings";

// The real router VALUE. Only server code imports it: the route handler
// (to serve HTTP) and tests (to build a caller).
export const appRouter = createTRPCRouter({
  bookings: bookingsRouter,
});

// Only the TYPE is exported to the client. Client files must never import
// anything else from this module (see src/trpc/client.tsx).
//
// `typeof appRouter` asks TypeScript "what is the type of this value?". That
// type describes every procedure: its path, input and output. The browser
// imports it with `import type`, which is erased at build time, so the client
// gets the full type information and zero server code.
export type AppRouter = typeof appRouter;
