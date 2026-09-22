import { createTRPCRouter } from "../init";
import { bookingsRouter } from "./bookings";

export const appRouter = createTRPCRouter({
  bookings: bookingsRouter,
});

// Only the TYPE is exported to the client. Client files must never import
// anything else from this module (see src/trpc/client.tsx).
export type AppRouter = typeof appRouter;
