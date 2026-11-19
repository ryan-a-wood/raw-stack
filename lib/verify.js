// @ts-check
// The verify tiers. "changed" is the fast loop an agent hits on every Stop;
// "full" is the check before a PR and in CI.
import { guard } from "./guard.js";
import { testConfigProblems } from "./test-config.js";
import { changedFiles, depcruiseScript, projectFiles, run, SOURCE_FILE, vpCommand } from "./project.js";

/** @typedef {{ label: string, ok: boolean, output: string, ms: number }} Step */

/**
 * Run dependency-cruiser on src/ and format its violations. Fails if it cruised
 * nothing, which is how a broken parser setup shows up.
 * @param {string} root @returns {Promise<Step>}
 */
async function depcruise(root) {
  const step = await run("dependency-cruiser", process.execPath, [depcruiseScript(), "src", "--output-type", "json"], root);
  /** @type {{ summary: { totalCruised: number, violations: Array<{ from: string, to: string, rule: { name: string } }>, ruleSetUsed: { forbidden?: Array<{ name: string, comment?: string }> } } }} */
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
  const lines = violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}\n  ${hints.get(v.rule.name) ?? ""}`);
  return { ...step, ok: violations.length === 0, output: lines.join("\n") };
}

/** @param {string} root @param {string[]} files @returns {Promise<Step>} */
async function guardStep(root, files) {
  const started = performance.now();
  const problems = [...guard(root, files), ...(await testConfigProblems(root))];
  return { label: "guard", ok: problems.length === 0, output: problems.join("\n"), ms: Math.round(performance.now() - started) };
}

/**
 * Fast tier: fix formatting, then lint + type check the project, run only the
 * tests related to changed files, and check imports and suppressions.
 * @param {string} root @returns {Promise<Step[]>}
 */
export async function verifyChanged(root) {
  const vp = vpCommand(root);
  const check = await run("vp check --fix", vp, ["check", "--fix"], root);
  const changed = changedFiles(root);
  const changedSource = changed.filter((f) => SOURCE_FILE.test(f) && f.startsWith("src/"));
  const rest = await Promise.all([
    changedSource.length > 0
      ? run("vp test related", vp, ["test", "related", "--run", "--project", "unit", "--passWithNoTests", ...changedSource], root)
      : Promise.resolve({ label: "vp test related", ok: true, output: "no changed source files", ms: 0 }),
    depcruise(root),
    guardStep(root, changed),
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
 * Full tier: everything, every test including e2e, no fixes. Before a PR and in CI.
 * Property tests try 10 times as many inputs as in the fast tier.
 * @param {string} root @returns {Promise<Step[]>}
 */
export function verifyFull(root) {
  const vp = vpCommand(root);
  const propertyRuns = { RAW_STACK_PROPERTY_RUNS: String(FULL_PROPERTY_RUNS) };
  return Promise.all([
    run("vp check", vp, ["check"], root),
    run(`vp test unit (${FULL_PROPERTY_RUNS} property runs)`, vp, ["test", "run", "--project", "unit", ...NO_SNAPSHOT_WRITES], root, propertyRuns),
    run("vp test e2e", vp, ["test", "run", "--project", "e2e", ...NO_SNAPSHOT_WRITES], root),
    depcruise(root),
    guardStep(root, projectFiles(root)),
  ]);
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

