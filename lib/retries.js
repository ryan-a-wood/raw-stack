// @ts-check
// Zero test retries. A retry turns a failing test into a passing one without
// fixing anything, so a flaky test hides a real bug or a broken test. Fix the
// cause, or delete the test if it no longer states a requirement.
//
// Vitest and Playwright can retry from the config (checked in test-config.js),
// from options on a test or suite, from a tag, from the command line, and from
// a vitest.config.* file, which Vitest reads instead of vite.config.ts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const NO_RETRIES =
  "Tests don't retry: fix what makes the test flaky, or delete the test if it no longer states a requirement.";

/** Files that use a test runner's API, where `retry` can only mean a test retry. */
const TEST_API = /\bfrom\s*["'](?:vite-plus\/test|vitest|@playwright\/test)["']/;

/** `{ retry: 2 }`, `{ retries: 2 }` (Playwright), or `task.retry = 2`. */
const RETRY_SETTING = /\b(retr(?:y|ies))\s*:|\.(retry)\s*=(?!=)/;

/** `--retry 2`, `--retry=2` (Vitest) or `--retries` (Playwright). */
const RETRY_FLAG = /--retr(?:y|ies)\b/;

/** Vitest reads these before vite.config.ts, so they would replace the checked config. */
const VITEST_CONFIG = /^vitest\.(?:config|workspace)\.[cm]?[jt]s$/;

/**
 * A retry option in a file that uses a test runner's API.
 * @param {string} file @param {string} source @returns {string[]}
 */
export function retryOptionProblems(file, source) {
  if (!TEST_API.test(source)) return [];
  return source.split("\n").flatMap((line, i) => {
    const hit = RETRY_SETTING.exec(line);
    return hit ? [`${file}:${i + 1}: test sets "${hit[1] ?? hit[2]}". ${NO_RETRIES}`] : [];
  });
}

/** @param {string} path @returns {string[]} */
function workflowFiles(path) {
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join(path, f));
}

/**
 * Retries the project can turn on outside its test files: a vitest.config.*
 * file, or a retry flag in a package.json script or a CI workflow.
 * @param {string} root @returns {string[]}
 */
export function projectRetryProblems(root) {
  const problems = readdirSync(root)
    .filter((f) => VITEST_CONFIG.test(f))
    .map((f) => `${f}: Vitest reads it instead of vite.config.ts, so the guard can't check it. Put test settings in vite.config.ts.`);
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    const scripts = JSON.parse(readFileSync(pkgPath, "utf8")).scripts ?? {};
    for (const [name, command] of Object.entries(scripts)) {
      if (typeof command === "string" && RETRY_FLAG.test(command)) {
        problems.push(`package.json script "${name}" passes a retry flag. ${NO_RETRIES}`);
      }
    }
  }
  for (const path of workflowFiles(join(root, ".github", "workflows"))) {
    if (RETRY_FLAG.test(readFileSync(path, "utf8"))) {
      problems.push(`${path.slice(root.length + 1)} passes a retry flag to the tests. ${NO_RETRIES}`);
    }
  }
  return problems;
}
