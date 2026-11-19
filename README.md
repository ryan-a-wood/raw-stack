# raw-stack

Guardrails for TypeScript projects on [Vite+](https://viteplus.dev), built so agents find their mistakes fast:

- **Strict TypeScript** (TS 7): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly` and more.
- **Type-aware Oxlint**, every finding an error: no `any`, no unsafe calls, no floating promises, exhaustive switches, size limits.
- **Deep modules** enforced by dependency-cruiser: each `src/modules/<name>/index.ts` is the module's only way in. Also no cycles, orphans, undeclared deps or dev deps in shipped code.
- **Guard**: no suppression comments, and project config can't loosen the shared rules. It loads `vite.config.ts` and checks the resolved test settings, so a project can't drop the unit or e2e test projects or narrow which tests they run.
- **Claude Code hooks** for a tiered verify loop: lint after each edit (about 0.4 s), the fast tier on Stop (1 to 3 s, blocking), the full tier before a PR.
- **E2e first**: the template has an `e2e/` test project that runs the real app, a `FEATURES.md` map of what the app does, and a `verify` skill that drives both.
- **Property tests**: [fast-check](https://fast-check.dev) generates inputs and checks a rule holds for all of them. raw-stack sets the run count (100 per property, 1000 in the full tier), and the guard rejects `numRuns`, `seed` and the other settings that weaken a property.

This repo is two things:

- The package `raw-stack` at the root: the shared config, the `raw-stack` CLI and the hook scripts. Projects install it as a git dependency pinned to a tag, so updating every project is a tag bump.
- `template/`: the starter project.

## Start a project

```bash
pnpm dlx giget@3 gh:ryan-a-wood/raw-stack/template#v0.3.0 my-app
cd my-app && git init && pnpm install
```

Then rename the package in `package.json` and the heading in `AGENTS.md`.

## Update a project

Change the tag in `package.json` (`"raw-stack": "github:ryan-a-wood/raw-stack#v0.3.0"`) and run `pnpm install`.

## CLI

- `raw-stack verify`: fast tier. `vp check --fix`, tests related to files changed on this branch, dependency-cruiser on `src/`, guard.
- `raw-stack verify --full`: everything, no fixes: unit tests with 1000 runs per property test, the e2e tests in `e2e/` (they run the real app), plus the rest.
- `raw-stack guard [files...]`: suppression comments, fast-check settings that weaken a property, and config overrides.

## Working on raw-stack

`scripts/try-template.sh [dir]` copies the template, points it at this checkout, installs and runs the full tier. Run it after every change. CI (`.github/workflows/ci.yml`) runs it on every PR and push to `main`.

To edit the template with type checking in your editor, run `scripts/install-template.sh` once. It installs `template/` in place with `raw-stack` linked to this checkout. Without it the editor can't resolve `raw-stack/tsconfig.json` or `vite-plus`, so it falls back to default compiler options and flags every `.ts` import. To release, tag `vX.Y.Z`, push the tag, and bump the ref in `template/package.json`.
