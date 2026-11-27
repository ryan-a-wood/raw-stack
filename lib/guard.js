// @ts-check
// Checks the linters can't do themselves: no suppression comments, and no
// project config that loosens the shared rules.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_FILE } from "./project.js";
import { browserTestProblems, playwrightConfigProblems } from "./browser-tests.js";
import { projectRetryProblems, retryOptionProblems } from "./retries.js";
import { FILE_SNAPSHOT, INLINE_SNAPSHOT, SNAPSHOT_DIR } from "./snapshots.js";
import { verifyWorkflowProblems } from "./workflows.js";

const SUPPRESSIONS = [
  /oxlint-disable/,
  /eslint-disable/,
  /@ts-ignore/,
  /@ts-nocheck/,
  /@ts-expect-error/,
  /dependency-cruiser-ignore/,
];

const SKIP = /(^|\/)(node_modules|dist|coverage)\//;

/**
 * fast-check settings that weaken a property: fewer runs, a fixed seed or path
 * (replays one case instead of searching), time limits that skip runs, more
 * skipped inputs. raw-stack sets the run count for every property.
 */
const PROPERTY_LOOSENERS =
  /\b(?:(numRuns|seed|path|interruptAfterTimeLimit|skipAllAfterTimeLimit|maxSkipsPerRun)\s*:|(configureGlobal)\b)/g;

/**
 * Snapshots go inline, in e2e tests only: there they record what the user sees,
 * and the PR diff shows every change. In unit tests they would only copy the code.
 * @param {string} file @param {string} line @returns {string[]}
 */
function snapshotProblems(file, line) {
  const separate = FILE_SNAPSHOT.exec(line);
  if (separate) return [`${separate[1]} keeps the snapshot in a separate file. Use toMatchInlineSnapshot.`];
  if (!file.startsWith(SNAPSHOT_DIR) && new RegExp(INLINE_SNAPSHOT.source).test(line)) {
    return [`inline snapshot outside ${SNAPSHOT_DIR}. Snapshots record what the user sees, so they go in e2e tests. Assert the expected value here.`];
  }
  return [];
}

/** @param {string} root @param {string} file @returns {string[]} */
function suppressionProblems(root, file) {
  if (!SOURCE_FILE.test(file) || SKIP.test(file)) return [];
  const path = join(root, file);
  if (!existsSync(path)) return [];
  const problems = [];
  const source = readFileSync(path, "utf8");
  const property = source.includes("fast-check");
  for (const [i, line] of source.split("\n").entries()) {
    const hit = SUPPRESSIONS.find((re) => re.test(line));
    if (hit) problems.push(`${file}:${i + 1}: suppression comment (${hit.source}). Fix the cause instead.`);
    problems.push(...snapshotProblems(file, line).map((p) => `${file}:${i + 1}: ${p}`));
    const looseners = property ? [...line.matchAll(PROPERTY_LOOSENERS)].map((m) => m[1] ?? m[2]) : [];
    if (looseners.length > 0) {
      problems.push(
        `${file}:${i + 1}: fast-check settings (${looseners.join(", ")}). raw-stack sets the run count, and a seed or path only replays one case while you debug. Remove them.`,
      );
    }
  }
  problems.push(...retryOptionProblems(file, source), ...browserTestProblems(file, source));
  return problems;
}

/** @param {string} text */
function parseJsonc(text) {
  const noComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "");
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, "$1"));
}

/** @param {string} root @returns {string[]} */
function tsconfigProblems(root) {
  const path = join(root, "tsconfig.json");
  if (!existsSync(path)) return ["tsconfig.json is missing."];
  const config = parseJsonc(readFileSync(path, "utf8"));
  const base = parseJsonc(readFileSync(new URL("../config/tsconfig.json", import.meta.url), "utf8"));
  const problems = [];
  if (config.extends !== "raw-stack/tsconfig.json") {
    problems.push('tsconfig.json must have "extends": "raw-stack/tsconfig.json".');
  }
  for (const [key, value] of Object.entries(config.compilerOptions ?? {})) {
    if (key in base.compilerOptions && JSON.stringify(base.compilerOptions[key]) !== JSON.stringify(value)) {
      problems.push(`tsconfig.json overrides the shared "${key}". Remove it.`);
    }
  }
  return problems;
}

const LINT_KEYS = /\b(lint|rules|categories|typeAware|typeCheck|ignorePatterns|jsPlugins)\s*:/;

/** @param {string} root @returns {string[]} */
function viteConfigProblems(root) {
  const path = join(root, "vite.config.ts");
  if (!existsSync(path)) return ["vite.config.ts is missing."];
  const text = readFileSync(path, "utf8");
  const problems = [];
  if (!text.includes("...rawStack()")) problems.push("vite.config.ts must spread ...rawStack() into defineConfig.");
  const hit = text.match(LINT_KEYS);
  if (hit) problems.push(`vite.config.ts sets "${hit[1]}". Lint settings come only from raw-stack.`);
  return problems;
}

const SHARED_RULES = [
  "deep-modules",
  "deep-modules-from-outside",
  "submodule-encapsulation",
  "submodule-encapsulation-from-parent",
  "module-max-depth",
  "module-max-depth-from",
  "module-max-depth-orphan",
  "client-no-node",
  "client-no-server",
  "no-circular",
  "no-orphans",
  "not-to-unresolvable",
  "no-undeclared-deps",
  "not-to-dev-dep",
  "not-to-test",
  "not-to-testing",
];

/** @param {string} root @returns {string[]} */
function depcruiseProblems(root) {
  const path = join(root, ".dependency-cruiser.cjs");
  if (!existsSync(path)) return [".dependency-cruiser.cjs is missing."];
  const text = readFileSync(path, "utf8");
  const problems = [];
  if (!text.includes("raw-stack/dependency-cruiser")) {
    problems.push('.dependency-cruiser.cjs must extend "raw-stack/dependency-cruiser".');
  }
  for (const name of SHARED_RULES) {
    if (text.includes(`"${name}"`) || text.includes(`'${name}'`)) {
      problems.push(`.dependency-cruiser.cjs redefines the shared rule "${name}". Remove it.`);
    }
  }
  return problems;
}

/**
 * @param {string} root
 * @param {string[]} files files to scan for suppression comments
 * @returns {string[]} one line per problem
 */
export function guard(root, files) {
  return [
    ...files.flatMap((file) => suppressionProblems(root, file)),
    ...tsconfigProblems(root),
    ...viteConfigProblems(root),
    ...depcruiseProblems(root),
    ...projectRetryProblems(root),
    ...playwrightConfigProblems(root),
    ...verifyWorkflowProblems(root),
  ];
}
