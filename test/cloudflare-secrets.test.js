// @ts-check
// End to end: runs the real `raw-stack cloudflare-secrets` CLI against a fake
// Cloudflare API (a local HTTP server) and a fake `gh` on PATH. Nothing here
// talks to Cloudflare or GitHub.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../bin/raw-stack.js", import.meta.url));
const ACCOUNT = "a".repeat(32);
const ZONE = "z".repeat(32);
const BOOTSTRAP = "bootstrap-secret-value";
const REPO = "ryan-a-wood/homebase";
const GROUPS = [
  "Workers Scripts Write",
  "Account Settings Read",
  "D1 Write",
  "Workers KV Storage Write",
  "Workers R2 Storage Write",
  "Queues Write",
  "Workers Routes Write",
];
const groupId = (/** @type {string} */ name) => `pg-${name.toLowerCase().replaceAll(" ", "-")}`;

const HOMEBASE = `{
  // like homebase: a Worker with D1 on a custom domain
  "name": "homebase",
  "main": "src/worker.ts",
  "compatibility_date": "2026-11-01",
  "routes": [{ "pattern": "home.ryananthonywood.com", "custom_domain": true }],
  "d1_databases": [{ "binding": "DB", "database_name": "homebase" }],
}
`;

/**
 * A fake Cloudflare API with just enough state: tokens, zones, permission groups.
 * @typedef {{ id: string, name: string, value: string, policies: any[] }} Token
 */
class FakeCloudflare {
  /** @type {Token[]} */ tokens = [];
  /** @type {{ method: string, path: string, auth: string | undefined }[]} */ requests = [];
  /** @type {Set<string>} */ deniedPaths = new Set();
  /** @type {Set<string>} */ failDelete = new Set();
  next = 1;
  url = "";
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const method = req.method ?? "GET";
      this.requests.push({ method, path: url.pathname, auth: req.headers.authorization });
      const send = (/** @type {number} */ status, /** @type {any} */ json) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };
      const ok = (/** @type {any} */ result) => send(200, { success: true, errors: [], messages: [], result });
      const fail = (/** @type {number} */ status, /** @type {string} */ message) =>
        send(status, { success: false, errors: [{ code: 9109, message }], messages: [], result: null });

      if (req.headers.authorization !== `Bearer ${BOOTSTRAP}`) return fail(401, "Invalid access token");
      const tokensPath = `/accounts/${ACCOUNT}/tokens`;
      if ([...this.deniedPaths].some((p) => url.pathname.startsWith(p))) return fail(403, "Unauthorized to access requested resource");

      if (method === "GET" && url.pathname === "/accounts") return ok([{ id: ACCOUNT, name: "Ryan" }]);
      if (method === "GET" && url.pathname === `${tokensPath}/permission_groups`) {
        const name = url.searchParams.get("name");
        return ok(GROUPS.filter((g) => g === name).map((g) => ({ id: groupId(g), name: g, scopes: [] })));
      }
      if (method === "GET" && url.pathname === "/zones") {
        const name = url.searchParams.get("name");
        return ok(name === "ryananthonywood.com" ? [{ id: ZONE, name }] : []);
      }
      if (method === "GET" && url.pathname === tokensPath) {
        return ok(this.tokens.map(({ id, name }) => ({ id, name })));
      }
      if (method === "POST" && url.pathname === tokensPath) {
        const { name, policies } = JSON.parse(body);
        const token = { id: `tok-${this.next}`, name, value: `NEW-TOKEN-VALUE-${this.next}`, policies };
        this.next++;
        this.tokens.push(token);
        return ok({ id: token.id, name, value: token.value, policies });
      }
      if (method === "DELETE" && url.pathname.startsWith(`${tokensPath}/`)) {
        const id = url.pathname.slice(tokensPath.length + 1);
        if (this.failDelete.has(id)) return fail(500, "internal error");
        this.tokens = this.tokens.filter((t) => t.id !== id);
        return ok({ id });
      }
      return fail(404, `no fake for ${method} ${url.pathname}`);
    });
  });

  start() {
    return new Promise((resolve) =>
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address();
        this.url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
        resolve(undefined);
      }),
    );
  }

  reset() {
    this.tokens = [];
    this.requests = [];
    this.deniedPaths = new Set();
    this.failDelete = new Set();
    this.next = 1;
  }

  created() {
    return this.requests.filter((r) => r.method === "POST");
  }
}

