# 09 · MCP: building your own server

You have *used* MCP servers. This chapter is what is happening underneath, and how to build one
that a company would actually ship.

## What MCP is

**Model Context Protocol** is a standard way for an AI application to discover and call functions
you expose. Think USB: build one server, and any MCP host — Claude Desktop, Claude Code, Cursor,
your own voice agent — can use it without you writing an integration for each.

| Term | Meaning | Here |
|---|---|---|
| **Host** | the AI application the user talks to | Claude Desktop / Claude Code / the Inspector |
| **Client** | the connection inside the host that speaks MCP to one server | created by the host |
| **Server** | your program; exposes capabilities | `mcp/server.ts` |
| **Tools** | functions the model decides to call | `list_services`, `find_available_slots`, `book_appointment`, `cancel_appointment` |
| **Resources** | read-only data the app or user attaches as context | `clinicdesk://appointments/upcoming` |
| **Prompts** | reusable templates the *user* picks | `receptionist` |
| **stdio transport** | the host launches your server as a subprocess, JSON-RPC over stdin/stdout | what we use locally |
| **Streamable HTTP** | the server runs remotely at a URL | what production needs |

The wire protocol is unglamorous JSON-RPC:

```
host → server   initialize                  handshake, capability negotiation
host → server   tools/list                  "what can you do?"
server → host   [{ name, description, inputSchema }, …]
host → server   tools/call { name, arguments }    ← the model decided to call something
server → host   { content: [...], isError?: true }
```

**The model only ever sees your tool names, descriptions and input schemas.** That is the entire
interface. Which means those strings are not documentation — they are *prompt*, and they are the
part you should spend the most time on.

## The one thing that makes this server worth showing

```ts
server.registerTool('book_appointment', { … },
  (args) => run(() => bookWithDeposit({ db, stripe }, { ...args, source: 'ai_agent' })));
```

That handler is the same `bookWithDeposit` the web form calls. The MCP server is a **thin
adapter over the same service layer** as tRPC — which means the AI physically cannot bypass a
business rule. Ask it to book 3 a.m. and it gets `BAD_REQUEST` from the same code path that
rejects a malicious HTTP client.

The rules are not in the prompt. **A prompt is persuadable; a service function is not.**

That single sentence is the reason to build the MCP server this way, and it is what separates a
real integration from a demo where the model is politely asked not to misbehave.

## Designing tools: six rules

### 1. Task-shaped, never database-shaped

`book_appointment`, not `run_sql` or `insert_row`. A generic `query_database` tool is convenient,
demos beautifully, and is a security hole with a friendly face: it hands the model your entire
schema and any bug in your prompt becomes a data breach. Every tool here maps to something a
receptionist actually *does*.

### 2. Few tools, clear names

Four customer tools. Every extra tool is another choice the model can get wrong, and every
description competes for the same attention budget. The right question is not "what could I
expose?" but "what is the smallest set that completes the job?"

### 3. IDs flow between tools, so nothing is invented

```
list_services  →  serviceId
                     ↓
find_available_slots  →  exact startsAt values (+ human labels)
                     ↓
book_appointment  ←  one of those exact values
```

The model never constructs a time. It picks one that the server already said was free. Compare
with a tool that takes a free-text `"tomorrow afternoon"` — now you have a parsing problem, a
timezone problem, and a hallucination problem.

`find_available_slots` deliberately returns **both** shapes:

```ts
return slots.map((s) => ({ startsAt: s.toISOString(), label: formatLocal(s) }));
// { startsAt: "2026-10-02T05:00:00.000Z", label: "Thu, 2 Oct, 10:00 am" }
```

`startsAt` is the machine value to hand back. `label` is what to say out loud. Give a model one
value and ask it to do both jobs and it will read ISO timestamps to a patient on the phone, or
paraphrase the time into the booking call.

### 4. Descriptions say *when* to call and *what to confirm first*

```ts
description:
  'Book an appointment. Before calling, read back the service, time, name and phone to the caller ' +
  'and get a clear yes. If the result has a checkoutUrl, a deposit is required: the slot is held ' +
  'for about 30 minutes and is released if unpaid. Share the link with the caller.',
```

