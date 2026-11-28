// @ts-check
// The verify tiers. "changed" is the fast loop an agent hits on every Stop;
// "full" is the check before a PR and in CI.
import { guard } from "./guard.js";
import { analyzeHealth } from "./health.js";
import { testConfigProblems } from "./test-config.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { changedFiles, depcruiseScript, projectFiles, run, SOURCE_FILE, vpCommand } from "./project.js";

/** @typedef {{ label: string, ok: boolean, output: string, ms: number }} Step */

const CLIENT_FILE_PATTERNS = [
  /^src\/browser\.tsx?$/,
  /^src\/modules\/[^/]+\/client\.tsx?$/,
  /^src\/modules\/[^/]+\/[^/]+\/client\.tsx?$/,
  /\.client\.tsx?$/,
  /\/client\//,
];
const TEST_FILE_PATTERN = /\.test\.tsx?$/;

/** @param {string} source */
function isClientSource(source) {
  return !TEST_FILE_PATTERN.test(source) && CLIENT_FILE_PATTERNS.some((re) => re.test(source));
}

/**
 * Find transitive runtime (non-type-only) reachability from browser/client files to
 * Node.js core built-ins. dependency-cruiser's `reachable: true` cannot filter out
 * `type-only` edges, so `client-no-node` enforces direct imports in dependency-cruiser
 * and this check enforces transitive runtime reachability over the cruised module graph.
 *
 * @param {Array<{ source: string, dependencies?: Array<{ resolved: string, dependencyTypes?: string[] }> }>} modules
 * @param {Array<{ from: string, to: string, rule: { name: string } }>} existingViolations
 * @returns {Array<{ from: string, to: string, via: string[], rule: { name: string } }>}
 */
function transitiveClientNodeViolations(modules, existingViolations) {
  /** @type {Map<string, Array<{ resolved: string, dependencyTypes: string[] }>>} */
  const depsBySource = new Map();
  for (const mod of modules) {
    depsBySource.set(
      mod.source,
      (mod.dependencies ?? []).map((d) => ({ resolved: d.resolved, dependencyTypes: d.dependencyTypes ?? [] })),
    );
  }

  const reported = new Set(
    existingViolations.filter((v) => v.rule.name === "client-no-node").map((v) => `${v.from} -> ${v.to}`),
  );
  /** @type {Array<{ from: string, to: string, via: string[], rule: { name: string } }>} */
  const extra = [];

  for (const mod of modules) {
    if (!isClientSource(mod.source)) continue;
    /** @type {Array<{ node: string, via: string[] }>} */
    const queue = [];
    /** @type {Set<string>} */
    const visited = new Set([mod.source]);

    for (const dep of depsBySource.get(mod.source) ?? []) {
      if (dep.dependencyTypes.includes("type-only")) continue;
      if (dep.dependencyTypes.includes("core")) continue;
      if (!visited.has(dep.resolved)) {
        visited.add(dep.resolved);
        queue.push({ node: dep.resolved, via: [dep.resolved] });
      }
    }

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      for (const dep of depsBySource.get(current.node) ?? []) {
        if (dep.dependencyTypes.includes("type-only")) continue;
        if (dep.dependencyTypes.includes("core")) {
          const key = `${mod.source} -> ${dep.resolved}`;
          if (!reported.has(key)) {
            reported.add(key);
            extra.push({
              from: mod.source,
              to: dep.resolved,
              via: current.via,
              rule: { name: "client-no-node" },
            });
          }
          continue;
        }
        if (!visited.has(dep.resolved)) {
          visited.add(dep.resolved);
          queue.push({ node: dep.resolved, via: [...current.via, dep.resolved] });
        }
      }
    }
  }

  return extra;
}

/**
 * Run dependency-cruiser on src/ and format its violations. Fails if it cruised
 * nothing, which is how a broken parser setup shows up.
 * @param {string} root @returns {Promise<Step>}
 */
