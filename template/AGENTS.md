# app

A TypeScript project on [raw-stack](https://github.com/ryan-a-wood/raw-stack): Vite+ for format, lint, type checks and tests, strict TypeScript, and deep modules enforced by dependency-cruiser.

## Commands

- `vp check`: format (Oxfmt), lint (Oxlint, type-aware) and type check. `vp check --fix` fixes formatting and fixable lint.
- `vp test`: run the tests (Vitest). Import test APIs from `vite-plus/test`. `vp test --project unit` or `--project e2e` runs one kind.
- `pnpm verify`: the full verify tier, e2e tests included. Run it before opening a PR.
- `node src/main.ts`: run the app. Node runs the TypeScript directly.

## Code layout: deep modules

- Features live in `src/modules/<name>/`. A module's `index.ts` is its whole interface. Every other file in the folder is private to it.
- Import another module only through its `index.ts`. dependency-cruiser fails the check otherwise.
- Aim for few modules with small interfaces that hide a lot. Test a module through its `index.ts`, with the test file inside the module folder.
- `src/main.ts` is the entry point. Files nothing imports fail the check, so delete dead code.
- Imports use the `.ts` extension: `import { greet } from "./modules/greeting/index.ts"`.

## Tests

- **E2e tests come first.** `e2e/` holds tests that run the real app and check what the user sees, one per feature in `FEATURES.md`. They are the hardest tests to fool: the feature either works or it doesn't. A new feature gets its `FEATURES.md` entry and its e2e test in the same change.
- **Property tests** come next. A property test states a rule that holds for every input, and [fast-check](https://fast-check.dev) tries many generated inputs to break it, then shrinks a failure to the smallest case. Write one for any module with logic over a wide input space: parsing, formatting, math, state transitions, anything with a round trip (`decode(encode(x))` equals `x`). They are unit tests, named `<name>.property.test.ts` next to the module. See `src/modules/greeting/greeting.property.test.ts`.
- raw-stack sets how many inputs each property tries: 100 in the fast tier, 1000 in `pnpm verify`. Don't set `numRuns`, `seed`, `path` or time limits: the guard fails on them. When a property fails, fix the code, or the property if the rule was wrong. You can replay the reported seed while debugging, then remove it.
- **Expect tests** (inline snapshots) record what the app printed and fail when it changes. Use them in `e2e/` for output that's tedious to write by hand: CLI output, rendered pages, error text, API responses. Write `expect(output).toMatchInlineSnapshot()` empty, run `vp test --project e2e` to fill it in, then read what it recorded and check it against `FEATURES.md`: whatever it recorded becomes the expected output. Only inline snapshots, only in `e2e/`: the guard rejects them in unit tests, where they would only copy the code, and rejects snapshot files.
- **Don't change a recorded snapshot yourself** unless the output is meant to change. If it is, update it, say why in the PR, and leave approval to a maintainer: CI fails on any edited or removed snapshot until a maintainer adds the `snapshots-approved` label. Never add that label. `pnpm verify` never writes snapshots, so an empty one fails there.
- **Unit tests** live next to the code in `src/modules/<name>/` and test a module through its `index.ts`. Use examples for the cases a property can't express.
- E2e tests don't import from `src/`, so the Stop hook doesn't run them. `pnpm verify` and CI do. For a UI, e2e tests drive a browser: see Browser tests below.
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

3. Name browser tests `e2e/<feature>.spec.ts`. Vitest runs `e2e/**/*.test.ts` and Playwright runs `*.spec.ts`, so they don't overlap. `pnpm verify` and CI run both. CI installs and caches the browsers.

`rawStackPlaywright()` sets what keeps the suite fast and honest, and the guard fails if `playwright.config.ts` changes it: tests run in parallel, even within a file (`fullyParallel`); only Chromium runs locally, and every browser runs in CI; a trace is kept only for a failed test; no retries; `.only` fails in CI. `projects` and `use` can be extended, for example with a login setup project.

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
- Agents can't edit `tsconfig.json`, `.dependency-cruiser.cjs`, `pnpm-workspace.yaml`, `.claude/settings.json` or `.github/`. `vite.config.ts` can add plugins and test settings (keep `test: { ...rawStack().test, ... }`), but not lint settings, and it can't change the test projects, `include`, `exclude`, `retry`, `allowOnly` or snapshot `update`. Test settings go in `vite.config.ts` only: the guard rejects `vitest.config.*`. The guard loads the config and checks what it resolves to. If a rule is wrong, say so in the PR, or open an issue in `ryan-a-wood/raw-stack`.

## The verify loop

Hooks in `.claude/settings.json` run the fast tiers for you:

| When            | What runs                                                                                                                                                                            | Time        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| After each edit | Lint the edited file, check it for suppression comments and fast-check settings                                                                                                      | about 0.4 s |
| When you stop   | `vp check --fix`, tests related to changed files (properties at 100 runs), dependency-cruiser, config guard. Blocks until it passes. Skipped if nothing changed since the last pass. | 1 to 3 s    |
| Before a PR     | The `verify` skill: `pnpm verify` (everything: unit, property at 1000 runs, e2e), then run the app and check each feature you touched against `FEATURES.md`                          | longer      |

CI (`.github/workflows/verify.yml`) runs `pnpm verify` on every PR and push to `main`, and on PRs `raw-stack snapshots`: it lists new snapshots for review and fails on changed or removed ones until the PR has the `snapshots-approved` label.

If the Stop hook blocks, fix what it reports. If it reports the same failure and you've changed nothing, it lets you stop: say what's still failing.

## Work intake

Issues labeled `ready-for-agent` are picked up by this project's hourly routine. Conventions are in the home repo's `docs/intake.md`.