```ts
description:
  'Get free start times for one service on one date (clinic local time, Asia/Karachi). ' +
  'Only ever offer the caller times returned by this tool. Never invent a time.',
```

Notice what these contain: preconditions ("get a clear yes"), post-conditions ("share the link"),
and a prohibition ("never invent a time"). A description that only says *what the function does*
wastes the one channel you have to the model.

Per-field `.describe()` does the same job at the argument level:
`uuid.describe('id from list_services')` tells the model where the value comes from.

### 5. Errors are results, not crashes

```ts
async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof DomainError) return fail(`${e.code}: ${e.message}`);
    console.error('[clinicdesk-mcp] unexpected error', e);   // stderr!
    return fail('INTERNAL: Something went wrong on our side. Tell the caller a staff member will call them back.');
  }
}
```

A thrown error becomes a **protocol** error: the model sees a transport failure and typically
retries the identical call or gives up. An `isError: true` result with `CONFLICT: That time was
just taken. Please pick another slot.` is something it can act on — and it will, by offering a
different time. Same `DomainError` as the web app, translated for a different audience. That is
what an adapter is.

The split in the `catch` matters too: expected failures carry a real message; unexpected ones are
logged with context and replaced by a safe generic string. You do not want a stack trace or a SQL
fragment read aloud to a patient.

### 6. Least privilege — don't register what shouldn't exist

```ts
if (mode === 'staff') {
  server.registerTool('list_upcoming_appointments', …);
}
```

In customer mode this tool is **not registered**, so it never appears in `tools/list` and the
model does not know it exists. That is a capability model, and it is stronger than a permission
check inside a handler: there is no call to get wrong, no flag to misread, no prompt injection
that can reach it.

`annotations` are the other half: `readOnlyHint: true` on the two reads, `destructiveHint: true`
on cancel. Hosts use these to decide when to ask the user to confirm — they are hints to the
*host*, not enforcement, so they complement your real checks rather than replacing them.

## The #1 stdio bug

```ts
// stdout IS the protocol channel. Logs MUST go to stderr.
console.error(`clinicdesk MCP server running on stdio (${mode} mode)`);
```

With stdio, stdout carries JSON-RPC. **One `console.log` anywhere — yours, a library's, or pnpm
printing `> clinicdesk@0.1.0 mcp` before running the script — corrupts the stream**, and the host
shows only a vague "server disconnected" with no clue why.

Two consequences:
- Every log in `mcp/*` is `console.error`.
- Configure hosts to launch `npx tsx …` **directly**, not `pnpm mcp`, so the package manager's own
  banner never reaches stdout. (This is also why `drizzle.config.ts` and `vitest.config.ts` load
  dotenv with `quiet: true` — dotenv v17+ prints a banner, and that habit is worth keeping
  everywhere.)

One more, specific to this repo: there is no `"type": "module"` in `package.json`, so tsx compiles
to CommonJS and **top-level `await` does not work**. Hence `async function main()` + `.catch()`.

## Resources and prompts

**A resource** is read-only context the host or user can attach — not something the model calls:

```ts
server.registerResource('upcoming-appointments', 'clinicdesk://appointments/upcoming', {…},
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json',
                                text: JSON.stringify(await listUpcoming(db), null, 2) }] }));
```

The distinction is about *who decides*: the **model** decides to call a tool; the **user or app**
decides to attach a resource. "What does my day look like?" with the schedule attached is a
resource use case.

**A prompt** is a reusable script the user picks from the host's UI:

```ts
`You are the receptionist for ${clinicName}. Be brief and warm. ` +
'Use list_services, then find_available_slots, and offer at most three times. ' +
'Always confirm details before book_appointment. Never promise a time the tools did not return. ' +
'If a tool returns an error, explain it simply and offer an alternative.'
```

Note that this prompt is about *manner* — how to talk, how many options to offer, how to recover.
It is not where the rules live. If the prompt were the only thing stopping a 3 a.m. booking, the
system would be one persuasive sentence away from failing.

## Testing it: a real client, in memory

