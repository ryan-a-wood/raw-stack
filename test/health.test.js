// @ts-check
// Tests for `raw-stack health` (lib/health.js and CLI flags --json, --strict).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeHealth, DEFAULT_THRESHOLDS, formatHealthReport } from "../lib/health.js";

const CLI = fileURLToPath(new URL("../bin/raw-stack.js", import.meta.url));

/**
 * Create a temporary project with `files`, run `fn(root)`, and clean up afterwards.
 * @template T
 * @param {Record<string, string>} files
 * @param {(root: string) => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withFixture(files, fn) {
  const root = mkdtempSync(join(tmpdir(), "raw-stack-health-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
    for (const [rel, content] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Run `raw-stack health ...args` in `cwd`.
 * @param {string} cwd
 * @param {string[]} [args]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runHealthCli(cwd, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "health", ...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("raw-stack health analysis", () => {
  test("counts prod files, prod LOC, sibling fan-out, and index export usage accurately", async () => {
    await withFixture(
      {
        "src/main.ts":
          'import { alpha, type AlphaConfig } from "./modules/a/index.ts";\nimport { beta } from "./modules/b/index.ts";\nconst c: AlphaConfig = { ok: true };\nconsole.log(alpha(c), beta());\n',
        "src/modules/a/index.ts":
          'export type AlphaConfig = { ok: boolean };\nexport function alpha(c: AlphaConfig) { return c.ok; }\nexport function testOnlyHelper() { return 1; }\nexport const unusedConst = 2;\n',
        "src/modules/a/internal.ts": "export const hidden = 1;\nexport const hidden2 = 2;\n",
        "src/modules/a/a.test.ts": 'import { alpha, testOnlyHelper } from "./index.ts";\nconsole.log(alpha({ ok: true }), testOnlyHelper());\n',
        "src/modules/a/types.d.ts": "export type IgnoredDts = string;\n",
        "src/modules/b/index.ts":
          'import { alpha } from "../a/index.ts";\nexport function beta() { return alpha({ ok: true }); }\n',
        "src/modules/c/index.ts": "export const gamma = 3;\n",
        "src/testing/mock.ts": 'import { gamma } from "../modules/c/index.ts";\nexport const mockGamma = () => gamma;\n',
        "e2e/app.test.ts": 'import { beta } from "../src/modules/b/index.ts";\nconsole.log(beta());\n',
      },
      (root) => {
        const report = analyzeHealth(root);
        assert.equal(report.ok, false);
        assert.deepEqual(report.thresholds, DEFAULT_THRESHOLDS);
        assert.equal(report.modules.length, 3);

        const modA = report.modules.find((m) => m.name === "a");
        assert.ok(modA);
        assert.equal(modA.hasIndex, true);
        assert.equal(modA.indexFile, "src/modules/a/index.ts");
        // index.ts (4 lines) + internal.ts (2 lines); excludes a.test.ts and types.d.ts
        assert.equal(modA.prodFiles, 2);
        assert.equal(modA.prodLoc, 6);
        assert.equal(modA.exports.total, 4);
        assert.deepEqual(modA.exports.usedByProd, ["AlphaConfig", "alpha"]);
        assert.deepEqual(modA.exports.testOnly, ["testOnlyHelper"]);
        assert.deepEqual(modA.exports.unused, ["unusedConst"]);
        assert.deepEqual(modA.siblingFanOut, {
          count: 0,
          totalSiblings: 2,
          ratio: 0,
          percent: 0,
          modules: [],
        });

        const modB = report.modules.find((m) => m.name === "b");
        assert.ok(modB);
        assert.equal(modB.prodFiles, 1);
        assert.equal(modB.prodLoc, 2);
        assert.deepEqual(modB.exports.usedByProd, ["beta"]);
        assert.deepEqual(modB.exports.testOnly, []);
        assert.deepEqual(modB.exports.unused, []);
        assert.deepEqual(modB.siblingFanOut, {
          count: 1,
          totalSiblings: 2,
          ratio: 0.5,
          percent: 50,
          modules: ["a"],
        });

        const modC = report.modules.find((m) => m.name === "c");
        assert.ok(modC);
        // gamma is only imported by src/testing/mock.ts, so it is testOnly (not unused)
        assert.deepEqual(modC.exports.usedByProd, []);
        assert.deepEqual(modC.exports.testOnly, ["gamma"]);
        assert.deepEqual(modC.exports.unused, []);

        assert.deepEqual(
          report.warnings.map((w) => ({ module: w.module, kind: w.kind })),
          [{ module: "a", kind: "unused-exports" }],
        );
      },
    );
  });

  test("handles re-exports, default/type/interface/enum/destructured exports, .js specifiers, and index.tsx", async () => {
    await withFixture(
      {
        "src/main.ts": [
          'import defVal, { renamed, starA, nsGroup, type MyIface, MyEnum, dObj, dArr } from "./modules/rich/index.js";',
          'import { View } from "./modules/ui/index.tsx";',
          "const x: MyIface = { v: defVal + renamed + starA + nsGroup.x + MyEnum.A + dObj + dArr };",
          "console.log(x, View());",
        ].join("\n"),
        "src/modules/rich/index.ts": [
          "export default 1;",
          'export { orig as renamed } from "./parts.ts";',
          'export * from "./star.ts";',
          'export * as nsGroup from "./ns.ts";',
          "export interface MyIface { v: number }",
          "export enum MyEnum { A = 1 }",
          "const obj = { dObj: 1 };",
          "const arr = [2];",
          "export const { dObj } = obj;",
          "export const [dArr] = arr;",
          "export type UnusedAlias = string;",
        ].join("\n"),
        "src/modules/rich/parts.ts": "export const orig = 1;\n",
        "src/modules/rich/star.ts": "export const starA = 2;\nexport const starUnused = 3;\nexport default 99;\n",
        "src/modules/rich/ns.ts": "export const x = 4;\n",
        "src/modules/ui/index.tsx": "export const View = () => <div />;\n",
      },
      (root) => {
        const report = analyzeHealth(root);
        const rich = report.modules.find((m) => m.name === "rich");
        assert.ok(rich);
        assert.deepEqual(rich.exports.usedByProd, ["MyEnum", "MyIface", "dArr", "dObj", "default", "nsGroup", "renamed", "starA"]);
        assert.deepEqual(rich.exports.unused, ["UnusedAlias", "starUnused"]);

        const ui = report.modules.find((m) => m.name === "ui");
        assert.ok(ui);
        assert.equal(ui.indexFile, "src/modules/ui/index.tsx");
        assert.deepEqual(ui.exports.usedByProd, ["View"]);
        assert.deepEqual(ui.exports.unused, []);
      },
    );
  });

  test("tracks namespace imports both granularly (member access / destructuring / qualified type) and opaquely (passed/spread)", async () => {
    await withFixture(
      {
        "src/main.ts": [
          'import * as granular from "./modules/granular/index.ts";',
          'import * as opaque from "./modules/opaque/index.ts";',
          'import * as dyn from "./modules/dynamic/index.ts";',
          "const { fromDestruct } = granular;",
          'const a = granular.byDot() + granular["byBracket"]() + fromDestruct;',
          "type T = granular.UsedType;",
          "const takeAll = (x: unknown) => x;",
          "takeAll(opaque);",
          'void import("./modules/dynamic/index.ts");',
          "console.log(a, dyn.one);",
        ].join("\n"),
        "src/modules/granular/index.ts": [
          "export const byDot = () => 1;",
          "export const byBracket = () => 2;",
          "export const fromDestruct = 3;",
          "export type UsedType = number;",
          "export const neverTouched = 4;",
        ].join("\n"),
        "src/modules/opaque/index.ts": "export const a = 1;\nexport const b = 2;\n",
        "src/modules/dynamic/index.ts": "export const one = 1;\nexport const two = 2;\n",
      },
      (root) => {
        const report = analyzeHealth(root);
        const granular = report.modules.find((m) => m.name === "granular");
        assert.ok(granular);
        assert.deepEqual(granular.exports.usedByProd, ["UsedType", "byBracket", "byDot", "fromDestruct"]);
        assert.deepEqual(granular.exports.unused, ["neverTouched"]);

        const opaque = report.modules.find((m) => m.name === "opaque");
        assert.ok(opaque);
        assert.deepEqual(opaque.exports.usedByProd, ["a", "b"]);
        assert.deepEqual(opaque.exports.unused, []);

        const dynamic = report.modules.find((m) => m.name === "dynamic");
        assert.ok(dynamic);
        assert.deepEqual(dynamic.exports.usedByProd, ["one", "two"]);
        assert.deepEqual(dynamic.exports.unused, []);
      },
    );
  });

  test("triggers soft-threshold warnings for prodFiles (>20), indexExports (>25), siblingFanOut (>50% with >=2 siblings), and unused exports", async () => {
    /** @type {Record<string, string>} */
    const files = {
      "src/main.ts": 'import * as big from "./modules/big/index.ts";\nimport { a } from "./modules/a/index.ts";\nimport { b } from "./modules/b/index.ts";\nimport { c } from "./modules/c/index.ts";\nconsole.log(big, a, b, c);\n',
      "src/modules/a/index.ts": "export const a = 1;\n",
      "src/modules/b/index.ts": "export const b = 2;\n",
      "src/modules/c/index.ts": "export const c = 3;\n",
    };

    // big module: 21 prod files (index.ts + f1..f20), 26 exports, imports 2/3 siblings (67%)
    const exportLines = [];
    for (let i = 1; i <= 26; i++) exportLines.push(`export const e${i} = ${i};`);
    files["src/modules/big/index.ts"] = [
      'import { a } from "../a/index.ts";',
      'import { b } from "../b/index.ts";',
      "export const sum = a + b;",
      ...exportLines,
    ].join("\n");
    for (let i = 1; i <= 20; i++) {
      files[`src/modules/big/f${i}.ts`] = `export const v${i} = ${i};\n`;
    }

    await withFixture(files, (root) => {
      const report = analyzeHealth(root);
      assert.equal(report.ok, false);
      const big = report.modules.find((m) => m.name === "big");
      assert.ok(big);
      assert.equal(big.prodFiles, 21);
      assert.equal(big.exports.total, 27);
      assert.equal(big.siblingFanOut.count, 2);
      assert.equal(big.siblingFanOut.totalSiblings, 3);
      assert.equal(big.siblingFanOut.percent, 67);

      const kinds = report.warnings.filter((w) => w.module === "big").map((w) => w.kind).sort();
      assert.deepEqual(kinds, ["index-exports", "prod-files", "sibling-fan-out"]);
    });
  });

  test("does not trigger sibling fan-out warning on 2-module projects (1/1 sibling) or at exact 50% (1/2)", async () => {
    await withFixture(
      {
        "src/main.ts": 'import { a } from "./modules/a/index.ts";\nimport { b } from "./modules/b/index.ts";\nconsole.log(a(), b());\n',
        "src/modules/a/index.ts": 'import { b } from "../b/index.ts";\nexport const a = () => b();\n',
        "src/modules/b/index.ts": "export const b = () => 1;\n",
      },
      (root) => {
        const report = analyzeHealth(root);
        assert.equal(report.ok, true);
        assert.deepEqual(report.warnings, []);
        const modA = report.modules.find((m) => m.name === "a");
        assert.ok(modA);
        assert.equal(modA.siblingFanOut.count, 1);
        assert.equal(modA.siblingFanOut.totalSiblings, 1);
        assert.equal(modA.siblingFanOut.percent, 100);
      },
    );
  });

  test("handles missing src/modules, empty src/modules, and modules without index.ts", async () => {
    await withFixture({ "src/main.ts": "console.log(1);\n" }, (root) => {
      const report = analyzeHealth(root);
      assert.equal(report.ok, true);
      assert.deepEqual(report.modules, []);
      assert.deepEqual(report.warnings, []);
      assert.equal(formatHealthReport(report), "No modules found under src/modules/.");
    });

    await withFixture({ "src/main.ts": "console.log(1);\n" }, (root) => {
      mkdirSync(join(root, "src", "modules"), { recursive: true });
      const report = analyzeHealth(root);
      assert.equal(report.ok, true);
      assert.deepEqual(report.modules, []);
      assert.equal(formatHealthReport(report), "No modules found under src/modules/.");
    });

    await withFixture(
      {
        "src/main.ts": "console.log(1);\n",
        "src/modules/noindex/helper.ts": "export const h = 1;\n",
      },
      (root) => {
        const report = analyzeHealth(root);
        assert.equal(report.ok, true);
        assert.equal(report.modules[0]?.hasIndex, false);
        assert.equal(report.modules[0]?.indexFile, null);
        const text = formatHealthReport(report);
        assert.match(text, /noindex\s+1\s+1\s+-\s+-\s+-\s+-\s+0\/0 \(0%\)/);
      },
    );
  });
});

