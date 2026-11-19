// @ts-check
// Mutation testing with Stryker. It changes the source in small ways (flips a
// condition, empties a function, swaps an operator) and runs the unit tests
// against each change. A change no test notices "survives": the tests run that
// code without checking what it does. raw-stack owns the whole Stryker config,
// so a project can't lower the score threshold or narrow what gets mutated.
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, SOURCE_FILE } from "./project.js";

/** The lowest mutation score, in percent, the changed files may have. */
export const MUTATION_BREAK = 80;

/** Source files Stryker mutates: src/ minus tests, type declarations and the entry point. */
const NOT_MUTATED = /(?:\.test\.[cm]?[jt]sx?|\.d\.[cm]?ts)$/;
const ENTRY_POINT = "src/main.ts"; // e2e tests cover it, and they can't kill mutants

/** @param {string} file */
export const isMutated = (file) =>
  file.startsWith("src/") && SOURCE_FILE.test(file) && !NOT_MUTATED.test(file) && file !== ENTRY_POINT;

/** Stryker's mutate option takes globs: escape a path so it matches only itself. @param {string} file */
const literalGlob = (file) => file.replace(/[\\[\]{}()*?!+@]/g, "\\$&");

/** @param {string} root */
const cacheDir = (root) => join(root, "node_modules", ".cache", "raw-stack");

/** @param {string} specifier */
const packagePath = (specifier) => fileURLToPath(import.meta.resolve(specifier));

/**
 * The Stryker config. Every setting comes from here, and the project's own
 * stryker config files are never read: verify passes this file explicitly.
 * @param {string} root @param {string[]} files
 */
export function strykerConfig(root, files) {
  return {
    testRunner: "vitest",
    plugins: [packagePath("@stryker-mutator/vitest-runner")],
    mutate: files.map(literalGlob),
    // Run every unit test in the first run, so a file no test imports scores 0
    // instead of erroring. RAW_STACK_MUTATION leaves out the e2e project.
    vitest: { related: false },
    coverageAnalysis: "perTest",
    thresholds: { high: 100, low: MUTATION_BREAK, break: MUTATION_BREAK },
    reporters: ["clear-text"],
    clearTextReporter: { allowColor: false, allowEmojis: false, reportTests: false, reportScoreTable: true },
    logLevel: "warn",
    fileLogLevel: "off",
    // Stryker rewrites tsconfig.json with the TypeScript JS API, which TS 7
    // doesn't have. raw-stack's tsconfig needs no rewriting, so point it nowhere.
    tsconfigFile: "raw-stack-no-tsconfig.json",
    // Outside the project: inside it, the copy would show up in lint and the
    // guard; inside node_modules, Vite wouldn't transform the copied tests.
    tempDirName: join(tmpdir(), `raw-stack-stryker-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`),
    cleanTempDir: "always",
    incremental: false,
  };
}

/**
 * Mutate the changed source files and fail if their score is under MUTATION_BREAK.
 * @param {string} root @param {string[]} changed files changed on this branch
 * @returns {Promise<{ label: string, ok: boolean, output: string, ms: number }>}
 */
export async function mutationStep(root, changed) {
  const label = `mutation (changed files, score >= ${MUTATION_BREAK}%)`;
  const files = changed.filter(isMutated);
  if (files.length === 0) return { label, ok: true, output: "no changed source files", ms: 0 };
  let stryker;
  try {
    stryker = join(dirname(packagePath("@stryker-mutator/core/package.json")), "bin", "stryker.js");
  } catch {
    return { label, ok: false, output: "Stryker isn't installed. Run pnpm install.", ms: 0 };
  }
  const configPath = join(cacheDir(root), `stryker.config.${process.pid}.json`);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(strykerConfig(root, files), null, 2));
  const step = await run(label, process.execPath, [stryker, "run", configPath], root, {
    RAW_STACK_MUTATION: "1",
  });
  rmSync(configPath, { force: true });
  const hint = step.ok
    ? ""
    : "\nSurvived: no test failed when this code changed. Add a test or property that checks the behavior, or delete the code if nothing needs it. NoCoverage: no unit test runs this code.";
  return { ...step, output: step.output + hint };
}
