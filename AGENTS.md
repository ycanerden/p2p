# Mesh Workspace Rules

## Package Manager

- Always use `bun` and `bunx`.
- Never use `npm`, `npx`, `pnpm`, or `yarn` in this repository.

## Workspace Layout

- `apps/web` contains the Next.js 16.2.1 App Router frontend.
- `apps/relay` contains the Bun/Hono/SQLite relay backend and operational scripts.
- `apps/macos-menu` contains the macOS menu bar helper app.
- `packages/contracts` contains shared API/domain contracts and frontend client helpers.
- `packages/typescript-config` and `packages/eslint-config` contain shared workspace configuration.
- `docs/` at the repo root contains product, migration, and architecture docs.

## Delivery Rules

- Preserve the public `/api/*` relay surface unless a change explicitly requires versioning.
- Keep Bun/Hono/SQLite as the live runtime in phase 1.
- Treat Convex as planning/documentation only unless a task explicitly changes runtime ownership.
- Do not add ad hoc package-level tooling outside the workspace layout.

## Agent Operating Rules

### Always Do

- Read this file (and package-level `AGENTS.md`) before editing.
- Use `bun` and `bunx` only for package scripts, installs, and tooling.
- Keep changes scoped to the requested task; prefer minimal diffs.
- Run relevant checks before proposing merge:
  - `bun run lint`
  - `bun run format:check`
- Preserve existing behavior unless the task explicitly changes it.
- Ask before any destructive or high-impact action.

### Never Do

- Never run `npm`, `npx`, `pnpm`, or `yarn`.
- Never run destructive commands without explicit approval:
  - `git reset --hard`
  - `git clean -fd`
  - `rm -rf` (or broad deletes)
  - `git push --force`
  - `git checkout -- <path>` (when it discards user changes)
- Never rewrite commit history on shared branches unless explicitly requested.
- Never leak or hardcode secrets, tokens, API keys, or credentials.
- Never silently revert user-authored changes unrelated to the current task.
