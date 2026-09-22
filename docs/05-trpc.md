# 05 · tRPC, properly understood

## The idea in one paragraph

You define a **router** on the server: named procedures, each a `query` (read) or a `mutation`
(write), each with a Zod `input`. The client imports **only the router's type** and calls
`trpc.bookings.book…` as if it were a local function, fully typed. There is no code generation,
no schema file, no OpenAPI document to keep in sync — the types *are* the contract, and they are
checked by the same `tsc` run that checks everything else. Rename a field on the server and the
React component goes red in your editor before you ever reload the page.

Over the wire it is plain HTTP to a single endpoint. Nothing magic is happening.

## The five pieces

| Piece | File | Role |
|---|---|---|
| Context + procedures | `src/server/trpc/init.ts` | who is calling; the reusable procedure types |
| Routers | `src/server/trpc/routers/*` | the actual endpoints |
| Root router + type | `src/server/trpc/routers/_app.ts` | `appRouter`, and `export type AppRouter` |
| HTTP handler | `src/app/api/trpc/[trpc]/route.ts` | connects Next.js requests to the router |
| Client provider | `src/trpc/client.tsx` | React Query + the tRPC client in the browser |

### 1. Context — answering "who is calling?" exactly once

```ts
export async function createTRPCContext(opts: { headers: Headers }) {
  const cookies = (opts.headers.get('cookie') ?? '').split(/;\s*/);
  const isAdmin = cookies.includes(`admin_token=${env.ADMIN_TOKEN}`);
  return { db, stripe, isAdmin };
}
```

This runs once per request, and whatever it returns is `ctx` inside every procedure. Two things
worth saying out loud:

**Dependencies travel in the context.** `ctx.db` and `ctx.stripe` are what get handed to the
services. A procedure never imports `db` directly. That is what makes it trivial to build a
caller with a different context in tests.

**This is demo-grade auth, and the comment in the file says so.** One shared secret in a cookie,
compared to an env var. It stands in for what a real app needs: a proper auth library (Auth.js,
Better Auth, Clerk), a `users` table, roles, and sessions you can revoke. Presenting a stand-in
*as* a stand-in is the difference between a simplification and a lie. Chapter 06 covers what
real auth would look like here.

### 2. Error mapping — the middleware that keeps services clean

```ts
const mapDomainErrors = t.middleware(async ({ next }) => {
  const result = await next();
  if (!result.ok && result.error.cause instanceof DomainError) {
    const cause = result.error.cause;
    throw new TRPCError({ code: cause.code, message: cause.message, cause });
  }
  return result;
});
```

This is the hinge of the whole architecture. Services throw `DomainError` with a code like
`CONFLICT`; this middleware turns it into a `TRPCError`, which tRPC renders as HTTP 409. The
service never imports anything from tRPC, which is exactly why the same service is callable from
the MCP server and the webhook.

`DomainError`'s codes were chosen to be a subset of tRPC's codes on purpose:
`NOT_FOUND` → 404, `CONFLICT` → 409, `BAD_REQUEST` → 400, `FORBIDDEN` → 403. The mapping is the
identity function, which is the best kind of mapping to have to explain.

Anything that is **not** a `DomainError` becomes `INTERNAL_SERVER_ERROR` → 500 with a *fixed
generic message*, while the real error is kept as `cause` and logged in the route handler's
`onError` (→ Sentry in production, which is what AgentZap uses).

> **That second half is not free, and I originally got it wrong.** The obvious implementation —
> map `DomainError`, let everything else fall through — leaks internal messages to the browser.
> tRPC builds an error's message as `opts.message ?? cause?.message ?? opts.code`, and
> `getErrorShape` serialises `message` **unconditionally**; only `stack` is gated behind dev mode.
> So `throw new Error('Insert returned no row')` in a service, a rethrown Stripe SDK error, or a
> driver's `connect ECONNREFUSED <host>:<port>` during an outage all went straight to the client.
>
> A security review caught it by reading `@trpc/server`'s own source instead of believing the
> code comment that claimed otherwise. The middleware now overwrites the message on any
> `INTERNAL_SERVER_ERROR`, and deliberately leaves `BAD_REQUEST` alone so Zod's field-level errors
> still reach the form. Two regression tests pin both halves — and I verified they bite by
> disabling the fix and watching the secret string reappear in the assertion diff.
>
> The general lesson, and it is worth carrying into any codebase: **a comment asserting what a
> framework does is a hypothesis until you have read the framework.** The MCP adapter's `run()`
> had this right from the start; the HTTP adapter did not, and nothing but reading the source
> would have told you.

### 3. The error formatter — field-level errors for forms

```ts
errorFormatter({ shape, error }) {
  return { ...shape, data: { ...shape.data,
    zodError: error.cause instanceof ZodError ? z.flattenError(error.cause) : null,
  }};
}
```

Without this the client gets one lumpy string. With it, the form can put "Phone must be 10–15
digits" under the phone field.

Note `z.flattenError(error.cause)` — **Zod 4**. The Zod 3 spelling was `error.cause.flatten()`,
and it is the kind of thing an agent trained on older code writes by reflex. The compiler catches
it, which is a good argument for strict mode being non-negotiable.

### 4. Procedures — building authorization into a type

```ts
export const publicProcedure = t.procedure.use(mapDomainErrors);

export const adminProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.isAdmin) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx });
});
```

`adminProcedure` builds on `publicProcedure`, so it inherits the error mapping. Now the guard is
in the *type you choose*, not in something you must remember to write:

```ts
upcoming: adminProcedure.query(({ ctx }) => listUpcoming(ctx.db)),
```

