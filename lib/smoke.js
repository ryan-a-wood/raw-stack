// @ts-check
// `raw-stack smoke`: wait for deployed SHA readiness (optional) and run smoke tests
// against a live URL using Vitest (`smoke/**/*.smoke.test.ts`) and optionally Playwright (`--browser`).
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { run, vpCommand } from "./project.js";
import { parseSmokeHeaders, validateSmokeUrl } from "./smoke-headers.js";
import { report } from "./verify.js";

export const SMOKE_USAGE =
  "usage: raw-stack smoke --url <base-url> [--sha <git-sha>] [--health-path /api/health] [--health-timeout-ms 30000] [--browser]";

export const DEFAULT_HEALTH_PATH = "/api/health";
export const DEFAULT_HEALTH_TIMEOUT_MS = 30_000;
export const DEFAULT_HEALTH_INTERVAL_MS = 2_000;

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage"]);
const VALUE_FLAGS = new Set(["--url", "--sha", "--health-path", "--health-timeout-ms"]);

export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = 2;
  }
}

/**
 * @typedef {{
 *   url: string,
 *   sha: string | undefined,
 *   healthPath: string,
 *   healthTimeoutMs: number,
 *   browser: boolean,
 * }} SmokeOptions
 */

/**
 * Parse and validate `raw-stack smoke` CLI arguments.
 * @param {string[]} args
 * @returns {SmokeOptions}
 */
export function parseSmokeArgs(args) {
  /** @type {string | undefined} */
  let rawUrl;
  /** @type {string | undefined} */
  let rawSha;
  /** @type {string | undefined} */
  let rawHealthPath;
  /** @type {string | undefined} */
  let rawHealthTimeoutMs;
  let browser = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--browser") {
      browser = true;
      continue;
    }

    let flag = arg;
    /** @type {string | undefined} */
    let val;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flag = arg.slice(0, eq);
      val = arg.slice(eq + 1);
      if (!VALUE_FLAGS.has(flag)) {
        throw new UsageError(`unknown option ${arg}.\n${SMOKE_USAGE}`);
      }
    } else if (VALUE_FLAGS.has(flag)) {
      const next = args[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`${flag} requires a value.\n${SMOKE_USAGE}`);
      }
      val = next;
      i++;
    } else {
      throw new UsageError(`unknown argument ${arg}.\n${SMOKE_USAGE}`);
    }

    if (flag === "--url") rawUrl = val;
    else if (flag === "--sha") rawSha = val;
    else if (flag === "--health-path") rawHealthPath = val;
    else if (flag === "--health-timeout-ms") rawHealthTimeoutMs = val;
  }

  if (rawUrl === undefined) {
    throw new UsageError(`missing required --url.\n${SMOKE_USAGE}`);
  }

  let url;
  try {
    url = validateSmokeUrl(rawUrl);
  } catch (err) {
    throw new UsageError(`${err instanceof Error ? err.message : String(err)}\n${SMOKE_USAGE}`);
  }

  /** @type {string | undefined} */
  let sha;
  if (rawSha !== undefined) {
    const trimmedSha = rawSha.trim();
    if (trimmedSha === "") {
      throw new UsageError(`--sha must not be empty.\n${SMOKE_USAGE}`);
    }
    sha = trimmedSha;
  }

  let healthPath = DEFAULT_HEALTH_PATH;
  if (rawHealthPath !== undefined) {
    if (rawHealthPath.trim() === "" || rawHealthPath !== rawHealthPath.trim() || !rawHealthPath.startsWith("/")) {
      throw new UsageError(`invalid --health-path ${JSON.stringify(rawHealthPath)}: must be non-empty and start with "/".\n${SMOKE_USAGE}`);
    }
    healthPath = rawHealthPath;
  }

  let healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS;
  if (rawHealthTimeoutMs !== undefined) {
    if (!/^\d+$/.test(rawHealthTimeoutMs)) {
      throw new UsageError(`invalid --health-timeout-ms ${JSON.stringify(rawHealthTimeoutMs)}: expected a positive integer.\n${SMOKE_USAGE}`);
    }
    const parsedTimeout = Number(rawHealthTimeoutMs);
    if (!Number.isSafeInteger(parsedTimeout) || parsedTimeout <= 0) {
      throw new UsageError(`invalid --health-timeout-ms ${JSON.stringify(rawHealthTimeoutMs)}: expected a positive integer.\n${SMOKE_USAGE}`);
    }
    healthTimeoutMs = parsedTimeout;
  }

  return { url, sha, healthPath, healthTimeoutMs, browser };
}

/**
 * Compare actual and expected git SHAs (case-insensitive, supports >=4-char prefix match).
 * @param {string} actual
 * @param {string} expected
 * @returns {boolean}
 */
export function shaMatches(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = actual.trim().toLowerCase();
  const e = expected.trim().toLowerCase();
  if (!a || !e) return false;
  if (a === e) return true;
  if (Math.min(a.length, e.length) >= 4 && (a.startsWith(e) || e.startsWith(a))) {
    return true;
  }
  return false;
}

