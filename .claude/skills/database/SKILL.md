---
name: database
description: Procedure for changing the ClinicDesk database schema with Drizzle — adding or changing tables, columns, indexes or constraints, and writing migrations. Use whenever schema.ts or drizzle/ needs to change.
---

# Changing the database safely

## 1. Understand the current state
- Read `src/server/db/schema.ts` and list the files in `drizzle/` (newest last).
- Find every query touching the table you'll change: `grep -rn "<tableName>" src tests mcp`.

## 2. Classify the change
| Change | Safe in one migration? |
|---|---|
| New table, new nullable column, new index on a small table | Yes |
| New NOT NULL column | Only with a `.default(...)`. Otherwise: nullable → backfill → NOT NULL (3 steps) |
| Rename column/table | No. Add new → dual-write → backfill → switch reads → drop old later |
| Drop column/table | No. Stop reading/writing it first, drop in a later deploy |
| Change a column type | Usually no. Add new column + backfill |
| Constraint, extension, CHECK, exclusion | Custom migration (step 4) |

If it's not "Yes", write the plan for all steps and get the user's OK before step 3.

## 3. Schema-driven migration
1. Edit `src/server/db/schema.ts`. Follow conventions: `tstz()` helper for time, integer cents,
   `uuid().primaryKey().defaultRandom()`, `.references(() => x.id, { onDelete: "restrict" })`.
2. Run `pnpm db:generate --name=<snake_case_description>`.
3. If drizzle-kit asks whether something is a rename or a new column: STOP and ask the user.
4. Open the new `drizzle/NNNN_<name>.sql` and read every line. Check for DROP, unexpected ALTERs,
   and NOT NULL without DEFAULT.

## 4. Custom SQL migration
1. `pnpm drizzle-kit generate --custom --name=<description>`
2. Write the SQL into the new empty file. Make it re-runnable where possible (`IF NOT EXISTS`).
3. Add a comment above each statement saying why it exists.

## 5. Verify
1. Ask the user to run `pnpm db:migrate` (needs approval).
2. `pnpm typecheck`: fix every place the type change breaks. No casts.
3. `pnpm test`: the test DB migrates itself in `tests/global-setup.ts`.
4. Add or adjust a test that proves the new constraint or column behaves as intended.

## Never
- Edit a committed migration (a hook blocks it).
- Run `drizzle-kit push`.
- Delete the `appointments_no_overlap` constraint or replace it with app-level checks.

## Report
Schema diff, generated SQL (pasted), the classification from step 2, test results.
