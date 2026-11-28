// @ts-check
// Shared Playwright settings for projects whose e2e tests drive a browser.
// Spread rawStackPlaywright() into defineConfig in playwright.config.ts; the
// guard fails if the config changes these settings.
import { parseSmokeHeaders, validateSmokeUrl } from "../lib/smoke-headers.js";

/** Where browser tests live, and their names: Vitest runs e2e/**\/*.test.ts, Playwright runs *.spec.ts. */
const TEST_DIR = "e2e";
const TEST_MATCH = "**/*.spec.ts";
const SMOKE_TEST_DIR = "smoke";
const SMOKE_TEST_MATCH = "**/*.smoke.spec.ts";

/**
 * Chromium and WebKit (Safari, and every browser on iOS) run in CI; Chromium
 * alone runs locally to keep the loop fast. Firefox is left out on purpose.
 */
const BROWSERS = /** @type {const} */ (["chromium", "webkit"]);

/**
 * Parse PW_SHARD ("<current>/<total>", e.g. "2/4") into Playwright's shard config.
 * Empty/unset or "1/1" means no sharding (returns undefined so `shard` is omitted).
 * Any non-empty malformed or out-of-range value throws so a misconfigured CI shard
 * fails loudly instead of silently running the full suite on every shard.
 * @param {string | undefined} raw
 * @returns {import("./playwright.d.ts").RawStackPlaywrightShard | undefined}
 */
export function parsePlaywrightShard(raw) {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  const match = /^(\d+)\/(\d+)$/.exec(trimmed);
  if (!match) {
    throw new Error(
      `Invalid PW_SHARD=${JSON.stringify(raw)}: expected "<current>/<total>" with positive integers where 1 <= current <= total (for example, "1/4").`,
    );
  }
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isSafeInteger(current) || !Number.isSafeInteger(total) || current < 1 || total < 1 || current > total) {
    throw new Error(
      `Invalid PW_SHARD=${JSON.stringify(raw)}: expected "<current>/<total>" with positive integers where 1 <= current <= total (for example, "1/4").`,
    );
  }
  return total > 1 ? { current, total } : undefined;
}

/**
 * @param {import("./playwright.d.ts").RawStackPlaywrightOptions} [options]
 * @returns {import("./playwright.d.ts").RawStackPlaywrightConfig}
 */
export function rawStackPlaywright(options = {}) {
  const { ci = Boolean(process.env["CI"]), baseURL, webServer, use } = options;
  const shard = parsePlaywrightShard(process.env["PW_SHARD"]);
  const rawSmokeUrl = process.env["SMOKE_BASE_URL"]?.trim();

  if (rawSmokeUrl) {
    const smokeBaseUrl = validateSmokeUrl(rawSmokeUrl);
    const smokeHeaders = parseSmokeHeaders(process.env["SMOKE_HEADERS_JSON"]);
    const hasSmokeHeaders = Object.keys(smokeHeaders).length > 0;
    const rawExistingHeaders = use?.["extraHTTPHeaders"];
    const existingHeaders =
      typeof rawExistingHeaders === "object" && rawExistingHeaders !== null && !Array.isArray(rawExistingHeaders)
        ? /** @type {Record<string, string>} */ (rawExistingHeaders)
        : undefined;

    return {
      testDir: SMOKE_TEST_DIR,
      testMatch: SMOKE_TEST_MATCH,
      fullyParallel: true,
      retries: 0,
      forbidOnly: ci,
      webServer: undefined,
      use: {
        ...(use ?? {}),
        trace: "retain-on-failure",
        baseURL: smokeBaseUrl,
        ...(hasSmokeHeaders ? { extraHTTPHeaders: { ...(existingHeaders ?? {}), ...smokeHeaders } } : {}),
      },
      projects: (ci ? BROWSERS : BROWSERS.slice(0, 1)).map((name) => ({ name, use: { browserName: name } })),
      ...(shard ? { shard } : {}),
    };
  }

  return {
    testDir: TEST_DIR,
    testMatch: TEST_MATCH,
    // Tests in one file run in parallel too, so each test must set up its own data.
    fullyParallel: true,
    // Zero retries: a flaky test gets its cause fixed, or is deleted.
    retries: 0,
    forbidOnly: ci,
    // A trace only for failed tests: passing tests pay nothing to record it.
    use: {
      ...(use ?? {}),
      ...(baseURL !== undefined ? { baseURL } : {}),
      trace: "retain-on-failure",
    },
    ...(webServer !== undefined ? { webServer } : {}),
    projects: (ci ? BROWSERS : BROWSERS.slice(0, 1)).map((name) => ({ name, use: { browserName: name } })),
    ...(shard ? { shard } : {}),
  };
}