/** A fake `gh` that logs each call's args and stdin. FAKE_GH_FAIL makes matching calls fail. */
const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
let stdin = "";
try { stdin = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, stdin }) + "\\n");
const fail = process.env.FAKE_GH_FAIL;
if (fail && args.join(" ").startsWith(fail)) { process.stderr.write("fake gh: " + fail + " failed\\n"); process.exit(1); }
if (args[0] === "repo" && args[1] === "view") process.stdout.write("${REPO}\\n");
`;

const cf = new FakeCloudflare();
/** @type {string} */ let dir;
/** @type {string} */ let home;
/** @type {string} */ let ghLog;
/** @type {string} */ let binDir;

before(async () => {
  await cf.start();
});
after(() => cf.server.close());

beforeEach(() => {
  cf.reset();
  const base = mkdtempSync(join(tmpdir(), "cf-secrets-"));
  dir = join(base, "project");
  home = join(base, "home");
  binDir = join(base, "bin");
  ghLog = join(base, "gh.jsonl");
  for (const d of [dir, home, binDir]) mkdirSync(d);
  writeFileSync(join(binDir, "gh"), FAKE_GH);
  chmodSync(join(binDir, "gh"), 0o755);
  writeFileSync(ghLog, "");
});

/**
 * Run the CLI in the project dir.
 * @param {string[]} [args] @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function cli(args = [], env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "cloudflare-secrets", ...args], {
      cwd: dir,
      env: {
        PATH: `${binDir}:${process.env["PATH"]}`,
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        FAKE_GH_LOG: ghLog,
        RAW_STACK_CLOUDFLARE_API_URL: cf.url,
        RAW_STACK_CLOUDFLARE_BOOTSTRAP_TOKEN: BOOTSTRAP,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** @returns {{ args: string[], stdin: string }[]} */
const ghCalls = () =>
  readFileSync(ghLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** The value each `gh secret set NAME` call received on stdin, last write wins. */
function secrets() {
  /** @type {Record<string, string>} */
  const out = {};
  for (const c of ghCalls()) if (c.args[0] === "secret" && c.args[1] === "set") out[c.args[2] ?? ""] = c.stdin;
  return out;
}

/** Every file under a directory, recursively. @param {string} d @returns {string[]} */
const filesUnder = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(d, e.name)) : [join(d, e.name)]));

/** The token value never shows up in output, in gh's arguments, or in a file. */
function assertNeverExposed(/** @type {string} */ value, /** @type {{ stdout: string, stderr: string }} */ run) {
  assert.ok(!run.stdout.includes(value), "token value in stdout");
  assert.ok(!run.stderr.includes(value), "token value in stderr");
  for (const c of ghCalls()) assert.ok(!c.args.join(" ").includes(value), "token value in gh arguments");
  for (const f of [...filesUnder(dir), ...filesUnder(home)]) {
    assert.ok(!readFileSync(f, "utf8").includes(value), `token value written to ${f}`);
  }
}

describe("raw-stack cloudflare-secrets", () => {
  test("creates a token scoped to the config and stores it as GitHub secrets", async () => {
    writeFileSync(join(dir, "wrangler.jsonc"), HOMEBASE);
    const run = await cli();
    assert.equal(run.code, 0, run.stderr);

    assert.equal(cf.tokens.length, 1);
    const token = cf.tokens[0];
    assert.ok(token);
    assert.equal(token.name, `github-actions ${REPO}`);
    assert.deepEqual(token.policies, [
      {
        effect: "allow",
        resources: { [`com.cloudflare.api.account.${ACCOUNT}`]: "*" },
        permission_groups: ["Workers Scripts Write", "Account Settings Read", "D1 Write"].map((g) => ({ id: groupId(g) })),
      },
      {
        effect: "allow",
        resources: { [`com.cloudflare.api.account.zone.${ZONE}`]: "*" },
        permission_groups: [{ id: groupId("Workers Routes Write") }],
      },
    ]);
    assert.deepEqual(secrets(), { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: token.value });
    assert.ok(ghCalls().every((c) => !c.args.includes("--body")), "secret values go on stdin");
    assertNeverExposed(token.value, run);
    assertNeverExposed(BOOTSTRAP, run);
    assert.ok(cf.requests.every((r) => r.auth === `Bearer ${BOOTSTRAP}`));
  });

  test("a rerun replaces the token and revokes the previous one, leaving other tokens alone", async () => {
    writeFileSync(join(dir, "wrangler.jsonc"), HOMEBASE);
    cf.tokens.push({ id: "tok-other", name: "github-actions ryan-a-wood/pfin", value: "OTHER", policies: [] });
    assert.equal((await cli()).code, 0);
    const first = cf.tokens.find((t) => t.name.endsWith("homebase"));
    assert.ok(first);

    const run = await cli();
    assert.equal(run.code, 0, run.stderr);
    const names = cf.tokens.map((t) => t.id).sort();
    assert.deepEqual(names, ["tok-2", "tok-other"]);
    assert.equal(secrets()["CLOUDFLARE_API_TOKEN"], "NEW-TOKEN-VALUE-2");
    assert.match(run.stdout, new RegExp(`Revoked the previous token ${first.id}`));
    assertNeverExposed("NEW-TOKEN-VALUE-2", run);
  });

  test("reads wrangler.toml with KV, R2 and a zone_name route", async () => {
    writeFileSync(
      join(dir, "wrangler.toml"),
      `name = "app"
