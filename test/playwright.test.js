// @ts-check
// Tests for rawStackPlaywright() and native PW_SHARD parsing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parsePlaywrightShard, rawStackPlaywright } from "../config/playwright.js";
import { playwrightConfigProblems } from "../lib/browser-tests.js";

/**
 * @param {Record<string, string | undefined>} vars
 * @param {() => void} fn
 */
function withEnv(vars, fn) {
  /** @type {Record<string, string | undefined>} */
  const prev = {};
  for (const [key, value] of Object.entries(vars)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** @param {string | undefined} value @param {() => void} fn */
function withPwShard(value, fn) {
  withEnv({ PW_SHARD: value }, fn);
}

describe("rawStackPlaywright PW_SHARD handling", () => {
  test("omits shard when PW_SHARD is unset, empty, whitespace, or 1/1", () => {
    for (const value of [undefined, "", "   ", "1/1", " 1/1 "]) {
      withPwShard(value, () => {
        const config = rawStackPlaywright({ ci: true });
        assert.equal("shard" in config, false, `expected shard omitted for ${JSON.stringify(value)}`);
        assert.equal(config.shard, undefined);
      });
    }
  });

  test("sets shard when PW_SHARD is valid with total > 1", () => {
    for (const [value, expected] of [
      ["1/2", { current: 1, total: 2 }],
      ["2/2", { current: 2, total: 2 }],
      ["2/4", { current: 2, total: 4 }],
      [" 3/10 ", { current: 3, total: 10 }],
    ]) {
      withPwShard(/** @type {string} */ (value), () => {
        const config = rawStackPlaywright({ ci: true });
        assert.deepEqual(config.shard, expected);
      });
    }
  });

  test("throws a clear error on malformed or out-of-range PW_SHARD values", () => {
    for (const bad of ["0/2", "1/0", "0/0", "3/2", "foo", "1/2/3", "1.5/2", "-1/2", "1/-2", "1/", "/2", "/", "1 / 2"]) {
      withPwShard(bad, () => {
        assert.throws(
          () => rawStackPlaywright({ ci: true }),
          (err) => err instanceof Error && /Invalid PW_SHARD/.test(err.message),
          `expected error for ${JSON.stringify(bad)}`,
        );
      });
    }
  });

  test("parsePlaywrightShard rejects unsafe integers", () => {
    assert.throws(
      () => parsePlaywrightShard("99999999999999999999/99999999999999999999"),
      /Invalid PW_SHARD/,
    );
  });

  test("preserves existing local and CI defaults alongside sharding", () => {
    withPwShard("2/4", () => {
      const local = rawStackPlaywright({ ci: false });
      assert.equal(local.forbidOnly, false);
      assert.equal(local.retries, 0);
      assert.equal(local.fullyParallel, true);
      assert.deepEqual(local.projects, [{ name: "chromium", use: { browserName: "chromium" } }]);
      assert.deepEqual(local.shard, { current: 2, total: 4 });

      const ci = rawStackPlaywright({ ci: true });
      assert.equal(ci.forbidOnly, true);
      assert.deepEqual(ci.projects, [
        { name: "chromium", use: { browserName: "chromium" } },
        { name: "webkit", use: { browserName: "webkit" } },
      ]);
      assert.deepEqual(ci.shard, { current: 2, total: 4 });
    });
  });

  test("remains compatible with playwrightConfigProblems guard", () => {
    const root = mkdtempSync(join(tmpdir(), "raw-stack-pw-guard-"));
    try {
      writeFileSync(
        join(root, "playwright.config.ts"),
        `import { defineConfig } from "@playwright/test";
import { rawStackPlaywright } from "raw-stack/playwright";

export default defineConfig({
  ...rawStackPlaywright(),
  use: { ...rawStackPlaywright().use, baseURL: "http://localhost:5173" },
});
`,
      );
      assert.deepEqual(playwrightConfigProblems(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("rawStackPlaywright SMOKE_BASE_URL and SMOKE_HEADERS_JSON handling", () => {
  test("preserves e2e defaults and optional baseURL / webServer when SMOKE_BASE_URL is unset", () => {
    withEnv({ SMOKE_BASE_URL: undefined, SMOKE_HEADERS_JSON: undefined, PW_SHARD: undefined }, () => {
      const defaults = rawStackPlaywright({ ci: false });
      assert.equal(defaults.testDir, "e2e");
      assert.equal(defaults.testMatch, "**/*.spec.ts");
      assert.equal("webServer" in defaults, false);
      assert.deepEqual(defaults.use, { trace: "retain-on-failure" });

      const withOpts = rawStackPlaywright({
        ci: false,
        baseURL: "http://localhost:5173",
        webServer: {
          command: "pnpm start",
          url: "http://localhost:5173",
          reuseExistingServer: true,
        },
        use: { viewport: { width: 1280, height: 720 } },
      });
      assert.equal(withOpts.testDir, "e2e");
      assert.equal(withOpts.testMatch, "**/*.spec.ts");
      assert.deepEqual(withOpts.webServer, {
        command: "pnpm start",
        url: "http://localhost:5173",
        reuseExistingServer: true,
      });
      assert.deepEqual(withOpts.use, {
        viewport: { width: 1280, height: 720 },
        baseURL: "http://localhost:5173",
        trace: "retain-on-failure",
      });
    });

    const root = mkdtempSync(join(tmpdir(), "raw-stack-pw-opts-"));
    try {
      writeFileSync(
        join(root, "playwright.config.ts"),
        `import { defineConfig } from "@playwright/test";
import { rawStackPlaywright } from "raw-stack/playwright";

export default defineConfig({
  ...rawStackPlaywright({
    baseURL: "http://localhost:5173",
    webServer: {
      command: "pnpm start",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
    },
  }),
});
`,
      );
      assert.deepEqual(playwrightConfigProblems(root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("targets smoke/, sets baseURL & extraHTTPHeaders, and disables webServer when SMOKE_BASE_URL is set", () => {
    const secret = "smoke-pw-secret-424242";
    withEnv(
      {
        SMOKE_BASE_URL: "https://staging.example.com/app/",
        SMOKE_HEADERS_JSON: JSON.stringify({
          "CF-Access-Client-Id": "id-1",
          "CF-Access-Client-Secret": secret,
        }),
        PW_SHARD: undefined,
      },
      () => {
        const cfg = rawStackPlaywright({
          ci: false,
          baseURL: "http://localhost:5173",
          webServer: {
            command: "pnpm start",
            url: "http://localhost:5173",
            reuseExistingServer: true,
          },
          use: {
            extraHTTPHeaders: { "X-Existing": "keep", "CF-Access-Client-Id": "override-me" },
          },
        });
        assert.equal(cfg.testDir, "smoke");
        assert.equal(cfg.testMatch, "**/*.smoke.spec.ts");
        assert.equal("webServer" in cfg, true);
        assert.equal(cfg.webServer, undefined);
        assert.equal(cfg.use.baseURL, "https://staging.example.com/app");
        assert.equal(cfg.use.trace, "retain-on-failure");
        assert.deepEqual(cfg.use.extraHTTPHeaders, {
          "X-Existing": "keep",
          "CF-Access-Client-Id": "id-1",
          "CF-Access-Client-Secret": secret,
        });
      },
    );

    withEnv({ SMOKE_BASE_URL: "https://public.example.com/", SMOKE_HEADERS_JSON: undefined }, () => {
      const cfg = rawStackPlaywright({ ci: false });
      assert.equal(cfg.testDir, "smoke");
      assert.equal(cfg.testMatch, "**/*.smoke.spec.ts");
      assert.equal(cfg.webServer, undefined);
      assert.equal(cfg.use.baseURL, "https://public.example.com");
      assert.equal("extraHTTPHeaders" in cfg.use, false);
    });
  });

  test("throws without leaking secrets on invalid SMOKE_BASE_URL or SMOKE_HEADERS_JSON", () => {
    const secret = "top-secret-pw-leak-check-999";
    withEnv({ SMOKE_BASE_URL: "ftp://invalid.example.com", SMOKE_HEADERS_JSON: undefined }, () => {
      assert.throws(() => rawStackPlaywright(), /Invalid smoke URL/);
    });

    for (const badJson of [
      `{broken ${secret}`,
      `["${secret}"]`,
      `{"Bad Header": "${secret}"}`,
      `{"X-Val": "${secret}\\n"}`,
      `{"X-Num": 42}`,
    ]) {
      withEnv({ SMOKE_BASE_URL: "https://example.com", SMOKE_HEADERS_JSON: badJson }, () => {
        assert.throws(
          () => rawStackPlaywright(),
          (err) => err instanceof Error && /Invalid SMOKE_HEADERS_JSON/.test(err.message) && !err.message.includes(secret),
          `expected secret-free error for ${badJson}`,
        );
      });
    }
  });
});
