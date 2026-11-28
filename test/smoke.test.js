// @ts-check
// Tests for `raw-stack smoke`: CLI arg parsing, readiness polling against real
// local HTTP servers, secret scrubbing, Vitest/Playwright smoke execution,
// and integration with vite.js exclusion, guard(), health, and no-orphans.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { rawStack } from "../config/vite.js";
import { guard } from "../lib/guard.js";
import { analyzeHealth } from "../lib/health.js";
import { depcruiseScript } from "../lib/project.js";
import { parseSmokeHeaders, validateSmokeUrl } from "../lib/smoke-headers.js";
import { discoverSmokeFiles, parseSmokeArgs, pollHealth, shaMatches, smoke, UsageError } from "../lib/smoke.js";
import { VERIFY_WORKFLOW } from "../lib/workflows.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(REPO_ROOT, "bin", "raw-stack.js");
const TEMPLATE_WORKFLOW = readFileSync(join(REPO_ROOT, "template", ".github", "workflows", "verify.yml"), "utf8");
const DEPCRUISE = depcruiseScript();
const SECRET = "super-secret-smoke-token-987654";

/**
 * Start a real local HTTP server on 127.0.0.1:0 and close it when `fn` finishes.
 * @template T
 * @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void} handler
 * @param {(baseUrl: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withLocalServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

/**
 * @param {{
 *   playwright?: boolean,
 *   vpFail?: boolean,
 *   vpEchoSecret?: string,
 *   playwrightFail?: boolean,
 *   files?: Record<string, string>,
 * }} [options]
 */
function createFakeSmokeProject({
  playwright = false,
  vpFail = false,
  vpEchoSecret = "",
  playwrightFail = false,
  files = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "raw-stack-smoke-"));
  const logFile = join(root, "events.log");
  const capturedEnvFile = join(root, "captured-env.json");

  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  symlinkSync(REPO_ROOT, join(root, "node_modules", "raw-stack"), "dir");

  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fake-smoke-app", type: "module" }, null, 2));
  writeFileSync(join(root, "src", "main.ts"), "export const ok = true;\n");
  writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ extends: "raw-stack/tsconfig.json" }, null, 2));
  writeFileSync(
    join(root, "vite.config.ts"),
    'import { rawStack } from "raw-stack/vite";\nexport default { ...rawStack() };\n',
  );
  writeFileSync(
    join(root, ".dependency-cruiser.cjs"),
    'module.exports = { extends: require.resolve("raw-stack/dependency-cruiser") };\n',
  );
  writeFileSync(join(root, VERIFY_WORKFLOW), TEMPLATE_WORKFLOW);

  if (playwright) {
    writeFileSync(
      join(root, "playwright.config.ts"),
      'import { rawStackPlaywright } from "raw-stack/playwright";\nexport default { ...rawStackPlaywright() };\n',
    );
  }

  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  const fakeVp = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, \`vp:\${args.join(" ")}\\n\`);
writeFileSync(${JSON.stringify(capturedEnvFile)}, JSON.stringify({
  SMOKE_BASE_URL: process.env.SMOKE_BASE_URL ?? null,
  SMOKE_HEADERS_JSON: process.env.SMOKE_HEADERS_JSON ?? null,
}));
if (${JSON.stringify(vpEchoSecret)}) {
  console.error("leaked:" + ${JSON.stringify(vpEchoSecret)});
}
if (${JSON.stringify(vpFail)}) {
  console.error("simulated vp smoke failure");
  process.exit(1);
}
`;
  const vpPath = join(root, "node_modules", ".bin", "vp");
  writeFileSync(vpPath, fakeVp);
  chmodSync(vpPath, 0o755);

  const fakePlaywright = `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, \`playwright:\${args.join(" ")}\\n\`);
writeFileSync(${JSON.stringify(capturedEnvFile)}, JSON.stringify({
  SMOKE_BASE_URL: process.env.SMOKE_BASE_URL ?? null,
  SMOKE_HEADERS_JSON: process.env.SMOKE_HEADERS_JSON ?? null,
}));
if (${JSON.stringify(playwrightFail)}) {
  console.error("simulated playwright smoke failure");
  process.exit(1);
}
`;
  const pwPath = join(root, "node_modules", ".bin", "playwright");
  writeFileSync(pwPath, fakePlaywright);
  chmodSync(pwPath, 0o755);

  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });

  return {
    root,
    events: () => {
      try {
        return readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
    capturedEnv: () => JSON.parse(readFileSync(capturedEnvFile, "utf8")),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>}
 */
function runSmokeCli(cwd, args, env = {}) {
  const merged = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "smoke", ...args], {
      cwd,
      env: merged,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
  });
}

