# 12 · Shipping this as a desktop app

You asked how ClinicDesk would become an Electron app. This chapter answers that properly —
what changes, what breaks, what it costs — and the repo contains a working shell in `desktop/`
so it is not just prose.

It is also directly relevant to the job: **HysabOne** is *"accounting and business software,
desktop and web. Offline-first; it syncs when it reconnects"*, built with TanStack Start, **Tauri**
and PowerSync. The reasoning below is the same reasoning that product needed, and the last
section compares Tauri honestly.

## First: why would a clinic want a desktop app at all?

Be suspicious of the question. A web app that works offline (a PWA) covers most of it. Desktop
earns its place when you need:

| Need | Why the browser can't | ClinicDesk example |
|---|---|---|
| Hardware | no raw USB/serial from a web page | receipt printer, card terminal, barcode scanner |
| The filesystem | sandboxed, user-prompted | nightly local backup of the appointment book |
| Always-on presence | a tab gets closed | a tray icon that pops up the next appointment |
| True offline | service workers help; a local database is stronger | reception keeps working when the internet dies |
| Native notifications | permission-gated, unreliable | "patient arriving in 10 minutes" |

If none of those apply, ship the web app. Saying that in an interview is worth more than an
enthusiastic yes.

## What Electron actually is

Chromium + Node.js in one process tree:

- **Main process** — Node. Owns windows, the tray, the menu, the filesystem, and any native
  module. One per app.
- **Renderer process** — Chromium. Your React UI. Sandboxed, one per window.
- **Preload script** — a small bridge that runs in the renderer with limited Node access and
  exposes a *deliberately tiny* API via `contextBridge`.

The security rule that everything else follows: **the renderer never gets Node.** `nodeIntegration: false`,
`contextIsolation: true`, and a preload that exposes named functions, never `ipcRenderer` itself.
If the renderer can `require('fs')`, then any XSS in your UI — or in a dependency — is arbitrary
code execution on the receptionist's machine, with their file permissions.

## Three ways to package ClinicDesk, in increasing order of work

### Option A — Thin shell over the hosted app (what `desktop/` does)

The Electron window loads `https://clinicdesk.example.com`. Everything stays server-side.

- **Gain:** a real window, a tray icon, native notifications, a desktop install, one-line deploys
  (the server still updates itself).
- **Cost:** nothing offline. Close the laptop lid in a basement clinic and it's a white screen.
- **Effort:** an afternoon.

This is genuinely the right first step, and it is what the repo ships. Most "we need a desktop
app" requests are satisfied by it.

### Option B — Bundle the Next.js server inside the app

Ship the built Next.js app plus a Node server, started by the main process on a random localhost
port; the window loads `http://127.0.0.1:<port>`.

- **Gain:** the app runs without your servers.
- **Cost:** Postgres does not come with it. You'd move to a local database (SQLite/libsql — which
  is, not coincidentally, what their connector platform already uses) and your SQL changes:
  no `tstzrange`, **no exclusion constraint**. The double-booking guarantee would have to be
  rebuilt as a unique key on a discrete time-slot column, or as a check in a single-writer
  process.
- **Effort:** a week, and a real schema redesign.

### Option C — Offline-first with sync (what HysabOne is)

Local database is the source of truth for reads and writes; a sync engine reconciles with the
server when the network returns. PowerSync, ElectricSQL, Replicache, or CRDTs.

- **Gain:** reception keeps working through an outage.
- **Cost:** you have signed up for distributed systems. Two receptionists book 10:30 on two
  laptops while offline; both succeed locally; on reconnect one must lose. **A constraint cannot
  save you here** — there is no single database at the moment of the write. You need a conflict
  policy, and someone has to decide it: server wins, last-write-wins, or a human resolves it.
- **Effort:** this is the product, not a feature of it.

The honest summary: *"offline-first isn't a checkbox you add to a CRUD app. The moment two
devices can write the same row while partitioned, you've replaced a database constraint with a
merge policy, and that policy is a product decision."*

## What is already portable, and what isn't

This is where the architecture from chapter 01 pays off:

