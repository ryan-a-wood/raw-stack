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
import { browserTestsOffForThisRun, verifyBrowser, verifyChanged, verifyChecks, verifyFull } from "../lib/verify.js";

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
        ["vp check", "vp test unit (1000 property runs)", "vp test e2e", "dependency-cruiser", "guard", "health"],
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
        ["vp check", "vp test unit (1000 property runs)", "vp test e2e", "dependency-cruiser", "guard", "health", "playwright test"],
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

  test("verifyFull without playwright.config.ts runs only the 6 checks", async () => {
    const project = createFakeProject({ playwright: false });
    try {
      const steps = await verifyFull(project.root);
      assert.equal(steps.every((s) => s.ok), true);
      assert.deepEqual(
        steps.map((s) => s.label),
        ["vp check", "vp test unit (1000 property runs)", "vp test e2e", "dependency-cruiser", "guard", "health"],
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

describe("strict module health enforcement in raw-stack verify", () => {
  /**
   * Write a set of relative files into a fake project root.
   * @param {string} root
   * @param {Record<string, string>} files
   */
  function writeFiles(root, files) {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    }
  }

  test("fails both verifyChanged and verifyChecks on unused value export, >20 prod files, >25 exports, and >50% sibling fan-out (>=6 siblings)", async () => {
    // 1. Unused value export (including test-only value export)
    const pUnused = createFakeProject();
    try {
      writeFiles(pUnused.root, {
        "src/main.ts": 'import { live } from "./modules/a/index.ts";\nconsole.log(live());\n',
        "src/modules/a/index.ts": "export const live = () => 1;\nexport const dead = () => 2;\n",
      });
      const changed = await verifyChanged(pUnused.root);
      const checks = await verifyChecks(pUnused.root);
      assert.equal(changed.find((s) => s.label === "health")?.ok, false);
      assert.match(changed.find((s) => s.label === "health")?.output ?? "", /unused-exports.*dead/);
      assert.equal(checks.find((s) => s.label === "health")?.ok, false);
      const cliRes = runCli(pUnused.root, ["verify"]);
      assert.equal(cliRes.status, 1);
      assert.match(cliRes.stdout, /FAIL {2}health/);
    } finally {
      pUnused.cleanup();
    }

    // 2. >20 prod files in a unit
    const pFiles = createFakeProject();
    try {
      /** @type {Record<string, string>} */
      const f = {
        "src/main.ts": 'import { run } from "./modules/big/index.ts";\nconsole.log(run());\n',
      };
      const imports = [];
      for (let i = 1; i <= 20; i++) {
        f[`src/modules/big/f${i}.ts`] = `export const v${i} = ${i};\n`;
        imports.push(`import { v${i} } from "./f${i}.ts";`);
      }
      f["src/modules/big/index.ts"] = `${imports.join("\n")}\nexport const run = () => ${Array.from({ length: 20 }, (_, i) => `v${i + 1}`).join(" + ")};\n`;
      writeFiles(pFiles.root, f);
      const checks = await verifyChecks(pFiles.root);
      assert.equal(checks.find((s) => s.label === "health")?.ok, false);
      assert.match(checks.find((s) => s.label === "health")?.output ?? "", /prod-files.*21 prod files/);
    } finally {
      pFiles.cleanup();
    }

    // 3. >25 exports on an entrypoint
    const pExports = createFakeProject();
    try {
      const exports = Array.from({ length: 26 }, (_, i) => `export const e${i + 1} = ${i + 1};`).join("\n");
      writeFiles(pExports.root, {
        "src/main.ts": 'import * as wide from "./modules/wide/index.ts";\nconsole.log(wide);\n',
        "src/modules/wide/index.ts": `${exports}\n`,
      });
      const checks = await verifyChecks(pExports.root);
      assert.equal(checks.find((s) => s.label === "health")?.ok, false);
      assert.match(checks.find((s) => s.label === "health")?.output ?? "", /index-exports.*26 exports/);
    } finally {
      pExports.cleanup();
    }

    // 4. >50% top-level sibling fan-out when >= 6 siblings exist
    const pFanOut = createFakeProject();
    try {
      writeFiles(pFanOut.root, {
        "src/main.ts":
          'import { hub } from "./modules/hub/index.ts";\nimport { m1 } from "./modules/m1/index.ts";\nimport { m2 } from "./modules/m2/index.ts";\nimport { m3 } from "./modules/m3/index.ts";\nimport { m4 } from "./modules/m4/index.ts";\nimport { m5 } from "./modules/m5/index.ts";\nimport { m6 } from "./modules/m6/index.ts";\nconsole.log(hub(), m1, m2, m3, m4, m5, m6);\n',
        "src/modules/hub/index.ts":
          'import { m1 } from "../m1/index.ts";\nimport { m2 } from "../m2/index.ts";\nimport { m3 } from "../m3/index.ts";\nimport { m4 } from "../m4/index.ts";\nexport const hub = () => m1 + m2 + m3 + m4;\n',
        "src/modules/m1/index.ts": "export const m1 = 1;\n",
        "src/modules/m2/index.ts": "export const m2 = 2;\n",
        "src/modules/m3/index.ts": "export const m3 = 3;\n",
        "src/modules/m4/index.ts": "export const m4 = 4;\n",
        "src/modules/m5/index.ts": "export const m5 = 5;\n",
        "src/modules/m6/index.ts": "export const m6 = 6;\n",
      });
      const checks = await verifyChecks(pFanOut.root);
      assert.equal(checks.find((s) => s.label === "health")?.ok, false);
      assert.match(checks.find((s) => s.label === "health")?.output ?? "", /sibling-fan-out.*4\/6/);
    } finally {
      pFanOut.cleanup();
    }
  });

  test("passes verifyChanged and verifyChecks on a 4-module app (importing 3 siblings), signature-referenced exported types, and *.property.test.ts importing internal files", async () => {
    const project = createFakeProject();
    try {
      writeFiles(project.root, {
        "src/main.ts":
          'import { createPointsService } from "./modules/points/index.ts";\nimport { b } from "./modules/b/index.ts";\nimport { c } from "./modules/c/index.ts";\nimport { d } from "./modules/d/index.ts";\nconsole.log(createPointsService(), b(), c(), d());\n',
        "src/modules/points/pure.ts": "export const add = (x: number, y: number) => x + y;\n",
        "src/modules/points/index.ts": [
          'import { b } from "../b/index.ts";',
          'import { c } from "../c/index.ts";',
          'import { d } from "../d/index.ts";',
          'import { add } from "./pure.ts";',
          "export interface PointSummary { total: number; }",
          "export interface PointsService { since(date: Date): PointSummary; }",
          "export function createPointsService(): PointsService { return { since: () => ({ total: add(b() + c(), d()) }) }; }",
        ].join("\n"),
        "src/modules/points/points.property.test.ts":
          'import { add } from "./pure.ts";\nconsole.log(add(1, 2));\n',
        "src/modules/b/index.ts": "export const b = () => 1;\n",
        "src/modules/c/index.ts": "export const c = () => 2;\n",
        "src/modules/d/index.ts": "export const d = () => 3;\n",
      });

      const changed = await verifyChanged(project.root);
      assert.equal(changed.every((s) => s.ok), true, changed.map((s) => `${s.label}: ${s.output}`).join("\n"));

      const checks = await verifyChecks(project.root);
      assert.equal(checks.every((s) => s.ok), true, checks.map((s) => `${s.label}: ${s.output}`).join("\n"));
    } finally {
      project.cleanup();
    }
  });

  test("verifyChecks catches transitive runtime node:* imports from client files while allowing type-only node:* imports", async () => {
    // 1. Transitive runtime import: client.tsx -> bridge/index.ts -> node:fs -> FAILS
    const bad = createFakeProject();
    try {
      writeFiles(bad.root, {
        "src/main.ts": 'import { hasFs } from "./modules/bridge/index.ts";\nconsole.log(hasFs());\n',
        "src/browser.tsx": 'import { view } from "./modules/feat/client.tsx";\nconsole.log(view());\n',
        "src/modules/bridge/index.ts": 'import { existsSync } from "node:fs";\nexport const hasFs = () => existsSync(".");\n',
        "src/modules/feat/client.tsx": 'import { hasFs } from "../bridge/index.ts";\nexport const view = () => hasFs();\n',
      });
      const checks = await verifyChecks(bad.root);
      const dc = checks.find((s) => s.label === "dependency-cruiser");
      assert.equal(dc?.ok, false);
      assert.match(dc?.output ?? "", /client-no-node: src\/modules\/feat\/client\.tsx -> fs \(via src\/modules\/bridge\/index\.ts\)/);
    } finally {
      bad.cleanup();
    }

    // 2. Direct & transitive type-only node:* imports from client files -> PASSES
    const good = createFakeProject();
    try {
      writeFiles(good.root, {
        "src/main.ts": 'import { label } from "./modules/ui/index.ts";\nconsole.log(label());\n',
        "src/browser.tsx": 'import { view } from "./modules/feat/client.tsx";\nconsole.log(view());\n',
        "src/modules/ui/index.ts": 'import type { Readable } from "node:stream";\nexport type UiStream = Readable;\nexport const label = () => "ok";\n',
        "src/modules/feat/client.tsx":
          'import type { PathLike } from "node:fs";\nimport { label, type UiStream } from "../ui/index.ts";\nexport type ClientTypes = [PathLike, UiStream];\nexport const view = (_t?: ClientTypes) => label();\n',
      });
      const checks = await verifyChecks(good.root);
      assert.equal(checks.every((s) => s.ok), true, checks.map((s) => `${s.label}: ${s.output}`).join("\n"));
    } finally {
      good.cleanup();
    }
  });
});
