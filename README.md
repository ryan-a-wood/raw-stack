# raw-stack

Guardrails for TypeScript projects on [Vite+](https://viteplus.dev), built so agents find their mistakes fast:

- **Strict TypeScript** (TS 7): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly` and more.
- **Type-aware Oxlint**, every finding an error: no `any`, no unsafe calls, no floating promises, exhaustive switches, size limits.
- **Deep modules & client/server isolation** enforced by dependency-cruiser: each module exposes `src/modules/<name>/index.ts(x)` and an optional `src/modules/<name>/client.ts(x)` browser entrypoint. Subdirectories under a module are automatically enforced as 1-level encapsulated submodules (`src/modules/<mod>/<submod>/index.ts(x)` or `client.ts(x)`), with max nesting depth 1 (no `src/modules/<mod>/<a>/<b>/...`). Client/browser files (`src/browser.ts(x)`, `client.ts(x)`, `*.client.ts(x)`, `/client/`) are prevented by default (`client-no-node`, `client-no-server`) from reaching Node built-ins (except `type-only` imports), `*.server.ts(x)` / `/server/`, or `src/modules/database/`, while pure/isomorphic modules (like `ui`) remain importable. Also no cycles, undeclared deps or dev deps in shipped code; `no-orphans` checks reachability from `src/main.ts(x)` / `src/browser.ts(x)` so dead production files fail even when they have outgoing imports; and `not-to-testing` keeps shipped code from importing `src/testing/`. Custom project boundaries can extend these defaults via `raw-stack/dependency-cruiser-rules`.
- **Module health & audits** enforced in `raw-stack verify` (inspectable with `raw-stack health`, plus the template `audit` skill): checks per-unit production file counts (`<= 20`) and per-entrypoint export counts (`<= 25` each for `index.ts(x)` and `client.ts(x)`) independently for each parent module and 1-level submodule, top-level sibling fan-out (`<= 50%` once `>= 6` sibling modules exist, i.e. 7+ modules), and unused exports across both `index.ts(x)` and `client.ts(x)` (unused or test-only value exports fail; exported types/interfaces transitively referenced by a live exported signature in the same entrypoint pass, while genuinely dead type exports fail). The template also ships a read-only `audit` skill (`.claude/skills/audit/SKILL.md`) for periodic or on-demand whole-repo architecture reviews.
- **Guard**: no suppression comments, and project config can't loosen the shared rules. It loads `vite.config.ts` and checks the resolved test settings, so a project can't drop the unit or e2e test projects or narrow which tests they run.
- **Browser tests** (opt-in): `raw-stack/playwright` exports `rawStackPlaywright()` for `playwright.config.ts`: fully parallel, Chromium only locally, Chromium and WebKit in CI (inside Playwright's image, so nothing installs), traces kept on failure, no retries, and native `PW_SHARD` (`"<current>/<total>"`, e.g. `"2/4"`) sharding support. The guard rejects `waitForTimeout`, `waitForSelector` and CSS or XPath selectors, and `verify --full` runs the non-browser checks first and `playwright test` afterward when the config exists. For larger suites, split CI into `raw-stack verify --checks` and sharded `raw-stack verify --browser` jobs. A project with one developer can run browser tests on only one kind of CI run (both commented out in the template): `RAW_STACK_PR_BROWSER_TESTS: "off"` skips them on PRs and leaves them to the push to main; `RAW_STACK_MAIN_BROWSER_TESTS: "off"` skips them on the push to main, whose merge its PR already tested, so it deploys sooner. Local runs always run them.
- **Zero test retries**: a flaky test gets its cause fixed, or is deleted if it no longer states a requirement. The guard rejects `retry` in the config and on test tags, `{ retry }` or Playwright `retries` in test files, `--retry`/`--retries` in package.json scripts and CI workflows, and `vitest.config.*` files, which Vitest reads instead of `vite.config.ts`.
- **Claude Code hooks** for a tiered verify loop: lint after each edit (about 0.4 s), the fast tier on Stop (1 to 3 s, blocking), the full tier before a PR. Harnesses other than Claude Code can run `pnpm exec raw-stack verify` directly for the same fast loop.
- **E2e first**: the template has an `e2e/` test project that runs the real app, a `FEATURES.md` map of what the app does (which scales into `features/<name>.md` with `FEATURES.md` as an index), and a `verify` skill that drives both.
- **Property tests**: [fast-check](https://fast-check.dev) generates inputs and checks a rule holds for all of them. raw-stack sets the run count (100 per property, 1000 in the full tier), and the guard rejects `numRuns`, `seed` and the other settings that weaken a property.
- **Expect tests** that change only by hand: inline snapshots (`toMatchInlineSnapshot`) in `e2e/` only, where they record what the user sees. The full tier never writes a snapshot, the guard rejects them in unit tests and rejects snapshot files, and the template's CI lists every new, changed or removed snapshot, with its old value, in the PR's job summary.

This repo is two things:

- The package `raw-stack` at the root: the shared config, the `raw-stack` CLI and the hook scripts. Projects install it as a git dependency pinned to a tag, so updating every project is a tag bump.
- `template/`: the starter project.

## Start a project

```bash
pnpm dlx giget@3 gh:ryan-a-wood/raw-stack/template#v0.4.0 my-app
cd my-app && git init && pnpm install
```

Then rename the package in `package.json` and the heading in `AGENTS.md`.

## Update a project

Change the tag in `package.json` (`"raw-stack": "github:ryan-a-wood/raw-stack#v0.4.0"`) and run `pnpm install`.

## CLI

- `raw-stack verify`: fast tier. `vp check --fix`, `--project unit` tests related to files changed on this branch, dependency-cruiser on `src/`, strict module health check, guard. Runs automatically on Claude Code Stop, or directly via `pnpm exec raw-stack verify` from other harnesses.
- `raw-stack verify --full`: everything, no fixes: runs `--checks` in parallel first (unit tests with 1000 runs per property test, never writing snapshots, the e2e tests in `e2e/`, `vp check`, dependency-cruiser, strict module health check, guard) and Playwright browser tests afterward so Playwright does not compete for CPU/RAM.
- `raw-stack verify --checks`: full non-browser tier (`vp check`, unit tests at 1000 property runs, Vitest `e2e` with `--update=none`, dependency-cruiser, strict module health check, guard). Skips Playwright.
- `raw-stack verify --browser`: Playwright browser tests only (respects `RAW_STACK_PR_BROWSER_TESTS` / `RAW_STACK_MAIN_BROWSER_TESTS`; succeeds cleanly with a skip message when `playwright.config.ts` does not exist).
- `raw-stack guard [files...]`: suppression comments, fast-check settings that weaken a property, snapshots outside `e2e/` or in separate files, test retries, config overrides, and a verify workflow that no longer runs `pnpm verify` (or split `--checks` + `--browser`) and the snapshot report.
- `raw-stack health [--json] [--strict]`: prints per-unit health metrics (prod files, prod LOC, `index.ts(x)` / `client.ts(x)` export usage, top-level sibling fan-out) and any violations. Exits 0 by default for inspection; `--strict` exits 1 when violations exist (and `raw-stack verify` always fails on violations). See [Module health](#module-health).
- `raw-stack cloudflare-secrets [--repo owner/name] [--account-id id] [--config file] [--dry-run]`: creates a Cloudflare API token scoped to what the project's wrangler config deploys and stores it as the GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. See [Deploy to Cloudflare](#deploy-to-cloudflare).
- `raw-stack snapshots [--base <ref>]`: compares the inline snapshots with where the branch left `<ref>` (default: the default branch) and lists the new, changed and removed ones, with the old values. It reports and never fails.

## Split CI checks & sharded browser tests

By default, `.github/workflows/verify.yml` runs a single `verify` job (`pnpm verify`, which runs `--checks` first and Playwright afterward). Projects with a larger Playwright suite can split CI into separate `checks` and sharded `browser` jobs:

```yaml
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      # ... checkout (fetch-depth: 0), setup pnpm/node, pnpm install --frozen-lockfile ...
      - run: pnpm exec raw-stack verify --checks
      - name: snapshots
        if: github.event_name == 'pull_request'
        env:
          BASE: origin/${{ github.base_ref }}
        run: pnpm exec raw-stack snapshots --base "$BASE"

  browser:
    needs: browsers
    if: needs.browsers.outputs.image != ''
    runs-on: ubuntu-latest
    container:
      image: ${{ needs.browsers.outputs.image }}
      options: --user 1001
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      # ... checkout, setup pnpm/node, pnpm install --frozen-lockfile ...
      - env:
          PW_SHARD: ${{ matrix.shard }}/${{ strategy.job-total }}
        run: pnpm exec raw-stack verify --browser
```

- `rawStackPlaywright()` reads `PW_SHARD` (`"<current>/<total>"`, e.g. `"2/4"`). Valid shards with `total > 1` set Playwright's `shard: { current, total }`; unset, empty, or `"1/1"` omits `shard`; malformed or out-of-range values (such as `"0/2"`, `"3/2"`, or `"foo"`) throw so misconfigured CI shards fail loudly instead of silently running the full suite on every shard.
- `raw-stack guard` accepts `.github/workflows/verify.yml` with either `run: pnpm verify` or split `run: pnpm exec raw-stack verify --checks` (or `run: pnpm verify:checks` when `package.json` defines `"verify:checks": "raw-stack verify --checks"`) plus, whenever `playwright.config.ts` exists, `run: pnpm exec raw-stack verify --browser` (or `run: pnpm verify:browser` when `package.json` defines `"verify:browser": "raw-stack verify --browser"`).

## Import-graph rules & custom boundaries

The shared `.dependency-cruiser.cjs` config enforces module architecture out of the box:

- **Deep modules (`deep-modules`, `deep-modules-from-outside`)**: external callers may import a module only through `src/modules/<name>/index.ts(x)` or optional `src/modules/<name>/client.ts(x)`.
- **Zero-config client/server isolation (`client-no-node`, `client-no-server`)**: browser entrypoints and client files (`src/browser.ts(x)`, `src/modules/<mod>/client.ts(x)`, `src/modules/<mod>/<submod>/client.ts(x)`, `*.client.ts(x)`, `/client/`) cannot reach (directly or transitively) runtime Node built-ins (`client-no-node`; `type-only` imports are allowed), server-only files (`*.server.ts(x)` or `/server/`), or `src/modules/database/` (`client-no-server`). Pure/isomorphic modules (such as `src/modules/ui/index.ts`) remain importable from client files.
- **Automatic 1-level deep submodules (`submodule-encapsulation`, `submodule-encapsulation-from-parent`, `module-max-depth*`)**: any directory `src/modules/<mod>/<submod>/` is treated as an encapsulated submodule. Parent files and sibling submodules inside `<mod>` may import it only through `src/modules/<mod>/<submod>/index.ts(x)` or `client.ts(x)`, while callers outside `<mod>` remain forbidden from importing submodules at all. Nesting deeper than 1 level (`src/modules/<mod>/<a>/<b>/...`) is forbidden (`module-max-depth`, `module-max-depth-from`, `module-max-depth-orphan`).
- **White-box property tests**: `*.property.test.ts(x)` inside a module (or submodule) may import pure internal files directly, so you never need to widen `index.ts` with test-only helpers.
- **Graph hygiene**: no cycles (`no-circular`), reachability from `src/main.ts(x)` / `src/browser.ts(x)` (`no-orphans`), no undeclared or unresolvable imports, no devDependencies in shipped code (`not-to-dev-dep`), and shipped code cannot import tests (`not-to-test`) or `src/testing/` (`not-to-testing`).

For projects that want additional project-specific server modules or custom client patterns beyond the built-in defaults, spread helpers from `raw-stack/dependency-cruiser-rules` into `forbidden` in `.dependency-cruiser.cjs`:

```cjs
const { clientBoundary } = require("raw-stack/dependency-cruiser-rules");

module.exports = {
  extends: require.resolve("raw-stack/dependency-cruiser"),
  forbidden: [
    ...clientBoundary({ serverModules: ["secrets", "billing"] }),
  ],
};
```

- `clientBoundary({ serverModules, clientPattern?, name? })`: blocks client files from reaching extra `serverModules` directly or transitively (`reachable: true`). Each entry in `serverModules` can be a module name under `src/modules/` (e.g. `"secrets"`), a Node built-in (`"node:fs"` or `"node:*"`), or a regex path pattern (e.g. `"^src/private/"`). `clientPattern` defaults to `DEFAULT_CLIENT_PATTERN` (`*.client.ts(x)`, `/client/`, `src/browser.ts(x)`, and `src/modules/<mod>(/<submod>)?/client.ts(x)`), excluding `*.test.ts(x)`.
- `deepSubmodules({ modules?, name? })`: kept for backwards compatibility with existing configs (also allowing `client.ts(x)`), though 1-level submodule encapsulation is now enforced automatically by the shared config.

Both builders reject custom `name` values that collide with raw-stack's shared rules, so they work cleanly with `raw-stack guard`.

## Module health

Module health is enforced automatically as part of `raw-stack verify` (both the fast/Stop-hook tier and the full/CI tier). Run `raw-stack health` directly from a project root to inspect every module and 1-level submodule under `src/modules/`:

```bash
pnpm exec raw-stack health              # human-readable table + violations (exits 0)
pnpm exec raw-stack health --json       # machine-readable JSON report
pnpm exec raw-stack health --strict     # exits 1 if any violation is present
```

For each encapsulated unit (each parent module's direct files and each 1-level submodule `src/modules/<mod>/<submod>/` independently), it reports:

- **Files / LOC**: production `.ts`/`.tsx` files and lines of code in that unit (excluding `*.test.ts(x)`, `*.d.ts`, `src/testing/`, and `e2e/`).
- **Exports**: symbols exported from `index.ts(x)` and `client.ts(x)` (including re-exports, types, default exports, and namespace-import usage), tracking whether each export is used by external production code, transitively referenced by a live exported signature in the same entrypoint (`usedBySignature`), used only by tests, or completely unused.
- **Fan-out**: evaluated at the top-level module (`src/modules/<mod>/**`) — how many sibling modules under `src/modules/` this module's production files import (`count/totalSiblings`), so submodules cannot hide cross-module coupling.

Enforced limits (fail `raw-stack verify` and `raw-stack health --strict`):

- **Production files per unit**: `<= 20` (`prod-files`) — split a growing module into sibling modules or 1-level submodules.
- **Entrypoint exports per unit**: `<= 25` (`index-exports`) per entrypoint (`index.ts(x)` and `client.ts(x)` checked independently) — narrow the interface or split the unit.
- **Top-level sibling fan-out**: `<= 50%` when at least `6` sibling modules exist, i.e. 7+ modules (`sibling-fan-out`) — lift cross-module wiring to `src/main.ts` or decouple modules.
- **Unused exports** (`unused-exports`):
  - Every exported **value** in `index.ts(x)` or `client.ts(x)` must have at least one external production importer — unused and `testOnly` value exports both fail verify. (Use white-box `*.property.test.ts(x)` inside the module for pure internal helpers instead of widening `index.ts`.)
  - Exported **types and interfaces** transitively referenced by a live exported signature (`usedBySignature`) in the same entrypoint pass; genuinely dead unreferenced type exports fail.

## Scaling guidance

`template/AGENTS.md` codifies the conventions for keeping a raw-stack repo clean as it grows:

- **Vertical feature slices**: keep `src/modules/` flat and the web/app shell thin (auth, layout, HTTP helpers, route registry) so each feature owns its domain, routes, pages, styles, and client islands (using optional `client.ts(x)` entrypoints, with client/server isolation enforced by default). Split a module into cohesive sibling modules or 1-level submodules before hitting the enforced `<= 20` prod files, `<= 25` entrypoint exports, or `<= 50%` sibling fan-out limits.
- **Property tests without bloating `index.ts`**: keep behavioral unit tests going through `index.ts` (or `client.ts`), and never widen `index.ts` solely for property tests (test-only value exports fail `raw-stack verify`) — extract pure algorithms into a small focused module or let white-box `*.property.test.ts(x)` files inside the module import pure internal helpers directly.
- **Cohesive file splits**: under `max-lines: 300`, split by concept and keep static stylesheets/assets as `.css` or data files instead of mechanical `-methods.ts`, `-views.tsx`, or CSS-in-TS shards.
- **Fast-loop behavioral tests for routes & UI**: because the Stop hook (`raw-stack verify`) runs `--project unit` only, pair Playwright e2e tests with fast in-process route/SSR and component unit tests.
- **Scaling specs & CI**: past ~10–15 features, split feature specs into `features/<name>.md` and keep `FEATURES.md` as an index linking each doc to its `e2e/` test; for larger Playwright suites, split CI into `raw-stack verify --checks` and sharded `raw-stack verify --browser` jobs via `PW_SHARD`.
- **Periodic architecture audits**: the template ships `.claude/skills/audit/SKILL.md` (alongside the `verify` skill) for periodic or on-demand read-only whole-repo reviews combining `raw-stack health --json`, unit-test-to-prod-LOC ratios, `git log --stat` feature footprints, file-split smells, `FEATURES.md`/`e2e/` alignment, and a deep-module semantic rubric to produce ready-to-file refactor issue specs.

## Deploy to Cloudflare

For a project that deploys a Worker from GitHub Actions, run this on your own machine from the repo root:

```bash
pnpm exec raw-stack cloudflare-secrets --dry-run   # show the permissions, create nothing
pnpm exec raw-stack cloudflare-secrets
```

It reads `wrangler.jsonc`, `wrangler.json` or `wrangler.toml` (the top level and every `env.*`), creates an account-owned API token named `github-actions <owner>/<repo>` with only the permissions that config needs, and sets the repo's `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets with `gh secret set`. A deploy workflow uses those two names:

| The config has | The token gets |
| --- | --- |
| any Worker | Workers Scripts Write, Account Settings Read (account) |
| `d1_databases` | D1 Write (account) |
| `kv_namespaces` | Workers KV Storage Write (account) |
| `r2_buckets` | Workers R2 Storage Write (account) |
| `queues` | Queues Write (account) |
| `routes` or `route`, including custom domains | Workers Routes Write on each route's zone only |

Cloudflare's Workers, D1, KV, R2 and Queues permissions cover the whole account; they can't be limited to one Worker or database. Custom domains need no DNS permission: Workers Routes Write on the zone covers them. Anything else in the config (Vectorize, Hyperdrive, Workers AI, Workflows and so on) stops the command before it creates anything, so add its permission here first.

The token's value is never printed, logged, written to disk or passed as an argument: it goes from Cloudflare's response to `gh`'s stdin. Rerunning is safe: it creates a fresh token, updates the secrets, then revokes the older tokens with the same name, and says so plainly if a revoke fails. If setting a secret fails, it revokes the new token and leaves everything as it was. It checks that `gh` is signed in and can manage the repo's secrets, that the bootstrap token works, and that every zone resolves before it creates anything.

**One-time setup: the bootstrap token.** The command uses a Cloudflare API token that can only create API tokens. Make it once:

1. In the Cloudflare dashboard, go to **Manage Account > Account API Tokens > Create Token > Custom token**.
2. Permissions: **Account > Account API Tokens > Edit**. Add **Zone > Zone > Read** (all zones in the account) so the command can find the zones your routes use; without it, set `zone_id` on each route.
3. Account resources: your account only.
4. Store it where the command looks, in this order:
   - the macOS keychain (recommended): `security add-generic-password -s raw-stack-cloudflare-bootstrap -a "$USER" -w` and paste the token at the prompt;
   - the file `~/.config/raw-stack/cloudflare-bootstrap-token` (or under `$XDG_CONFIG_HOME`), mode 600; the command refuses a file others can read;
   - or `$RAW_STACK_CLOUDFLARE_BOOTSTRAP_TOKEN`, set yourself for one run.

Keep it on your machine only: not in a repo, not in CI, not in an agent's environment.

The account is the `--account-id` flag, then the config's `account_id`, then `$CLOUDFLARE_ACCOUNT_ID`, then the one account the bootstrap token can see.

## Working on raw-stack

`scripts/try-template.sh [dir]` copies the template, points it at this checkout, installs and runs the full tier. Run it after every change. `npm test` runs raw-stack's own tests in `test/` (for example `cloudflare-secrets` against a fake Cloudflare API and a fake `gh`). CI (`.github/workflows/ci.yml`) runs both on every PR and push to `main`.

To edit the template with type checking in your editor, run `scripts/install-template.sh` once. It installs `template/` in place with `raw-stack` linked to this checkout. Without it the editor can't resolve `raw-stack/tsconfig.json` or `vite-plus`, so it falls back to default compiler options and flags every `.ts` import. To release, bump `version` in `package.json` and the ref in `template/package.json` in a PR. On the merge to `main`, `.github/workflows/release.yml` tags the commit that set each version `vX.Y.Z`, if that tag doesn't exist yet.
