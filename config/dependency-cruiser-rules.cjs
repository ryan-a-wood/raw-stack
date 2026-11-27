// @ts-check
// Opt-in dependency-cruiser rule builders for raw-stack projects.
// Spread into `forbidden` in a project's .dependency-cruiser.cjs:
//
//   const { clientBoundary, deepSubmodules } = require("raw-stack/dependency-cruiser-rules");
//   module.exports = {
//     extends: require.resolve("raw-stack/dependency-cruiser"),
//     forbidden: [
//       ...clientBoundary({ serverModules: ["db", "secrets"] }),
//       ...deepSubmodules({ modules: ["reading"] }),
//     ],
//   };

const { builtinModules } = require("node:module");

const TEST = "\\.test\\.tsx?$";
const MODULE_NAME = /^[A-Za-z0-9._-]+$/;

/** Default pattern identifying client-side code: `*.client.ts(x)`, `.../client/...`, `src/browser.ts(x)`, and `src/modules/<mod>(/<submod>)?/client.ts(x)`. */
const DEFAULT_CLIENT_PATTERN =
  "(?:\\.client\\.tsx?$|/client/|^src/browser\\.tsx?$|^src/modules/[^/]+/client\\.tsx?$|^src/modules/[^/]+/[^/]+/client\\.tsx?$)";

const SHARED_RULE_NAMES = new Set([
  "deep-modules",
  "deep-modules-from-outside",
  "submodule-encapsulation",
  "submodule-encapsulation-from-parent",
  "module-max-depth",
  "module-max-depth-from",
  "module-max-depth-orphan",
  "client-no-node",
  "client-no-server",
  "no-circular",
  "no-orphans",
  "not-to-unresolvable",
  "no-undeclared-deps",
  "not-to-dev-dep",
  "not-to-test",
  "not-to-testing",
]);

/** @param {string} value */
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const NODE_CORE_PATTERN = `^(?:node:)?(?:${[
  ...new Set(builtinModules.map((m) => (m.startsWith("node:") ? m.slice("node:".length) : m))),
]
  .map(escapeRegex)
  .join("|")})$`;

/**
 * Validate a custom rule name so it cannot collide with raw-stack's shared rules.
 * @param {string | undefined} name
 * @param {string} fallback
 * @param {string} caller
 */
function validateRuleName(name, fallback, caller) {
  if (name === undefined) return fallback;
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError(`${caller}: "name" must be a non-empty string.`);
  }
  if (SHARED_RULE_NAMES.has(name)) {
    throw new Error(`${caller}: rule name "${name}" collides with a shared raw-stack rule.`);
  }
  return name;
}

/**
 * Validate a single regex pattern string.
 * @param {string} pattern
 * @param {string} label
 */