async function depcruise(root) {
  const step = await run("dependency-cruiser", process.execPath, [depcruiseScript(), "src", "--output-type", "json"], root);
  /** @type {{ modules?: Array<{ source: string, dependencies?: Array<{ resolved: string, dependencyTypes?: string[] }> }>, summary: { totalCruised: number, violations: Array<{ from: string, to: string, rule: { name: string } }>, ruleSetUsed: { forbidden?: Array<{ name: string, comment?: string }> } } }} */
  let result;
  try {
    result = JSON.parse(step.output);
  } catch {
    return { ...step, ok: false };
  }
  const { totalCruised, violations } = result.summary;
  if (totalCruised === 0) {
    return { ...step, ok: false, output: "dependency-cruiser checked 0 files in src/. Its parser isn't working." };
  }
  const hints = new Map((result.summary.ruleSetUsed.forbidden ?? []).map((r) => [r.name, r.comment ?? ""]));
  const transitiveNode = transitiveClientNodeViolations(result.modules ?? [], violations);
  const lines = [
    ...violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}\n  ${hints.get(v.rule.name) ?? ""}`),
    ...transitiveNode.map(
      (v) =>
        `${v.rule.name}: ${v.from} -> ${v.to} (via ${v.via.join(" -> ")})\n  ${hints.get(v.rule.name) || "Browser entrypoints and client files cannot reach Node built-ins at runtime (type-only imports are allowed)."}`,
    ),
  ];
  return { ...step, ok: violations.length === 0 && transitiveNode.length === 0, output: lines.join("\n") };
}

/** @param {string} root @param {string[]} files @returns {Promise<Step>} */
async function guardStep(root, files) {
  const started = performance.now();
  const problems = [...guard(root, files), ...(await testConfigProblems(root))];
  return { label: "guard", ok: problems.length === 0, output: problems.join("\n"), ms: Math.round(performance.now() - started) };
}

/** @param {string} root @returns {Promise<Step>} */
async function healthStep(root) {
  const started = performance.now();
  const result = analyzeHealth(root);
  const output = result.warnings.map((w) => `[${w.kind}] ${w.message}`).join("\n");
  return { label: "health", ok: result.ok, output, ms: Math.round(performance.now() - started) };
}

/**
 * Fast tier: fix formatting, then lint + type check the project, run only the
 * tests related to changed files, and check imports, suppressions, and module health.
 * @param {string} root @returns {Promise<Step[]>}
 */
export async function verifyChanged(root) {
  const vp = vpCommand(root);
  const check = await run("vp check --fix", vp, ["check", "--fix"], root);
  const changed = changedFiles(root);
  const changedSource = changed.filter((f) => SOURCE_FILE.test(f) && f.startsWith("src/"));
  const rest = await Promise.all([
    changedSource.length > 0
      ? run(
          "vp test related",
          vp,
          ["test", "related", "--run", "--project", "unit", "--passWithNoTests", ...changedSource],
          root,
          { SMOKE_BASE_URL: "", SMOKE_HEADERS_JSON: "" },
        )
      : Promise.resolve({ label: "vp test related", ok: true, output: "no changed source files", ms: 0 }),
    depcruise(root),
    guardStep(root, changed),
    healthStep(root),
  ]);
  return [check, ...rest];
}

/** fast-check runs per property in the full tier. The fast tier uses fast-check's 100. */
const FULL_PROPERTY_RUNS = 1000;

/**
 * The full tier never writes a snapshot: an empty toMatchInlineSnapshot() fails
 * instead of recording whatever the code printed. The fast tier runs unit tests
 * only, which have no snapshots.
 */
const NO_SNAPSHOT_WRITES = ["--update=none"];

/**
 * A project runs its browser tests on one kind of CI run, not both. With
 * RAW_STACK_PR_BROWSER_TESTS=off they're skipped on pull_request runs and left
 * to the push to main. With RAW_STACK_MAIN_BROWSER_TESTS=off they're skipped on
 * push runs: each PR runs them, and the push to main, whose merge its PR
 * already tested, deploys sooner. Local runs and other events always run them.
 * @param {NodeJS.ProcessEnv} env @returns {boolean}
 */
export function browserTestsOffForThisRun(env) {
  const event = env["GITHUB_EVENT_NAME"];
  if (event === "pull_request") return env["RAW_STACK_PR_BROWSER_TESTS"] === "off";
  if (event === "push") return env["RAW_STACK_MAIN_BROWSER_TESTS"] === "off";
  return false;
}

/** @param {string} root @returns {Promise<Step>} */
function browserTests(root) {
  if (browserTestsOffForThisRun(process.env)) {
    const pr = process.env["GITHUB_EVENT_NAME"] === "pull_request";
    const output = pr
      ? "RAW_STACK_PR_BROWSER_TESTS=off: browser tests run on the push to main, not on PRs."
      : "RAW_STACK_MAIN_BROWSER_TESTS=off: browser tests run on PRs, not on the push to main.";
    return Promise.resolve({ label: `playwright test skipped on this ${pr ? "PR" : "push"}`, ok: true, output, ms: 0 });
  }
  return run("playwright test", join(root, "node_modules", ".bin", "playwright"), ["test"], root, {
    SMOKE_BASE_URL: "",
    SMOKE_HEADERS_JSON: "",
  });
}

/**
 * Full non-browser tier: vp check, unit tests (1,000 property runs), Vitest e2e
 * tests, dependency-cruiser, guard, and module health. Skips Playwright browser tests.
 * @param {string} root @returns {Promise<Step[]>}
 */
export function verifyChecks(root) {
  const vp = vpCommand(root);
  const offlineTestEnv = { SMOKE_BASE_URL: "", SMOKE_HEADERS_JSON: "" };
  const propertyRuns = { ...offlineTestEnv, RAW_STACK_PROPERTY_RUNS: String(FULL_PROPERTY_RUNS) };
  return Promise.all([
    run("vp check", vp, ["check"], root),
    run(`vp test unit (${FULL_PROPERTY_RUNS} property runs)`, vp, ["test", "run", "--project", "unit", ...NO_SNAPSHOT_WRITES], root, propertyRuns),
    run("vp test e2e", vp, ["test", "run", "--project", "e2e", ...NO_SNAPSHOT_WRITES], root, offlineTestEnv),
    depcruise(root),
    guardStep(root, projectFiles(root)),
    healthStep(root),
  ]);
}

/**
 * Playwright browser tests only (respecting RAW_STACK_PR_BROWSER_TESTS and
 * RAW_STACK_MAIN_BROWSER_TESTS). Succeeds cleanly with a skip message when
 * playwright.config.ts does not exist.
 * @param {string} root @returns {Promise<Step[]>}
 */
export async function verifyBrowser(root) {
  if (!existsSync(join(root, "playwright.config.ts"))) {
    return [
      {
        label: "playwright test skipped (no playwright.config.ts)",
        ok: true,
        output: "No playwright.config.ts found; skipping browser tests.",
        ms: 0,
      },
    ];
  }
  return [await browserTests(root)];
}

/**
 * Full tier: everything, every test including e2e (and Playwright browser tests
 * when the project has playwright.config.ts, unless they're off for this run), no fixes. Before a PR and in CI.
 * Runs the non-browser checks in parallel first and Playwright afterward so browser
 * tests do not compete with vp check and 1,000-run property tests for CPU and RAM.
 * @param {string} root @returns {Promise<Step[]>}
 */
export async function verifyFull(root) {
  const checks = await verifyChecks(root);
  if (!existsSync(join(root, "playwright.config.ts"))) return checks;
  return [...checks, await browserTests(root)];
}

const MAX_LINES = 60;

/** @param {Step[]} steps */
export function report(steps) {
  const summary = steps.map((s) => `${s.ok ? "pass" : "FAIL"}  ${s.label} (${s.ms} ms)`).join("\n");
  const failures = steps
    .filter((s) => !s.ok)
    .map((s) => {
      const out = s.output.trim().split("\n");
      const tail = out.length > MAX_LINES ? ["...", ...out.slice(-MAX_LINES)] : out;
      return `--- ${s.label} ---\n${tail.join("\n")}`;
    });
  return [summary, ...failures].join("\n\n");
}

