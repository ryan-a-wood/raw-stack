# app

A TypeScript project on [raw-stack](https://github.com/ryan-a-wood/raw-stack): Vite+ for format, lint, type checks and tests, strict TypeScript, and deep modules enforced by dependency-cruiser.

## Commands

- `vp check`: format (Oxfmt), lint (Oxlint, type-aware) and type check. `vp check --fix` fixes formatting and fixable lint.
- `vp test`: run the tests (Vitest). Import test APIs from `vite-plus/test`. `vp test --project unit` or `--project e2e` runs one kind.
- `pnpm verify`: the full verify tier, e2e tests included. Run it before opening a PR. CI (`.github/workflows/ci.yml`) runs it on every PR and push to `main`.
- `node src/main.ts`: run the app. Node runs the TypeScript directly.

## Code layout: deep modules

- Features live in `src/modules/<name>/`. A module's `index.ts` is its whole interface. Every other file in the folder is private to it.
- Import another module only through its `index.ts`. dependency-cruiser fails the check otherwise.
- Aim for few modules with small interfaces that hide a lot. Test a module through its `index.ts`, with the test file inside the module folder.
- `src/main.ts` is the entry point. Files nothing imports fail the check, so delete dead code.
- Imports use the `.ts` extension: `import { greet } from "./modules/greeting/index.ts"`.

## Tests

- **E2e tests come first.** `e2e/` holds tests that run the real app and check what the user sees, one per feature in `FEATURES.md`. They are the hardest tests to fool: the feature either works or it doesn't. A new feature gets its `FEATURES.md` entry and its e2e test in the same change.
- **Unit tests** live next to the code in `src/modules/<name>/` and test a module through its `index.ts`.
- E2e tests don't import from `src/`, so the Stop hook doesn't run them. `pnpm verify` and CI do.

## Guardrails

The rules are strict on purpose. Fix the cause; don't work around a rule.

- No `any`, no non-null `!`, no unsafe calls on untyped values, no floating promises, exhaustive `switch`.
- Functions up to 60 lines, files up to 300, at most 4 parameters.
- No suppression comments: `oxlint-disable`, `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`.
- Agents can't edit `tsconfig.json`, `.dependency-cruiser.cjs`, `pnpm-workspace.yaml` or `.claude/settings.json`. `vite.config.ts` can add plugins and test settings but not lint settings. If a rule is wrong, say so in the PR, or open an issue in `ryan-a-wood/raw-stack`.

## The verify loop

Hooks in `.claude/settings.json` run the fast tiers for you:

| When            | What runs                                                                                                                                                   | Time        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| After each edit | Lint the edited file, check it for suppression comments                                                                                                     | about 0.4 s |
| When you stop   | `vp check --fix`, tests related to changed files, dependency-cruiser, config guard. Blocks until it passes. Skipped if nothing changed since the last pass. | 1 to 3 s    |
| Before a PR     | The `verify` skill: `pnpm verify` (everything, unit and e2e tests), then run the app and check each feature you touched against `FEATURES.md`               | longer      |

If the Stop hook blocks, fix what it reports. If it reports the same failure and you've changed nothing, it lets you stop: say what's still failing.

## Work intake

Issues labeled `ready-for-agent` are picked up by this project's hourly routine. Conventions are in the home repo's `docs/intake.md`.