```ts
const server = createClinicServer({ db, stripe, mode });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'test-client', version: '0.0.0' });
await client.connect(clientTransport);
```

This is why `createClinicServer` takes its dependencies as arguments instead of importing them —
the same pattern as the services. A **real MCP client** talks to a **real server** over a real
(in-memory) transport, against the real test database. No mocks, no subprocess, no model.

What the tests pin:
- customer mode exposes exactly four tools and **not** `list_upcoming_appointments`; staff mode
  does;
- a 3 a.m. booking returns `isError: true` matching `/BAD_REQUEST/` — **not** a thrown protocol
  error;
- the full happy path: `list_services` → parse the id → `find_available_slots` → `book_appointment`
  with a returned `startsAt` → assert the row exists with `source: 'ai_agent'`;
- booking the same returned slot twice → `isError` matching `/CONFLICT/`;
- cancelling with the wrong phone → `isError` matching `/NOT_FOUND/`.

Almost nobody writes tests for their MCP server. It is the cheapest way to stand out, and it
catches the thing manual testing never does: a tool that *appears* when it shouldn't.

## Trying it by hand

The **MCP Inspector** is a host you drive yourself, with no model in the loop:

```bash
pnpm mcp:inspect
# Connect → Tools → List Tools
# 1) list_services                       → copy an id
# 2) find_available_slots { serviceId, date: tomorrow }
# 3) book_appointment with one of the startsAt values
# 4) the SAME time again                 → isError "CONFLICT: …"
# 5) startsAt at 3am                     → isError "BAD_REQUEST: …"
```

Then wire it to a real host. Use **absolute paths** — hosts launch your server from their own
working directory, so relative paths and the `@/` alias won't resolve unless you point tsx at the
tsconfig:

```bash
claude mcp add clinicdesk -- npx tsx \
  --tsconfig D:/Projects/Typescript/clinicdesk/tsconfig.json \
  --env-file=D:/Projects/Typescript/clinicdesk/.env.local \
  D:/Projects/Typescript/clinicdesk/mcp/server.ts
```

For Claude Desktop (`claude_desktop_config.json`), same arguments as a JSON array, with
`"env": { "CLINICDESK_MCP_MODE": "staff" }` for a second staff-mode entry. On Windows, escape
backslashes (`C:\\Users\\…`) or use forward slashes.

Then say: *"I'd like a HydraFacial tomorrow afternoon. My name is Ayesha, 03001234567."* and watch
it walk the chain.

## Going remote

A voice receptionist runs in the cloud and cannot launch a local subprocess. The same
`createClinicServer` would be served over `StreamableHTTPServerTransport`, mounted at `/mcp` on
an Express or Fastify app. What changes:

- **Authentication becomes mandatory.** Over stdio the host launched the process, so it is trusted
  by construction. Over HTTP, anyone who finds the URL can book appointments. The MCP spec uses
  OAuth 2.1; a simpler internal option is a per-tenant API key checked before the request reaches
  the server.
- **Tenant scoping comes from the token, never from a tool argument.** If `clinicId` were a tool
  parameter, a model could be talked into passing someone else's. The tenant is an input to
  `createClinicServer`, not to the tools.
- **Rate limits and an audit log on every call**: who, what, when, result. You are giving a
  language model write access to a business's calendar; you want to be able to reconstruct any
  booking after the fact.

## The interview answer

> "My MCP server is a thin adapter over the same service layer as my tRPC API, so the AI can't
> bypass business rules — a hallucinated 3 a.m. booking is rejected by the same function that
> rejects a malicious HTTP client, not by the prompt. Tools are task-shaped rather than
> database-shaped: no generic SQL tool. IDs flow from one tool to the next, and the slot tool
> returns both an exact timestamp and a human label, so the model never invents a time or reads
> an ISO string to a patient. Domain errors come back as `isError` results the model can recover
> from instead of protocol errors it can only retry. Staff tools aren't hidden behind a check —
> they're not registered at all in customer mode. I test it with the SDK's in-memory transport and
> a real client, including asserting that the staff tool is absent. Remotely I'd run it over
> Streamable HTTP with auth, and take the tenant from the token rather than a tool argument."
