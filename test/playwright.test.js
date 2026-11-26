// @ts-check
// Tests for rawStackPlaywright() and native PW_SHARD parsing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parsePlaywrightShard, rawStackPlaywright } from "../config/playwright.js";
import { playwrightConfigProblems } from "../lib/browser-tests.js";

/** @param {string | undefined} value @param {() => void} fn */
function withPwShard(value, fn) {
  const prev = process.env["PW_SHARD"];
  if (value === undefined) delete process.env["PW_SHARD"];
  else process.env["PW_SHARD"] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env["PW_SHARD"];
    else process.env["PW_SHARD"] = prev;
  }
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
