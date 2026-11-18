# raw-stack

Guardrails for TypeScript projects on [Vite+](https://viteplus.dev), built so agents find their mistakes fast:

- **Strict TypeScript** (TS 7): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly` and more.
- **Type-aware Oxlint**, every finding an error: no `any`, no unsafe calls, no floating promises, exhaustive switches, size limits.
- **Deep modules** enforced by dependency-cruiser: each `src/modules/<name>/index.ts` is the module's only way in. Also no cycles, orphans, undeclared deps or dev deps in shipped code.
- **Guard**: no suppression comments, and project config can't loosen the shared rules.
- **Claude Code hooks** for a tiered verify loop: lint after each edit (about 0.4 s), the fast tier on Stop (1 to 3 s, blocking), the full tier before a PR.

This repo is two things:

- The package `raw-stack` at the root: the shared config, the `raw-stack` CLI and the hook scripts. Projects install it as a git dependency pinned to a tag, so updating every project is a tag bump.
- `template/`: the starter project.

## Start a project

```bash
pnpm dlx giget@3 gh:ryan-a-wood/raw-stack/template#v0.1.0 my-app
cd my-app && git init && pnpm install
```

Then rename the package in `package.json` and the heading in `AGENTS.md`.

## Update a project

Change the tag in `package.json` (`"raw-stack": "github:ryan-a-wood/raw-stack#v0.2.0"`) and run `pnpm install`.

## CLI

- `raw-stack verify`: fast tier. `vp check --fix`, tests related to files changed on this branch, dependency-cruiser on `src/`, guard.
- `raw-stack verify --full`: everything, all tests, no fixes.
- `raw-stack guard [files...]`: suppression comments and config overrides.

## Working on raw-stack

`scripts/try-template.sh [dir]` copies the template, points it at this checkout, installs and runs the full tier. Run it after every change.

To edit the template with type checking in your editor, run `scripts/install-template.sh` once. It installs `template/` in place with `raw-stack` linked to this checkout. Without it the editor can't resolve `raw-stack/tsconfig.json` or `vite-plus`, so it falls back to default compiler options and flags every `.ts` import. To release, tag `vX.Y.Z`, push the tag, and bump the ref in `template/package.json`.