Forget the guard and you have to have typed `publicProcedure` — a visible, greppable choice in
review, rather than a missing `if` nobody notices. Making the secure thing the default shape is
worth more than any amount of vigilance.

### 5. The router — look how thin it is

```ts
export const bookingsRouter = createTRPCRouter({
  services: publicProcedure.query(({ ctx }) => listServices(ctx.db)),

  availableSlots: publicProcedure
    .input(z.object({ serviceId: z.uuid(), date: z.iso.date() }))
    .query(({ ctx, input }) => findAvailableSlots(ctx.db, input)),

  book: publicProcedure
    .input(BookInput.omit({ source: true }))
    .mutation(({ ctx, input }) => bookWithDeposit(ctx, { ...input, source: 'web' })),

  cancel: publicProcedure.input(CancelInput)
    .mutation(({ ctx, input }) => cancelAppointment(ctx.db, input)),

  upcoming: adminProcedure.query(({ ctx }) => listUpcoming(ctx.db)),
});
```

Every procedure is one line of body. If a procedure ever grows an `if` about business state, the
logic is in the wrong file.

**`BookInput.omit({ source: true })` is a security control, not tidiness.** `source` records
whether a booking came from the web, the AI agent, or staff. If the client could send it, anyone
could claim to be `staff`, corrupting your analytics and any future rule that trusts it. Omitting
it from the input schema means the server is the only thing that can set it. The general rule:
**never accept a field from the client that the server can determine itself.**

**`cancel` is `publicProcedure` on purpose.** There is no patient login; the phone number *is*
the authorization check, done inside `cancelAppointment` (which returns the same error whether
the id or the phone was wrong, so nobody can probe for valid ids). That is a real design decision
with a real trade-off — a determined attacker with a patient's phone number can cancel their
appointment — and it is the kind of thing to state plainly rather than hide.

## What actually goes over the wire

Worth knowing, because "it's magic" is a bad interview answer:

- Queries are `GET /api/trpc/bookings.services?input=…`; mutations are `POST /api/trpc/bookings.book`.
- `httpBatchLink` collects calls made in the same tick into **one** HTTP request:
  `/api/trpc/bookings.services,bookings.availableSlots?batch=1`. Fewer round trips, and the
  reason the form doesn't produce a waterfall.
- `superjson` is why a `Date` from the server is still a `Date` in the browser. Plain JSON would
  turn it into a string, and `slot.getTime()` in the form would explode. It serialises as
  `{ json: …, meta: … }` describing which fields need reviving.
- The transformer must be configured on **both** ends, and in v11 the client side goes **on the
  link**: `httpBatchLink({ url, transformer: superjson })`, not on `createTRPCClient`.

## The version traps (this is where agents fail)

tRPC v11 with `@trpc/tanstack-react-query` is **not** the classic `@trpc/react-query` API that
most training data contains. The differences are not cosmetic:

| ❌ v10 / classic (agents write this) | ✅ v11 + `@trpc/tanstack-react-query` |
|---|---|
| `trpc.bookings.services.useQuery()` | `useQuery(trpc.bookings.services.queryOptions())` |
| `trpc.bookings.book.useMutation()` | `useMutation(trpc.bookings.book.mutationOptions())` |
| `createTRPCReact<AppRouter>()` | `createTRPCContext<AppRouter>()` |
| `trpc.useContext()` / `utils.invalidate()` | `queryClient.invalidateQueries(trpc.x.queryFilter())` |
| `transformer` on `createTRPCClient` | `transformer` on the **link** |

The mental model that makes the new API obvious: `trpc.x.queryOptions()` just **builds a React
Query options object** — a `queryKey` and a `queryFn`. tRPC is no longer wrapping React Query's
hooks; it is generating input for them. Everything React Query can do (`select`, `enabled`,
`placeholderData`, `useSuspenseQuery`, prefetching) works with no tRPC-specific support, because
tRPC isn't in the way.

One more trap, and it is a security one rather than an ergonomic one:

```ts
import type { AppRouter } from '@/server/trpc/routers/_app';   // ✅ type-only
import { appRouter }      from '@/server/trpc/routers/_app';   // ❌ drags server code to the browser
```

A value import pulls the router — and transitively the database client, the Stripe client, and
`env` — toward the client bundle. Next.js will usually shout about it, but "usually" is not a
security model. **Client files import types only.**

## Testing procedures without HTTP

```ts
const createCaller = createCallerFactory(appRouter);
const caller = createCaller({ db, stripe, isAdmin: false });
await expect(caller.bookings.upcoming()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
```

`createCallerFactory` runs the whole pipeline — input parsing, middleware, the procedure — with
a context you construct, and no server listening. That means you can test the **authorization
guard** and the **`DomainError` → tRPC code mapping** as cheaply as a unit test, against the real
database. `tests/trpc.test.ts` does exactly that, including asserting that booking the same slot
twice through the caller surfaces `code: 'CONFLICT'` — which proves the whole chain from a
Postgres `23P01` up to an HTTP status.

## When *not* to use tRPC

Worth having an opinion ready, because "I use it for everything" is the wrong answer.

tRPC is right when the client and server are in one TypeScript repo and you control both — which
is AgentZap's situation, and this project's. It is the wrong tool for:

- **A public API** consumed by other languages or third parties. There is no schema document to
  hand out; REST + OpenAPI or GraphQL is what those consumers need.
- **Vendors calling you.** Stripe and Google POST to plain URLs. That is why the webhook and both
  OAuth routes in this repo are ordinary Next.js route handlers, not tRPC procedures. Using tRPC
  there would be forcing a client-shaped tool into a server-to-server hole.
- **Non-HTTP callers.** The MCP server never touches tRPC; it calls the services directly, which
  is the whole point of the services existing.
