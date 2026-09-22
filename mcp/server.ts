// The stdio entry point. Hosts (Claude Desktop, Claude Code, the Inspector)
// launch this file as a subprocess and speak JSON-RPC to it over stdin/stdout.
//
// THE #1 STDIO BUG: with the stdio transport, stdout IS the protocol channel.
// A single console.log here (or in anything this file imports) corrupts the
// JSON-RPC stream and the host just shows a vague "server disconnected". So
// every log in this file -- and in mcp/create-server.ts -- goes to
// console.error (stderr) instead. See also CLAUDE.md's integration notes.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { db } from "@/server/db";
import { stripe } from "@/server/stripe";
import { createClinicServer } from "./create-server";

// Staff mode can be requested either via an env var (how `pnpm mcp:staff`
// does it) or a `--staff` argv flag, so a host config that only lets you pass
// a launch command (not env vars) can still opt in.
const mode =
  process.env.CLINICDESK_MCP_MODE === "staff" || process.argv.includes("--staff")
    ? "staff"
    : "customer";

// This project has no "type": "module" in package.json, so tsx compiles this
// file to CommonJS, where top-level `await` is not available. An async
// main() with a .catch() is the CJS-compatible equivalent.
async function main() {
  const server = createClinicServer({ db, stripe, mode });
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel -- see the file banner above. Logs MUST go
  // to stderr, which hosts show in their own log viewer.
  console.error(`clinicdesk MCP server running on stdio (${mode} mode)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