/**
 * Inspect an HTTP 200 health response for a matching build SHA.
 * @param {Response} res
 * @param {string} expectedSha
 * @returns {Promise<{ ok: true, matchedSha: string, source: "header" | "body" } | { ok: false, observation: string }>}
 */
async function evaluateHealthResponse(res, expectedSha) {
  const headerSha = res.headers.get("x-build-sha")?.trim() ?? "";
  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") throw err;
    return { ok: false, observation: `HTTP 200 (failed to read body: ${err instanceof Error ? err.message : String(err)})` };
  }

  /** @type {unknown} */
  let bodyOk;
  /** @type {string} */
  let bodySha = "";
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      bodyOk = /** @type {Record<string, unknown>} */ (parsed)["ok"];
      const rawBodySha = /** @type {Record<string, unknown>} */ (parsed)["sha"];
      if (typeof rawBodySha === "string") bodySha = rawBodySha.trim();
    }
  } catch {
    // Non-JSON response body: rely on header if present.
  }

  if (bodyOk === false) {
    return { ok: false, observation: "HTTP 200 (body ok: false)" };
  }
  if (headerSha && shaMatches(headerSha, expectedSha)) {
    return { ok: true, matchedSha: headerSha, source: "header" };
  }
  if (bodySha && shaMatches(bodySha, expectedSha)) {
    return { ok: true, matchedSha: bodySha, source: "body" };
  }

  const parts = [];
  if (headerSha) parts.push(`header x-build-sha=${headerSha}`);
  if (bodySha) parts.push(`body sha=${bodySha}`);
  const observation =
    parts.length > 0
      ? `HTTP 200 (${parts.join(", ")})`
      : "HTTP 200, no x-build-sha header or JSON sha field";
  return { ok: false, observation };
}

/**
 * Poll a deployment health endpoint until the expected SHA is served or timeout expires.
 * Never includes headers or secrets in errors or return values.
 * @param {{
 *   url: string,
 *   sha: string,
 *   healthPath?: string,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   headers?: Record<string, string>,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 * }} options
 * @returns {Promise<
 *   | { ok: true, matchedSha: string, source: "header" | "body", attempts: number, ms: number }
 *   | { ok: false, attempts: number, ms: number, message: string }
 * >}
 */
