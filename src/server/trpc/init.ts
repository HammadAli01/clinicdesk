// Set up once, per request: who is calling (context), and the reusable
// procedure types (public, admin) every router builds on.
//
// tRPC in one sentence: the server exports named functions ("procedures"),
// and the browser calls them over HTTP with full TypeScript types, with no
// hand-written fetch() calls and no copy-pasted response types.
// This file is the "kit of parts" every router in routers/* is built from.
// Beginner guide: docs/05-trpc.md.

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { z, ZodError } from "zod";
import { db } from "@/server/db";
import { DomainError } from "@/server/errors";
import { getStaffBySession } from "@/server/services/staff";
import { readCookie, STAFF_COOKIE } from "@/server/staff-cookie";
import { stripe } from "@/server/stripe";

/**
 * Builds the `ctx` object for ONE request. The route handler
 * (src/app/api/trpc/[trpc]/route.ts) calls it once per HTTP request, and the
 * returned object is passed as `ctx` to every middleware and procedure.
 *
 * It holds two kinds of thing:
 * - dependencies (`db`, `stripe`) so procedures never import them directly,
 *   which lets tests swap in their own context via createCallerFactory;
 * - facts about the caller (`isAdmin`), worked out once here instead of in
 *   every procedure.
 *
 * `opts: { headers: Headers }` is an inline object type: the function takes
 * one argument that must have a `headers` field of the web-standard `Headers` type.
 */
export async function createTRPCContext(opts: { headers: Headers }) {
  // Staff are signed in when their `staff_session` cookie holds a live session
  // token (set by /api/admin/login; see services/staff.ts). No cookie, an unknown
  // token or an expired session all mean "not staff".
  const token = readCookie(opts.headers.get("cookie"), STAFF_COOKIE);
  const staff = token ? await getStaffBySession(db, token) : null;
  const isAdmin = staff !== null;
  // `{ db, stripe, isAdmin }` is shorthand for `{ db: db, stripe: stripe, isAdmin: isAdmin }`.
  return { db, stripe, isAdmin };
}

// Derive the Context TYPE from the function instead of writing it by hand, so
// the two can never drift apart. Read it inside-out:
//   typeof createTRPCContext -> the function's type
//   ReturnType<...>          -> what it returns: Promise<{ db, stripe, isAdmin }>
//   Awaited<...>             -> unwrap the Promise: { db, stripe, isAdmin }
type Context = Awaited<ReturnType<typeof createTRPCContext>>;

// `t` is the tRPC "builder". Every router, procedure and middleware in the app
// comes from it, so they all share this one Context type and this one config.
// `.context<Context>()` is a generic call: the <...> passes a TYPE, not a
// value, and tells tRPC what `ctx` looks like everywhere.
const t = initTRPC.context<Context>().create({
  // JSON has no Date type: a Date becomes a string on the way to the browser.
  // superjson sends extra metadata so it's turned back into a real Date there.
  // The client must use the same transformer (see src/trpc/client.tsx).
  transformer: superjson, // Dates stay Dates on the client
  // Runs on every error just before it is sent to the client. `shape` is the
  // default error JSON tRPC built; we return it with one extra field.
  // `({ shape, error })` destructures the single argument object into two variables.
  errorFormatter({ shape, error }) {
    return {
      ...shape, // spread: copy every field of `shape` into this new object
      data: {
        ...shape.data,
        // Send field-level validation errors so forms can show them.
        // When `.input(schema)` rejects the input, tRPC throws BAD_REQUEST with
        // the ZodError as `cause`. z.flattenError (Zod 4) turns it into
        // { formErrors: [...], fieldErrors: { customerPhone: ["..."] } }.
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
//
// How a middleware works: it wraps the procedure. `await next()` runs the rest
// of the chain (later middlewares + the procedure itself) and gives back a
// result object: `{ ok: true, data }` or `{ ok: false, error }`. tRPC has
// already caught any throw by then and wrapped it in a TRPCError whose
// `.cause` is the original error, which is why we look at `.cause` below.
const mapDomainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (result.ok) return result; // success: pass it through untouched

  // An expected failure (slot taken, not found...). DomainError's codes are a
  // subset of tRPC's (NOT_FOUND, CONFLICT, BAD_REQUEST, FORBIDDEN), so the
  // code maps straight across and tRPC turns it into 404/409/400/403.
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

  // Any other deliberate TRPCError (e.g. UNAUTHORIZED from adminProcedure).
  return result;
});

// Re-export the builder pieces under clearer names. Routers import these,
// never `t` itself, so `t` stays private to this file.
export const createTRPCRouter = t.router; // groups procedures into a router
export const createCallerFactory = t.createCallerFactory; // call procedures without HTTP (tests)

// A "procedure" is one endpoint. These are procedure TEMPLATES: a router
// picks one and adds `.input(...)` and `.query(...)` / `.mutation(...)`.
// `.use(mw)` returns a NEW procedure builder with the middleware attached; it
// doesn't change the original. Every procedure gets error mapping this way.
export const publicProcedure = t.procedure.use(mapDomainErrors);

// Built ON TOP of publicProcedure, so it inherits mapDomainErrors, then adds a
// guard. The auth check lives in the template you choose, not in an `if` you
// must remember to write in each procedure.
// `({ ctx, next }) => { ... }` is an arrow function whose parameter is
// destructured. `next({ ctx })` continues the chain, passing ctx on.
export const adminProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.isAdmin) throw new TRPCError({ code: "UNAUTHORIZED" }); // -> HTTP 401
  return next({ ctx });
});
