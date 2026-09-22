"use client";

// Client-side tRPC wiring. This file must NEVER import a value from
// `src/server/*` — only the `AppRouter` TYPE, which erases at build time and
// carries no server code or secrets into the browser bundle.
//
// This is the @trpc/tanstack-react-query integration (tRPC v11), not the
// classic @trpc/react-query one. The hooks are `useQuery(trpc.x.queryOptions())`
// and `useMutation(trpc.x.mutationOptions())` — there is no `trpc.x.useQuery()`.

import { createTRPCContext } from "@trpc/tanstack-react-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import superjson from "superjson";
import type { AppRouter } from "@/server/trpc/routers/_app";

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

export function TRPCReactProvider({ children }: { children: ReactNode }) {
  // useState (not a module-level singleton) so each browser tab gets exactly
  // one QueryClient and one tRPC client, created once, and never shared
  // across requests on the server.
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } }),
  );
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      // `transformer` lives on the link in v11, not on createTRPCClient
      // itself — putting it here is a TypeError under the installed types.
      links: [httpBatchLink({ url: "/api/trpc", transformer: superjson })],
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