| Layer | Moves to desktop? | Why |
|---|---|---|
| `src/server/services/*` | ✅ unchanged | plain async functions taking `db` — they don't know what a request is |
| `src/server/db/schema.ts` | ⚠️ mostly | Drizzle supports SQLite, but `tstzrange` + `EXCLUDE` are Postgres-only |
| `src/server/trpc/*` | ✅ | tRPC has an **IPC link**: the renderer calls procedures over Electron IPC instead of HTTP, with the same types |
| `mcp/*` | ✅ | stdio is a local transport already; a desktop app is its natural home |
| `src/app/api/webhooks/*` | ❌ | Stripe cannot call a laptop. Webhooks stay on the server, always |
| `src/app/api/oauth/*` | ⚠️ | the redirect URI must become a custom protocol (`clinicdesk://oauth`) or a loopback listener |
| `src/server/jobs/*` | ✅ | node-cron runs fine in the main process |

Two consequences worth stating plainly:

**Webhooks can never live in the desktop app.** Anything payment-related stays server-side, and
the desktop app learns about it by syncing. That single fact forces a hybrid architecture on
almost every "desktop version" of a SaaS product.

**OAuth changes shape.** `http://localhost:3000/api/oauth/google/callback` isn't reachable when
the app isn't a web server. The two supported patterns are a registered custom protocol handler,
or opening the system browser and listening on an ephemeral loopback port. PKCE becomes
mandatory rather than merely correct, because a desktop app cannot keep a client secret — anyone
can unzip the `.asar` and read it.

## What's in `desktop/`

Option A, with the security posture right:

```
desktop/
├── main.ts        window + tray + menu; loads APP_URL (dev: localhost:3000)
├── preload.ts     contextBridge — exposes a tiny named API, never ipcRenderer
└── tsconfig.json  CommonJS output; Electron's main process is not ESM
```

The parts that matter:

```ts
// desktop/main.ts
new BrowserWindow({
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    nodeIntegration: false,   // the renderer gets NO Node
    contextIsolation: true,   // preload and page can't touch each other's globals
    sandbox: true,
  },
});
```

```ts
// desktop/preload.ts — the entire attack surface, on purpose
contextBridge.exposeInMainWorld('clinicdesk', {
  notify: (title: string, body: string) => ipcRenderer.invoke('notify', title, body),
  getVersion: () => ipcRenderer.invoke('app:version'),
});
```

Plus: external links open in the system browser rather than in-app (`setWindowOpenHandler`), and
navigation is pinned to the app's own origin (`will-navigate`), so a stray link can't turn your
window into an uncontrolled browser.

It is **not installed by default** — `electron` is a ~100 MB dev dependency, and adding it would
slow `pnpm install` and CI for everyone to support a demo. To run it:

```bash
pnpm add -D electron electron-builder
pnpm dev                      # terminal 1: the Next.js app
pnpm exec tsc -p desktop      # compile main/preload
pnpm exec electron desktop/dist/main.js
```

Packaging is `electron-builder` with a config naming the platform targets (`nsis` on Windows,
`dmg` on macOS, `AppImage` on Linux), code signing certificates per platform, and an auto-update
feed. That last bit is the real ongoing cost of desktop: **you own updates now.** A web app is
fixed by a deploy; a desktop app is fixed when users take the update, which means shipping an
updater and thinking about version skew between old clients and your current API.

## Tauri, since HysabOne uses it

| | Electron | Tauri |
|---|---|---|
| Runtime | bundles Chromium + Node (~85 MB base) | uses the OS webview (~5 MB base) |
| Backend language | TypeScript/Node | Rust |
| Rendering | identical everywhere — Chromium | WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux — **they differ** |
| Ecosystem | enormous, mature | younger, growing fast |
| Memory | heavier | lighter |
| Team fit | any Node developer | needs someone comfortable in Rust |

Tauri's smaller binary is the headline, but the real trade is the **webview**: Tauri renders in
whatever the OS provides, so a CSS feature can work on Windows and break on an older Linux
WebKitGTK. Electron guarantees one engine. Tauri's Rust backend is faster and safer but is a
second language in the codebase, and the security model differs — Tauri's command allowlist is
closer to Electron's `contextBridge` than to `nodeIntegration`.

For ClinicDesk specifically: Electron, because the whole stack is TypeScript and nobody needs to
learn Rust to fix a bug. For HysabOne: Tauri makes sense if they're distributing widely and care
about install size, and they already accept Rust in the stack.

## If I had to do this for real, in order

1. **Ship Option A** and find out whether "we need a desktop app" really meant "we want an icon
   in the taskbar and notifications". It usually does.
2. Add the tray, native notifications, and a printer integration — the things a browser genuinely
   cannot do.
3. Only then, if outages are actually hurting the clinic, scope Option C — and start by writing
   down the conflict policy for a double-booked slot **before** writing any code, because that
   decision drives the entire schema.
