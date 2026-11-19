// @ts-check
// Checks the test settings vite.config.ts resolves to, not its text: a project
// can add test settings, but it can't replace raw-stack's test projects (which
// would drop the e2e tests or the property-test setup), narrow which files they
// find, or change the property run count.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { rawStack } from "../config/vite.js";

/** Root test settings that would change which tests run or how strictly. */
const FORBIDDEN = ["include", "exclude", "dir", "root", "allowOnly", "retry", "testNamePattern", "project"];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {string} path @returns {Promise<unknown>} */
async function loadConfig(path) {
  const mod = await import(`${pathToFileURL(path).href}?t=${Date.now()}`);
  const exported = mod.default;
  return typeof exported === "function" ? exported({ command: "serve", mode: "test" }) : exported;
}

/** @param {Record<string, unknown>} test @returns {string[]} */
function compare(test) {
  const shared = rawStack().test;
  const problems = [];
  if (JSON.stringify(test["projects"]) !== JSON.stringify(shared.projects)) {
    problems.push('vite.config.ts changes test "projects". The unit and e2e projects come only from raw-stack.');
  }
  if (test["passWithNoTests"] !== shared.passWithNoTests) {
    problems.push('vite.config.ts changes test "passWithNoTests". Remove it.');
  }
  for (const key of FORBIDDEN) {
    if (key in test) problems.push(`vite.config.ts sets test "${key}", which changes which tests run or how they pass. Remove it.`);
  }
  const env = isObject(test["env"]) ? Object.keys(test["env"]) : [];
  for (const key of env.filter((k) => k.startsWith("RAW_STACK_"))) {
    problems.push(`vite.config.ts sets test env "${key}". raw-stack sets it. Remove it.`);
  }
  return problems;
}

/**
 * Load vite.config.ts and check its resolved test settings against rawStack().
 * Fails closed: a config that can't be loaded is a problem too.
 * @param {string} root @returns {Promise<string[]>}
 */
export async function testConfigProblems(root) {
  const path = join(root, "vite.config.ts");
  if (!existsSync(path)) return []; // guard() reports the missing file
  let config;
  try {
    config = await loadConfig(path);
  } catch (err) {
    const reason = err instanceof Error ? err.message.split("\n")[0] : String(err);
    return [`vite.config.ts couldn't be loaded to check its test settings: ${reason}`];
  }
  if (!isObject(config) || !isObject(config["test"])) {
    return ["vite.config.ts has no test settings. Spread ...rawStack() into defineConfig."];
  }
  return compare(config["test"]);
}
