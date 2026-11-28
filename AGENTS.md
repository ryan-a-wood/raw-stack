# raw-stack

Shared guardrails for TypeScript projects, plus the starter template. See [README.md](README.md) for what it is.

## Layout

- `config/`: what projects extend: `tsconfig.json`, `vite.js` (`rawStack()` for vite.config.ts), `dependency-cruiser.cjs` (deep modules with `index.ts(x)` + optional `client.ts(x)` entrypoints, zero-config client/server isolation via `client-no-node` and `client-no-server`, and automatic 1-level deep-submodule encapsulation with max depth 1), `dependency-cruiser-rules.cjs` (`.d.ts`) exporting customizable boundary rule builders (`clientBoundary`, `deepSubmodules`), `playwright.js` (`rawStackPlaywright()` for projects with browser tests), and `property-setup.js`, which sets fast-check's run count for the unit tests. fast-check is an optional peer dependency, not a dependency.
- `lib/`: the verify tiers and the guard, shared by the CLI and the hooks. `test-config.js` loads a project's `vite.config.ts` and checks its resolved test settings. `health.js` computes per-unit module health metrics (`raw-stack health`) using `@swc/core` and is enforced in `raw-stack verify` (both fast and full tiers). `snapshots.js` finds inline snapshots and compares them with the base branch. `retries.js` rejects every way to retry a test. `browser-tests.js` checks Playwright tests and config. `workflows.js` checks that the project's `.github/workflows/verify.yml` still runs verify and the snapshot report (agents may edit `.github/`). `smoke.js` and `smoke-headers.js` implement `raw-stack smoke` (readiness polling, strict `SMOKE_HEADERS_JSON` / URL validation, and `smoke/` Vitest + Playwright execution). `cloudflare/` is `cloudflare-secrets`: `wrangler-config.js` reads what a wrangler config deploys, `deploy-token.js` creates the scoped token and sets the GitHub secrets.
- `bin/raw-stack.js`: the CLI (`verify`, `verify --full`, `guard`, `health`, `snapshots`, `smoke`, `cloudflare-secrets`).
- `test/`: raw-stack's own tests, run with `npm test` (`node --test`). They run the real CLI against fakes; never against a real Cloudflare account or real GitHub secrets.
- `hooks/`: Claude Code hooks that projects reference from `node_modules/raw-stack/hooks/`.
- `template/`: the starter project. Its `.claude/settings.json` wires up the hooks, and `.github/workflows/verify.yml` runs the full tier and the snapshot report in CI.

## Rules for changes here

- The root package is plain JavaScript with `// @ts-check`, no build step, and only runtime dependencies. Projects install it from GitHub, so keep it small.
- Every change must pass `scripts/try-template.sh` and `npm test`. When you change a check, also prove it still fails on a violation: add the bad code to a scratch copy and run `raw-stack verify`.
- dependency-cruiser must use the swc parser while TypeScript 7 has no JS compiler API. The verify step fails if it cruised 0 files. Keep `SHARED_RULES` in `lib/guard.js` (and `SHARED_RULE_NAMES` in `config/dependency-cruiser-rules.cjs`) in sync with `config/dependency-cruiser.cjs`.
- Keep the hook paths stable (`hooks/after-edit.js`, `hooks/before-stop.js`): every project's settings point at them.
- Releases are tags `vX.Y.Z`. To release, bump `version` in `package.json` (and `package-lock.json`) and `template/package.json`'s `raw-stack` ref to the new tag in the PR. On the merge, `.github/workflows/release.yml` tags the commit. Don't push tags by hand.