/** @param {Record<string, string | undefined>} vars @param {() => void} fn */
function withEnv(vars, fn) {
  /** @type {Record<string, string | undefined>} */
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("raw-stack smoke URL, header, and CLI arg parsing", () => {
  test("validateSmokeUrl normalizes trailing slashes and rejects invalid URLs", () => {
    assert.equal(validateSmokeUrl("https://example.com/"), "https://example.com");
    assert.equal(validateSmokeUrl("  https://example.com/sub///  "), "https://example.com/sub");
    assert.equal(validateSmokeUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");

    for (const bad of [
      "",
      "   ",
      "ftp://example.com",
      "file:///etc/passwd",
      "not-a-url",
      "https://example.com?foo=1",
      "https://example.com#frag",
      "https://example.com/app?x=1#y",
    ]) {
      assert.throws(() => validateSmokeUrl(bad), /Invalid smoke URL/, `expected reject for ${JSON.stringify(bad)}`);
    }
    assert.throws(() => validateSmokeUrl(/** @type {string} */ (/** @type {unknown} */ (null))), /Invalid smoke URL/);
  });

  test("parseSmokeArgs accepts --flag value and --flag=value forms and defaults", () => {
    const spaceArgs = parseSmokeArgs([
      "--url",
      "https://app.example.com/",
      "--sha",
      "abc1234",
      "--health-path",
      "/healthz",
      "--health-timeout-ms",
      "5000",
      "--browser",
    ]);
    assert.deepEqual(spaceArgs, {
      url: "https://app.example.com",
      sha: "abc1234",
      healthPath: "/healthz",
      healthTimeoutMs: 5000,
      browser: true,
    });

    const eqArgs = parseSmokeArgs([
      "--url=http://127.0.0.1:3000/api/",
      "--sha=deadbeef",
      "--health-path=/status",
      "--health-timeout-ms=1200",
    ]);
    assert.deepEqual(eqArgs, {
      url: "http://127.0.0.1:3000/api",
      sha: "deadbeef",
      healthPath: "/status",
      healthTimeoutMs: 1200,
      browser: false,
    });
  });

  test("parseSmokeArgs rejects missing, unknown, and invalid arguments with UsageError (exit 2)", () => {
    const cases = [
      [],
      ["--sha", "abc1234"],
      ["--url"],
      ["--url", "--browser"],
      ["--url", "https://example.com", "--sha"],
      ["--url", "https://example.com", "--health-path"],
      ["--url", "https://example.com", "--health-timeout-ms"],
      ["--url", "ftp://example.com"],
      ["--url", "file:///tmp/app"],
      ["--url", "not-a-url"],
      ["--url", "https://example.com?q=1"],
      ["--url", "https://example.com#hash"],
      ["--url", "https://example.com", "--sha", "   "],
      ["--url", "https://example.com", "--health-path", "api/health"],
      ["--url", "https://example.com", "--health-path", ""],
      ["--url", "https://example.com", "--health-path", " /health"],
      ["--url", "https://example.com", "--health-timeout-ms", "0"],
      ["--url", "https://example.com", "--health-timeout-ms", "-5"],
      ["--url", "https://example.com", "--health-timeout-ms", "abc"],
      ["--url", "https://example.com", "--health-timeout-ms", "1.5"],
      ["--url", "https://example.com", "--health-timeout-ms", "99999999999999999999"],
      ["--url", "https://example.com", "--bogus"],
      ["--url", "https://example.com", "--browser=true"],
      ["--url", "https://example.com", "positional"],
    ];

    for (const argv of cases) {
      assert.throws(
        () => parseSmokeArgs(argv),
        (err) => err instanceof UsageError && err.exitCode === 2,
        `expected UsageError for ${JSON.stringify(argv)}`,
      );
    }
  });

  test("shaMatches handles case-insensitive exact and >=4-char prefix matching", () => {
    assert.equal(shaMatches("ABCDEF123456", "abcdef123456"), true);
    assert.equal(shaMatches("abcdef1234567890", "ABCDEF12"), true);
    assert.equal(shaMatches("abcd", "abcdef123456"), true);
    assert.equal(shaMatches("abc", "abcdef123456"), false);
    assert.equal(shaMatches("abcdef", "123456"), false);
    assert.equal(shaMatches("", "abcdef"), false);
  });

  test("parseSmokeHeaders validates strictly and never leaks secrets on error", () => {
    assert.deepEqual(parseSmokeHeaders(undefined), {});
    assert.deepEqual(parseSmokeHeaders("   "), {});
    assert.deepEqual(parseSmokeHeaders('{"X-Test":"ok","CF-Access-Client-Id":"id"}'), {
      "X-Test": "ok",
      "CF-Access-Client-Id": "id",
    });

    const badInputs = [
      `{bad json ${SECRET}`,
      `["${SECRET}"]`,
      `"${SECRET}"`,
      "123",
      "null",
      `{"X-Num": 123, "X-Secret": "${SECRET}"}`,
      `{"Bad Header": "${SECRET}"}`,
      `{"X-Crlf": "${SECRET}\\r\\ninjected"}`,
      `{"X-Lf": "${SECRET}\\ninjected"}`,
    ];

    for (const raw of badInputs) {
      assert.throws(
        () => parseSmokeHeaders(raw),
        (err) => err instanceof Error && /Invalid SMOKE_HEADERS_JSON/.test(err.message) && !err.message.includes(SECRET),
        `expected secret-free error for ${raw}`,
      );
    }
  });
});

describe("readiness polling against real local HTTP server", () => {
  test("transitions from 503 and stale SHA to new SHA via JSON body", async () => {
    let requests = 0;
    const targetSha = "a1b2c3d4e5f60000";

    await withLocalServer(
      (req, res) => {
        requests++;
        if (req.url !== "/api/health") {
          res.writeHead(404).end();
          return;
        }
        if (requests === 1) {
          res.writeHead(503).end("booting");
          return;
        }
        if (requests === 2) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, sha: "00000000" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sha: targetSha }));
      },
      async (baseUrl) => {
        const result = await pollHealth({
          url: baseUrl,
          sha: "a1b2c3d4",
          timeoutMs: 2000,
          intervalMs: 15,
        });
        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.matchedSha, targetSha);
          assert.equal(result.source, "body");
          assert.equal(result.attempts, 3);
        }
      },
    );
  });

  test("matches x-build-sha header (exact and prefix) and ignores { ok: false, sha }", async () => {
    let phase = 0;
    const fullSha = "deadbeefcafebabe1234";

    await withLocalServer(
      (_req, res) => {
        phase++;
        if (phase === 1) {
          // Even with matching header/body SHA, ok: false must not be treated as ready
          res.writeHead(200, {
            "content-type": "application/json",
            "x-build-sha": fullSha,
          });
          res.end(JSON.stringify({ ok: false, sha: fullSha }));
          return;
        }
        res.writeHead(200, { "x-build-sha": "DEADBEEF" });
        res.end("ok");
      },
      async (baseUrl) => {
        const result = await pollHealth({
          url: baseUrl,
          sha: fullSha,
          timeoutMs: 2000,
          intervalMs: 15,
        });
        assert.equal(result.ok, true);
        if (result.ok) {
          assert.equal(result.matchedSha, "DEADBEEF");
          assert.equal(result.source, "header");
          assert.equal(result.attempts, 2);
        }
      },
    );
  });

  test("pollHealth preserves prior HTTP observation when a later attempt aborts at deadline", async () => {
    let calls = 0;
    const result = await pollHealth({
      url: "https://example.com",
      sha: "target1234",
      timeoutMs: 80,
      intervalMs: 10,
      fetchImpl: async (_input, init) => {
        calls++;
        if (calls === 1) {
          return new Response(JSON.stringify({ ok: true, sha: "stale0000" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return await new Promise((_resolve, reject) => {
          const sig = init?.signal;
          if (sig?.aborted) {
            reject(sig.reason);
            return;
          }
          sig?.addEventListener("abort", () => reject(sig.reason), { once: true });
        });
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.attempts >= 2);
      assert.match(result.message, /last: HTTP 200 \(body sha=stale0000\)/);
    }
  });

  test("forwards SMOKE_HEADERS_JSON on health requests and never leaks secrets on success, timeout, network error, or invalid JSON", async () => {
    /** @type {Array<Record<string, string | string[] | undefined>>} */
    const seenHeaders = [];

    await withLocalServer(
      (req, res) => {
        seenHeaders.push(req.headers);
        if (req.url === "/ready") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, sha: "1234abcd" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sha: "stale0000" }));
      },
      async (baseUrl) => {
        const project = createFakeSmokeProject({
          playwright: true,
          files: {
            "smoke/api.smoke.test.ts": 'import { expect, test } from "vite-plus/test";\ntest("ok", () => expect(1).toBe(1));\n',
            "smoke/app.smoke.spec.ts": 'import { test } from "@playwright/test";\ntest("ok", async () => {});\n',
          },
        });

        try {
          const headersJson = JSON.stringify({
            "CF-Access-Client-Id": "client-123",
            "CF-Access-Client-Secret": SECRET,
          });

          // 1. Success forwards headers and does not leak secret
          const okRes = await runSmokeCli(
            project.root,
            ["--url", baseUrl, "--sha", "1234abcd", "--health-path", "/ready", "--health-timeout-ms", "5000"],
            { SMOKE_HEADERS_JSON: headersJson, RAW_STACK_SMOKE_POLL_INTERVAL_MS: "15" },
          );
          assert.equal(okRes.status, 0, okRes.stderr || okRes.stdout);
          assert.ok(seenHeaders.length >= 1);
          assert.equal(seenHeaders[0]?.["cf-access-client-id"], "client-123");
          assert.equal(seenHeaders[0]?.["cf-access-client-secret"], SECRET);
          assert.equal(okRes.stdout.includes(SECRET), false);
          assert.equal(okRes.stderr.includes(SECRET), false);

          // 2. Timeout fails (exit 1), does NOT run Vitest/Playwright, and does not leak secret
          const beforeEvents = project.events().length;
          const timeoutRes = await runSmokeCli(
            project.root,
            ["--url", baseUrl, "--sha", "9999ffff", "--health-path", "/stale", "--health-timeout-ms", "600", "--browser"],
            { SMOKE_HEADERS_JSON: headersJson, RAW_STACK_SMOKE_POLL_INTERVAL_MS: "25" },
          );
          assert.equal(timeoutRes.status, 1);
          assert.match(timeoutRes.stderr, /Timed out after 600ms.*stale0000/);
          assert.equal(timeoutRes.stdout.includes(SECRET), false);
          assert.equal(timeoutRes.stderr.includes(SECRET), false);
          assert.equal(project.events().length, beforeEvents, "must not run vitest or playwright after health timeout");

          // 3. Invalid JSON exits 2 and never leaks secret
          const badJsonRes = await runSmokeCli(
            project.root,
            ["--url", baseUrl, "--sha", "1234abcd"],
            { SMOKE_HEADERS_JSON: `{broken:${SECRET}` },
          );
          assert.equal(badJsonRes.status, 2);
          assert.match(badJsonRes.stderr, /Invalid SMOKE_HEADERS_JSON/);
          assert.equal(badJsonRes.stdout.includes(SECRET), false);
          assert.equal(badJsonRes.stderr.includes(SECRET), false);

          // 4. Network error (unreachable port) exits 1 and never leaks secret
          const closedPortUrl = baseUrl.replace(/:\d+$/, ":1");
          const netRes = await runSmokeCli(
            project.root,
            ["--url", closedPortUrl, "--sha", "1234abcd", "--health-timeout-ms", "600"],
            { SMOKE_HEADERS_JSON: headersJson, RAW_STACK_SMOKE_POLL_INTERVAL_MS: "25" },
          );
          assert.equal(netRes.status, 1);
          assert.match(netRes.stderr, /Timed out after 600ms/);
          assert.equal(netRes.stdout.includes(SECRET), false);
          assert.equal(netRes.stderr.includes(SECRET), false);
        } finally {
          project.cleanup();
        }
      },
    );
  });
});