export async function pollHealth({
  url,
  sha,
  healthPath = DEFAULT_HEALTH_PATH,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  intervalMs = DEFAULT_HEALTH_INTERVAL_MS,
  headers = {},
  fetchImpl = fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const healthUrl = `${url.replace(/\/+$/, "")}${healthPath}`;
  const started = Date.now();
  const deadline = started + timeoutMs;
  let attempts = 0;
  let lastObservation = "no response yet";

  while (attempts === 0 ? timeoutMs > 0 : Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (attempts > 0 && remaining <= 0) break;
    attempts++;

    try {
      const res = await fetchImpl(healthUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(Math.max(1, Math.min(10_000, remaining))),
      });
      if (res.status === 200) {
        const result = await evaluateHealthResponse(res, sha);
        if (result.ok) {
          return {
            ok: true,
            matchedSha: result.matchedSha,
            source: result.source,
            attempts,
            ms: Date.now() - started,
          };
        }
        lastObservation = result.observation;
      } else {
        await res.body?.cancel?.().catch(() => {});
        lastObservation = `HTTP ${res.status}`;
      }
    } catch (err) {
      const isDeadlineAbort =
        attempts > 1 && Date.now() >= deadline && err instanceof Error && err.name === "TimeoutError";
      if (!isDeadlineAbort) {
        lastObservation = `network error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    const remainingAfter = deadline - Date.now();
    if (remainingAfter <= 0) break;
    await sleep(Math.min(intervalMs, remainingAfter));
  }

  const ms = Date.now() - started;
  return {
    ok: false,
    attempts,
    ms,
    message: `Timed out after ${timeoutMs}ms waiting for ${healthUrl} to serve SHA ${sha} (${attempts} attempt(s); last: ${lastObservation}).`,
  };
}

/**
 * Recursively walk `smoke/` and return sorted POSIX paths for Vitest and Playwright smoke files.
 * @param {string} root
 * @returns {{ vitest: string[], playwright: string[] }}
 */
export function discoverSmokeFiles(root) {
  const smokeDir = join(root, "smoke");
  /** @type {string[]} */
  const vitest = [];
  /** @type {string[]} */
  const playwright = [];
  if (!existsSync(smokeDir)) return { vitest, playwright };

  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = relative(root, full).split("\\").join("/");
        if (entry.name.endsWith(".smoke.test.ts")) vitest.push(rel);
        else if (entry.name.endsWith(".smoke.spec.ts")) playwright.push(rel);
      }
    }
  };

  walk(smokeDir);
  return { vitest: vitest.sort(), playwright: playwright.sort() };
}

/**
 * @param {number | undefined} intervalMs
 * @param {NodeJS.ProcessEnv} env
 * @returns {number}
 */
function resolvePollInterval(intervalMs, env) {
  if (typeof intervalMs === "number" && Number.isSafeInteger(intervalMs) && intervalMs > 0) {
    return intervalMs;
  }
  const raw = env["RAW_STACK_SMOKE_POLL_INTERVAL_MS"]?.trim();
  if (raw && /^\d+$/.test(raw)) {
    const parsed = Number(raw);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_HEALTH_INTERVAL_MS;
}

/**
 * Defense-in-depth scrubbing so secret header values never reach stdout/stderr.
 * @param {string} text
 * @param {string | undefined} rawHeadersJson
 * @param {Record<string, string>} headers
 * @returns {string}
 */
function scrubSecrets(text, rawHeadersJson, headers) {
  const secrets = [
    ...(typeof rawHeadersJson === "string" && rawHeadersJson.trim().length >= 4 ? [rawHeadersJson.trim()] : []),
    ...Object.values(headers).filter((v) => v.length >= 4),
  ].sort((a, b) => b.length - a.length);

  let safe = text;
  for (const secret of secrets) {
    if (safe.includes(secret)) safe = safe.split(secret).join("[REDACTED]");
  }
  return safe;
}

/**
 * Run `raw-stack smoke`.
 * @param {{
 *   root: string,
 *   args: string[],
 *   env?: NodeJS.ProcessEnv,
 *   out?: { log: (line: string) => void, error: (line: string) => void },
 *   fetchImpl?: typeof fetch,
 *   intervalMs?: number,
 * }} ctx
 * @returns {Promise<number>}
 */
export async function smoke({
  root,
  args,
  env = process.env,
  out = { log: console.log, error: console.error },
  fetchImpl,
  intervalMs,
}) {
  /** @type {SmokeOptions} */
  let opts;
  try {
    opts = parseSmokeArgs(args);
  } catch (err) {
    out.error(`raw-stack smoke: ${err instanceof Error ? err.message : String(err)}`);
    return err instanceof UsageError ? err.exitCode : 2;
  }

  /** @type {Record<string, string>} */
  let headers;
  try {
    headers = parseSmokeHeaders(env["SMOKE_HEADERS_JSON"]);
  } catch (err) {
    out.error(`raw-stack smoke: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }

  const pollIntervalMs = resolvePollInterval(intervalMs, env);
  /** @type {import("./verify.js").Step[]} */
  const steps = [];

  if (opts.sha) {
    const ready = await pollHealth({
      url: opts.url,
      sha: opts.sha,
      healthPath: opts.healthPath,
      timeoutMs: opts.healthTimeoutMs,
      intervalMs: pollIntervalMs,
      headers,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    if (!ready.ok) {
      out.error(`FAIL  health poll (${ready.ms} ms)\n\n--- health poll ---\n${ready.message}`);
      return 1;
    }
    const line = `pass  health poll (${opts.url}${opts.healthPath} matched ${ready.matchedSha} via ${ready.source}, ${ready.attempts} attempt(s), ${ready.ms} ms)`;
    out.log(line);
    steps.push({
      label: `health poll (${opts.url}${opts.healthPath} matched ${ready.matchedSha} via ${ready.source}, ${ready.attempts} attempt(s))`,
      ok: true,
      output: "",
      ms: ready.ms,
    });
  }

  const { vitest, playwright } = discoverSmokeFiles(root);
  /** @type {Record<string, string>} */
  const smokeEnv = {
    SMOKE_BASE_URL: opts.url,
    ...(env["SMOKE_HEADERS_JSON"] !== undefined
      ? { SMOKE_HEADERS_JSON: env["SMOKE_HEADERS_JSON"] }
      : process.env["SMOKE_HEADERS_JSON"] !== undefined
        ? { SMOKE_HEADERS_JSON: "" }
        : {}),
  };

  if (vitest.length > 0) {
    const res = await run("vitest smoke", vpCommand(root), ["test", "run", "--project", "smoke", "--update=none"], root, smokeEnv);
    steps.push({
      ...res,
      output: scrubSecrets(res.output, env["SMOKE_HEADERS_JSON"], headers),
    });
  }

  if (opts.browser) {
    if (playwright.length > 0) {
      if (!existsSync(join(root, "playwright.config.ts"))) {
        steps.push({
          label: "playwright smoke",
          ok: false,
          output: "Found browser smoke spec(s) in smoke/, but playwright.config.ts is missing.",
          ms: 0,
        });
      } else {
        const res = await run("playwright smoke", join(root, "node_modules", ".bin", "playwright"), ["test"], root, smokeEnv);
        steps.push({
          ...res,
          output: scrubSecrets(res.output, env["SMOKE_HEADERS_JSON"], headers),
        });
      }
    } else {
      steps.push({
        label: "playwright smoke skipped (no smoke/**/*.smoke.spec.ts files)",
        ok: true,
        output: "",
        ms: 0,
      });
    }
  }

  const ranTests = vitest.length > 0 || (opts.browser && playwright.length > 0);
  if (!ranTests) {
    out.log(
      `No smoke tests found in smoke/ (looked for **/*.smoke.test.ts${opts.browser ? " and **/*.smoke.spec.ts" : ""}).`,
    );
    if (steps.length > 0) out.log(report(steps));
    return 0;
  }

  out.log(report(steps));
  return steps.every((s) => s.ok) ? 0 : 1;
}
