# GitHub Workflow

## Purpose

This skill defines how Claude should use Git and GitHub for ClinicDesk.

## Repository Workflow

Never implement feature work directly on `main`.

Before starting development:

1. Inspect the current branch.
2. Inspect git status.
3. Pull/fetch the latest remote state when appropriate.
4. Understand the issue or requested feature.
5. Create an appropriate feature/fix branch.

## Branch Naming

Use:

- `feature/<description>`
- `fix/<description>`
- `refactor/<description>`
- `chore/<description>`

Use lowercase kebab-case.

Example:

`feature/appointment-booking`

## Commits

Use conventional commits.

Examples:

`feat: add appointment booking`

`fix: prevent duplicate appointments`

`refactor: simplify appointment service`

Keep commits focused and meaningful.

Before committing:

- inspect git diff
- inspect git status
- run relevant tests
- run typecheck
- run lint
- run build when appropriate

Never commit secrets, `.env` files, credentials, API keys, or tokens.

## Pull Requests

When a task is intended to be completed through GitHub:

1. Create a feature branch.
2. Implement the change.
3. Verify the implementation.
4. Commit the changes.
5. Push the branch.
6. Create a pull request against `main`.

PR title format:

`<type>: <short description>`

PR body should contain:

### Summary

What changed.

### Implementation

Important technical details.

### Testing

Commands/checks performed.

### Database

Mention schema or migration changes.

### Risks

Potential areas that require attention.

## Pull Request Review

After creating a PR:

1. Inspect GitHub Actions.
2. Inspect the PR diff.
3. Inspect review comments.
4. Fix legitimate issues.
5. Push fixes to the same branch.
6. Re-check CI.

Do not create a new PR just to fix review comments.

## GitHub Comments

When responding to a review comment:

- understand the actual issue first
- make the required change
- verify it
- explain what was changed
- do not argue with valid feedback

If feedback is incorrect or conflicts with the architecture, explain why before changing the code.

## CI

If CI fails:

1. Read the actual failure.
2. Reproduce locally when practical.
3. Identify the root cause.
4. Fix the root cause.
5. Run the relevant check.
6. Commit and push the fix.
7. Re-check GitHub Actions.

Never claim CI passed without checking the actual result.

## Merge

A PR may be merged only when:

- implementation is complete
- CI passes
- required reviews are satisfied
- no unresolved critical issues remain
- database migrations have been reviewed
- the branch is up to date when required

Use GitHub's PR merge capability rather than manually modifying the main branch.

## Important

Prefer normal local Git commands for:

- branch creation
- staging
- commits
- pushing

Use GitHub MCP for:

- repository information
- issues
- pull requests
- PR comments/reviews
- GitHub Actions
- GitHub-side operations
- merging pull requests