describe("raw-stack health CLI", () => {
  test("prints table and exits 0 by default even with warnings, exits 1 with --strict, and supports --json and --json --strict", async () => {
    await withFixture(
      {
        "src/main.ts": 'import { used } from "./modules/alpha/index.ts";\nconsole.log(used());\n',
        "src/modules/alpha/index.ts": "export const used = () => 1;\nexport const dead = () => 2;\n",
      },
      async (root) => {
        const textRun = await runHealthCli(root);
        assert.equal(textRun.code, 0, textRun.stderr);
        assert.match(textRun.stdout, /Module\s+Files\s+LOC\s+Exports\s+Prod\s+Test-only\s+Unused\s+Fan-out/);
        assert.match(textRun.stdout, /alpha/);
        assert.match(textRun.stdout, /Warnings \(1\):/);
        assert.match(textRun.stdout, /\[unused-exports\].*dead/);

        const strictRun = await runHealthCli(root, ["--strict"]);
        assert.equal(strictRun.code, 1);
        assert.match(strictRun.stdout, /Warnings \(1\):/);

        const jsonRun = await runHealthCli(root, ["--json"]);
        assert.equal(jsonRun.code, 0, jsonRun.stderr);
        const parsed = JSON.parse(jsonRun.stdout);
        assert.equal(parsed.ok, false);
        assert.equal(parsed.modules.length, 1);
        assert.equal(parsed.modules[0].name, "alpha");
        assert.deepEqual(parsed.modules[0].exports.unused, ["dead"]);
        assert.equal(parsed.warnings.length, 1);

        const jsonStrictRun = await runHealthCli(root, ["--json", "--strict"]);
        assert.equal(jsonStrictRun.code, 1);
        const parsedStrict = JSON.parse(jsonStrictRun.stdout);
        assert.equal(parsedStrict.ok, false);
        assert.equal(parsedStrict.warnings.length, 1);
      },
    );
  });

  test("exits 0 with --strict and --json --strict when healthy, and exits 2 on unknown flags", async () => {
    await withFixture(
      {
        "src/main.ts": 'import { used } from "./modules/alpha/index.ts";\nconsole.log(used());\n',
        "src/modules/alpha/index.ts": "export const used = () => 1;\n",
      },
      async (root) => {
        const strictRun = await runHealthCli(root, ["--strict"]);
        assert.equal(strictRun.code, 0, strictRun.stderr);
        assert.match(strictRun.stdout, /No health warnings\./);

        const jsonStrictRun = await runHealthCli(root, ["--json", "--strict"]);
        assert.equal(jsonStrictRun.code, 0, jsonStrictRun.stderr);
        const parsed = JSON.parse(jsonStrictRun.stdout);
        assert.equal(parsed.ok, true);
        assert.deepEqual(parsed.warnings, []);

        const badFlag = await runHealthCli(root, ["--bogus"]);
        assert.equal(badFlag.code, 2);
        assert.match(badFlag.stderr, /unknown option\(s\): --bogus/);
      },
    );
  });
});
