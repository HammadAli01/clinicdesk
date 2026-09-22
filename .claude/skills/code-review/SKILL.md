---
name: code-review
description: Full pre-commit review of the current ClinicDesk changes using the reviewer and security subagents in parallel. Run with /code-review before committing or opening a merge request.
disable-model-invocation: true
---

# Pre-commit code review

Run this only when the user asks (/code-review).

## 1. Gather the change
- `git status` and `git diff --stat` (uncommitted) plus `git diff main...HEAD --stat` (committed on this branch).
- If the total is over ~300 changed lines, tell the user it should be split, suggest how, and ask
  whether to review anyway.

## 2. Run checks yourself
`pnpm typecheck && pnpm lint && pnpm test`. Record the results.

## 3. Launch two subagents IN PARALLEL (same message)
- `reviewer`: correctness, AI-generated failure modes, tests, conventions.
- `security`: auth, validation, secrets, webhooks, OAuth, MCP exposure.
Give each the exact diff range to review. They are read-only.

## 4. Combine the results
Produce one report:
1. **Verdict**: ready to commit / needs changes.
2. **Blocking issues**: merged and de-duplicated, highest severity first, each with file:line and fix.
3. **Non-blocking suggestions.**
4. **Checks run**: command results from step 2.
5. **Proposed CLAUDE.md additions**: any mistake likely to repeat, as one-line rules.

## 5. Don't fix anything yet
Ask the user which issues to fix. Fixing is a separate step, so the user stays in control of what lands.
