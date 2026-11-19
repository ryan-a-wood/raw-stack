// @ts-check
// Checks for Playwright browser tests: the usual causes of slow or flaky tests,
// and a playwright.config.ts that drops the shared settings.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PLAYWRIGHT = /\bfrom\s*["']@playwright\/test["']/;

/** Code that waits a fixed time or finds elements by page structure. */
const BROWSER_SMELLS = [
  {
    re: /\.waitForTimeout\s*\(/,
    why: "waitForTimeout sleeps a fixed time: too short is flaky, too long is slow. Wait for what the user would see with a web-first assertion, like await expect(locator).toBeVisible().",
  },
  {
    re: /\.waitForSelector\s*\(/,
    why: "waitForSelector waits on a CSS selector. Use a user-facing locator and a web-first assertion.",
  },
  {
    re: /\.(?:locator|\$\$?|\$\$?eval)\s*\(\s*["'`]|\b(?:xpath|css)=/,
    why: "a CSS or XPath selector breaks when the markup changes. Use getByRole, getByLabel, getByText, or getByTestId.",
  },
];

/** @param {string} file @param {string} source @returns {string[]} */
export function browserTestProblems(file, source) {
  if (!PLAYWRIGHT.test(source) || /(^|\/)playwright\.config\./.test(file)) return [];
  return source.split("\n").flatMap((line, i) => {
    const hit = BROWSER_SMELLS.find((s) => s.re.test(line));
    return hit ? [`${file}:${i + 1}: ${hit.why}`] : [];
  });
}

/** Settings rawStackPlaywright() owns: which tests run, parallelism, `.only`, and traces. */
const SHARED_KEYS = /\b(fullyParallel|forbidOnly|testDir|testMatch|testIgnore|grep|grepInvert|trace)\s*:/;

/**
 * playwright.config.ts must spread rawStackPlaywright() and leave its settings alone.
 * Playwright would read any other playwright.config.* instead, unchecked.
 * @param {string} root @returns {string[]}
 */
export function playwrightConfigProblems(root) {
  const problems = readdirSync(root)
    .filter((f) => /^playwright\.config\.[cm]?[jt]s$/.test(f) && f !== "playwright.config.ts")
    .map((f) => `${f}: name the Playwright config playwright.config.ts, so the guard checks it.`);
  const path = join(root, "playwright.config.ts");
  if (!existsSync(path)) return problems;
  const text = readFileSync(path, "utf8");
  if (!text.includes("...rawStackPlaywright(")) {
    problems.push('playwright.config.ts must spread ...rawStackPlaywright() from "raw-stack/playwright" into defineConfig.');
  }
  const hit = SHARED_KEYS.exec(text);
  if (hit) problems.push(`playwright.config.ts sets "${hit[1]}". raw-stack sets it. Remove it.`);
  return problems;
}
