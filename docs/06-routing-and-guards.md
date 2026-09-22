# 06 · Routing and route guards

## Two routing systems, and why both exist

Next.js App Router maps **folders to URLs**. A folder with `page.tsx` renders a page; a folder
with `route.ts` is an HTTP endpoint. Everything in `src/app/` is one or the other.

On top of that, tRPC does its own routing *inside one endpoint*: every procedure in the app is
reached through `/api/trpc/[trpc]`, and the `[trpc]` segment carries the procedure name.

That is a deliberate split, and it is the answer to "why isn't everything tRPC?":

> **tRPC is for callers I control. Route handlers are for callers I don't.**

Stripe and Google will POST and redirect to plain URLs with their own conventions. They have
never heard of tRPC and cannot be asked to care. So they get ordinary route handlers.

## Every route in this app

| URL | File | Kind | Who may call it | Guard |
|---|---|---|---|---|
| `/` | `app/page.tsx` | page | anyone | none |
| `/book` | `app/book/page.tsx` | page | anyone | none — it's the public booking page |
| `/admin` | `app/admin/page.tsx` | page | staff | the data behind it is guarded, not the page |
| `/api/trpc/*` | `app/api/trpc/[trpc]/route.ts` | handler | the browser | per-procedure (below) |
| `/api/oauth/google/start` | `…/start/route.ts` | handler | staff | **admin cookie, 401 otherwise** |
| `/api/oauth/google/callback` | `…/callback/route.ts` | handler | Google's redirect | **`state` must match the cookie** |
| `/api/webhooks/stripe` | `…/stripe/route.ts` | handler | Stripe | **HMAC signature + timestamp** |

Three different callers, three completely different kinds of proof. That is the point of the
table: "is this request allowed?" does not have one answer, it has one answer *per caller*.

## Guard 1 — tRPC procedures: authorization as a type

```ts
export const publicProcedure = t.procedure.use(mapDomainErrors);

export const adminProcedure = publicProcedure.use(({ ctx, next }) => {
  if (!ctx.isAdmin) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return next({ ctx });
});
```

Choosing `adminProcedure` instead of `publicProcedure` *is* the guard. You cannot forget to write
the `if`, because the `if` lives in the procedure type. What you can do is pick the wrong base —
and that is a one-word difference visible in any diff, which is a much better failure mode than
an absent line nobody notices.

| Procedure | Base | Why |
|---|---|---|
| `services`, `availableSlots` | public | a patient must see these before booking |
| `book` | public | there is no patient login |
| `cancel` | public | **the phone number is the authorization** — see below |
| `upcoming` | **admin** | customer names and phone numbers |

### Authentication vs authorization, and the bug that hides between them

- **Authentication** = who are you? (a session, a token)
- **Authorization** = are you allowed to do *this* to *this record*?

Most real security bugs are missing **authorization**, not missing authentication. The classic:

```ts
// The bug that ships in real products
cancel: protectedProcedure                       // ✓ you are logged in
  .input(z.object({ appointmentId: z.uuid() }))
  .mutation(({ input }) => cancelById(input.appointmentId)),   // ✗ is it YOURS?
```

Logged in, yes. Allowed to cancel *that* appointment — never checked. Change the id in the
request and cancel a stranger's booking.

ClinicDesk has no patient accounts, so the check is ownership-by-knowledge:

```ts
await db.update(appointments).set({ status: 'cancelled' })
  .where(and(
    eq(appointments.id, input.appointmentId),
    eq(appointments.customerPhone, input.customerPhone),   // ← the authorization check
    ne(appointments.status, 'cancelled'),
  ))
  .returning({ id: appointments.id });

if (!row) throw new DomainError('NOT_FOUND', 'No active appointment matches that id and phone number');
```

Two properties worth pointing at:

**The check is inside the same statement as the write.** Not `SELECT` then compare then `UPDATE`
— one atomic statement. There is no window between checking and acting.

**The error is identical for a wrong id and a wrong phone.** If "unknown appointment" and "wrong
phone number" produced different errors, an attacker could enumerate which appointment ids exist
by watching which message comes back. Same message, no oracle. This is the same reason a login
form should say "email or password is incorrect" rather than "no such user".

Be honest about the limit: anyone who knows the appointment id *and* the phone number can cancel.
With real patient accounts this becomes a session check plus `WHERE user_id = ctx.user.id`. The
structure is identical — the authorization predicate lives in the `WHERE` clause either way.

## Guard 2 — the OAuth start route: don't let strangers begin a flow

```ts
const jar = await cookies();                       // Next.js 16: cookies() is async
if (jar.get('admin_token')?.value !== env.ADMIN_TOKEN) {
  return new Response('Unauthorized', { status: 401 });
}
```

It is tempting to leave `/start` open — it only redirects to Google, after all. Don't. An open
start endpoint lets an attacker begin a flow whose callback lands on *your* server, and it is
free reconnaissance about which integrations you have. The flow that connects a clinic's calendar
should be startable only by that clinic's staff.

## Guard 3 — the OAuth callback: `state`, the guard people forget

