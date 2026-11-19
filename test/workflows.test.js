// @ts-check
// Agents can edit .github/, so the guard checks the template's verify workflow
// still runs verify and the label-gated snapshot check. Each case starts from
// the real template workflow and breaks one thing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { verifyWorkflowProblems, VERIFY_WORKFLOW } from "../lib/workflows.js";

const TEMPLATE = readFileSync(new URL(`../template/${VERIFY_WORKFLOW}`, import.meta.url), "utf8");

/** @param {string | undefined} workflow */
function problemsFor(workflow) {
  const root = mkdtempSync(join(tmpdir(), "raw-stack-workflow-"));
  try {
    if (workflow !== undefined) {
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(join(root, VERIFY_WORKFLOW), workflow);
    }
    return verifyWorkflowProblems(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** @param {string} from @param {string} to */
const edit = (from, to) => {
  assert.ok(TEMPLATE.includes(from), `template has ${from}`);
  return TEMPLATE.replace(from, to);
};

describe("verify workflow guard", () => {
  test("accepts the template workflow", () => {
    assert.deepEqual(problemsFor(TEMPLATE), []);
  });

  test("accepts other edits, like a new step", () => {
    assert.deepEqual(problemsFor(edit("      - run: pnpm verify\n", "      - run: pnpm build\n      - run: pnpm verify\n")), []);
  });

  const broken = {
    "missing workflow": [undefined, /is missing/],
    "verify step removed": [edit("      - run: pnpm verify\n", ""), /run: pnpm verify/],
    "verify made to pass": [edit("run: pnpm verify\n", "run: pnpm verify || true\n"), /run: pnpm verify/],
    "snapshot check removed": [edit("run: pnpm exec raw-stack snapshots", "run: echo skipped"), /raw-stack snapshots/],
    "no pull_request trigger": [edit("  pull_request:\n", "  workflow_dispatch:\n"), /pull_request/],
    "continue-on-error": [edit("      - run: pnpm verify\n", "      - run: pnpm verify\n        continue-on-error: true\n"), /continue-on-error/],
    "paths-ignore": [edit("    branches: [main]\n", "    branches: [main]\n    paths-ignore: ['src/**']\n"), /paths-ignore/],
    "always approved": [edit('$BASE" $APPROVED', '$BASE" --approved'), /snapshots-approved label/],
    "approved by another label": [edit("'snapshots-approved'", "'lgtm'"), /snapshots-approved label/],
  };
  for (const [name, [workflow, expected]] of Object.entries(broken)) {
    test(`rejects ${name}`, () => {
      const problems = problemsFor(/** @type {string | undefined} */ (workflow));
      assert.ok(problems.some((p) => /** @type {RegExp} */ (expected).test(p)), problems.join("\n") || "no problems");
    });
  }
});
