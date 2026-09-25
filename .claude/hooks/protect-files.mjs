// PreToolUse hook: runs before Claude edits or writes any file.
// Blocks two things that should never happen:
//   1. Editing a migration in drizzle/ that is already committed to git
//      (it has run somewhere; the fix is a NEW migration).
//   2. Editing .env files (secrets).
// Exit code 2 = block the tool call; whatever we print to stderr is shown to Claude as the reason.

import { execFileSync } from "node:child_process";
import path from "node:path";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

let filePath = "";
try {
  filePath = JSON.parse(raw)?.tool_input?.file_path ?? "";
} catch {
  process.exit(0); // can't parse input: don't block
}
if (!filePath) process.exit(0);

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const rel = path.relative(projectDir, path.resolve(projectDir, filePath)).split(path.sep).join("/");

if (/(^|\/)\.env(\.|$)/.test(rel)) {
  console.error(`Blocked: ${rel} holds secrets. Ask the user to edit env files themselves.`);
  process.exit(2);
}

if (rel.startsWith("drizzle/")) {
  let tracked = false;
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", rel], { cwd: projectDir, stdio: "ignore" });
    tracked = true;
  } catch {
    tracked = false; // new, uncommitted migration (e.g. from `generate --custom`): editing is fine
  }
  if (tracked) {
    console.error(
      `Blocked: ${rel} is a committed migration and may already have run. ` +
        "Never edit it. Change schema.ts and run `pnpm db:generate --name=<fix>`, " +
        "or `pnpm drizzle-kit generate --custom --name=<fix>` for hand-written SQL.",
    );
    process.exit(2);
  }
}

process.exit(0);
