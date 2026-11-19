// @ts-check
// Shared Playwright settings for projects whose e2e tests drive a browser.
// Spread rawStackPlaywright() into defineConfig in playwright.config.ts; the
// guard fails if the config changes these settings.

/** Where browser tests live, and their names: Vitest runs e2e/**\/*.test.ts, Playwright runs *.spec.ts. */
const TEST_DIR = "e2e";
const TEST_MATCH = "**/*.spec.ts";

/** Every browser runs in CI; Chromium alone runs locally to keep the loop fast. */
const BROWSERS = /** @type {const} */ (["chromium", "firefox", "webkit"]);

/**
 * @param {{ ci?: boolean }} [options] defaults to the CI environment variable
 * @returns {import("./playwright.d.ts").RawStackPlaywrightConfig}
 */
export function rawStackPlaywright({ ci = Boolean(process.env["CI"]) } = {}) {
  return {
    testDir: TEST_DIR,
    testMatch: TEST_MATCH,
    // Tests in one file run in parallel too, so each test must set up its own data.
    fullyParallel: true,
    // Zero retries: a flaky test gets its cause fixed, or is deleted.
    retries: 0,
    forbidOnly: ci,
    // A trace only for failed tests: passing tests pay nothing to record it.
    use: { trace: "retain-on-failure" },
    projects: (ci ? BROWSERS : BROWSERS.slice(0, 1)).map((name) => ({ name, use: { browserName: name } })),
  };
}
