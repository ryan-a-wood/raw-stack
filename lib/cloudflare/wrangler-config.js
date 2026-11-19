// @ts-check
// Reads a project's wrangler config and works out what a deploy touches: the
// account, the storage products it binds, and the zones its routes use. Keys we
// don't know how to scope are reported, so the token never misses a permission
// silently and never gets one "just in case".
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";

export const CONFIG_FILES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"];

/** Keys that need nothing beyond deploying the Worker itself. */
const NO_EXTRA_PERMISSION = new Set([
  "$schema", "name", "main", "compatibility_date", "compatibility_flags", "account_id", "workers_dev",
  "preview_urls", "vars", "durable_objects", "migrations", "services", "assets", "observability", "build",
  "minify", "keep_names", "no_bundle", "rules", "find_additional_modules", "base_dir", "preserve_file_names",
  "upload_source_maps", "placement", "limits", "triggers", "tail_consumers", "define", "alias",
  "jsx_factory", "jsx_fragment", "tsconfig", "legacy_env", "send_metrics", "dev", "keep_vars",
  "version_metadata", "usage_model", "wasm_modules", "text_blobs", "data_blobs", "env", "logpush",
  "compliance_region", "site", "node_compat", "first_party_worker", "zone_id",
]);

/** Keys this command grants permissions for. */
const SCOPED = new Set(["routes", "route", "d1_databases", "kv_namespaces", "r2_buckets", "queues"]);

/**
 * @typedef {{ pattern: string, zoneId?: string, zoneName?: string, customDomain: boolean }} Route
 * @typedef {{
 *   file: string, name?: string, accountId?: string,
 *   d1: boolean, kv: boolean, r2: boolean, queues: boolean,
 *   routes: Route[], unknown: string[],
 * }} DeployNeeds
 */

/** The config file in `root`, or undefined. @param {string} root */
export function findConfig(root) {
  return CONFIG_FILES.map((f) => join(root, f)).find((p) => existsSync(p));
}

/**
 * Strip // and /* *\/ comments and trailing commas from JSONC, leaving strings alone.
 * @param {string} text
 */
export function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[\]}])/g, "$1");
}

/** @param {string} path @returns {Record<string, unknown>} */
export function readConfig(path) {
  const text = readFileSync(path, "utf8");
  try {
    const value = path.endsWith(".toml") ? parseToml(text) : JSON.parse(stripJsonc(text));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    return /** @type {Record<string, unknown>} */ (value);
  } catch (err) {
    throw new Error(`can't parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** @param {unknown} v */
const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : isObject(v) ? Object.keys(v).length > 0 : Boolean(v));

/**
 * The routes in one config section, with the section's zone_id as the default.
 * @param {Record<string, unknown>} section @returns {Route[]}
 */
function sectionRoutes(section) {
  const zoneId = typeof section["zone_id"] === "string" ? section["zone_id"] : undefined;
  const raw = [
    ...(Array.isArray(section["routes"]) ? section["routes"] : []),
    ...(section["route"] === undefined ? [] : [section["route"]]),
  ];
  return raw.map((r) => {
    if (typeof r === "string") return { pattern: r, ...(zoneId ? { zoneId } : {}), customDomain: false };
    if (!isObject(r) || typeof r["pattern"] !== "string") throw new Error(`a route has no pattern: ${JSON.stringify(r)}`);
    /** @type {Route} */
    const route = { pattern: r["pattern"], customDomain: r["custom_domain"] === true };
    const id = typeof r["zone_id"] === "string" ? r["zone_id"] : zoneId;
    if (id) route.zoneId = id;
    if (typeof r["zone_name"] === "string") route.zoneName = r["zone_name"];
    return route;
  });
}

/**
 * What deploying this config needs, across the top level and every `env.*`.
 * @param {Record<string, unknown>} config @param {string} file @returns {DeployNeeds}
 */
export function deployNeeds(config, file) {
  const envs = isObject(config["env"]) ? Object.values(config["env"]).filter(isObject) : [];
  const sections = [config, ...envs];
  /** @type {DeployNeeds} */
  const needs = { file, d1: false, kv: false, r2: false, queues: false, routes: [], unknown: [] };
  if (typeof config["name"] === "string") needs.name = config["name"];
  if (typeof config["account_id"] === "string") needs.accountId = config["account_id"];
  const unknown = new Set();
  for (const section of sections) {
    needs.d1 ||= nonEmpty(section["d1_databases"]);
    needs.kv ||= nonEmpty(section["kv_namespaces"]);
    needs.r2 ||= nonEmpty(section["r2_buckets"]);
    needs.queues ||= nonEmpty(section["queues"]);
    needs.routes.push(...sectionRoutes(section));
    for (const key of Object.keys(section)) {
      if (!NO_EXTRA_PERMISSION.has(key) && !SCOPED.has(key) && nonEmpty(section[key])) unknown.add(key);
    }
  }
  needs.unknown = [...unknown].sort();
  return needs;
}

/**
 * The hostname a route pattern serves: no scheme, path or leading wildcard.
 * @param {string} pattern
 */
export function routeHost(pattern) {
  const host = pattern.replace(/^[a-z]+:\/\//i, "").split("/")[0] ?? "";
  return host.replace(/^\*\.?/, "").replace(/:\d+$/, "").toLowerCase();
}

/**
 * Candidate zone names for a host, most specific first: a.b.example.com gives
 * a.b.example.com, b.example.com, example.com.
 * @param {string} host
 */
export function zoneCandidates(host) {
  const labels = host.split(".").filter(Boolean);
  return labels.slice(0, -1).map((_, i) => labels.slice(i).join("."));
}
