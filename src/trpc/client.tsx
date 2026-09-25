"use client";
// ^ Next.js directive: this file runs in the browser (it uses React state and
// context). It must come before any import or other code.

// Client-side tRPC wiring. This file must NEVER import a value from
// `src/server/*` — only the `AppRouter` TYPE, which erases at build time and
// carries no server code or secrets into the browser bundle.
//
// This is the @trpc/tanstack-react-query integration (tRPC v11), not the
// classic @trpc/react-query one. The hooks are `useQuery(trpc.x.queryOptions())`
// and `useMutation(trpc.x.mutationOptions())` — there is no `trpc.x.useQuery()`.
//
// Two libraries work together here:
// - tRPC client: turns `trpc.bookings.book` into an HTTP call to /api/trpc.
// - TanStack Query (React Query): caching, loading/error state, refetching.
//   tRPC only builds the options objects that React Query's hooks consume.

import { createTRPCContext } from "@trpc/tanstack-react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import superjson from "superjson";
// `import type` = type-only import. It is deleted at build time, so the router,
// db, Stripe client and env never reach the browser, only the shape of the API.
import type { AppRouter } from "@/server/trpc/routers/_app";

// Not the same function as createTRPCContext in src/server/trpc/init.ts: this
// one makes a React Context (a value shared down the component tree).
// The generic `<AppRouter>` is what gives every call full types.
// `const { TRPCProvider, useTRPC } = ...` destructures the returned object.
// - TRPCProvider: component that puts the client into React context (below).
// - useTRPC():    hook components call to get the typed `trpc` proxy.
export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

/**
 * Wraps the whole app (see src/app/layout.tsx) so any client component can
 * call `useTRPC()` and React Query hooks. Creates the two clients once and
 * provides them to the tree.
 *
 * `{ children }: { children: ReactNode }` destructures the props object and
 * types it: `children` is whatever JSX is nested inside <TRPCReactProvider>.
 */
export function TRPCReactProvider({ children }: { children: ReactNode }) {
  // useState (not a module-level singleton) so each browser tab gets exactly
  // one QueryClient and one tRPC client, created once, and never shared
  // across requests on the server.
  // `const [queryClient] = useState(() => ...)`: array destructuring takes only
  // the value (no setter needed), and passing a FUNCTION means React calls it
  // once on first render instead of making a new client on every render.
  const [queryClient] = useState(
    // staleTime 30_000 ms (the `_` is just a digit separator): cached data counts
    // as fresh for 30s, so remounting a component doesn't refetch immediately.
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } }),
  );
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      // `transformer` lives on the link in v11, not on createTRPCClient
      // itself — putting it here is a TypeError under the installed types.
      // A "link" is the step that actually sends requests. httpBatchLink
      // collects calls made in the same tick into ONE HTTP request (?batch=1).
      // superjson must match the server's transformer (init.ts) so Dates survive.
      links: [httpBatchLink({ url: "/api/trpc", transformer: superjson })],
    }),
  );

  // Both providers get the SAME queryClient: QueryClientProvider serves
  // React Query's own hooks (useQuery, useQueryClient), and TRPCProvider
  // uses it too, so every tRPC query lives in that one cache.
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
