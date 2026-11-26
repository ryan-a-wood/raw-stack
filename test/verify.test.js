// @ts-check
// Tests for raw-stack verify modes (--checks, --browser, --full), CLI flag
// validation, sequencing (Playwright after checks), and browser-test skip env vars.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { browserTestsOffForThisRun, verifyBrowser, verifyChecks, verifyFull } from "../lib/verify.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(REPO_ROOT, "bin", "raw-stack.js");
const TEMPLATE_WORKFLOW = readFileSync(join(REPO_ROOT, "template", ".github", "workflows", "verify.yml"), "utf8");

/**
 * @param {{
 *   playwright?: boolean,
 *   vpDelayMs?: number,
 *   vpFailSubcommand?: string,
 *   playwrightFail?: boolean,
 * }} [options]
 */
function createFakeProject({ playwright = false, vpDelayMs = 0, vpFailSubcommand = "", playwrightFail = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "raw-stack-verify-"));
  const logFile = join(root, "events.log");

  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  symlinkSync(REPO_ROOT, join(root, "node_modules", "raw-stack"), "dir");

  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fake-app", type: "module" }, null, 2));
  writeFileSync(join(root, "src", "main.ts"), "export const answer = 42;\n");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ extends: "raw-stack/tsconfig.json" }, null, 2));
  writeFileSync(
    join(root, "vite.config.ts"),
    'import { rawStack } from "raw-stack/vite";\nexport default { ...rawStack() };\n',
  );
  writeFileSync(
    join(root, ".dependency-cruiser.cjs"),
    'module.exports = { extends: require.resolve("raw-stack/dependency-cruiser") };\n',
  );
  writeFileSync(join(root, ".github", "workflows", "verify.yml"), TEMPLATE_WORKFLOW);

  if (playwright) {
    writeFileSync(
      join(root, "playwright.config.ts"),
      'import { rawStackPlaywright } from "raw-stack/playwright";\nexport default { ...rawStackPlaywright() };\n',
    );
  }

  const fakeVp = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const tag = args.join(" ");
