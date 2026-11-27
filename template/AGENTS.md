# app

A TypeScript project on [raw-stack](https://github.com/ryan-a-wood/raw-stack): Vite+ for format, lint, type checks and tests, strict TypeScript, and deep modules enforced by dependency-cruiser.

## Commands

- `vp check`: format (Oxfmt), lint (Oxlint, type-aware) and type check. `vp check --fix` fixes formatting and fixable lint.
- `vp test`: run the tests (Vitest). Import test APIs from `vite-plus/test`. `vp test --project unit` or `--project e2e` runs one kind.
- `pnpm exec raw-stack verify`: the fast verify tier (`vp check --fix`, related unit tests, dependency-cruiser, module health, guard). The Claude Code Stop hook runs this automatically; run it directly from other harnesses.
- `pnpm verify`: the full verify tier (`raw-stack verify --full`), e2e and browser tests included. Run it before opening a PR. Use `pnpm exec raw-stack verify --checks` or `--browser` to run the non-browser checks or Playwright browser tests on their own.
- `pnpm exec raw-stack health`: per-unit production file count, LOC, `index.ts(x)` / `client.ts(x)` export usage, and top-level sibling fan-out (`--strict` exits 1 on violations; `--json` prints JSON). `raw-stack verify` enforces these checks automatically.
- `node src/main.ts`: run the app. Node runs the TypeScript directly.

## Code layout: deep modules

- **Vertical feature slices over horizontal buckets.** Keep `src/modules/` flat, keep the web/app shell thin (auth, layout, HTTP helpers, route registry), and let each feature module own its domain, routes, pages, styles, and client islands. A module's `index.ts(x)` (plus an optional `client.ts(x)` browser entrypoint) is its whole public interface; every other file in the folder is private to it.
- **Strict module boundaries & zero-config client/server isolation.** Import another module only through its `index.ts(x)` or `client.ts(x)`; dependency-cruiser fails otherwise. Browser entrypoints and client files (`src/browser.ts(x)`, `src/modules/<mod>/client.ts(x)`, `src/modules/<mod>/<submod>/client.ts(x)`, `*.client.ts(x)`, `/client/`) are prevented by default (`client-no-node`, `client-no-server`) from reaching (directly or transitively) runtime Node built-ins (`type-only` imports are allowed), `*.server.ts(x)` / `/server/`, or `src/modules/database/`. Pure/isomorphic modules (such as `src/modules/ui/index.ts`) remain importable from client files. Add project-specific server modules in `.dependency-cruiser.cjs` with `clientBoundary` from `raw-stack/dependency-cruiser-rules` if needed.
- **1-level submodules & enforced module health.** Split a growing module into cohesive sibling modules — or into **1-level encapsulated submodules** (`src/modules/<mod>/<submod>/index.ts(x)` or `client.ts(x)`). Nesting deeper than 1 level (`src/modules/<mod>/<a>/<b>/...`) is forbidden, and any `<submod>/` directory is automatically encapsulated: parent files and sibling submodules may import it only through its `index.ts(x)` or `client.ts(x)`, while callers outside `<mod>` cannot import submodules at all. `raw-stack verify` enforces module health automatically (both on Stop and in CI):
  - **Size & surface area (per unit):** each parent module and each 1-level submodule independently must stay `<= 20` production files and `<= 25` exports per entrypoint (`index.ts(x)` and `client.ts(x)` checked independently).
  - **Top-level sibling fan-out:** once a project has `>= 6` sibling modules (7+ modules total), no top-level module (`src/modules/<mod>/**`) may import `> 50%` of its siblings (lift cross-module wiring to `src/main.ts`).
  - **No unused exports:** every exported **value** in `index.ts(x)` or `client.ts(x)` must have an external production importer — unused and test-only value exports fail verify. Exported **types/interfaces** transitively referenced by a live exported signature in the same entrypoint pass, while genuinely dead unreferenced type exports fail.
- **Split files by concept, not mechanically.** Under `max-lines: 300`, split along cohesive responsibilities and keep static stylesheets and assets as `.css` or data files — never mechanical `-methods.ts`, `-views.tsx`, or CSS-in-TS shards.
- `src/main.ts` (and `src/browser.ts(x)` for browser bundles) is the entry point. Unreachable production files fail the check, so delete dead code.
- Imports use the `.ts` extension: `import { greet } from "./modules/greeting/index.ts"`.

## Tests

- **E2e tests come first.** `e2e/` holds tests that run the real app and check what the user sees, one per feature in `FEATURES.md`. They are the hardest tests to fool: the feature either works or it doesn't. A new feature gets its `FEATURES.md` entry and its e2e test in the same change. Once the app grows past ~10–15 features, split individual specs into `features/<name>.md` and keep `FEATURES.md` as a short index linking each feature doc to its `e2e/` test.
- **Property tests** come next. A property test states a rule that holds for every input, and [fast-check](https://fast-check.dev) tries many generated inputs to break it, then shrinks a failure to the smallest case. Write one for any module with logic over a wide input space: parsing, formatting, math, state transitions, anything with a round trip (`decode(encode(x))` equals `x`). They are unit tests, named `<name>.property.test.ts` next to the module. See `src/modules/greeting/greeting.property.test.ts`. Never widen a module's public `index.ts` solely to expose internal helpers for property tests (test-only value exports fail `raw-stack verify`): `*.property.test.ts(x)` inside a module (or submodule) may import pure internal files directly, or you can extract pure algorithms into a small focused module.
- raw-stack sets how many inputs each property tries: 100 in the fast tier, 1000 in `pnpm verify`. Don't set `numRuns`, `seed`, `path` or time limits: the guard fails on them. When a property fails, fix the code, or the property if the rule was wrong. You can replay the reported seed while debugging, then remove it.
- **Expect tests** (inline snapshots) record what the app printed and fail when it changes. Use them in `e2e/` for output that's tedious to write by hand: CLI output, rendered pages, error text, API responses. Write `expect(output).toMatchInlineSnapshot()` empty, run `vp test --project e2e` to fill it in, then read what it recorded and check it against `FEATURES.md`: whatever it recorded becomes the expected output. Only inline snapshots, only in `e2e/`: the guard rejects them in unit tests, where they would only copy the code, and rejects snapshot files.
- **Don't change a recorded snapshot yourself** unless the output is meant to change. If it is, update it and say why in the PR: CI lists every changed or removed snapshot with its old value in the job summary, and the reviewer reads it in the diff. `pnpm verify` never writes snapshots, so an empty one fails there.
- **Unit tests** live next to the code in `src/modules/<name>/` and test a module's behavior through its `index.ts` (or `client.ts` for browser entrypoints); `*.property.test.ts(x)` may import pure internal files directly. Use examples for the cases a property can't express.
- **Fast-loop behavioral tests for routes and UI.** E2e tests don't import from `src/`, and the Stop hook runs `--project unit` only (`vp test related --project unit`), so `pnpm verify` and CI run e2e and browser tests. Pair Playwright e2e tests with fast in-process route/SSR and component unit tests so UI and route edits get behavioral feedback on Stop. For browser e2e setup, see Browser tests below.
- **Zero retries.** A test that passes only on a second try is hiding a bug in the code or in the test. When a test is flaky, fix the cause right away: a race, shared state between tests, a missing `await`, a fixed port, real time or randomness the test doesn't control. If the test no longer states a requirement in `FEATURES.md`, delete it and say why in the PR. The guard rejects every way to retry: `retry` in `vite.config.ts` or on a test tag, `{ retry }` on a test or `describe`, Playwright `retries`, `--retry` or `--retries` in a script or workflow, and a `vitest.config.*` file, which Vitest would read instead of `vite.config.ts`.

## Browser tests (Playwright)

When the app gets a web UI (a site or PWA), its e2e tests drive a browser with [Playwright](https://playwright.dev). A CLI needs none of this: its e2e tests run the process, as `e2e/greeting.test.ts` does. Add Playwright once:

1. `pnpm add -D @playwright/test`, then `pnpm exec playwright install chromium`.
2. Create `playwright.config.ts`:

   ```ts
   import { defineConfig } from "@playwright/test";
   import { rawStackPlaywright } from "raw-stack/playwright";

   export default defineConfig({
     ...rawStackPlaywright(),
     webServer: {
       command: "pnpm start",
       url: "http://localhost:5173",
       reuseExistingServer: !process.env.CI,
     },
     use: { ...rawStackPlaywright().use, baseURL: "http://localhost:5173" },
   });
   ```

3. Name browser tests `e2e/<feature>.spec.ts`. Vitest runs `e2e/**/*.test.ts` and Playwright runs `*.spec.ts`, so they don't overlap. `pnpm verify` and CI run both. CI runs them inside Playwright's Docker image, which matches your Playwright version and has the browsers preinstalled. A project with one developer can run them on only one kind of run by uncommenting one line in `.github/workflows/verify.yml`: `RAW_STACK_PR_BROWSER_TESTS: "off"` leaves them to the push to main, and `RAW_STACK_MAIN_BROWSER_TESTS: "off"` leaves them to PRs.

`rawStackPlaywright()` sets what keeps the suite fast and honest, and the guard fails if `playwright.config.ts` changes it: tests run in parallel, even within a file (`fullyParallel`); only Chromium runs locally, and Chromium and WebKit run in CI (never Firefox); a trace is kept only for a failed test; no retries; `.only` fails in CI; and `PW_SHARD` (`"<current>/<total>"`) enables native sharding in CI (throws on malformed values). `projects` and `use` can be extended, for example with a login setup project. For larger suites, `.github/workflows/verify.yml` includes a commented-out example showing how to split CI into `raw-stack verify --checks` and sharded `raw-stack verify --browser` jobs.

Write browser tests so they stay fast and don't flake:

- **Find elements the way a user does**: `getByRole`, `getByLabel`, `getByText`, or `getByTestId` as a last resort. The guard rejects CSS and XPath selectors (`locator("...")`, `$`, `xpath=`), which break when the markup changes.
- **Never wait a fixed time.** Assert what the user should see, `await expect(page.getByRole("alert")).toHaveText("Saved")`, and Playwright waits until it's true. The guard rejects `waitForTimeout` and `waitForSelector`.
- **Each test makes its own data**, with unique names (a random suffix), so tests can run in any order and in parallel without sharing state.
- **Seed state through the API, not the UI**, but only for state that another e2e test already builds through the UI. Seeding signup in every test is fine only if one test still signs up by clicking through the form. Each seed helper names that test in a comment, `// UI covered by e2e/signup.spec.ts`, so deleting the UI test also shows the seed is now unproven.
- **Once the app has login**, log in once in a setup project, save the session with `page.context().storageState({ path })`, and load it in the other projects with `use: { storageState }` and `dependencies: ["setup"]`. Keep one test that logs in through the form.

## Guardrails

The rules are strict on purpose. Fix the cause; don't work around a rule.

- No `any`, no non-null `!`, no unsafe calls on untyped values, no floating promises, exhaustive `switch`.
- Functions up to 60 lines, files up to 300, at most 4 parameters.
- No suppression comments: `oxlint-disable`, `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`.
- Agents can't edit `tsconfig.json`, `.dependency-cruiser.cjs`, `pnpm-workspace.yaml` or `.claude/settings.json`. Agents can edit `.github/` (add workflows, change steps), but the guard checks that `.github/workflows/verify.yml` still runs `pnpm verify` (or split `raw-stack verify --checks` plus `raw-stack verify --browser` when `playwright.config.ts` exists) on every PR and push and `raw-stack snapshots`, with no `continue-on-error` or path filters, and that no workflow passes a retry flag. `vite.config.ts` can add plugins and test settings (keep `test: { ...rawStack().test, ... }`), but not lint settings, and it can't change the test projects, `include`, `exclude`, `retry`, `allowOnly` or snapshot `update`. Test settings go in `vite.config.ts` only: the guard rejects `vitest.config.*`. The guard loads the config and checks what it resolves to. If a rule is wrong, say so in the PR, or open an issue in `ryan-a-wood/raw-stack`.

## The verify loop

Hooks in `.claude/settings.json` run the fast tiers for you in Claude Code:

| When                     | What runs                                                                                                                                                                                                                                | Time        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| After each edit          | Lint the edited file, check it for suppression comments and fast-check settings                                                                                                                                                          | about 0.4 s |
| When you stop            | `vp check --fix`, related `--project unit` tests (properties at 100 runs), dependency-cruiser, module health, config guard. Blocks until it passes. Skipped if nothing changed since the last pass.                                      | 1 to 3 s    |
| Before a PR              | The `verify` skill: `pnpm verify` (everything: unit, property at 1000 runs, e2e, browser), then run the app and check each feature you touched against `FEATURES.md`                                                                     | longer      |
| Periodically / on demand | The `audit` skill (`.claude/skills/audit/SKILL.md`): read-only whole-repo architecture audit (`raw-stack health --json`, test ratios, PR footprints, deep-module rubric) producing ready-to-file refactor issue specs — not for every PR | on demand   |

In other agent harnesses (without Claude Code hooks), run `pnpm exec raw-stack verify` directly after edits for the same fast loop, `pnpm verify` (or `pnpm exec raw-stack verify --checks` and `--browser`) before opening a PR, and `pnpm exec raw-stack health` to inspect the full module health table.

CI (`.github/workflows/verify.yml`) runs `pnpm verify` on every PR and push to `main` (or split `raw-stack verify --checks` and sharded `raw-stack verify --browser` jobs using `PW_SHARD` for larger Playwright suites), and on PRs `raw-stack snapshots`: it lists new, changed and removed snapshots, with the old values, for review.

If the Stop hook blocks, fix what it reports. If it reports the same failure and you've changed nothing, it lets you stop: say what's still failing.

## Work intake

Issues labeled `ready-for-agent` are picked up by this project's hourly routine. Conventions are in the home repo's `docs/intake.md`.