describe("smoke test discovery, execution, and secret scrubbing", () => {
  test("discoverSmokeFiles sorts Vitest and Playwright smoke files", () => {
    const project = createFakeSmokeProject({
      files: {
        "smoke/b.smoke.test.ts": "export {};\n",
        "smoke/nested/a.smoke.test.ts": "export {};\n",
        "smoke/z.smoke.spec.ts": "export {};\n",
        "smoke/nested/c.smoke.spec.ts": "export {};\n",
        "smoke/helper.ts": "export const x = 1;\n",
      },
    });
    try {
      assert.deepEqual(discoverSmokeFiles(project.root), {
        vitest: ["smoke/b.smoke.test.ts", "smoke/nested/a.smoke.test.ts"],
        playwright: ["smoke/nested/c.smoke.spec.ts", "smoke/z.smoke.spec.ts"],
      });
    } finally {
      project.cleanup();
    }
  });

  test("runs Vitest smoke project, forwards env, scrubs echoed secrets, and skips Playwright without --browser", async () => {
    const headersJson = JSON.stringify({ Authorization: `Bearer ${SECRET}` });
    const project = createFakeSmokeProject({
      playwright: true,
      vpEchoSecret: SECRET,
      files: {
        "smoke/api.smoke.test.ts": 'import { expect, test } from "vite-plus/test";\ntest("ok", () => expect(1).toBe(1));\n',
        "smoke/app.smoke.spec.ts": 'import { test } from "@playwright/test";\ntest("ok", async () => {});\n',
      },
    });
    try {
      const res = await runSmokeCli(project.root, ["--url", "https://smoke.example.com/"], {
        SMOKE_HEADERS_JSON: headersJson,
      });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.deepEqual(project.events(), ["vp:test run --project smoke --update=none"]);
      assert.deepEqual(project.capturedEnv(), {
        SMOKE_BASE_URL: "https://smoke.example.com",
        SMOKE_HEADERS_JSON: headersJson,
      });
      assert.equal(res.stdout.includes(SECRET), false);
      assert.equal(res.stderr.includes(SECRET), false);
      assert.match(res.stdout, /pass {2}vitest smoke/);
    } finally {
      project.cleanup();
    }
  });

  test("exits 1 when Vitest smoke tests fail", async () => {
    const project = createFakeSmokeProject({
      vpFail: true,
      files: {
        "smoke/api.smoke.test.ts": 'import { expect, test } from "vite-plus/test";\ntest("fail", () => expect(1).toBe(2));\n',
      },
    });
    try {
      const res = await runSmokeCli(project.root, ["--url", "https://smoke.example.com"]);
      assert.equal(res.status, 1);
      assert.match(res.stdout, /FAIL {2}vitest smoke/);
    } finally {
      project.cleanup();
    }
  });

  test("handles --browser execution, pass/fail, clean skip when no specs, and error when playwright.config.ts is missing", async () => {
    const headersJson = JSON.stringify({ "X-Api-Key": SECRET });

    // 1. Pass with --browser when smoke spec + playwright.config.ts exist
    const passing = createFakeSmokeProject({
      playwright: true,
      files: {
        "smoke/app.smoke.spec.ts": 'import { test } from "@playwright/test";\ntest("ok", async () => {});\n',
      },
    });
    try {
      const res = await runSmokeCli(passing.root, ["--url", "https://smoke.example.com", "--browser"], {
        SMOKE_HEADERS_JSON: headersJson,
      });
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.deepEqual(passing.events(), ["playwright:test"]);
      assert.deepEqual(passing.capturedEnv(), {
        SMOKE_BASE_URL: "https://smoke.example.com",
        SMOKE_HEADERS_JSON: headersJson,
      });
      assert.match(res.stdout, /pass {2}playwright smoke/);
      assert.equal(res.stdout.includes(SECRET), false);
    } finally {
      passing.cleanup();
    }

    // 2. Fail with --browser when Playwright fails
    const failing = createFakeSmokeProject({
      playwright: true,
      playwrightFail: true,
      files: {
        "smoke/app.smoke.spec.ts": 'import { test } from "@playwright/test";\ntest("fail", async () => {});\n',
      },
    });
    try {
      const res = await runSmokeCli(failing.root, ["--url", "https://smoke.example.com", "--browser"]);
      assert.equal(res.status, 1);
      assert.match(res.stdout, /FAIL {2}playwright smoke/);
    } finally {
      failing.cleanup();
    }

    // 3. Clean skip when --browser is passed with no .smoke.spec.ts
    const noSpecs = createFakeSmokeProject({
      playwright: true,
      files: {
        "smoke/api.smoke.test.ts": 'import { expect, test } from "vite-plus/test";\ntest("ok", () => expect(1).toBe(1));\n',
      },
    });
    try {
      const res = await runSmokeCli(noSpecs.root, ["--url", "https://smoke.example.com", "--browser"]);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.deepEqual(noSpecs.events(), ["vp:test run --project smoke --update=none"]);
      assert.match(res.stdout, /playwright smoke skipped \(no smoke\/\*\*\/\*\.smoke\.spec\.ts files\)/);
    } finally {
      noSpecs.cleanup();
    }

    // 4. Clear failure when .smoke.spec.ts exists without playwright.config.ts
    const missingConfig = createFakeSmokeProject({
      playwright: false,
      files: {
        "smoke/app.smoke.spec.ts": 'import { test } from "@playwright/test";\ntest("ok", async () => {});\n',
      },
    });
    try {
      const logs = /** @type {string[]} */ ([]);
      const code = await smoke({
        root: missingConfig.root,
        args: ["--url", "https://smoke.example.com", "--browser"],
        env: {},
        out: { log: (l) => logs.push(l), error: (l) => logs.push(l) },
      });
      assert.equal(code, 1);
      assert.match(logs.join("\n"), /playwright\.config\.ts is missing/);
      assert.deepEqual(missingConfig.events(), []);
    } finally {
      missingConfig.cleanup();
    }
  });
});