const runs = process.env.RAW_STACK_PROPERTY_RUNS ?? "";
appendFileSync(${JSON.stringify(logFile)}, \`start:vp \${tag} runs=\${runs}\\n\`);
const delay = ${vpDelayMs};
if (delay > 0) await new Promise((r) => setTimeout(r, delay));
appendFileSync(${JSON.stringify(logFile)}, \`end:vp \${tag}\\n\`);
if (${JSON.stringify(vpFailSubcommand)} && args[0] === ${JSON.stringify(vpFailSubcommand)}) {
  console.error("simulated vp failure");
  process.exit(1);
}
`;
  const vpPath = join(root, "node_modules", ".bin", "vp");
  writeFileSync(vpPath, fakeVp);
  chmodSync(vpPath, 0o755);

  const fakePlaywright = `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
const tag = args.join(" ");
appendFileSync(${JSON.stringify(logFile)}, \`start:playwright \${tag}\\n\`);
appendFileSync(${JSON.stringify(logFile)}, \`end:playwright \${tag}\\n\`);
if (${JSON.stringify(playwrightFail)}) {
  console.error("simulated playwright failure");
  process.exit(1);
}
`;
  const pwPath = join(root, "node_modules", ".bin", "playwright");
  writeFileSync(pwPath, fakePlaywright);
  chmodSync(pwPath, 0o755);

  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });

  return {
    root,
    events: () => (readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean)),
    hasEvents: () => {
      try {
        return readFileSync(logFile, "utf8").trim().length > 0;
      } catch {
        return false;
      }
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** @param {string} cwd @param {string[]} args @param {Record<string, string | undefined>} [env] */
function runCli(cwd, args, env = {}) {
  const merged = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd,
      env: merged,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = /** @type {{ status?: number, stdout?: string, stderr?: string }} */ (err);
    return { status: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("browser tests off on PRs", () => {
  test("skips them on a PR run when off", () => {
    assert.equal(browserTestsOffForThisRun({ RAW_STACK_PR_BROWSER_TESTS: "off", GITHUB_EVENT_NAME: "pull_request" }), true);
  });

  test("runs them on the push to main even when off", () => {
    assert.equal(browserTestsOffForThisRun({ RAW_STACK_PR_BROWSER_TESTS: "off", GITHUB_EVENT_NAME: "push" }), false);
  });

  test("runs them locally, outside CI, even when off", () => {
    assert.equal(browserTestsOffForThisRun({ RAW_STACK_PR_BROWSER_TESTS: "off" }), false);
  });

  test("runs them on PRs by default", () => {
    assert.equal(browserTestsOffForThisRun({ GITHUB_EVENT_NAME: "pull_request" }), false);
  });

  test("skips them on the push to main when main is off", () => {
    assert.equal(browserTestsOffForThisRun({ RAW_STACK_MAIN_BROWSER_TESTS: "off", GITHUB_EVENT_NAME: "push" }), true);
  });

  test("runs them on PRs when only main is off", () => {
    assert.equal(browserTestsOffForThisRun({ RAW_STACK_MAIN_BROWSER_TESTS: "off", GITHUB_EVENT_NAME: "pull_request" }), false);
  });

  test("runs them locally when main is off", () => {
    assert.equal(browserTestsOffForThisRun({ RAW_STACK_MAIN_BROWSER_TESTS: "off" }), false);
  });

  test("runs them for any other value", () => {
    assert.equal(browserTestsOffForThisRun({ RAW_STACK_PR_BROWSER_TESTS: "false", GITHUB_EVENT_NAME: "pull_request" }), false);
  });
});

describe("verify split modes and sequencing", () => {
  test("verifyChecks runs non-browser checks at 1000 property runs and skips Playwright", async () => {
    const project = createFakeProject({ playwright: true });
    try {
      const steps = await verifyChecks(project.root);
      assert.equal(steps.every((s) => s.ok), true, steps.map((s) => `${s.label}: ${s.output}`).join("\n"));
      assert.deepEqual(
        steps.map((s) => s.label),
        ["vp check", "vp test unit (1000 property runs)", "vp test e2e", "dependency-cruiser", "guard"],
      );
      const events = project.events();
      assert.ok(events.some((e) => e === "start:vp check runs="));
      assert.ok(events.some((e) => e === "start:vp test run --project unit --update=none runs=1000"));
      assert.ok(events.some((e) => e === "start:vp test run --project e2e --update=none runs="));
      assert.ok(!events.some((e) => e.includes("playwright")), `unexpected playwright event: ${events.join("\n")}`);
    } finally {
      project.cleanup();
    }
  });

  test("verifyBrowser skips cleanly with a message when playwright.config.ts does not exist", async () => {
    const project = createFakeProject({ playwright: false });
    try {
      const steps = await verifyBrowser(project.root);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]?.ok, true);
      assert.match(steps[0]?.label ?? "", /skipped.*playwright\.config\.ts/i);
      assert.equal(project.hasEvents(), false);
    } finally {
      project.cleanup();
    }
  });

  test("verifyBrowser runs only Playwright when playwright.config.ts exists", async () => {
    const project = createFakeProject({ playwright: true });
    try {
      const steps = await verifyBrowser(project.root);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]?.ok, true);
      assert.equal(steps[0]?.label, "playwright test");
      const events = project.events();
      assert.deepEqual(events, ["start:playwright test", "end:playwright test"]);
    } finally {
      project.cleanup();
    }
  });

  test("verifyBrowser respects RAW_STACK_PR_BROWSER_TESTS=off and RAW_STACK_MAIN_BROWSER_TESTS=off", () => {
    const project = createFakeProject({ playwright: true });
    try {
      const prRes = runCli(project.root, ["verify", "--browser"], {
        GITHUB_EVENT_NAME: "pull_request",
        RAW_STACK_PR_BROWSER_TESTS: "off",
        RAW_STACK_MAIN_BROWSER_TESTS: undefined,
      });
      assert.equal(prRes.status, 0, prRes.stderr || prRes.stdout);
      assert.match(prRes.stdout, /playwright test skipped on this PR/);
      assert.equal(project.hasEvents(), false);

      const pushRes = runCli(project.root, ["verify", "--browser"], {
        GITHUB_EVENT_NAME: "push",
        RAW_STACK_MAIN_BROWSER_TESTS: "off",
        RAW_STACK_PR_BROWSER_TESTS: undefined,
      });
      assert.equal(pushRes.status, 0, pushRes.stderr || pushRes.stdout);
      assert.match(pushRes.stdout, /playwright test skipped on this push/);
      assert.equal(project.hasEvents(), false);
    } finally {
      project.cleanup();
    }
  });

  test("verifyBrowser fails when Playwright exits non-zero", async () => {
    const project = createFakeProject({ playwright: true, playwrightFail: true });
    try {
      const steps = await verifyBrowser(project.root);
      assert.equal(steps.length, 1);
      assert.equal(steps[0]?.ok, false);
      assert.match(steps[0]?.output ?? "", /simulated playwright failure/);
    } finally {
      project.cleanup();
    }
  });

  test("verifyFull runs checks first and starts Playwright strictly after checks complete", async () => {
    const project = createFakeProject({ playwright: true, vpDelayMs: 60 });
    try {
      const steps = await verifyFull(project.root);
      assert.equal(steps.every((s) => s.ok), true, steps.map((s) => `${s.label}: ${s.output}`).join("\n"));
      assert.deepEqual(
        steps.map((s) => s.label),
        ["vp check", "vp test unit (1000 property runs)", "vp test e2e", "dependency-cruiser", "guard", "playwright test"],
      );
      const events = project.events();
      const pwStart = events.indexOf("start:playwright test");
      assert.ok(pwStart > 0, `expected playwright start event: ${events.join("\n")}`);
      const vpEnds = events
        .map((line, idx) => ({ line, idx }))
        .filter(({ line }) => line.startsWith("end:vp "));
      assert.equal(vpEnds.length, 3);
      for (const { line, idx } of vpEnds) {
        assert.ok(idx < pwStart, `expected ${line} (at ${idx}) before start:playwright test (at ${pwStart})`);
      }
    } finally {
      project.cleanup();
    }
  });

  test("verifyFull without playwright.config.ts runs only the 5 checks", async () => {
    const project = createFakeProject({ playwright: false });
    try {
      const steps = await verifyFull(project.root);
      assert.equal(steps.every((s) => s.ok), true);
      assert.deepEqual(
        steps.map((s) => s.label),
        ["vp check", "vp test unit (1000 property runs)", "vp test e2e", "dependency-cruiser", "guard"],
      );
    } finally {
      project.cleanup();
    }
  });

  test("verifyFull reports failing checks cleanly and still finishes the full report", async () => {
    const project = createFakeProject({ playwright: true, vpFailSubcommand: "check" });
    try {
      const steps = await verifyFull(project.root);
      assert.equal(steps.find((s) => s.label === "vp check")?.ok, false);
      assert.equal(steps.find((s) => s.label === "playwright test")?.ok, true);
    } finally {
      project.cleanup();
    }
  });
});

