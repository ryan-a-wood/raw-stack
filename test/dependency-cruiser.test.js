// @ts-check
// Tests for shared dependency-cruiser rules (no-orphans reachability,
// not-to-test, not-to-testing) and opt-in presets from raw-stack/dependency-cruiser-rules
// (clientBoundary, deepSubmodules), plus guard compatibility.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { guard } from "../lib/guard.js";
import { depcruiseScript } from "../lib/project.js";
import { VERIFY_WORKFLOW } from "../lib/workflows.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE_WORKFLOW = readFileSync(new URL(`../template/${VERIFY_WORKFLOW}`, import.meta.url), "utf8");
const DEPCRUISE = depcruiseScript();
const require = createRequire(import.meta.url);

/**
 * Create a temporary project directory with `node_modules/raw-stack` linked to this checkout,
 * run `fn(root)`, and clean up afterwards.
 * @template T
 * @param {Record<string, string>} files
 * @param {(root: string) => T} fn
 * @param {string} [depcruiseConfig]
 * @returns {T}
 */
function withProject(files, fn, depcruiseConfig) {
  const root = mkdtempSync(join(tmpdir(), "raw-stack-depcruise-"));
  try {
    mkdirSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(REPO_ROOT, join(root, "node_modules", "raw-stack"), "dir");

    /** @type {Record<string, string>} */
    const baseFiles = {
      "package.json": JSON.stringify({ name: "fixture", private: true, type: "module" }, null, 2),
      "tsconfig.json": JSON.stringify({ extends: "raw-stack/tsconfig.json" }, null, 2),
      "vite.config.ts": 'import { defineConfig } from "vite-plus";\nimport { rawStack } from "raw-stack/vite";\nexport default defineConfig({ ...rawStack() });\n',
      [VERIFY_WORKFLOW]: TEMPLATE_WORKFLOW,
      ".dependency-cruiser.cjs":
        depcruiseConfig ?? 'module.exports = { extends: require.resolve("raw-stack/dependency-cruiser") };\n',
      ...files,
    };

    for (const [rel, content] of Object.entries(baseFiles)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }

    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Run dependency-cruiser on `src/` in `root` and return parsed JSON summary.
 * @param {string} root
 * @returns {{ totalCruised: number, violations: Array<{ from: string, to: string, rule: { name: string } }> }}
 */
function runDepcruise(root) {
  const res = spawnSync(process.execPath, [DEPCRUISE, "src", "--output-type", "json"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.ok(res.stdout.trim().length > 0, `depcruise produced no JSON stdout. stderr:\n${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.ok(parsed.summary.totalCruised > 0, "dependency-cruiser must cruise > 0 files");
  return parsed.summary;
}

describe("shared dependency-cruiser rules: no-orphans reachability", () => {
  test("passes on a valid single-entrypoint project (src/main.ts) with tests, .d.ts, and src/testing/", () => {
    withProject(
      {
        "src/main.ts": 'import { greet } from "./modules/greeting/index.ts";\nconsole.log(greet("world"));\n',
        "src/types.d.ts": "export type Brand = string;\n",
        "src/modules/greeting/index.ts": 'import { format } from "./format.ts";\nexport const greet = (name: string) => format(name);\n',
        "src/modules/greeting/format.ts": 'export const format = (s: string) => `Hello, ${s}!`;\n',
        "src/modules/greeting/greeting.test.ts":
          'import { greet } from "./index.ts";\nimport { fakeName } from "../../testing/fixtures.ts";\nconsole.log(greet(fakeName()));\n',
        "src/testing/fixtures.ts": 'import { randomSeed } from "./seed.ts";\nexport const fakeName = () => `user-${randomSeed()}`;\n',
        "src/testing/seed.ts": "export const randomSeed = () => 42;\n",
      },
      (root) => {
        const summary = runDepcruise(root);
        assert.deepEqual(summary.violations, []);
      },
    );
  });

  test("passes on a multi-entrypoint project (src/main.ts + src/browser.tsx)", () => {
    withProject(
      {
        "src/main.ts": 'import { runServer } from "./modules/server/index.ts";\nrunServer();\n',
        "src/browser.tsx": 'import { renderApp } from "./modules/ui/index.tsx";\nrenderApp();\n',
        "src/modules/server/index.ts": "export const runServer = () => 1;\n",
        "src/modules/ui/index.tsx": "export const renderApp = () => null;\n",
      },
      (root) => {
        const summary = runDepcruise(root);
        assert.deepEqual(summary.violations, []);
      },
    );
  });

  test("fails on a dead production file that has outgoing imports", () => {
    withProject(
      {
        "src/main.ts": 'import { live } from "./modules/app/index.ts";\nconsole.log(live());\n',
        "src/modules/app/index.ts": 'import { shared } from "./shared.ts";\nexport const live = () => shared();\n',
        "src/modules/app/shared.ts": "export const shared = () => 1;\n",
        "src/modules/app/dead-with-import.ts": 'import { shared } from "./shared.ts";\nexport const unused = () => shared() + 1;\n',
      },
      (root) => {
        const summary = runDepcruise(root);
        const orphanViolations = summary.violations.filter((v) => v.rule.name === "no-orphans");
        assert.ok(
          orphanViolations.some((v) => v.to === "src/modules/app/dead-with-import.ts"),
          `expected no-orphans on dead-with-import.ts, got: ${JSON.stringify(summary.violations)}`,
        );
      },
    );
  });

  test("fails on an unreachable dead chain of production files", () => {
    withProject(
      {
        "src/main.ts": 'import { ok } from "./modules/app/index.ts";\nconsole.log(ok());\n',
        "src/modules/app/index.ts": "export const ok = () => 1;\n",
        "src/modules/dead/index.ts": 'import { helper } from "./helper.ts";\nexport const dead = () => helper();\n',
        "src/modules/dead/helper.ts": "export const helper = () => 2;\n",
      },
      (root) => {
        const summary = runDepcruise(root);
        const orphanTargets = summary.violations.filter((v) => v.rule.name === "no-orphans").map((v) => v.to);
        assert.ok(orphanTargets.includes("src/modules/dead/index.ts"), `missing dead/index.ts in ${JSON.stringify(orphanTargets)}`);
        assert.ok(orphanTargets.includes("src/modules/dead/helper.ts"), `missing dead/helper.ts in ${JSON.stringify(orphanTargets)}`);
      },
    );
  });

  test("fails on a dead production file imported only by a test file", () => {
    withProject(
      {
        "src/main.ts": 'import { ok } from "./modules/app/index.ts";\nconsole.log(ok());\n',
        "src/modules/app/index.ts": "export const ok = () => 1;\n",
        "src/modules/app/test-only-prod.ts": "export const onlyTested = () => 2;\n",
        "src/modules/app/app.test.ts": 'import { onlyTested } from "./test-only-prod.ts";\nconsole.log(onlyTested());\n',
      },
      (root) => {
        const summary = runDepcruise(root);
        const orphanTargets = summary.violations.filter((v) => v.rule.name === "no-orphans").map((v) => v.to);
        assert.ok(
          orphanTargets.includes("src/modules/app/test-only-prod.ts"),
          `expected no-orphans on test-only-prod.ts, got: ${JSON.stringify(summary.violations)}`,
        );
      },
    );
  });
});

describe("shared dependency-cruiser rules: not-to-test and not-to-testing", () => {
  test("fails when production code imports src/testing/*", () => {
    withProject(
      {
        "src/main.ts": 'import { run } from "./modules/app/index.ts";\nrun();\n',
        "src/modules/app/index.ts": 'import { fakeUser } from "../../testing/users.ts";\nexport const run = () => fakeUser();\n',
        "src/testing/users.ts": 'export const fakeUser = () => "alice";\n',
      },
      (root) => {
        const summary = runDepcruise(root);
        assert.ok(
          summary.violations.some((v) => v.rule.name === "not-to-testing" && v.from === "src/modules/app/index.ts" && v.to === "src/testing/users.ts"),
          `expected not-to-testing violation, got: ${JSON.stringify(summary.violations)}`,
        );
      },
    );
  });

  test("fails when production code imports a *.test.ts file", () => {
    withProject(
      {
        "src/main.ts": 'import { helper } from "./modules/app/app.test.ts";\nconsole.log(helper);\n',
        "src/modules/app/app.test.ts": "export const helper = 1;\n",
      },
      (root) => {
        const summary = runDepcruise(root);
        assert.ok(
          summary.violations.some((v) => v.rule.name === "not-to-test" && v.from === "src/main.ts"),
          `expected not-to-test violation, got: ${JSON.stringify(summary.violations)}`,
        );
      },
    );
  });

  test("passes when tests import src/testing/* and src/testing/* files import each other", () => {
    withProject(
      {
        "src/main.ts": 'import { ok } from "./modules/app/index.ts";\nconsole.log(ok());\n',
        "src/modules/app/index.ts": "export const ok = () => 1;\n",
        "src/modules/app/app.test.ts": 'import { makeFixture } from "../../testing/fixtures.ts";\nconsole.log(makeFixture());\n',
        "src/testing/fixtures.ts": 'import { baseId } from "./ids.ts";\nexport const makeFixture = () => ({ id: baseId() });\n',
        "src/testing/ids.ts": "export const baseId = () => 99;\n",
      },
      (root) => {
        const summary = runDepcruise(root);
        assert.deepEqual(summary.violations, []);
      },
    );
  });

  test("guard rejects redefining not-to-testing in .dependency-cruiser.cjs", () => {
    const badConfig = `module.exports = {
      extends: require.resolve("raw-stack/dependency-cruiser"),
      forbidden: [{ name: "not-to-testing", severity: "ignore", from: {}, to: {} }],
    };\n`;
    withProject(
      { "src/main.ts": "export const x = 1;\n" },
      (root) => {
        const problems = guard(root, []);
        assert.ok(
          problems.some((p) => p.includes('redefines the shared rule "not-to-testing"')),
          `expected guard to reject redefining not-to-testing, got: ${JSON.stringify(problems)}`,
        );
      },
      badConfig,
    );
  });
});

describe("opt-in presets: raw-stack/dependency-cruiser-rules", () => {
  test("exports clientBoundary, deepSubmodules, and DEFAULT_CLIENT_PATTERN via both CJS require and ESM import", async () => {
    const cjs = require("../config/dependency-cruiser-rules.cjs");
    const esm = await import("../config/dependency-cruiser-rules.cjs");
    assert.equal(typeof cjs.clientBoundary, "function");
    assert.equal(typeof cjs.deepSubmodules, "function");
    assert.equal(typeof cjs.DEFAULT_CLIENT_PATTERN, "string");
    assert.equal(typeof esm.clientBoundary, "function");
    assert.equal(typeof esm.deepSubmodules, "function");
    assert.equal(esm.DEFAULT_CLIENT_PATTERN, cjs.DEFAULT_CLIENT_PATTERN);
  });

  test("validates options and rejects collisions with SHARED_RULES", () => {
    const { clientBoundary, deepSubmodules } = require("../config/dependency-cruiser-rules.cjs");
    assert.throws(() => clientBoundary(/** @type {any} */ (null)), TypeError);
    assert.throws(() => clientBoundary({ serverModules: [] }), TypeError);
    assert.throws(() => clientBoundary({ serverModules: ["db"], clientPattern: "" }), TypeError);
    assert.throws(() => clientBoundary({ serverModules: ["db"], clientPattern: "[invalid" }), TypeError);
    assert.throws(() => clientBoundary({ serverModules: ["node:"] }), TypeError);
    assert.throws(() => clientBoundary({ serverModules: ["db"], name: "no-orphans" }), /collides with a shared raw-stack rule/);

    assert.throws(() => deepSubmodules(/** @type {any} */ ([])), TypeError);
    assert.throws(() => deepSubmodules({ modules: [] }), TypeError);
    assert.throws(() => deepSubmodules({ modules: ["a/b"] }), TypeError);
    assert.throws(() => deepSubmodules({ name: "deep-modules" }), /collides with a shared raw-stack rule/);
  });

  test("clientBoundary rejects direct, transitive, and Node built-in imports from client files while accepting valid imports and passing guard", () => {
    const config = `const { clientBoundary } = require("raw-stack/dependency-cruiser-rules");
module.exports = {
  extends: require.resolve("raw-stack/dependency-cruiser"),
  forbidden: [
    ...clientBoundary({ serverModules: ["db", "node:fs", "^src/server/"] }),
  ],
};
`;

    // Valid graph: client imports only shared/client-safe module; server entry imports db & node:fs; client test may import server module
    withProject(
      {
        "src/main.ts": 'import { query } from "./modules/db/index.ts";\nimport { boot } from "./server/boot.ts";\nconsole.log(query(), boot());\n',
        "src/browser.tsx": 'import { format } from "./modules/shared/index.ts";\nimport { widget } from "./modules/ui/index.ts";\nconsole.log(format(), widget());\n',
        "src/modules/db/index.ts": 'import { existsSync } from "node:fs";\nexport const query = () => existsSync(".");\n',
        "src/server/boot.ts": "export const boot = () => true;\n",
        "src/modules/shared/index.ts": "export const format = () => 'ok';\n",
        "src/modules/ui/index.ts": 'export { widget } from "./widget.client.ts";\n',
        "src/modules/ui/widget.client.ts": 'import { format } from "../shared/index.ts";\nexport const widget = () => format();\n',
        "src/modules/ui/widget.client.test.ts": 'import { query } from "../db/index.ts";\nconsole.log(query());\n',
      },
      (root) => {
        const summary = runDepcruise(root);
        assert.deepEqual(summary.violations, []);
        assert.deepEqual(guard(root, []), []);
      },
      config,
    );

    // Invalid graph: client transitively reaches db, directly reaches node:fs, and imports ^src/server/
    withProject(
      {
        "src/main.ts": 'import { query } from "./modules/db/index.ts";\nconsole.log(query());\n',
        "src/browser.tsx": 'import { bad } from "./modules/ui/index.ts";\nimport { boot } from "./server/boot.ts";\nconsole.log(bad(), boot());\n',
        "src/modules/db/index.ts": 'import { existsSync } from "node:fs";\nexport const query = () => existsSync(".");\n',
        "src/server/boot.ts": "export const boot = () => true;\n",
        "src/modules/bridge/index.ts": 'import { query } from "../db/index.ts";\nexport const bridged = () => query();\n',
        "src/modules/ui/index.ts": 'export { bad } from "./bad.client.ts";\n',
        "src/modules/ui/bad.client.ts": 'import { bridged } from "../bridge/index.ts";\nexport const bad = () => bridged();\n',
      },
      (root) => {
        const summary = runDepcruise(root);
        const hits = summary.violations.filter((v) => v.rule.name === "client-boundary");
        assert.ok(
          hits.some((v) => v.from === "src/modules/ui/bad.client.ts" && v.to === "src/modules/db/index.ts"),
          `expected transitive client-boundary violation to db, got: ${JSON.stringify(hits)}`,
        );
        assert.ok(
          hits.some((v) => v.from === "src/browser.tsx" && v.to === "src/server/boot.ts"),
          `expected direct client-boundary violation to src/server/boot.ts, got: ${JSON.stringify(hits)}`,
        );
        assert.ok(
          hits.some((v) => v.from === "src/modules/ui/bad.client.ts" && /^(?:node:)?fs$/.test(v.to)),
          `expected transitive client-boundary violation to node:fs, got: ${JSON.stringify(hits)}`,
        );
      },
      config,
    );
  });

  test("clientBoundary supports custom clientPattern and node:*", () => {
    const config = `const { clientBoundary } = require("raw-stack/dependency-cruiser-rules");
module.exports = {
  extends: require.resolve("raw-stack/dependency-cruiser"),
  forbidden: [
    ...clientBoundary({ serverModules: ["node:*"], clientPattern: "^src/modules/web/" }),
  ],
};
`;
    withProject(
      {
        "src/main.ts": 'import { view } from "./modules/web/index.ts";\nconsole.log(view());\n',
        "src/modules/web/index.ts": 'import { join } from "node:path";\nexport const view = () => join("a", "b");\n',
      },
      (root) => {
        const summary = runDepcruise(root);
        assert.ok(
          summary.violations.some((v) => v.rule.name === "client-boundary" && v.from === "src/modules/web/index.ts" && /^(?:node:)?path$/.test(v.to)),
          `expected node:* violation, got: ${JSON.stringify(summary.violations)}`,
        );
      },
      config,
    );
  });

  test("deepSubmodules enforces submodule index.ts encapsulation and passes guard", () => {
    const config = `const { deepSubmodules } = require("raw-stack/dependency-cruiser-rules");
module.exports = {
  extends: require.resolve("raw-stack/dependency-cruiser"),
  forbidden: [
    ...deepSubmodules({ modules: ["reading"] }),
  ],
};
`;

    // Valid: parent root and sibling submodule import via submodule index.ts or client.ts
    withProject(
      {
        "src/main.ts": 'import { read } from "./modules/reading/index.ts";\nimport { other } from "./modules/other/index.ts";\nconsole.log(read(), other());\n',
        "src/modules/reading/index.ts":
          'import { parse } from "./parser/index.ts";\nimport { render } from "./render/index.ts";\nexport const read = () => render(parse("x"));\n',
        "src/modules/reading/parser/index.ts": 'import { tokenize } from "./tokenize.ts";\nexport const parse = (s: string) => tokenize(s);\n',
        "src/modules/reading/parser/tokenize.ts": "export const tokenize = (s: string) => s;\n",
        "src/modules/reading/render/index.ts": 'import { parse } from "../parser/index.ts";\nexport const render = (s: string) => parse(s);\n',
        "src/modules/other/index.ts": 'import { detail } from "./sub/index.ts";\nexport const other = () => detail();\n',
        "src/modules/other/sub/index.ts": "export const detail = () => 1;\n",
      },
      (root) => {
        const summary = runDepcruise(root);
        assert.deepEqual(summary.violations, []);
        assert.deepEqual(guard(root, []), []);
      },
      config,
    );

    // Invalid: parent module root and sibling submodule reach into parser/tokenize.ts directly
    withProject(
      {
        "src/main.ts": 'import { read } from "./modules/reading/index.ts";\nconsole.log(read());\n',
        "src/modules/reading/index.ts":
          'import { tokenize } from "./parser/tokenize.ts";\nimport { render } from "./render/index.ts";\nexport const read = () => render(tokenize("x"));\n',
        "src/modules/reading/parser/index.ts": 'import { tokenize } from "./tokenize.ts";\nexport const parse = (s: string) => tokenize(s);\n',
        "src/modules/reading/parser/tokenize.ts": "export const tokenize = (s: string) => s;\n",
        "src/modules/reading/render/index.ts":
          'import { parse } from "../parser/index.ts";\nimport { tokenize } from "../parser/tokenize.ts";\nexport const render = (s: string) => parse(tokenize(s));\n',
      },
      (root) => {
        const summary = runDepcruise(root);
        assert.ok(
          summary.violations.some(
            (v) => v.rule.name === "deep-submodules-from-outside" && v.from === "src/modules/reading/index.ts" && v.to === "src/modules/reading/parser/tokenize.ts",
          ),
          `expected deep-submodules-from-outside violation, got: ${JSON.stringify(summary.violations)}`,
        );
        assert.ok(
          summary.violations.some(
            (v) => v.rule.name === "deep-submodules" && v.from === "src/modules/reading/render/index.ts" && v.to === "src/modules/reading/parser/tokenize.ts",
          ),
          `expected deep-submodules violation, got: ${JSON.stringify(summary.violations)}`,
        );
      },
      config,
    );
  });

  test("deepSubmodules() with no options enforces encapsulation across all modules", () => {
    const config = `const { deepSubmodules } = require("raw-stack/dependency-cruiser-rules");
module.exports = {
  extends: require.resolve("raw-stack/dependency-cruiser"),
  forbidden: [
    ...deepSubmodules(),
  ],
};
`;
    withProject(
      {
        "src/main.ts": 'import { run } from "./modules/billing/index.ts";\nconsole.log(run());\n',
        "src/modules/billing/index.ts": 'import { calc } from "./tax/calc.ts";\nexport const run = () => calc();\n',
        "src/modules/billing/tax/calc.ts": "export const calc = () => 10;\n",
      },
      (root) => {
        const summary = runDepcruise(root);
        assert.ok(
          summary.violations.some(
            (v) => v.rule.name === "deep-submodules-from-outside" && v.from === "src/modules/billing/index.ts" && v.to === "src/modules/billing/tax/calc.ts",
          ),
          `expected deep-submodules-from-outside violation, got: ${JSON.stringify(summary.violations)}`,
        );
      },
      config,
    );
  });
});

describe("shared dependency-cruiser rules: client.ts(x) entrypoint and zero-config client-no-node / client-no-server", () => {
  test("allows external callers to import a module via client.ts(x) or index.ts(x), allows pure/isomorphic modules, and excludes type-only node:* imports", () => {
    withProject(
      {
        "src/main.ts": 'import { load } from "./modules/reading/index.ts";\nconsole.log(load());\n',
        "src/browser.tsx":
          'import { Reader } from "./modules/reading/client.tsx";\nimport { Button } from "./modules/ui/index.tsx";\nconsole.log(Reader(), Button());\n',
        "src/modules/reading/index.ts": 'import { query } from "../database/index.ts";\nexport const load = () => query();\n',
        "src/modules/reading/client.tsx":
          'import type { PathLike } from "node:fs";\nimport { Button } from "../ui/index.tsx";\nimport { Widget } from "./widget.client.tsx";\nexport type ClientPath = PathLike;\nexport const Reader = () => [Button(), Widget()];\n',
        "src/modules/reading/widget.client.tsx":
          'import { Button } from "../ui/index.tsx";\nexport const Widget = () => Button();\n',
        "src/modules/reading/widget.client.test.ts":
          'import { query } from "../database/index.ts";\nconsole.log(query());\n',
        "src/modules/ui/index.tsx":
          'import type { Readable } from "node:stream";\nimport { label } from "./label.ts";\nexport type UiStream = Readable;\nexport const Button = () => label();\n',
        "src/modules/ui/label.ts": 'export const label = () => "ok";\n',
        "src/modules/database/index.ts": 'import { readFileSync } from "node:fs";\nexport const query = () => readFileSync(".", "utf8");\n',
      },
      (root) => {
        const summary = runDepcruise(root);
        assert.deepEqual(summary.violations, []);
      },
    );
  });

  test("forbids client.ts, *.client.tsx, and src/browser.tsx from importing node:fs directly or reaching database / *.server.ts transitively", () => {
    withProject(
      {
        "src/main.ts": 'import { ok } from "./modules/database/index.ts";\nconsole.log(ok());\n',
        "src/browser.tsx":
          'import { a } from "./modules/featA/client.ts";\nimport { b } from "./modules/featB/client.tsx";\nimport { c } from "./modules/featC/index.ts";\nconsole.log(a(), b(), c());\n',
        "src/modules/database/index.ts": "export const ok = () => 1;\n",
        "src/modules/bridgeDb/index.ts": 'import { ok } from "../database/index.ts";\nexport const fromDb = () => ok();\n',
        "src/modules/bridgeServer/index.ts": 'import { secret } from "./secret.server.ts";\nexport const getSecret = () => secret();\n',
        "src/modules/bridgeServer/secret.server.ts": 'export const secret = () => "s";\n',
        "src/modules/featA/client.ts": 'import { fromDb } from "../bridgeDb/index.ts";\nexport const a = () => fromDb();\n',
        "src/modules/featB/client.tsx": 'import { existsSync } from "node:fs";\nexport const b = () => existsSync(".");\n',
        "src/modules/featC/index.ts": 'export { c } from "./view.client.tsx";\n',
        "src/modules/featC/view.client.tsx": 'import { getSecret } from "../bridgeServer/index.ts";\nexport const c = () => getSecret();\n',
      },
      (root) => {
        const summary = runDepcruise(root);
        const serverHits = summary.violations.filter((v) => v.rule.name === "client-no-server");
        const nodeHits = summary.violations.filter((v) => v.rule.name === "client-no-node");
        assert.ok(
          serverHits.some((v) => v.from === "src/modules/featA/client.ts" && v.to === "src/modules/database/index.ts"),
          `expected transitive client-no-server violation to database, got: ${JSON.stringify(serverHits)}`,
        );
        assert.ok(
          nodeHits.some((v) => v.from === "src/modules/featB/client.tsx" && /^(?:node:)?fs$/.test(v.to)),
          `expected direct client-no-node violation to node:fs, got: ${JSON.stringify(nodeHits)}`,
        );
        assert.ok(
          serverHits.some((v) => v.from === "src/modules/featC/view.client.tsx" && v.to === "src/modules/bridgeServer/secret.server.ts"),
          `expected transitive client-no-server violation to *.server.ts, got: ${JSON.stringify(serverHits)}`,
        );
      },
    );
  });

  test("forbids submodule client.ts from reaching /server/ and forbids external callers from bypassing index/client", () => {
    withProject(
      {
        "src/main.ts": 'import { leak } from "./modules/a/internal.ts";\nconsole.log(leak());\n',
        "src/browser.tsx": 'import { run } from "./modules/a/client.ts";\nconsole.log(run());\n',
        "src/modules/a/internal.ts": "export const leak = () => 1;\n",
        "src/modules/a/client.ts": 'import { sub } from "./sub/client.ts";\nexport const run = () => sub();\n',
        "src/modules/a/sub/client.ts": 'import { boot } from "../../boot/server/index.ts";\nexport const sub = () => boot();\n',
        "src/modules/boot/server/index.ts": "export const boot = () => 2;\n",
      },
      (root) => {
        const summary = runDepcruise(root);
        assert.ok(
          summary.violations.some((v) => v.rule.name === "deep-modules-from-outside" && v.to === "src/modules/a/internal.ts"),
          `expected deep-modules-from-outside on internal.ts, got: ${JSON.stringify(summary.violations)}`,
        );
        assert.ok(
          summary.violations.some((v) => v.rule.name === "client-no-server" && v.from === "src/modules/a/sub/client.ts" && v.to === "src/modules/boot/server/index.ts"),
          `expected client-no-server on sub/client.ts -> /server/, got: ${JSON.stringify(summary.violations)}`,
        );
      },
    );
  });
});

describe("shared dependency-cruiser rules: automatic 1-level submodules, max depth 1, and property tests", () => {
  test("passes when parent and sibling submodules import via sub/index.ts or sub/client.ts and property tests import pure internals", () => {
    withProject(
      {
        "src/main.ts": 'import { read } from "./modules/reading/index.ts";\nconsole.log(read());\n',
        "src/browser.tsx": 'import { renderClient } from "./modules/reading/client.ts";\nconsole.log(renderClient());\n',
        "src/modules/reading/index.ts":
          'import { parse } from "./curriculum/index.ts";\nimport { format } from "./format.ts";\nexport const read = () => format(parse("x"));\n',
        "src/modules/reading/client.ts":
          'import { view } from "./curriculum/client.ts";\nexport const renderClient = () => view();\n',
        "src/modules/reading/format.ts": "export const format = (s: string) => s.trim();\n",
        "src/modules/reading/reading.property.test.ts":
          'import { format } from "./format.ts";\nconsole.log(format(" hi "));\n',
        "src/modules/reading/curriculum/index.ts":
          'import { tokenize } from "./tokenize.ts";\nexport const parse = (s: string) => tokenize(s);\n',
        "src/modules/reading/curriculum/client.ts": 'export const view = () => "ok";\n',
        "src/modules/reading/curriculum/tokenize.ts": "export const tokenize = (s: string) => s;\n",
        "src/modules/reading/curriculum/curriculum.property.test.ts":
          'import { tokenize } from "./tokenize.ts";\nconsole.log(tokenize("a"));\n',
        "src/modules/reading/render/index.ts":
          'import { parse } from "../curriculum/index.ts";\nexport const render = (s: string) => parse(s);\n',
        "src/modules/reading/render/render.test.ts":
          'import { render } from "./index.ts";\nconsole.log(render("a"));\n',
      },
      (root) => {
        // Also import render from reading/index.ts so it's not an orphan
        writeFileSync(
          join(root, "src/modules/reading/index.ts"),
          'import { parse } from "./curriculum/index.ts";\nimport { render } from "./render/index.ts";\nimport { format } from "./format.ts";\nexport const read = () => render(format(parse("x")));\n',
        );
        const summary = runDepcruise(root);
        assert.deepEqual(summary.violations, []);
      },
    );
  });

  test("forbids bypassing submodule index.ts/client.ts from parent, sibling submodule, or outside module", () => {
    withProject(
      {
        "src/main.ts":
          'import { read } from "./modules/reading/index.ts";\nimport { parse } from "./modules/reading/curriculum/index.ts";\nconsole.log(read(), parse("x"));\n',
        "src/modules/reading/index.ts":
          'import { tokenize } from "./curriculum/tokenize.ts";\nimport { render } from "./render/index.ts";\nexport const read = () => render(tokenize("x"));\n',
        "src/modules/reading/curriculum/index.ts":
          'import { tokenize } from "./tokenize.ts";\nexport const parse = (s: string) => tokenize(s);\n',
        "src/modules/reading/curriculum/tokenize.ts": "export const tokenize = (s: string) => s;\n",
        "src/modules/reading/render/index.ts":
          'import { tokenize } from "../curriculum/tokenize.ts";\nexport const render = (s: string) => tokenize(s);\n',
      },
      (root) => {
        const summary = runDepcruise(root);
        assert.ok(
          summary.violations.some(
            (v) => v.rule.name === "submodule-encapsulation-from-parent" && v.from === "src/modules/reading/index.ts" && v.to === "src/modules/reading/curriculum/tokenize.ts",
          ),
          `expected submodule-encapsulation-from-parent, got: ${JSON.stringify(summary.violations)}`,
        );
        assert.ok(
          summary.violations.some(
            (v) => v.rule.name === "submodule-encapsulation" && v.from === "src/modules/reading/render/index.ts" && v.to === "src/modules/reading/curriculum/tokenize.ts",
          ),
          `expected submodule-encapsulation, got: ${JSON.stringify(summary.violations)}`,
        );
        assert.ok(
          summary.violations.some(
            (v) => v.rule.name === "deep-modules-from-outside" && v.from === "src/main.ts" && v.to === "src/modules/reading/curriculum/index.ts",
          ),
          `expected deep-modules-from-outside on submodule entrypoint, got: ${JSON.stringify(summary.violations)}`,
        );
      },
    );
  });

  test("forbids nesting 2 levels deep (src/modules/a/b/c/file.ts) whether imported, importing, or orphan", () => {
    withProject(
      {
        "src/main.ts": 'import { a } from "./modules/a/index.ts";\nconsole.log(a());\n',
        "src/modules/a/index.ts": 'import { b } from "./b/index.ts";\nexport const a = () => b();\n',
        "src/modules/a/b/index.ts": 'import { deep } from "./c/file.ts";\nexport const b = () => deep();\n',
        "src/modules/a/b/c/file.ts": "export const deep = () => 1;\n",
        "src/modules/a/b/c/nested.test.ts": 'import { b } from "../index.ts";\nconsole.log(b());\n',
        "src/modules/a/b/c/standalone.test.ts": "export const x = 1;\n",
      },
      (root) => {
        const summary = runDepcruise(root);
        assert.ok(
          summary.violations.some((v) => v.rule.name === "module-max-depth" && v.to === "src/modules/a/b/c/file.ts"),
          `expected module-max-depth on imported file, got: ${JSON.stringify(summary.violations)}`,
        );
        assert.ok(
          summary.violations.some((v) => v.rule.name === "module-max-depth-from" && v.from === "src/modules/a/b/c/nested.test.ts"),
          `expected module-max-depth-from on importing deep test file, got: ${JSON.stringify(summary.violations)}`,
        );
        assert.ok(
          summary.violations.some((v) => v.rule.name === "module-max-depth-orphan" && v.from === "src/modules/a/b/c/standalone.test.ts"),
          `expected module-max-depth-orphan on standalone deep file, got: ${JSON.stringify(summary.violations)}`,
        );
      },
    );
  });

  test("SHARED_RULES in guard.js and SHARED_RULE_NAMES in dependency-cruiser-rules.cjs stay in sync with dependency-cruiser.cjs", () => {
    const baseConfig = require("../config/dependency-cruiser.cjs");
    const { clientBoundary } = require("../config/dependency-cruiser-rules.cjs");
    const ruleNames = (baseConfig.forbidden ?? []).map((r) => r.name ?? "").filter(Boolean);
    assert.ok(ruleNames.length >= 15);

    for (const name of ruleNames) {
      assert.throws(
        () => clientBoundary({ serverModules: ["db"], name }),
        /collides with a shared raw-stack rule/,
        `SHARED_RULE_NAMES in dependency-cruiser-rules.cjs is missing "${name}"`,
      );
      const badConfig = `module.exports = {
        extends: require.resolve("raw-stack/dependency-cruiser"),
        forbidden: [{ name: ${JSON.stringify(name)}, severity: "ignore", from: {}, to: {} }],
      };\n`;
      withProject(
        { "src/main.ts": "export const x = 1;\n" },
        (root) => {
          const problems = guard(root, []);
          assert.ok(
            problems.some((p) => p.includes(`redefines the shared rule "${name}"`)),
            `SHARED_RULES in lib/guard.js is missing "${name}"`,
          );
        },
        badConfig,
      );
    }
  });
});
