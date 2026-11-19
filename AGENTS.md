# raw-stack

Shared guardrails for TypeScript projects, plus the starter template. See [README.md](README.md) for what it is.

## Layout

- `config/`: what projects extend: `tsconfig.json`, `vite.js` (`rawStack()` for vite.config.ts), `dependency-cruiser.cjs`, and `property-setup.js`, which sets fast-check's run count for the unit tests. fast-check is an optional peer dependency, not a dependency.
- `lib/`: the verify tiers and the guard, shared by the CLI and the hooks.
- `bin/raw-stack.js`: the CLI (`verify`, `verify --full`, `guard`).
- `hooks/`: Claude Code hooks that projects reference from `node_modules/raw-stack/hooks/`.
- `template/`: the starter project. Its `.claude/settings.json` wires up the hooks.

## Rules for changes here

- The root package is plain JavaScript with `// @ts-check`, no build step, and only runtime dependencies. Projects install it from GitHub, so keep it small.
- Every change must pass `scripts/try-template.sh`. When you change a check, also prove it still fails on a violation: add the bad code to a scratch copy and run `raw-stack verify`.
- dependency-cruiser must use the swc parser while TypeScript 7 has no JS compiler API. The verify step fails if it cruised 0 files.
- Keep the hook paths stable (`hooks/after-edit.js`, `hooks/before-stop.js`): every project's settings point at them.
- Releases are tags `vX.Y.Z`. Bump `template/package.json`'s `raw-stack` ref to the new tag.
