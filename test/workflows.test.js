// @ts-check
// Agents can edit .github/, so the guard checks the verify workflow still runs
// verify (monolithic `pnpm verify` or split `--checks` + `--browser`) and the
// snapshot report, with no looseners or retry flags.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { verifyWorkflowProblems, VERIFY_WORKFLOW } from "../lib/workflows.js";

const TEMPLATE = readFileSync(new URL(`../template/${VERIFY_WORKFLOW}`, import.meta.url), "utf8");

/**
 * @param {string | undefined} workflow
 * @param {{ playwright?: boolean, scripts?: Record<string, string> }} [options]
 */
function problemsFor(workflow, { playwright = false, scripts } = {}) {
  const root = mkdtempSync(join(tmpdir(), "raw-stack-workflow-"));
  try {
    if (workflow !== undefined) {
      mkdirSync(join(root, ".github", "workflows"), { recursive: true });
      writeFileSync(join(root, VERIFY_WORKFLOW), workflow);
    }
    if (playwright) {
      writeFileSync(join(root, "playwright.config.ts"), "export default {};\n");
    }
    if (scripts !== undefined) {
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "app", scripts }, null, 2));
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

const SPLIT_CHECKS_ONLY = `name: verify
on:
  pull_request:
  push:
    branches: [main]
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm exec raw-stack verify --checks
      - name: snapshots
        if: github.event_name == 'pull_request'
        run: pnpm exec raw-stack snapshots --base "origin/\${{ github.base_ref }}"
`;

const SPLIT_DIRECT_WITH_BROWSER = `name: verify
on:
  pull_request:
  push:
    branches: [main]
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm exec raw-stack verify --checks
      - name: snapshots
        if: github.event_name == 'pull_request'
        run: pnpm exec raw-stack snapshots --base "origin/\${{ github.base_ref }}"
  browser:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        shard: [1, 2, 3, 4]
    steps:
      - env:
          PW_SHARD: \${{ matrix.shard }}/\${{ strategy.job-total }}
        run: pnpm exec raw-stack verify --browser
`;

const SPLIT_SCRIPT_WITH_BROWSER = `name: verify
on:
  pull_request:
  push:
    branches: [main]
jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm verify:checks
      - name: snapshots
        if: github.event_name == 'pull_request'
        run: pnpm exec raw-stack snapshots --base "origin/\${{ github.base_ref }}"
  browser:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm verify:browser
`;

