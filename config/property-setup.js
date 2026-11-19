// @ts-check
// Vitest setup for the unit test project. It sets how many random inputs every
// fast-check property tries: 100 by default, more in the full tier
// (RAW_STACK_PROPERTY_RUNS). The guard fails on numRuns, seed and the other
// run settings in project files, so the count comes only from here.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_RUNS = 100;

function projectUsesFastCheck() {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    return "fast-check" in { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return false;
  }
}

/** @type {{ configureGlobal: (p: { numRuns: number }) => void } | undefined} */
let fc;
try {
  // A variable keeps Vite from resolving it at transform time: fast-check is an
  // optional peer, and projects without property tests don't install it.
  const name = "fast-check";
  fc = await import(name);
} catch (err) {
  if (projectUsesFastCheck()) throw err;
}

const runs = Number(process.env["RAW_STACK_PROPERTY_RUNS"]);
fc?.configureGlobal({ numRuns: Number.isInteger(runs) && runs > 0 ? runs : DEFAULT_RUNS });