```ts
const expectedState = jar.get('g_state')?.value;
const verifier      = jar.get('g_verifier')?.value;
jar.delete('g_state');                    // single use, deleted before we act on it
jar.delete('g_verifier');

if (!code || !state || !expectedState || !verifier || state !== expectedState) {
  return new Response('Invalid or expired OAuth state. Start again.', { status: 400 });
}
```

The callback is a URL **Google redirects the user's browser to**, which means an attacker can
also send a browser there, with whatever query string they like. `state` is what makes that
useless: a random value minted at `/start`, stored in an httpOnly cookie, and required to match
on return.

Without it: an attacker completes a flow with *their own* Google account and tricks an admin into
loading the callback with the attacker's `code`. Your server exchanges it and the clinic's
appointments start flowing into the attacker's calendar.

The cookies are `httpOnly` (JavaScript cannot read them, so XSS cannot steal the flow),
`sameSite: 'lax'` (still sent on Google's top-level redirect back, but not on cross-site POSTs),
`secure` in production, `maxAge: 600` (a flow you didn't finish in ten minutes is dead), and
scoped to `path: '/api/oauth/google'` so they are not attached to every request in the app.

> **Watch the agent.** The two failure shapes here are *no `state` at all*, and — more insidious
> — generating `state`, setting the cookie, and then **never comparing it** on the way back. The
> second one looks completely correct in review unless you read for the comparison specifically.

## Guard 4 — the Stripe webhook: cryptographic proof, not identity

```ts
const signature = req.headers.get('stripe-signature');
if (!signature) return new Response('Missing signature', { status: 400 });
const rawBody = await req.text();
event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
```

There is no user and no session here. The only question is "was this really sent by Stripe, and
recently?" — answered by an HMAC over the raw bytes, with a timestamp inside the signed payload
(chapter 08). IP allowlists are not a substitute: they break when the vendor changes ranges, and
they prove routing, not authorship.

## Guard 5 — the MCP server: capability, not credentials

The AI receptionist is not authenticated at all over stdio — the host **launched the process**,
so it is trusted by construction. The guard is instead *what tools exist*:

```ts
if (mode === 'staff') {
  server.registerTool('list_upcoming_appointments', …);
}
```

In customer mode that tool is **not registered**, so it is not in `tools/list`, so the model
cannot call it — it does not know it exists. That is a capability model: you restrict by not
handing over the capability, rather than by checking a permission at call time.

And underneath, the real guard is the same one as everywhere else: the tools call
`services/bookings.ts`, so an AI asking for 3 a.m. gets `BAD_REQUEST` from the same code path
that rejects a malicious web client. **The business rules are not in the prompt.** A prompt is
persuadable; a service function is not.

Over Streamable HTTP this changes completely — anyone who finds the URL could book appointments —
and you need real auth with the tenant taken from the token, never from a tool argument. Chapter
09.

## Page-level guards, and why `/admin` isn't one

`/admin` is not protected. Its **data** is: `upcoming` is an `adminProcedure`, so without the
cookie the query fails and the page renders "Not signed in."

That is the right place for the boundary. A guard on the page only hides the UI; the data is what
needs protecting, and the data is reached through an API that any client can call directly. Guard
the endpoint and the page follows; guard only the page and you have hidden a door without locking
it.

In a real app you would *also* redirect unauthenticated users in middleware or a layout — for
user experience, not for security. Worth being able to explain the difference.

## Cookies in Next.js 16

`cookies()` is **async**:

```ts
const jar = await cookies();
const token = jar.get('admin_token')?.value;
```

This is one of the places where a model trained on Next 13/14 confidently writes synchronous
code. `AGENTS.md` in this repo tells agents that this Next.js version differs from their training
data and points at `node_modules/next/dist/docs/` — which is the general fix for "the agent
invented an API": don't argue with it, give it the documentation for the version you actually
installed.

And you can only `set`/`delete` cookies in a Route Handler or Server Action, not while rendering
a Server Component — which is one reason the OAuth flow lives in route handlers.

## What real auth would look like here

`ADMIN_TOKEN` in a cookie, compared with `===`, is a demo. Named as such in the code, because a
simplification you have labelled is a decision and an unlabelled one is a mistake. For production:

1. **An auth library** — Auth.js, Better Auth, or Clerk. Do not hand-roll sessions.
2. **A `users` table** with a role, and a `staff` table joining users to a clinic.
3. **`ctx.user`** built in `createTRPCContext` from a verified session, replacing `isAdmin`.
4. **`protectedProcedure` / `staffProcedure`** replacing `adminProcedure`, with the tenant taken
   from the session.
5. **Row-level scoping**: every staff query filtered by `clinic_id` from the session — never from
   user input. This is the nice-to-have the job description calls *"tenant isolation, per-tenant
   data scoping"*, and the place it usually goes wrong is exactly here: accepting `clinicId` as a
   parameter because it was convenient for one endpoint.
6. **Constant-time comparison** for any remaining shared secret (`timingSafeEqual`), because
   `===` on a secret leaks its length and prefix through timing.
7. **Audit trail**: who changed what, when. `appointments.source` is the seed of one.
