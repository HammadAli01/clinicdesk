// Set up once, per request: who is calling (context), and the reusable
// procedure types (public, admin) every router builds on.

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { z, ZodError } from "zod";
import { env } from "@/env";
import { db } from "@/server/db";
import { DomainError } from "@/server/errors";
import { stripe } from "@/server/stripe";

// Runs for every request. Whatever it returns is `ctx` in every procedure.
export async function createTRPCContext(opts: { headers: Headers }) {
  const cookies = (opts.headers.get("cookie") ?? "").split(/;\s*/);
  // Demo-grade admin auth: a single shared cookie compared to an env var.
  // In a real app use a proper auth library (Auth.js, Better Auth, Clerk)
  // and a users table with roles, not a bearer-token-in-a-cookie hack.
  const isAdmin = cookies.includes(`admin_token=${env.ADMIN_TOKEN}`);
  return { db, stripe, isAdmin };
}
type Context = Awaited<ReturnType<typeof createTRPCContext>>;

const t = initTRPC.context<Context>().create({
  transformer: superjson, // Dates stay Dates on the client
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        // Send field-level validation errors so forms can show them.
        zodError: error.cause instanceof ZodError ? z.flattenError(error.cause) : null,
      },
    };
  },
});

/** Shown to the caller for any failure that is NOT an expected DomainError. */
const GENERIC_ERROR_MESSAGE = 'Something went wrong on our side. Please try again.';

// Translate DomainError (thrown by services) into proper tRPC/HTTP errors, and
// make sure nothing else leaks an internal message to the caller.
//
// Why the second half is not optional: tRPC builds an error's message as
// `opts.message ?? cause?.message ?? opts.code` (see TRPCError's constructor in
// @trpc/server), and `getErrorShape` then serialises `message` unconditionally --
// only `stack` is gated behind dev mode. So a plain `throw new Error("Insert
// returned no row")` in a service, or a rethrown Stripe/postgres driver error,
// would be sent verbatim to the browser: internal invariants, SQL fragments,
// even `connect ECONNREFUSED <host>:<port>` during an outage.
//
// Expected failures carry a message we WROTE for the caller. Everything else
// gets a generic string, with the real error preserved as `cause` so the route
// handler's onError still logs it (-> Sentry in production). This mirrors what
// `run()` in mcp/create-server.ts already does for the AI-facing adapter.
const mapDomainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (result.ok) return result;

  if (result.error.cause instanceof DomainError) {
    const cause = result.error.cause;
    throw new TRPCError({ code: cause.code, message: cause.message, cause });
  }

  // Zod input-validation failures are BAD_REQUEST, not INTERNAL_SERVER_ERROR;
  // their messages are safe and the errorFormatter above turns them into
  // field-level errors for the form. Only sanitise genuine 500s.
  if (result.error.code === 'INTERNAL_SERVER_ERROR') {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: GENERIC_ERROR_MESSAGE,
      cause: result.error.cause ?? result.error,
    });
  }

  return result;
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;

export const publicProcedure = t.procedure.use(mapDomainErrors);

export const adminProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.isAdmin) throw new TRPCError({ code: "UNAUTHORIZED" });
  return next({ ctx });
});
