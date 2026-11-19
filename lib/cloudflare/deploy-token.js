// @ts-check
// raw-stack cloudflare-secrets: create a Cloudflare API token scoped to what the
// project's wrangler config deploys, and store it with the account ID as the
// repo's GitHub Actions secrets CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
//
// The new token's value only ever lives in memory and on gh's stdin: it is never
// printed, logged, written to disk or passed as an argument. A rerun creates a
// fresh token, updates the secret, then revokes the older tokens with the same
// name. Every check runs before anything is created.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { deployNeeds, findConfig, readConfig, routeHost, zoneCandidates, CONFIG_FILES } from "./wrangler-config.js";

const API = "https://api.cloudflare.com/client/v4";
export const KEYCHAIN_SERVICE = "raw-stack-cloudflare-bootstrap";
export const BOOTSTRAP_ENV = "RAW_STACK_CLOUDFLARE_BOOTSTRAP_TOKEN";
/** Only for tests: point the command at a local fake of the Cloudflare API. */
const API_ENV = "RAW_STACK_CLOUDFLARE_API_URL";

/** Permission groups by what the config uses. Cloudflare looks them up by these names. */
const ACCOUNT_GROUPS = {
  always: ["Workers Scripts Write", "Account Settings Read"],
  d1: "D1 Write",
  kv: "Workers KV Storage Write",
  r2: "Workers R2 Storage Write",
  queues: "Queues Write",
};
const ZONE_GROUPS = ["Workers Routes Write"];

export const USAGE = "usage: raw-stack cloudflare-secrets [--repo owner/name] [--account-id id] [--config file] [--dry-run]";

class Failure extends Error {}

/**
 * @typedef {{ log: (line: string) => void, error: (line: string) => void }} Output
 * @typedef {{ base: string, token: string }} Api
 * @typedef {{ id: string, name: string }} Group
 * @typedef {{ id: string, name: string }} Zone
 */

/** @param {string[]} args */
function parseArgs(args) {
  /** @type {{ repo?: string, accountId?: string, config?: string, dryRun: boolean }} */
  const opts = { dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => {
      const v = args[++i];
      if (!v || v.startsWith("--")) throw new Failure(`${arg} needs a value. ${USAGE}`);
      return v;
    };
    if (arg === "--repo") opts.repo = value();
    else if (arg === "--account-id") opts.accountId = value();
    else if (arg === "--config") opts.config = value();
    else if (arg === "--dry-run") opts.dryRun = true;
    else throw new Failure(`unknown argument ${arg}. ${USAGE}`);
  }
  return opts;
}

/**
 * Run gh. Its output is returned, never echoed; `input` goes to its stdin.
 * @param {string[]} args @param {string} cwd @param {string} [input]
 */