describe("verify workflow guard", () => {
  test("accepts the template workflow", () => {
    assert.deepEqual(problemsFor(TEMPLATE), []);
    assert.deepEqual(problemsFor(TEMPLATE, { playwright: true }), []);
  });

  test("accepts other edits, like a new step", () => {
    assert.deepEqual(problemsFor(edit("      - run: pnpm verify\n", "      - run: pnpm build\n      - run: pnpm verify\n")), []);
  });

  test("accepts monolithic pnpm exec raw-stack verify --full", () => {
    assert.deepEqual(
      problemsFor(edit("      - run: pnpm verify\n", "      - run: pnpm exec raw-stack verify --full\n"), { playwright: true }),
      [],
    );
  });

  test("accepts split --checks alone when playwright.config.ts does not exist", () => {
    assert.deepEqual(problemsFor(SPLIT_CHECKS_ONLY, { playwright: false }), []);
  });

  test("accepts split --checks + sharded --browser (pnpm exec form) when playwright.config.ts exists", () => {
    assert.deepEqual(problemsFor(SPLIT_DIRECT_WITH_BROWSER, { playwright: true }), []);
  });

  test("accepts split pnpm verify:checks + pnpm verify:browser with valid package.json scripts", () => {
    const scripts = {
      "verify:checks": "raw-stack verify --checks",
      "verify:browser": "raw-stack verify --browser",
    };
    assert.deepEqual(problemsFor(SPLIT_SCRIPT_WITH_BROWSER, { playwright: true, scripts }), []);
    assert.deepEqual(problemsFor(SPLIT_SCRIPT_WITH_BROWSER, { playwright: false, scripts }), []);

    const withRun = SPLIT_SCRIPT_WITH_BROWSER.replace("pnpm verify:checks", "pnpm run verify:checks").replace(
      "pnpm verify:browser",
      "pnpm run verify:browser",
    );
    assert.deepEqual(problemsFor(withRun, { playwright: true, scripts }), []);
  });

  test("accepts the documented split example from template/.github/workflows/verify.yml", () => {
    const marker = "  # checks:\n";
    const start = TEMPLATE.indexOf(marker);
    assert.ok(start !== -1, "template documents commented split checks + browser example");
    const header = TEMPLATE.slice(0, TEMPLATE.indexOf("  verify:\n"));
    const uncommented = TEMPLATE.slice(start)
      .split("\n")
      .map((line) => line.replace(/^  # ?/, "  "))
      .join("\n");
    assert.deepEqual(problemsFor(header + uncommented, { playwright: true }), []);
  });

  const broken = {
    "missing workflow": [undefined, {}, /is missing/],
    "verify step removed": [edit("      - run: pnpm verify\n", ""), {}, /run: pnpm verify/],
    "verify made to pass": [edit("run: pnpm verify\n", "run: pnpm verify || true\n"), {}, /run: pnpm verify/],
    "snapshot check removed": [edit("run: pnpm exec raw-stack snapshots", "run: echo skipped"), {}, /raw-stack snapshots/],
    "snapshot check hidden in comment": [
      edit('run: pnpm exec raw-stack snapshots --base "$BASE"', "run: echo ok # raw-stack snapshots"),
      {},
      /raw-stack snapshots/,
    ],
    "no pull_request trigger": [edit("  pull_request:\n", "  workflow_dispatch:\n"), {}, /pull_request/],
    "no push trigger": [edit("  push:\n    branches: [main]\n", ""), {}, /push/],
    "continue-on-error": [edit("      - run: pnpm verify\n", "      - run: pnpm verify\n        continue-on-error: true\n"), {}, /continue-on-error/],
    "paths": [edit("  pull_request:\n", "  pull_request:\n    paths: ['src/**']\n"), {}, /"paths"/],
    "paths-ignore": [edit("    branches: [main]\n", "    branches: [main]\n    paths-ignore: ['src/**']\n"), {}, /paths-ignore/],
    "branches-ignore": [edit("    branches: [main]\n", "    branches-ignore: ['docs/**']\n"), {}, /branches-ignore/],
    "retry flag on another step": [
      edit("      - run: pnpm verify\n", "      - run: pnpm verify\n      - run: pnpm exec playwright test --retries 2\n"),
      {},
      /retry flag/i,
    ],
    "split checks dropped (browser only)": [
      SPLIT_DIRECT_WITH_BROWSER.replace("      - run: pnpm exec raw-stack verify --checks\n", ""),
      { playwright: true },
      /checks step/,
    ],
    "split browser dropped when playwright.config.ts exists": [
      SPLIT_CHECKS_ONLY,
      { playwright: true },
      /browser step.*playwright\.config\.ts/,
    ],
    "split checks || true": [
      SPLIT_DIRECT_WITH_BROWSER.replace("verify --checks", "verify --checks || true"),
      { playwright: true },
      /checks step/,
    ],
    "split browser || true": [
      SPLIT_DIRECT_WITH_BROWSER.replace("verify --browser", "verify --browser || true"),
      { playwright: true },
      /browser step/,
    ],
    "split browser --retries": [
      SPLIT_DIRECT_WITH_BROWSER.replace("verify --browser", "verify --browser --retries=2"),
      { playwright: true },
      /retry flag/i,
    ],
    "missing package.json for verify:checks": [
      SPLIT_SCRIPT_WITH_BROWSER,
      { playwright: true },
      /package\.json script "verify:checks"/,
    ],
    "tampered verify:checks script (|| true)": [
      SPLIT_SCRIPT_WITH_BROWSER,
      {
        playwright: true,
        scripts: {
          "verify:checks": "raw-stack verify --checks || true",
          "verify:browser": "raw-stack verify --browser",
        },
      },
      /package\.json script "verify:checks"/,
    ],
    "tampered verify:checks script (wrong command)": [
      SPLIT_SCRIPT_WITH_BROWSER,
      {
        playwright: true,
        scripts: {
          "verify:checks": "raw-stack verify",
          "verify:browser": "raw-stack verify --browser",
        },
      },
      /package\.json script "verify:checks"/,
    ],
    "tampered verify:browser script (|| true)": [
      SPLIT_SCRIPT_WITH_BROWSER,
      {
        playwright: true,
        scripts: {
          "verify:checks": "raw-stack verify --checks",
          "verify:browser": "raw-stack verify --browser || true",
        },
      },
      /package\.json script "verify:browser"/,
    ],
    "tampered verify:browser script even without playwright.config.ts": [
      SPLIT_SCRIPT_WITH_BROWSER,
      {
        playwright: false,
        scripts: {
          "verify:checks": "raw-stack verify --checks",
          "verify:browser": "echo skipped",
        },
      },
      /package\.json script "verify:browser"/,
    ],
    "tampered verify:checks script with retry flag": [
      SPLIT_SCRIPT_WITH_BROWSER,
      {
        playwright: true,
        scripts: {
          "verify:checks": "raw-stack verify --checks --retry 2",
          "verify:browser": "raw-stack verify --browser",
        },
      },
      /package\.json script "verify:checks"/,
    ],
  };

  for (const [name, [workflow, opts, expected]] of Object.entries(broken)) {
    test(`rejects ${name}`, () => {
      const problems = problemsFor(
        /** @type {string | undefined} */ (workflow),
        /** @type {{ playwright?: boolean, scripts?: Record<string, string> }} */ (opts),
      );
      assert.ok(problems.some((p) => /** @type {RegExp} */ (expected).test(p)), problems.join("\n") || "no problems");
    });
  }
});