function assertValidRegex(pattern, label) {
  try {
    new RegExp(pattern);
  } catch (err) {
    throw new TypeError(`${label}: invalid regex "${pattern}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * @typedef {{
 *   serverModules: string[],
 *   clientPattern?: string | string[],
 *   name?: string,
 * }} ClientBoundaryOptions
 */

/**
 * Prevent client-side files from importing server-only modules (directly or transitively).
 *
 * Each entry in `serverModules` may be:
 * - A module name under `src/modules/` (e.g. `"db"` -> `^src/modules/db(?:/|$)`).
 * - A Node.js built-in specifier (e.g. `"node:fs"` -> `^(?:node:)?fs$`, or `"node:*"` for all Node core modules).
 * - A regex path pattern (e.g. `"^src/server/"`, `"\\.server\\.tsx?$"`).
 *
 * @param {ClientBoundaryOptions} options
 * @returns {import("dependency-cruiser").IForbiddenRuleType[]}
 */
function clientBoundary(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("clientBoundary: options object is required.");
  }
  const { serverModules, clientPattern = DEFAULT_CLIENT_PATTERN, name } = options;
  if (!Array.isArray(serverModules) || serverModules.length === 0) {
    throw new TypeError("clientBoundary: serverModules must be a non-empty array of strings.");
  }
  const ruleName = validateRuleName(name, "client-boundary", "clientBoundary");

  /** @type {string | string[]} */
  let normalizedClientPattern;
  if (typeof clientPattern === "string") {
    if (clientPattern.trim() === "") {
      throw new TypeError("clientBoundary: clientPattern must be a non-empty string or array of strings.");
    }
    assertValidRegex(clientPattern, "clientBoundary(clientPattern)");
    normalizedClientPattern = clientPattern;
  } else if (Array.isArray(clientPattern) && clientPattern.length > 0) {
    for (const p of clientPattern) {
      if (typeof p !== "string" || p.trim() === "") {
        throw new TypeError("clientBoundary: every entry in clientPattern must be a non-empty string.");
      }
      assertValidRegex(p, "clientBoundary(clientPattern)");
    }
    normalizedClientPattern = [...clientPattern];
  } else {
    throw new TypeError("clientBoundary: clientPattern must be a non-empty string or array of strings.");
  }

  /** @type {string[]} */
  const pathPatterns = [];

  for (const entry of serverModules) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new TypeError("clientBoundary: every entry in serverModules must be a non-empty string.");
    }
    if (entry === "node:*") {
      pathPatterns.push(NODE_CORE_PATTERN);
    } else if (entry.startsWith("node:")) {
      const builtin = entry.slice("node:".length);
      if (builtin === "") {
        throw new TypeError(`clientBoundary: invalid Node built-in specifier "${entry}".`);
      }
      pathPatterns.push(`^(?:node:)?${escapeRegex(builtin)}$`);
    } else if (MODULE_NAME.test(entry)) {
      pathPatterns.push(`^src/modules/${escapeRegex(entry)}(?:/|$)`);
    } else {
      assertValidRegex(entry, "clientBoundary(serverModules)");
      pathPatterns.push(entry);
    }
  }

  return [
    {
      name: ruleName,
      comment: "Client code can't import server-only modules (directly or transitively).",
      severity: "error",
      from: { path: normalizedClientPattern, pathNot: TEST },
      to: {
        path: pathPatterns,
        reachable: true,
      },
    },
  ];
}

/**
 * @typedef {{
 *   modules?: string[],
 *   name?: string,
 * }} DeepSubmodulesOptions
 */

/**
 * Enforce `src/modules/<mod>/<submod>/index.ts(x)` encapsulation when a large module
 * is split into submodules. Code outside `src/modules/<mod>/<submod>/` (including
 * the parent module's root files and sibling submodules) may import the submodule
 * only through its `index.ts(x)`.
 *
 * Omit `modules` to apply to every module under `src/modules/`.
 *
 * @param {DeepSubmodulesOptions} [options]
 * @returns {import("dependency-cruiser").IForbiddenRuleType[]}
 */
function deepSubmodules(options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("deepSubmodules: options must be an object when provided.");
  }
  const { modules, name } = options;
  const ruleName = validateRuleName(name, "deep-submodules", "deepSubmodules");
  const outsideRuleName = `${ruleName}-from-outside`;
  validateRuleName(outsideRuleName, outsideRuleName, "deepSubmodules");

  let modPattern = "[^/]+";
  if (modules !== undefined) {
    if (!Array.isArray(modules) || modules.length === 0) {
      throw new TypeError("deepSubmodules: modules must be a non-empty array of module names.");
    }
    for (const mod of modules) {
      if (typeof mod !== "string" || !MODULE_NAME.test(mod)) {
        throw new TypeError(
          `deepSubmodules: invalid module name "${String(mod)}". Expected a directory name under src/modules/ without slashes.`,
        );
      }
    }
    modPattern = `(?:${modules.map(escapeRegex).join("|")})`;
  }

  const subInternal = `^src/modules/${modPattern}/[^/]+/.`;
  const subEntry = `^src/modules/${modPattern}/[^/]+/(?:index|client)\\.tsx?$`;

  return [
    {
      name: ruleName,
      comment: "A submodule is used only through its index.ts(x) or client.ts(x). Import the submodule entrypoint, not a file inside it.",
      severity: "error",
      from: { path: `^src/modules/(${modPattern})/([^/]+)/` },
      to: {
        path: subInternal,
        pathNot: ["^src/modules/$1/$2/", subEntry],
      },
    },
    {
      name: outsideRuleName,
      comment: "Code outside a submodule uses it only through its index.ts(x) or client.ts(x).",
      severity: "error",
      from: { pathNot: `^src/modules/${modPattern}/[^/]+/` },
      to: {
        path: subInternal,
        pathNot: subEntry,
      },
    },
  ];
}

module.exports = {
  DEFAULT_CLIENT_PATTERN,
  clientBoundary,
  deepSubmodules,
};
