# ClinicDesk desktop shell

Electron shell: a thin window over the hosted web app. It changes nothing server-side — it
just gives ClinicDesk a taskbar/dock presence, a tray with quick actions, and
native notifications. See that chapter for why Option A is the right first
step, and what Options B and C would additionally cost.

`electron` is **deliberately not installed** — it's a ~100 MB dev dependency
that would slow `pnpm install`/CI for everyone just to support this shell.
Because of that, these files typecheck against a local stand-in
(`types/electron-shim.d.ts`) instead of the real Electron types, which
normally ship inside the `electron` package itself.

## Enable it

```bash
pnpm add -D electron electron-builder
```

This also pulls in the real `electron.d.ts` types. At that point, **delete
`desktop/types/electron-shim.d.ts`** — see the comment at the top of that
file for why keeping both causes conflicting declarations.

## Run it in development

```bash
pnpm dev                         # terminal 1: Next.js app on :3000
pnpm exec tsc -p desktop         # terminal 2: compile main.ts/preload.ts -> desktop/dist
pnpm exec electron desktop/dist/main.js
```

Set `CLINICDESK_APP_URL` to point the window somewhere other than
`http://localhost:3000` (e.g. a staging deploy).

## Packaging

`electron-builder.yml` configures `nsis` (Windows), `dmg` (macOS), and
`AppImage` (Linux) targets. It is not wired into a `pnpm` script yet, and
electron-builder additionally expects a `desktop/package.json` with a `main`
field naming the compiled entry point (`dist/main.js`) — both are outside
this task's file ownership; whoever adds the packaging script should add
both. This config has not been run against a real `electron-builder`
install.

## What would change for Options B and C

- **Option B** (bundle the Next.js server): `main.ts` would spawn the Next
  server on a random localhost port and load `http://127.0.0.1:<port>`
  instead of a remote URL. `electron-builder.yml`'s `files` would then need
  the Next build output and server dependencies — intentionally *not*
  included here, since Option A never serves that output locally. Postgres's
  `tstzrange` + `EXCLUDE` double-booking constraint doesn't travel to a local
  SQLite/libsql database either; see the chapter.
- **Option C** (offline-first + sync): `main.ts` would own a local database
  and a sync engine, and the preload/IPC surface would grow well beyond
  `notify`/`getVersion` — the renderer would read/write local data, not just
  call two functions. Entirely out of scope here.