describe("exclusion from default verify, guard(), health, and no-orphans", () => {
  test("rawStack().test.projects excludes smoke/ unless SMOKE_BASE_URL is set", () => {
    withEnv({ SMOKE_BASE_URL: undefined }, () => {
      const projects = rawStack().test.projects;
      assert.deepEqual(
        projects.map((p) => p.test.name),
        ["unit", "e2e"],
      );
    });

    withEnv({ SMOKE_BASE_URL: "   " }, () => {
      const projects = rawStack().test.projects;
      assert.deepEqual(
        projects.map((p) => p.test.name),
        ["unit", "e2e"],
      );
    });

    withEnv({ SMOKE_BASE_URL: "https://example.com" }, () => {
      const projects = rawStack().test.projects;
      assert.deepEqual(
        projects.map((p) => p.test.name),
        ["unit", "e2e", "smoke"],
      );
      const smokeProj = projects.find((p) => p.test.name === "smoke");
      assert.deepEqual(smokeProj?.test.include, ["smoke/**/*.smoke.test.ts"]);
    });
  });

  test("guard() enforces suppressions, retries, and Playwright smells in smoke/", () => {
    const project = createFakeSmokeProject({
      playwright: true,
      files: {
        "smoke/suppressed.smoke.test.ts": "// @ts-ignore\n// oxlint-disable-next-line\nexport const x = 1;\n",
        "smoke/retried.smoke.test.ts": 'import { test } from "vite-plus/test";\ntest("flaky", { retry: 2 }, () => {});\n',
        "smoke/smelly.smoke.spec.ts": [
          'import { test } from "@playwright/test";',
          'test("smell", async ({ page }) => {',
          "  await page.waitForTimeout(500);",
          '  await page.waitForSelector(".btn");',
          '  await page.locator(".btn").click();',
          "});",
        ].join("\n"),
      },
    });
    try {
      const problems = guard(project.root, [
        "smoke/suppressed.smoke.test.ts",
        "smoke/retried.smoke.test.ts",
        "smoke/smelly.smoke.spec.ts",
      ]);
      assert.ok(problems.some((p) => p.includes("smoke/suppressed.smoke.test.ts:1: suppression comment")));
      assert.ok(problems.some((p) => p.includes("smoke/suppressed.smoke.test.ts:2: suppression comment")));
      assert.ok(problems.some((p) => p.includes("smoke/retried.smoke.test.ts") && p.includes("retry")));
      assert.ok(problems.some((p) => p.includes("smoke/smelly.smoke.spec.ts:3:") && p.includes("waitForTimeout")));
      assert.ok(problems.some((p) => p.includes("smoke/smelly.smoke.spec.ts:4:") && p.includes("waitForSelector")));
      assert.ok(problems.some((p) => p.includes("smoke/smelly.smoke.spec.ts:5:") && p.includes("CSS or XPath")));

      // Also check Playwright config-level retries inside smoke/
      const pwRetryProject = createFakeSmokeProject({
        files: {
          "smoke/pw-retry.smoke.spec.ts": 'import { test } from "@playwright/test";\ntest.describe.configure({ retries: 1 });\n',
        },
      });
      try {
        const retryProblems = guard(pwRetryProject.root, ["smoke/pw-retry.smoke.spec.ts"]);
        assert.ok(retryProblems.some((p) => p.includes("smoke/pw-retry.smoke.spec.ts") && p.includes("retries")));
      } finally {
        pwRetryProject.cleanup();
      }
    } finally {
      project.cleanup();
    }
  });

  test("analyzeHealth() and dependency-cruiser (no-orphans) do not penalize smoke/ files", () => {
    const project = createFakeSmokeProject({
      files: {
        "src/main.ts": 'import { greet } from "./modules/greeting/index.ts";\nconsole.log(greet("world"));\n',
        "src/modules/greeting/index.ts": 'export const greet = (name: string) => `Hi, ${name}`;\n',
        "smoke/api.smoke.test.ts": 'import assert from "node:assert/strict";\nassert.equal(1, 1);\n',
        "smoke/app.smoke.spec.ts": 'import assert from "node:assert/strict";\nassert.equal(true, true);\n',
      },
    });
    try {
      const health = analyzeHealth(project.root);
      assert.equal(health.ok, true, JSON.stringify(health.violations));
      assert.equal(health.modules.length, 1);
      assert.equal(health.modules[0]?.prodFiles, 1);

      const depRes = spawnSync(process.execPath, [DEPCRUISE, "src", "smoke", "--output-type", "json"], {
        cwd: project.root,
        encoding: "utf8",
      });
      assert.equal(depRes.status, 0, depRes.stderr);
      const parsed = JSON.parse(depRes.stdout);
      assert.ok(parsed.summary.totalCruised >= 2);
      assert.deepEqual(parsed.summary.violations, []);
    } finally {
      project.cleanup();
    }
  });
});
