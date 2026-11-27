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
          [
            { module: "a", kind: "unused-exports" },
            { module: "c", kind: "unused-exports" },
          ],
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

  test("triggers warnings for prodFiles (>20), indexExports (>25), siblingFanOut (>50% with >=6 siblings), and unused exports", async () => {
    /** @type {Record<string, string>} */
    const files = {
      "src/main.ts": [
        'import * as big from "./modules/big/index.ts";',
        'import { m1 } from "./modules/m1/index.ts";',
        'import { m2 } from "./modules/m2/index.ts";',
        'import { m3 } from "./modules/m3/index.ts";',
        'import { m4 } from "./modules/m4/index.ts";',
        'import { m5 } from "./modules/m5/index.ts";',
        'import { m6 } from "./modules/m6/index.ts";',
        "console.log(big, m1, m2, m3, m4, m5, m6);",
      ].join("\n"),
      "src/modules/m1/index.ts": "export const m1 = 1;\n",
      "src/modules/m2/index.ts": "export const m2 = 2;\n",
      "src/modules/m3/index.ts": "export const m3 = 3;\n",
      "src/modules/m4/index.ts": "export const m4 = 4;\n",
      "src/modules/m5/index.ts": "export const m5 = 5;\n",
      "src/modules/m6/index.ts": "export const m6 = 6;\n",
    };

    // big module: 21 prod files (index.ts + f1..f20), 27 exports, imports 4/6 siblings (67%)
    const exportLines = [];
    for (let i = 1; i <= 26; i++) exportLines.push(`export const e${i} = ${i};`);
    files["src/modules/big/index.ts"] = [
      'import { m1 } from "../m1/index.ts";',
      'import { m2 } from "../m2/index.ts";',
      'import { m3 } from "../m3/index.ts";',
      'import { m4 } from "../m4/index.ts";',
      "export const sum = m1 + m2 + m3 + m4;",
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
      assert.equal(big.siblingFanOut?.count, 4);
      assert.equal(big.siblingFanOut?.totalSiblings, 6);
      assert.equal(big.siblingFanOut?.percent, 67);

      const kinds = report.warnings.filter((w) => w.module === "big").map((w) => w.kind).sort();
      assert.deepEqual(kinds, ["index-exports", "prod-files", "sibling-fan-out"]);
    });
  });

  test("does not trigger sibling fan-out warning on a 4-module app (even when importing 3/3 siblings) or at 3/6 (50%)", async () => {
    await withFixture(
      {
        "src/main.ts":
          'import { a } from "./modules/a/index.ts";\nimport { b } from "./modules/b/index.ts";\nimport { c } from "./modules/c/index.ts";\nimport { d } from "./modules/d/index.ts";\nconsole.log(a(), b(), c(), d());\n',
        "src/modules/a/index.ts":
          'import { b } from "../b/index.ts";\nimport { c } from "../c/index.ts";\nimport { d } from "../d/index.ts";\nexport const a = () => b() + c() + d();\n',
        "src/modules/b/index.ts": "export const b = () => 1;\n",
        "src/modules/c/index.ts": "export const c = () => 2;\n",
        "src/modules/d/index.ts": "export const d = () => 3;\n",
      },
      (root) => {
        const report = analyzeHealth(root);
        assert.equal(report.ok, true);
        assert.deepEqual(report.warnings, []);
        const modA = report.modules.find((m) => m.name === "a");
        assert.ok(modA);
        assert.equal(modA.siblingFanOut?.count, 3);
        assert.equal(modA.siblingFanOut?.totalSiblings, 3);
        assert.equal(modA.siblingFanOut?.percent, 100);
      },
    );
  });

  test("counts prodFiles and entrypoint exports per 1-level submodule unit while evaluating sibling fan-out at top-level module", async () => {
    /** @type {Record<string, string>} */
    const files = {
      "src/main.ts": [
        'import { run } from "./modules/reading/index.ts";',
        'import { m1 } from "./modules/m1/index.ts";',
        'import { m2 } from "./modules/m2/index.ts";',
        'import { m3 } from "./modules/m3/index.ts";',
        'import { m4 } from "./modules/m4/index.ts";',
        'import { m5 } from "./modules/m5/index.ts";',
        'import { m6 } from "./modules/m6/index.ts";',
        "console.log(run(), m1, m2, m3, m4, m5, m6);",
      ].join("\n"),
      "src/modules/m1/index.ts": "export const m1 = 1;\n",
      "src/modules/m2/index.ts": "export const m2 = 2;\n",
      "src/modules/m3/index.ts": "export const m3 = 3;\n",
      "src/modules/m4/index.ts": "export const m4 = 4;\n",
      "src/modules/m5/index.ts": "export const m5 = 5;\n",
      "src/modules/m6/index.ts": "export const m6 = 6;\n",
      "src/modules/reading/index.ts":
        'import { parse } from "./parser/index.ts";\nimport { render } from "./render/index.ts";\nexport const run = () => render(parse());\n',
      "src/modules/reading/parser/index.ts":
        'import { m1 } from "../../m1/index.ts";\nimport { m2 } from "../../m2/index.ts";\nexport const parse = () => m1 + m2;\n',
      "src/modules/reading/render/index.ts":
        'import { m3 } from "../../m3/index.ts";\nimport { m4 } from "../../m4/index.ts";\nexport const render = (n: number) => n + m3 + m4;\n',
    };
    // 11 extra files in reading + 11 extra files in reading/parser = 24 total (>20), but each unit has 12 (<=20)
    for (let i = 1; i <= 11; i++) {
      files[`src/modules/reading/h${i}.ts`] = `export const h${i} = ${i};\n`;
      files[`src/modules/reading/parser/p${i}.ts`] = `export const p${i} = ${i};\n`;
    }

    await withFixture(files, (root) => {
      const report = analyzeHealth(root);
      const reading = report.modules.find((m) => m.name === "reading");
      const parser = report.modules.find((m) => m.name === "reading/parser");
      const render = report.modules.find((m) => m.name === "reading/render");
      assert.ok(reading && parser && render);

      assert.equal(reading.prodFiles, 12);
      assert.equal(parser.prodFiles, 12);
      assert.equal(render.prodFiles, 1);
      assert.equal(parser.isSubmodule, true);
      assert.equal(parser.siblingFanOut, null);

      // No prod-files warning because each unit is <= 20
      assert.equal(report.warnings.some((w) => w.kind === "prod-files"), false);
      // Top-level sibling fan-out STILL catches 4/6 (m1, m2 from parser + m3, m4 from render)
      assert.deepEqual(reading.siblingFanOut?.modules, ["m1", "m2", "m3", "m4"]);
      assert.ok(
        report.warnings.some((w) => w.module === "reading" && w.kind === "sibling-fan-out"),
        `expected top-level sibling-fan-out warning, got: ${JSON.stringify(report.warnings)}`,
      );
    });
  });

  test("allows exported types/interfaces referenced by live exported signatures (direct and re-exported) while flagging dead types and test-only values", async () => {
    await withFixture(
      {
        "src/main.ts":
          'import { createPointsService } from "./modules/points/index.ts";\nimport { createReService } from "./modules/reexp/index.ts";\nconsole.log(createPointsService(), createReService());\n',
        "src/modules/points/index.ts": [
          "export interface PointSummary { total: number; }",
          "export interface PointsService { since(date: Date): PointSummary; }",
          "export function createPointsService(): PointsService { return { since: () => ({ total: 0 }) }; }",
          "export interface DeadType { x: string; }",
          "export interface DeadChainA { b: DeadChainB; }",
          "export interface DeadChainB { n: number; }",
          "export function testOnlyFn() { return 1; }",
        ].join("\n"),
        "src/modules/points/points.test.ts":
          'import { testOnlyFn, type PointSummary } from "./index.ts";\nconst s: PointSummary = { total: testOnlyFn() };\nconsole.log(s);\n',
        "src/modules/reexp/types.ts": "export interface SummaryItem { id: string; }\n",
        "src/modules/reexp/service.ts":
          'import type { SummaryItem } from "./types.ts";\nexport interface ReService { list(): Promise<SummaryItem[]>; }\nexport const createReService = (): ReService => ({ list: async () => [] });\n',
        "src/modules/reexp/index.ts":
          'export { createReService, type ReService } from "./service.ts";\nexport type { SummaryItem } from "./types.ts";\n',
      },
      (root) => {
        const report = analyzeHealth(root);
        const points = report.modules.find((m) => m.name === "points");
        assert.ok(points);
        assert.deepEqual(points.exports.usedByProd, ["createPointsService"]);
        assert.deepEqual(points.exports.usedBySignature, ["PointSummary", "PointsService"]);
        assert.deepEqual(points.exports.testOnly, ["testOnlyFn"]);
        assert.deepEqual(points.exports.unused, ["DeadChainA", "DeadChainB", "DeadType"]);

        const reexp = report.modules.find((m) => m.name === "reexp");
        assert.ok(reexp);
        assert.deepEqual(reexp.exports.usedByProd, ["createReService"]);
        assert.deepEqual(reexp.exports.usedBySignature, ["ReService", "SummaryItem"]);
        assert.deepEqual(reexp.exports.testOnly, []);
        assert.deepEqual(reexp.exports.unused, []);
        assert.equal(report.warnings.some((w) => w.module === "reexp"), false);

        const pointsWarn = report.warnings.find((w) => w.module === "points" && w.kind === "unused-exports");
        assert.ok(pointsWarn);
        assert.match(pointsWarn.message, /DeadType/);
        assert.match(pointsWarn.message, /testOnlyFn/);
        assert.doesNotMatch(pointsWarn.message, /PointSummary/);
        assert.doesNotMatch(pointsWarn.message, /PointsService/);
      },
    );
  });

  test("recognizes types referenced by exported object literal methods/properties and inherited base class methods", async () => {
    await withFixture(
      {
        "src/main.ts": 'import { api, Sub } from "./modules/sigs/index.ts";\nconsole.log(api, new Sub());\n',
        "src/modules/sigs/index.ts": [
          "export interface GetReq { id: string; }",
          "export interface GetRes { ok: boolean; }",
          "export interface PostRes { saved: boolean; }",
          "export interface Out { v: number; }",
          "const helper = (r: GetReq): PostRes => ({ saved: r.id.length > 0 });",
          "export const api = {",
          "  get(req: GetReq): GetRes { return { ok: req.id.length > 0 }; },",
          "  helper,",
          "};",
          "class Base { get(): Out { return { v: 1 }; } }",
          "export class Sub extends Base {}",
        ].join("\n"),
      },
      (root) => {
        const report = analyzeHealth(root);
        assert.equal(report.ok, true, JSON.stringify(report.warnings));
        const sigs = report.modules.find((m) => m.name === "sigs");
        assert.ok(sigs);
        assert.deepEqual(sigs.exports.usedByProd, ["Sub", "api"]);
        assert.deepEqual(sigs.exports.usedBySignature, ["GetReq", "GetRes", "Out", "PostRes"]);
        assert.deepEqual(sigs.exports.unused, []);
      },
    );
  });

  test("checks client.ts(x) entrypoints independently for export count and unused exports, and allows *.property.test.ts to import pure internal files", async () => {
    await withFixture(
      {
        "src/main.ts": 'import { greet } from "./modules/ui/index.ts";\nconsole.log(greet("a"));\n',
        "src/browser.tsx": 'import { Widget } from "./modules/ui/client.tsx";\nconsole.log(Widget());\n',
        "src/modules/ui/pure.ts": "export const normalize = (s: string) => s.trim();\n",
        "src/modules/ui/index.ts": 'import { normalize } from "./pure.ts";\nexport const greet = (s: string) => normalize(s);\n',
        "src/modules/ui/client.tsx":
          'export const Widget = () => <div />;\nexport const unusedClientExport = () => 1;\n',
        "src/modules/ui/ui.property.test.ts":
          'import { normalize } from "./pure.ts";\nconsole.log(normalize(" hi "));\n',
      },
      (root) => {
        const report = analyzeHealth(root);
        assert.equal(report.ok, false);
        const ui = report.modules.find((m) => m.name === "ui");
        assert.ok(ui);
        assert.equal(ui.hasClient, true);
        assert.equal(ui.clientFile, "src/modules/ui/client.tsx");
        assert.deepEqual(ui.exports.usedByProd, ["greet"]);
        assert.deepEqual(ui.exports.unused, []);
        assert.deepEqual(ui.clientExports?.usedByProd, ["Widget"]);
        assert.deepEqual(ui.clientExports?.unused, ["unusedClientExport"]);
        assert.equal(report.warnings.length, 1);
        assert.match(report.warnings[0]?.message ?? "", /client\.tsx.*unusedClientExport/);
      },
    );
  });

  test("checks export count per entrypoint (15 index + 15 client passes, 26 client fails) and prod-files per submodule (>20 fails)", async () => {
    /** @type {Record<string, string>} */
    const okFiles = {
      "src/main.ts": 'import * as a from "./modules/a/index.ts";\nconsole.log(a);\n',
      "src/browser.tsx": 'import * as ac from "./modules/a/client.ts";\nconsole.log(ac);\n',
      "src/modules/a/index.ts": Array.from({ length: 15 }, (_, i) => `export const s${i} = ${i};`).join("\n") + "\n",
      "src/modules/a/client.ts": Array.from({ length: 15 }, (_, i) => `export const c${i} = ${i};`).join("\n") + "\n",
    };
    await withFixture(okFiles, (root) => {
      const report = analyzeHealth(root);
      assert.equal(report.ok, true, JSON.stringify(report.warnings));
    });

    /** @type {Record<string, string>} */
    const failFiles = {
      "src/main.ts": 'import { root } from "./modules/a/index.ts";\nconsole.log(root());\n',
      "src/browser.tsx": 'import * as ac from "./modules/a/client.ts";\nconsole.log(ac);\n',
      "src/modules/a/index.ts": 'import { sub } from "./sub/index.ts";\nexport const root = () => sub();\n',
      "src/modules/a/client.ts": Array.from({ length: 26 }, (_, i) => `export const c${i} = ${i};`).join("\n") + "\n",
      "src/modules/a/sub/index.ts": "export const sub = () => 1;\n",
    };
    for (let i = 1; i <= 20; i++) {
      failFiles[`src/modules/a/sub/f${i}.ts`] = `export const f${i} = ${i};\n`;
    }
    await withFixture(failFiles, (root) => {
      const report = analyzeHealth(root);
      assert.equal(report.ok, false);
      assert.ok(
        report.warnings.some((w) => w.module === "a" && w.kind === "index-exports" && w.message.includes("client.ts")),
        `expected client.ts index-exports warning, got: ${JSON.stringify(report.warnings)}`,
      );
      assert.ok(
        report.warnings.some((w) => w.module === "a/sub" && w.kind === "prod-files" && w.message.includes('submodule "a/sub"')),
        `expected submodule a/sub prod-files warning, got: ${JSON.stringify(report.warnings)}`,
      );
    });
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
