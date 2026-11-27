---
name: audit
description: Run a read-only whole-repo architecture audit against raw-stack's deep-module and vertical-slice principles, outputting a health summary and ready-to-file refactor issue specs. Use periodically or on demand, not on every PR.
---

# Audit

Periodic, whole-repo architecture review. Checks whether the codebase is staying aligned with raw-stack's deep-module and vertical-slice principles as it grows, and turns real structural drift into concrete refactor issues.

**Strictly read-only.** Do not edit files, run `--fix`, or make drive-by cleanups during an audit. Collect evidence, inspect the code, and produce the report.

## 1. Deterministic telemetry first

Gather hard numbers before reading files or forming opinions:

1. **Module health.** Run `pnpm exec raw-stack health --json`. Capture `thresholds`, `warnings[]` (`prod-files`, `index-exports`, `sibling-fan-out`, `unused-exports`), and every entry in `modules[]`:
   - `prodFiles` and `prodLoc` (default warning: `> 20` prod files)
   - `exports`: `total`, `usedByProd`, `testOnly`, `unused` (default warning: `> 25` total exports, or any `unused`)
   - `siblingFanOut`: `count`, `totalSiblings`, `ratio`, `percent`, `modules` (default warning: `> 50%` when `totalSiblings >= 2`)

   `raw-stack health` aggregates at the top-level `src/modules/<mod>/` directory. Whenever a module already has submodules (`src/modules/<mod>/<submod>/index.ts(x)`), also count per-submodule prod files and LOC directly, and check `.dependency-cruiser.cjs` to see whether `deepSubmodules` and `clientBoundary` are wired up where needed.

2. **Fast-loop unit test coverage ratios.** For each module under `src/modules/`, compare `*.test.ts(x)` LOC against `prodLoc`. Flag fast-loop coverage blind spots — especially UI, route, or web modules with large `prodLoc` and minimal or zero unit tests, since the Stop hook (`raw-stack verify`) runs `--project unit` only and leaves untested modules with no behavioral feedback until `pnpm verify` or CI.

3. **Recent feature PR footprints.** Run `git log --stat -n 20` (or `--first-parent --stat -n 20` on merge-commit histories) and count how many modules under `src/modules/` each feature change touches. Flag high cross-module blast radius (features routinely touching 4+ modules) and shared hub bottlenecks that show up in most feature changes.

4. **File-split smells and 300-line ceiling clustering.** Scan `src/` for:
   - Mechanical split suffixes: `*-methods.ts`, `*-views.tsx`, `*-stage.tsx`, `*-sections.tsx`, `*-styles.ts`, or CSS-in-TS fragments/sprawl where `.css` or data files belong.
   - Production files clustering near the `max-lines: 300` ceiling (e.g. 260–300 non-blank, non-comment lines), which often indicates code is being crammed or mechanically shaved to dodge the limit instead of split by concept.

5. **`FEATURES.md` and `e2e/` alignment.** Check `FEATURES.md` length and feature count:
   - Past ~10–15 features, flag bloat and recommend splitting into `features/<name>.md` with `FEATURES.md` as a short index.
   - Verify every feature listed in `FEATURES.md` (and `features/*.md`, if present) maps cleanly to an existing `e2e/` test (`*.test.ts` or `*.spec.ts`), and flag orphaned e2e tests or undocumented features.

## 2. Semantic architecture rubric

Read the flagged modules, their `index.ts(x)` surfaces, and the entry points (`src/main.ts(x)`, `src/browser.ts(x)`). Numbers surface candidates; code reading confirms whether the structure is actually wrong.

Evaluate against Ousterhout's deep-module principle (small, clean interfaces hiding real complexity) and vertical feature ownership:

- **Vertical ownership vs. horizontal layer drift.** Is the composition root (`src/main.ts`, `src/browser.tsx`) and app/web shell kept thin (auth, layout, HTTP helpers, route registry), while each feature module owns its domain, routes, pages, styles, and `client.ts` / `*.client.tsx` islands? Flag horizontal buckets (`web`, `routes`, `components`, `services`, `utils`, `shared`, `types`) absorbing feature logic.
- **Cohesion and split readiness.**
  - Inside modules still under the 20-file cap, look for mixed, unrelated responsibilities that should be separated into sibling modules.
  - For modules approaching the 15–20 prod-file or 25-export caps that belong to one domain, evaluate a cohesive 1-level submodule split (`src/modules/<mod>/<submod>/index.ts` enforced with `deepSubmodules` from `raw-stack/dependency-cruiser-rules`).
- **Boundary leaks and duplication.** Look for domain logic leaking into HTTP routes, UI event handlers, or across module boundaries, and for duplicated rules or types across sibling modules that point to a missing or misplaced boundary.
- **Interface depth.** Inspect `index.ts` exports for wide or chatty surfaces, pass-through wrappers, unused exports, or `testOnly` exports added solely for property tests (prefer white-box `*.property.test.ts` inside the module or a small focused pure-algorithm module instead of widening `index.ts`).

## 3. Output format

Keep the report concise, evidence-backed, and directly actionable. Do not pad with trivial nits. If the codebase is healthy and nothing warrants a dedicated refactor PR, say so plainly.

### Health summary

Include a compact Markdown table combining the telemetry for every module (plus submodule rows where present):

| Module | Prod files | Prod LOC | Test LOC (ratio) | Exports (prod / test / unused) | Fan-out | Smells / near-300 |
| ------ | ---------: | -------: | ---------------: | -----------------------------: | ------: | ----------------- |

Follow the table with brief bullets for:

- `raw-stack health` warnings (if any)
- Git footprint findings (average/max modules touched across the last 20 changes, recurring hub files)
- `FEATURES.md` / `e2e/` size and mapping drift

### Prioritized refactor proposals

List only concrete refactors worth a dedicated PR, ordered by impact (`P1` highest to `P3`). Write each proposal as a ready-to-file GitHub issue spec suitable for handing straight to `innerloop`:

```markdown
### [P1] <Imperative issue title>

**Motivation**
<What is wrong, backed by telemetry numbers, file paths, and commit footprints.>

**Scope**

- In scope: <exact modules/files to change>
- Out of scope: <explicit non-goals to keep the PR focused>

**Target boundaries**
<Desired module/submodule layout, public `index.ts` surface, and any `.dependency-cruiser.cjs` preset updates (`clientBoundary`, `deepSubmodules`).>

**Verification**

- `pnpm verify` passes (lint, types, unit/property, e2e, browser, dependency-cruiser, guard).
- `pnpm exec raw-stack health` shows <expected improvement, e.g. prod files / exports / fan-out / unused exports>.
- <Specific unit, property, or e2e test expectations.>
```
