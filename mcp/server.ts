// The stdio entry point. Hosts (Claude Desktop, Claude Code, the Inspector)
// launch this file as a subprocess and speak JSON-RPC to it over stdin/stdout.
//
// Why two files? This file is the "plug": it picks a transport (stdio) and the
// real dependencies (the real db, the real Stripe client). All the tools live
// in mcp/create-server.ts, which takes those dependencies as arguments. That
// split lets tests/mcp.test.ts build the SAME server with the test database
// and an in-memory transport, without spawning a subprocess.
//
// THE #1 STDIO BUG: with the stdio transport, stdout IS the protocol channel.
// A single console.log here (or in anything this file imports) corrupts the
// JSON-RPC stream and the host just shows a vague "server disconnected". So
// every log in this file -- and in mcp/create-server.ts -- goes to
// console.error (stderr) instead. See also CLAUDE.md's integration notes.

// StdioServerTransport reads JSON-RPC messages from stdin and writes replies
// to stdout. It is one of several transports; the server code doesn't care
// which one it is given (see server.connect below).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// The REAL dependencies. `@/` is the path alias from tsconfig.json for src/.
// Importing db also validates env vars (DATABASE_URL etc.) via src/env.ts.
import { db } from "@/server/db";
import { stripe } from "@/server/stripe";
import { createClinicServer } from "./create-server";

// Staff mode can be requested either via an env var (CLINICDESK_MCP_MODE,
// e.g. from a host config's "env" block) or a `--staff` argv flag (how
// `pnpm mcp:staff` does it), so a host config that only lets you pass a
// launch command (not env vars) can still opt in.
// The ternary (`cond ? a : b`) means `mode` is typed as the literal union
// "staff" | "customer", which matches the `mode` field of createClinicServer's
// Deps type -- no cast needed.
const mode =
  process.env.CLINICDESK_MCP_MODE === "staff" || process.argv.includes("--staff")
    ? "staff"
    : "customer";

// This project has no "type": "module" in package.json, so tsx compiles this
// file to CommonJS, where top-level `await` is not available. An async
// main() with a .catch() is the CJS-compatible equivalent.
/**
 * Builds the server with the real dependencies and connects it to stdio.
 *
 * `async` lets us use `await`: server.connect() returns a Promise that
 * resolves once the transport is listening. After that, the process stays
 * alive on its own because stdin is open -- there is no loop to write.
 */
async function main() {
  // Dependency injection: we HAND the factory its db/stripe/mode instead of
  // letting create-server.ts import them. Tests hand it different ones.
  const server = createClinicServer({ db, stripe, mode });
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel -- see the file banner above. Logs MUST go
  // to stderr, which hosts show in their own log viewer.
  console.error(`clinicdesk MCP server running on stdio (${mode} mode)`);
}

// If main() rejects (building the server or connecting the transport failed),
// print the error to stderr and exit with a non-zero code so the host reports
// "failed to start" instead of hanging. (A bad env var fails even earlier, at
// import time, when src/env.ts validates it -- Node also exits non-zero then.)
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