function gh(args, cwd, input) {
  try {
    return execFileSync("gh", args, {
      cwd,
      encoding: "utf8",
      input: input ?? "",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    const e = /** @type {{ code?: string, stderr?: string }} */ (err);
    if (e.code === "ENOENT") throw new Failure("gh isn't installed. Install the GitHub CLI and run `gh auth login`.");
    throw new Failure(`gh ${args.slice(0, 2).join(" ")} failed: ${(e.stderr ?? "").trim() || "no output"}`);
  }
}

/**
 * The bootstrap token: the env var, then the macOS keychain, then a mode-600 file.
 * @param {NodeJS.ProcessEnv} env @returns {{ token: string, source: string }}
 */
export function bootstrapToken(env) {
  const fromEnv = env[BOOTSTRAP_ENV]?.trim();
  if (fromEnv) return { token: fromEnv, source: `$${BOOTSTRAP_ENV}` };

  if (process.platform === "darwin") {
    try {
      const token = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (token) return { token, source: `the keychain item "${KEYCHAIN_SERVICE}"` };
    } catch {
      // not in the keychain: try the file
    }
  }

  const file = join(env["XDG_CONFIG_HOME"] || join(env["HOME"] || homedir(), ".config"), "raw-stack", "cloudflare-bootstrap-token");
  let mode;
  try {
    mode = statSync(file).mode;
  } catch {
    throw new Failure(
      `no Cloudflare bootstrap token. Put it in the macOS keychain (service "${KEYCHAIN_SERVICE}"), ` +
        `in ${file} with mode 600, or in $${BOOTSTRAP_ENV}. See "Deploy to Cloudflare" in raw-stack's README.`,
    );
  }
  if ((mode & 0o077) !== 0) {
    throw new Failure(`${file} can be read by other users. Run: chmod 600 '${file}'`);
  }
  const token = readFileSync(file, "utf8").trim();
  if (!token) throw new Failure(`${file} is empty.`);
  return { token, source: file };
}

/** @param {NodeJS.ProcessEnv} env */
function apiBase(env) {
  const override = env[API_ENV];
  if (!override) return API;
  // A test hook: never let it send the bootstrap token anywhere but this machine.
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(override)) {
    throw new Failure(`${API_ENV} must point at localhost.`);
  }
  return override.replace(/\/$/, "");
}

/**
 * Call the Cloudflare API. Errors carry Cloudflare's messages, never the result,
 * so a token value can't end up in an error.
 * @param {Api} api @param {string} method @param {string} path @param {unknown} [body]
 * @returns {Promise<{ result: any, result_info?: { page?: number, total_pages?: number } }>}
 */
async function cf(api, method, path, body) {
  let res;
  try {
    res = await fetch(api.base + path, {
      method,
      headers: { Authorization: `Bearer ${api.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (err) {
    throw new Failure(`can't reach the Cloudflare API: ${err instanceof Error ? err.message : String(err)}`);
  }
  /** @type {any} */
  let json = {};
  try {
    json = await res.json();
  } catch {
    // not JSON: report the status below
  }
  if (!res.ok || json.success === false) {
    const errors = Array.isArray(json.errors) ? json.errors : [];
    const detail = errors.map((/** @type {any} */ e) => `${e.message} (code ${e.code})`).join("; ");
    const err = new Failure(`Cloudflare ${method} ${path.split("?")[0]} failed with ${res.status}${detail ? `: ${detail}` : ""}`);
    /** @type {any} */ (err).status = res.status;
    throw err;
  }
  return json;
}

/** All pages of a list endpoint. @param {Api} api @param {string} path */
async function cfList(api, path) {
  const items = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const json = await cf(api, "GET", `${path}${sep}page=${page}&per_page=50`);
    items.push(...(Array.isArray(json.result) ? json.result : []));
    const total = json.result_info?.total_pages ?? 1;
    if (page >= total) return items;
  }
}

/** @param {Api} api @param {string} accountId @param {string} name @returns {Promise<Group>} */
async function permissionGroup(api, accountId, name) {
  const json = await cf(api, "GET", `/accounts/${accountId}/tokens/permission_groups?name=${encodeURIComponent(name)}`);
  const group = (Array.isArray(json.result) ? json.result : []).find((/** @type {any} */ g) => g.name === name);
  if (!group) throw new Failure(`Cloudflare has no permission group named "${name}" for this account.`);
  return { id: group.id, name };
}

/** @param {Api} api @param {string} accountId @param {import("./wrangler-config.js").Route} route @returns {Promise<Zone>} */
async function routeZone(api, accountId, route) {
  if (route.zoneId) return { id: route.zoneId, name: route.zoneName ?? route.zoneId };
  const host = routeHost(route.pattern);
  const names = route.zoneName ? [route.zoneName] : zoneCandidates(host);
  for (const name of names) {
    let json;
    try {
      json = await cf(api, "GET", `/zones?name=${encodeURIComponent(name)}&account.id=${accountId}`);
    } catch (err) {
      if (/** @type {any} */ (err).status === 403) {
        throw new Failure(
          `the bootstrap token can't look up zones (route "${route.pattern}"). Give it Zone > Zone > Read, ` +
            `or set zone_id on the route in the wrangler config.`,
        );
      }
      throw err;
    }
    const zone = (Array.isArray(json.result) ? json.result : []).find((/** @type {any} */ z) => z.name === name);
    if (zone) return { id: zone.id, name: zone.name };
  }
  throw new Failure(`no zone in this Cloudflare account serves route "${route.pattern}" (tried ${names.join(", ")}).`);
}

/**
 * The --account-id flag, then the config's account_id, then $CLOUDFLARE_ACCOUNT_ID,
 * then the bootstrap token's only account.
 * @param {Api} api @param {string | undefined} given @returns {Promise<string>}
 */
async function resolveAccount(api, given) {
  if (given) return given;
  const accounts = await cfList(api, "/accounts");
  if (accounts.length === 1) return accounts[0].id;
  if (accounts.length === 0) throw new Failure("the bootstrap token can't see any account. Pass --account-id.");
  throw new Failure(`the bootstrap token sees ${accounts.length} accounts. Pass --account-id or set account_id in the wrangler config.`);
}

/**
 * @param {{ root: string, args: string[], env: NodeJS.ProcessEnv, out: Output }} ctx
 * @returns {Promise<number>} exit code
 */
export async function cloudflareSecrets({ root, args, env, out }) {
  try {
    await run(root, args, env, out);
    return 0;
  } catch (err) {
    if (err instanceof Failure) {
      out.error(`raw-stack cloudflare-secrets: ${err.message}`);
      return 1;
    }
    throw err;
  }
}

/** @param {string} root @param {string[]} args @param {NodeJS.ProcessEnv} env @param {Output} out */
async function run(root, args, env, out) {
  const opts = parseArgs(args);

  // 1. The wrangler config, and whether we know how to scope everything in it.
  const configPath = opts.config ? join(root, opts.config) : findConfig(root);
  if (!configPath) throw new Failure(`no wrangler config in ${root} (looked for ${CONFIG_FILES.join(", ")}).`);
  const needs = deployNeeds(readConfig(configPath), relative(root, configPath));
  if (needs.unknown.length > 0) {
    throw new Failure(
      `${needs.file} uses ${needs.unknown.join(", ")}, which raw-stack doesn't know how to scope a token for. ` +
        `Nothing was created. Add the permission to lib/cloudflare/deploy-token.js in raw-stack, or deploy those another way.`,
    );
  }

  // 2. gh is signed in and can write this repo's secrets.
  gh(["auth", "status"], root);
  const repo = opts.repo ?? gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], root).trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Failure(`can't tell which GitHub repo this is (got "${repo}"). Pass --repo owner/name.`);
  gh(["secret", "list", "--repo", repo], root);

  // 3. The bootstrap token works, and the permissions and zones resolve.
  const bootstrap = bootstrapToken(env);
  const api = { base: apiBase(env), token: bootstrap.token };
  const accountId = await resolveAccount(api, opts.accountId ?? needs.accountId ?? env["CLOUDFLARE_ACCOUNT_ID"]);
  if (!/^[0-9a-f]{32}$/.test(accountId)) throw new Failure(`"${accountId}" isn't a Cloudflare account ID.`);
  const tokenName = `github-actions ${repo}`;
  let existing;
  try {
    existing = (await cfList(api, `/accounts/${accountId}/tokens`)).filter((t) => t.name === tokenName);
  } catch (err) {
    if (/** @type {any} */ (err).status === 401 || /** @type {any} */ (err).status === 403) {
      throw new Failure(
        `the bootstrap token from ${bootstrap.source} can't manage API tokens on account ${accountId}. ` +
          `It needs Account > Account API Tokens > Edit. (${/** @type {Error} */ (err).message})`,
      );
    }
    throw err;
  }

  const accountNames = [
    ...ACCOUNT_GROUPS.always,
    ...(needs.d1 ? [ACCOUNT_GROUPS.d1] : []),
    ...(needs.kv ? [ACCOUNT_GROUPS.kv] : []),
    ...(needs.r2 ? [ACCOUNT_GROUPS.r2] : []),
    ...(needs.queues ? [ACCOUNT_GROUPS.queues] : []),
  ];
  const accountGroups = await Promise.all(accountNames.map((n) => permissionGroup(api, accountId, n)));
  const zones = [...new Map((await Promise.all(needs.routes.map((r) => routeZone(api, accountId, r)))).map((z) => [z.id, z])).values()];
  const zoneGroups = zones.length > 0 ? await Promise.all(ZONE_GROUPS.map((n) => permissionGroup(api, accountId, n))) : [];

  out.log(`Token "${tokenName}" on account ${accountId}, from ${needs.file}:`);
  for (const g of accountGroups) out.log(`  account: ${g.name}`);
  for (const g of zoneGroups) out.log(`  ${zones.map((z) => z.name).join(", ")}: ${g.name}`);
  if (opts.dryRun) {
    out.log(`Dry run: nothing created. ${existing.length} existing token(s) with this name would be revoked.`);
    return;
  }

  // 4. Create the token, store the secrets, then revoke the older tokens.
  const policies = [
    {
      effect: "allow",
      resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
      permission_groups: accountGroups.map((g) => ({ id: g.id })),
    },
    ...(zones.length > 0
      ? [
          {
            effect: "allow",
            resources: Object.fromEntries(zones.map((z) => [`com.cloudflare.api.account.zone.${z.id}`, "*"])),
            permission_groups: zoneGroups.map((g) => ({ id: g.id })),
          },
        ]
      : []),
  ];
  const created = (await cf(api, "POST", `/accounts/${accountId}/tokens`, { name: tokenName, policies })).result;
  const newId = typeof created?.id === "string" ? created.id : undefined;
  const value = typeof created?.value === "string" ? created.value : undefined;
  if (!newId || !value) throw new Failure("Cloudflare created a token but didn't return its ID and value. Check the dashboard for it.");
  out.log(`Created token ${newId}.`);

  try {
    gh(["secret", "set", "CLOUDFLARE_ACCOUNT_ID", "--repo", repo], root, accountId);
    gh(["secret", "set", "CLOUDFLARE_API_TOKEN", "--repo", repo], root, value);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    try {
      await cf(api, "DELETE", `/accounts/${accountId}/tokens/${newId}`);
    } catch (revokeErr) {
      throw new Failure(
        `${why}\nThe new token ${newId} was not stored, and revoking it failed too: ` +
          `${revokeErr instanceof Error ? revokeErr.message : String(revokeErr)}. Delete it in the Cloudflare dashboard.`,
      );
    }
    throw new Failure(`${why}\nRevoked the new token ${newId}. The secrets and the older tokens are unchanged.`);
  }
  out.log(`Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN on ${repo}.`);

  const failed = [];
  for (const old of existing) {
    try {
      await cf(api, "DELETE", `/accounts/${accountId}/tokens/${old.id}`);
      out.log(`Revoked the previous token ${old.id}.`);
    } catch (err) {
      failed.push(`${old.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed.length > 0) {
    throw new Failure(
      `the new token is in place, but revoking the previous token(s) failed. They still work until you delete them ` +
        `in the Cloudflare dashboard:\n  ${failed.join("\n  ")}`,
    );
  }
}