describe("raw-stack verify CLI flags", () => {
  test("runs --checks and --browser cleanly from CLI", () => {
    const project = createFakeProject({ playwright: false });
    try {
      const checks = runCli(project.root, ["verify", "--checks"]);
      assert.equal(checks.status, 0, checks.stderr || checks.stdout);
      assert.match(checks.stdout, /pass {2}vp check/);
      assert.match(checks.stdout, /pass {2}guard/);

      const browser = runCli(project.root, ["verify", "--browser"]);
      assert.equal(browser.status, 0, browser.stderr || browser.stdout);
      assert.match(browser.stdout, /playwright test skipped \(no playwright\.config\.ts\)/);
    } finally {
      project.cleanup();
    }
  });

  test("rejects unknown verify options with exit code 2", () => {
    const project = createFakeProject();
    try {
      const res = runCli(project.root, ["verify", "--bogus"]);
      assert.equal(res.status, 2);
      assert.match(res.stderr, /unknown option.*--bogus/i);
      assert.match(res.stderr, /usage: raw-stack verify \[--full \| --checks \| --browser\]/);
    } finally {
      project.cleanup();
    }
  });

  for (const flags of [
    ["--full", "--checks"],
    ["--checks", "--browser"],
    ["--full", "--browser"],
  ]) {
    test(`rejects conflicting verify options (${flags.join(" ")}) with exit code 2`, () => {
      const project = createFakeProject();
      try {
        const res = runCli(project.root, ["verify", ...flags]);
        assert.equal(res.status, 2);
        assert.match(res.stderr, /conflicting options/i);
        assert.match(res.stderr, /usage: raw-stack verify \[--full \| --checks \| --browser\]/);
      } finally {
        project.cleanup();
      }
    });
  }
});