main = "src/index.ts"
account_id = "${ACCOUNT}"

[[routes]]
pattern = "app.ryananthonywood.com/*"
zone_name = "ryananthonywood.com"

[[kv_namespaces]]
binding = "CACHE"

[env.staging]
[[env.staging.r2_buckets]]
binding = "FILES"
bucket_name = "files"
`,
    );
    const run = await cli();
    assert.equal(run.code, 0, run.stderr);
    const token = cf.tokens[0];
    assert.ok(token);
    assert.deepEqual(
      token.policies[0].permission_groups,
      ["Workers Scripts Write", "Account Settings Read", "Workers KV Storage Write", "Workers R2 Storage Write"].map((g) => ({
        id: groupId(g),
      })),
    );
    assert.deepEqual(Object.keys(token.policies[1].resources), [`com.cloudflare.api.account.zone.${ZONE}`]);
    assert.ok(!cf.requests.some((r) => r.path === "/accounts"), "account_id from the config is used");
  });

  test("a Worker with no routes or bindings gets account permissions only", async () => {
    writeFileSync(join(dir, "wrangler.json"), JSON.stringify({ name: "w", main: "src/w.ts", workers_dev: true }));
    const run = await cli();
    assert.equal(run.code, 0, run.stderr);
    assert.equal(cf.tokens[0]?.policies.length, 1);
  });

  test("--dry-run shows the permissions and creates nothing", async () => {
    writeFileSync(join(dir, "wrangler.jsonc"), HOMEBASE);
    const run = await cli(["--dry-run"]);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /account: D1 Write/);
    assert.match(run.stdout, /ryananthonywood\.com: Workers Routes Write/);
    assert.equal(cf.created().length, 0);
    assert.deepEqual(secrets(), {});
  });

  describe("fails before creating anything", () => {
    /** @param {{ code: number | null, stderr: string }} run @param {RegExp} message */
    function assertFailedClean(run, message) {
      assert.equal(run.code, 1);
      assert.match(run.stderr, message);
      assert.equal(cf.created().length, 0, "no token created");
      assert.deepEqual(secrets(), {}, "no secret set");
    }

    test("when gh isn't signed in", async () => {
      writeFileSync(join(dir, "wrangler.jsonc"), HOMEBASE);
      assertFailedClean(await cli([], { FAKE_GH_FAIL: "auth status" }), /gh auth status failed/);
      assert.equal(cf.requests.length, 0);
    });

    test("when gh can't manage the repo's secrets", async () => {
      writeFileSync(join(dir, "wrangler.jsonc"), HOMEBASE);
      assertFailedClean(await cli([], { FAKE_GH_FAIL: "secret list" }), /gh secret list failed/);
    });

    test("when there is no bootstrap token", async () => {
      writeFileSync(join(dir, "wrangler.jsonc"), HOMEBASE);
      assertFailedClean(await cli([], { RAW_STACK_CLOUDFLARE_BOOTSTRAP_TOKEN: "" }), /no Cloudflare bootstrap token/);
    });

    test("when the bootstrap token file is readable by others", async () => {
      writeFileSync(join(dir, "wrangler.jsonc"), HOMEBASE);
      mkdirSync(join(home, ".config", "raw-stack"), { recursive: true });
      const file = join(home, ".config", "raw-stack", "cloudflare-bootstrap-token");
      writeFileSync(file, BOOTSTRAP);
      chmodSync(file, 0o644);
      assertFailedClean(await cli([], { RAW_STACK_CLOUDFLARE_BOOTSTRAP_TOKEN: "" }), /can be read by other users/);
      chmodSync(file, 0o600);
      assert.equal((await cli([], { RAW_STACK_CLOUDFLARE_BOOTSTRAP_TOKEN: "" })).code, 0, "a mode-600 file works");
    });

    test("when the bootstrap token can't manage API tokens", async () => {
      writeFileSync(join(dir, "wrangler.jsonc"), HOMEBASE);
      cf.deniedPaths.add(`/accounts/${ACCOUNT}/tokens`);
      assertFailedClean(await cli(), /can't manage API tokens.*Account API Tokens > Edit/);
    });

    test("when the bootstrap token is invalid", async () => {
      writeFileSync(join(dir, "wrangler.jsonc"), HOMEBASE);
      assertFailedClean(await cli([], { RAW_STACK_CLOUDFLARE_BOOTSTRAP_TOKEN: "wrong" }), /401/);
    });

    test("when a route's zone can't be looked up", async () => {
      writeFileSync(join(dir, "wrangler.jsonc"), HOMEBASE);
      cf.deniedPaths.add("/zones");
      assertFailedClean(await cli(), /can't look up zones.*Zone > Zone > Read/);
    });

    test("when a route's zone isn't in the account", async () => {
      writeFileSync(
        join(dir, "wrangler.jsonc"),
        JSON.stringify({ name: "w", routes: [{ pattern: "x.example.org", custom_domain: true }] }),
      );
      assertFailedClean(await cli(), /no zone in this Cloudflare account serves route "x.example.org"/);
    });

    test("when the config uses something it can't scope", async () => {
      writeFileSync(
        join(dir, "wrangler.jsonc"),
        JSON.stringify({ name: "w", vectorize: [{ binding: "V", index_name: "i" }], env: { prod: { hyperdrive: [{ binding: "H" }] } } }),
      );
      assertFailedClean(await cli(), /uses hyperdrive, vectorize, which raw-stack doesn't know how to scope/);
      assert.equal(cf.requests.length, 0);
    });

    test("when there is no wrangler config", async () => {
      assertFailedClean(await cli(), /no wrangler config/);
    });
  });

  test("if storing the secret fails, it revokes the new token and keeps the old one", async () => {
    writeFileSync(join(dir, "wrangler.jsonc"), HOMEBASE);
    assert.equal((await cli()).code, 0);
    const run = await cli([], { FAKE_GH_FAIL: "secret set CLOUDFLARE_API_TOKEN" });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /Revoked the new token tok-2\. The secrets and the older tokens are unchanged/);
    assert.deepEqual(
      cf.tokens.map((t) => t.id),
      ["tok-1"],
    );
    assertNeverExposed("NEW-TOKEN-VALUE-2", run);
  });

  test("if revoking the previous token fails, it says so plainly", async () => {
    writeFileSync(join(dir, "wrangler.jsonc"), HOMEBASE);
    assert.equal((await cli()).code, 0);
    cf.failDelete.add("tok-1");
    const run = await cli();
    assert.equal(run.code, 1);
    assert.match(run.stderr, /the new token is in place, but revoking the previous token\(s\) failed/);
    assert.match(run.stderr, /tok-1/);
    assert.equal(secrets()["CLOUDFLARE_API_TOKEN"], "NEW-TOKEN-VALUE-2");
  });

  test("refuses to send the bootstrap token anywhere but localhost when the API URL is overridden", async () => {
    writeFileSync(join(dir, "wrangler.jsonc"), HOMEBASE);
    const run = await cli([], { RAW_STACK_CLOUDFLARE_API_URL: "http://evil.example" });
    assert.equal(run.code, 1);
    assert.match(run.stderr, /must point at localhost/);
  });
});
