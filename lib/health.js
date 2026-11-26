// @ts-check
// Module health metrics for raw-stack projects: prod file count, prod LOC,
// index.ts export utilization (used by prod / test-only / unused), sibling
// module fan-out, and soft-threshold warnings.
import { parseSync } from "@swc/core";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/;
const PROD_EXT = /\.(?:[cm]?tsx?)$/;
const TEST_FILE = /\.test\.tsx?$/;
const DTS_FILE = /\.d\.ts$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "coverage", ".git"]);
const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_TO_TS_EXTS = {
  ".js": [".ts", ".tsx", ".d.ts", ".js"],
  ".jsx": [".tsx", ".ts", ".jsx"],
  ".mjs": [".mts", ".d.mts", ".mjs"],
  ".cjs": [".cts", ".d.cts", ".cjs"],
};

export const DEFAULT_THRESHOLDS = {
  maxProdFiles: 20,
  maxIndexExports: 25,
  maxSiblingFanOutRatio: 0.5,
  minSiblingsForFanOut: 2,
};

/**
 * @typedef {{
 *   maxProdFiles: number,
 *   maxIndexExports: number,
 *   maxSiblingFanOutRatio: number,
 *   minSiblingsForFanOut: number,
 * }} HealthThresholds
 */

/**
 * @typedef {{
 *   name: string,
 *   hasIndex: boolean,
 *   indexFile: string | null,
 *   prodFiles: number,
 *   prodLoc: number,
 *   exports: {
 *     total: number,
 *     usedByProd: string[],
 *     testOnly: string[],
 *     unused: string[],
 *   },
 *   siblingFanOut: {
 *     count: number,
 *     totalSiblings: number,
 *     ratio: number,
 *     percent: number,
 *     modules: string[],
 *   },
 * }} ModuleHealth
 */

/**
 * @typedef {{
 *   module: string,
 *   kind: "prod-files" | "index-exports" | "sibling-fan-out" | "unused-exports",
 *   message: string,
 * }} HealthWarning
 */

/**
 * @typedef {{
 *   ok: boolean,
 *   thresholds: HealthThresholds,
 *   modules: ModuleHealth[],
 *   warnings: HealthWarning[],
 * }} HealthReport
 */

/**
 * Normalize a path relative to root using POSIX separators.
 * @param {string} root
 * @param {string} absPath
 */
function toRel(root, absPath) {
  return relative(root, absPath).split("\\").join("/");
}

/**
 * Recursively list source files under `dir` (as POSIX paths relative to `root`).
 * @param {string} root
 * @param {string} dir
 * @returns {string[]}
 */
function walkSourceFiles(root, dir) {
  if (!existsSync(dir)) return [];
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkSourceFiles(root, full));
    } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
      out.push(toRel(root, full));
    }
  }
  return out.sort();
}

/** @param {string} relPath */
function isTestOrHelperFile(relPath) {
  return TEST_FILE.test(relPath) || relPath.startsWith("src/testing/") || relPath.startsWith("e2e/");
}

/** @param {string} relPath */
function isProdFile(relPath) {
  return (
    relPath.startsWith("src/") &&
    PROD_EXT.test(relPath) &&
    !DTS_FILE.test(relPath) &&
    !isTestOrHelperFile(relPath)
  );
}

/** @param {string} relPath @returns {string | null} */
function moduleOf(relPath) {
  const match = /^src\/modules\/([^/]+)\//.exec(relPath);
  return match ? match[1] ?? null : null;
}

/** @param {string} source */
function countLoc(source) {
  if (source.length === 0) return 0;
  return source.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

/**
 * Parse a JS/TS/TSX file with @swc/core.
 * @param {string} root
 * @param {string} relPath
 * @param {Map<string, any>} cache
 */
function parseFile(root, relPath, cache) {
  if (cache.has(relPath)) return cache.get(relPath);
  const abs = join(root, relPath);
  const source = readFileSync(abs, "utf8");
  const isTs = /\.[cm]?tsx?$/.test(relPath);
  const isJsx = relPath.endsWith(".tsx") || relPath.endsWith(".jsx");
  const ast = parseSync(
    source,
    isTs
      ? { syntax: "typescript", tsx: isJsx, decorators: true }
      : { syntax: "ecmascript", jsx: isJsx, decorators: true },
  );
  const entry = { ast, source };
  cache.set(relPath, entry);
  return entry;
}

/**
 * Resolve a relative import specifier from `fromRel` to a POSIX path relative to `root`.
 * Handles TypeScript `.js` -> `.ts`/`.tsx` extension mapping and directory `index.ts(x)`.
 * @param {string} root
 * @param {string} fromRel
 * @param {string} specifier
 * @returns {string | null}
 */
function resolveRelativeImport(root, fromRel, specifier) {
  if (!specifier.startsWith(".")) return null;
  const fromDir = dirname(join(root, fromRel));
  const raw = resolve(fromDir, specifier);

  // Exact file match
  if (existsSync(raw) && !isDirectory(raw)) {
    return toRel(root, raw);
  }

  // TypeScript .js/.jsx/.mjs/.cjs -> .ts/.tsx/.mts/.cts rewrite
  for (const [jsExt, candidates] of Object.entries(JS_TO_TS_EXTS)) {
    if (raw.endsWith(jsExt)) {
      const stem = raw.slice(0, -jsExt.length);
      for (const ext of candidates) {
        const candidate = stem + ext;
        if (existsSync(candidate) && !isDirectory(candidate)) {
          return toRel(root, candidate);
        }
      }
    }
  }

  // Extensionless file match
  for (const ext of RESOLVE_EXTS) {
    const candidate = raw + ext;
    if (existsSync(candidate) && !isDirectory(candidate)) {
      return toRel(root, candidate);
    }
  }

  // Directory index match
  if (existsSync(raw) && isDirectory(raw)) {
    for (const ext of RESOLVE_EXTS) {
      const candidate = join(raw, `index${ext}`);
      if (existsSync(candidate) && !isDirectory(candidate)) {
        return toRel(root, candidate);
      }
    }
  }

  return null;
}

/** @param {string} path */
function isDirectory(path) {
  try {
    return readdirSync(path), true;
  } catch {
    return false;
  }
}

/**
 * Extract bound identifier names from a JS/TS destructuring pattern.
 * @param {any} pattern
 * @param {Set<string>} names
 */
function collectPatternNames(pattern, names) {
  if (!pattern || typeof pattern !== "object") return;
  switch (pattern.type) {
    case "Identifier":
      if (typeof pattern.value === "string") names.add(pattern.value);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties ?? []) {
        if (prop.type === "KeyValuePatternProperty") {
          collectPatternNames(prop.value, names);
        } else if (prop.type === "AssignmentPatternProperty") {
          if (prop.key?.type === "Identifier") names.add(prop.key.value);
        } else if (prop.type === "RestElement") {
          collectPatternNames(prop.argument, names);
        }
      }
      break;
    case "ArrayPattern":
      for (const elem of pattern.elements ?? []) {
        collectPatternNames(elem, names);
      }
      break;
    case "RestElement":
      collectPatternNames(pattern.argument, names);
      break;
    case "AssignmentPattern":
      collectPatternNames(pattern.left, names);
      break;
    default:
      break;
  }
}

/**
 * Extract string name from an Identifier or StringLiteral AST node.
 * @param {any} node
 * @returns {string | null}
 */
function exportNameOf(node) {
  if (!node || typeof node !== "object") return null;
  if (node.type === "Identifier" || node.type === "StringLiteral") {
    return typeof node.value === "string" ? node.value : null;
  }
  return null;
}

/**
 * Collect all exported symbol names from `relPath`, following `export * from "..."`.
 * @param {string} root
 * @param {string} relPath
 * @param {Map<string, any>} astCache
 * @param {Set<string>} [seen]
 * @returns {Set<string>}
 */
function collectExports(root, relPath, astCache, seen = new Set()) {
  /** @type {Set<string>} */
  const exports = new Set();
  if (seen.has(relPath)) return exports;
  seen.add(relPath);

  const { ast } = parseFile(root, relPath, astCache);
  for (const item of ast.body ?? []) {
    switch (item.type) {
      case "ExportDeclaration": {
        const decl = item.declaration;
        if (!decl) break;
        if (
          decl.type === "FunctionDeclaration" ||
          decl.type === "ClassDeclaration"
        ) {
          if (decl.identifier?.value) exports.add(decl.identifier.value);
        } else if (
          decl.type === "TsTypeAliasDeclaration" ||
          decl.type === "TsInterfaceDeclaration" ||
          decl.type === "TsEnumDeclaration" ||
          decl.type === "TsModuleDeclaration"
        ) {
          const name = exportNameOf(decl.id);
          if (name) exports.add(name);
        } else if (decl.type === "VariableDeclaration") {
          for (const declarator of decl.declarations ?? []) {
            collectPatternNames(declarator.id, exports);
          }
        }
        break;
      }
      case "ExportDefaultDeclaration":
      case "ExportDefaultExpression":
        exports.add("default");
        break;
      case "ExportNamedDeclaration":
        for (const spec of item.specifiers ?? []) {
          if (spec.type === "ExportSpecifier") {
            const name = exportNameOf(spec.exported ?? spec.orig);
            if (name) exports.add(name);
          } else if (spec.type === "ExportNamespaceSpecifier") {
            const name = exportNameOf(spec.name);
            if (name) exports.add(name);
          } else if (spec.type === "ExportDefaultSpecifier") {
            const name = exportNameOf(spec.exported);
            if (name) exports.add(name);
          }
        }
        break;
      case "ExportAllDeclaration": {
        const specifier = item.source?.value;
        if (typeof specifier === "string") {
          const target = resolveRelativeImport(root, relPath, specifier);
          if (target) {
            for (const name of collectExports(root, target, astCache, seen)) {
              if (name !== "default") exports.add(name);
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }
  return exports;
}

/**
 * Walk an AST node recursively, calling `visitor(node, parent)` for every AST node object.
 * @param {any} node
 * @param {(node: any, parent: any) => void} visitor
 * @param {any} [parent]
 */
function walkAst(node, visitor, parent = null) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visitor, parent);
    return;
  }
  if (typeof node.type === "string") {
    visitor(node, parent);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === "span" || value === null || typeof value !== "object") continue;
    walkAst(value, visitor, node);
  }
}

/**
 * Collect property accesses on namespace import identifiers (`ns.foo`, `ns["foo"]`, `ns.MyType`,
 * or `const { a, b } = ns`), and detect opaque uses (`fn(ns)`, `{ ...ns }`) where all exports
 * must be treated as used.
 * @param {any} ast
 * @param {Set<string>} namespaceLocals
 * @returns {Map<string, { names: Set<string>, all: boolean }>}
 */
function analyzeNamespaceUsages(ast, namespaceLocals) {
  /** @type {Map<string, { names: Set<string>, all: boolean }>} */
  const result = new Map();
  for (const local of namespaceLocals) {
    result.set(local, { names: new Set(), all: false });
  }
  if (namespaceLocals.size === 0) return result;

  walkAst(ast, (node, parent) => {
    if (node.type === "MemberExpression" && node.object?.type === "Identifier" && namespaceLocals.has(node.object.value)) {
      const entry = result.get(node.object.value);
      if (!entry) return;
      if (node.property?.type === "Identifier") {
        entry.names.add(node.property.value);
      } else if (node.property?.type === "Computed" && node.property.expression?.type === "StringLiteral") {
        entry.names.add(node.property.expression.value);
      } else {
        entry.all = true;
      }
      return;
    }

    if (node.type === "TsQualifiedName" && node.left?.type === "Identifier" && namespaceLocals.has(node.left.value)) {
      const entry = result.get(node.left.value);
      if (entry && node.right?.type === "Identifier") {
        entry.names.add(node.right.value);
      }
      return;
    }

    if (
      node.type === "VariableDeclarator" &&
      node.init?.type === "Identifier" &&
      namespaceLocals.has(node.init.value) &&
      node.id?.type === "ObjectPattern"
    ) {
      const entry = result.get(node.init.value);
      if (!entry) return;
      for (const prop of node.id.properties ?? []) {
        if (prop.type === "KeyValuePatternProperty") {
          const key = exportNameOf(prop.key);
          if (key) entry.names.add(key);
          else entry.all = true;
        } else if (prop.type === "AssignmentPatternProperty" && prop.key?.type === "Identifier") {
          entry.names.add(prop.key.value);
        } else if (prop.type === "RestElement") {
          entry.all = true;
        }
      }
      return;
    }

    // Detect opaque identifier reference (e.g. passed to a function, spread, returned, reassigned)
    if (node.type === "Identifier" && namespaceLocals.has(node.value)) {
      if (!parent) return;
      // Ignore the ImportNamespaceSpecifier binding itself
      if (parent.type === "ImportNamespaceSpecifier") return;
      // Handled above as MemberExpression object
      if (parent.type === "MemberExpression" && parent.object === node) return;
      // Handled above as TsQualifiedName left
      if (parent.type === "TsQualifiedName" && parent.left === node) return;
      // Handled above as VariableDeclarator init with ObjectPattern
      if (parent.type === "VariableDeclarator" && parent.init === node && parent.id?.type === "ObjectPattern") return;
      // Property name (non-computed) like `{ ns: 1 }` or `obj.ns` is NOT a reference to the namespace
      if (parent.type === "MemberExpression" && parent.property === node) return;
      if (parent.type === "KeyValueProperty" && parent.key === node) return;
      if (parent.type === "TsPropertySignature" && parent.key === node) return;
      const entry = result.get(node.value);
      if (entry) entry.all = true;
    }
  });

  return result;
}

/**
 * Extract all relative imports / re-exports / dynamic imports from `relPath`.
 * @param {string} root
 * @param {string} relPath
 * @param {Map<string, any>} astCache
 * @returns {Array<{ target: string, names: Set<string>, all: boolean }>}
 */
function collectImports(root, relPath, astCache) {
  const { ast } = parseFile(root, relPath, astCache);
  /** @type {Array<{ target: string, names: Set<string>, all: boolean }>} */
  const records = [];
  /** @type {Map<string, { target: string, names: Set<string>, all: boolean }>} */
  const byTarget = new Map();

  /** @param {string} target */
  const getRecord = (target) => {
    let rec = byTarget.get(target);
    if (!rec) {
      rec = { target, names: new Set(), all: false };
      byTarget.set(target, rec);
      records.push(rec);
    }
    return rec;
  };

  /** @type {Map<string, string>} local namespace identifier -> resolved target */
  const nsTargets = new Map();

  for (const item of ast.body ?? []) {
    if (item.type === "ImportDeclaration") {
      const specifier = item.source?.value;
      if (typeof specifier !== "string") continue;
      const target = resolveRelativeImport(root, relPath, specifier);
      if (!target) continue;
      const rec = getRecord(target);
      for (const spec of item.specifiers ?? []) {
        if (spec.type === "ImportSpecifier") {
          const name = exportNameOf(spec.imported ?? spec.local);
          if (name) rec.names.add(name);
        } else if (spec.type === "ImportDefaultSpecifier") {
          rec.names.add("default");
        } else if (spec.type === "ImportNamespaceSpecifier" && spec.local?.value) {
          nsTargets.set(spec.local.value, target);
        }
      }
    } else if (item.type === "ExportNamedDeclaration" && item.source?.value) {
      const target = resolveRelativeImport(root, relPath, item.source.value);
      if (!target) continue;
      const rec = getRecord(target);
      for (const spec of item.specifiers ?? []) {
        if (spec.type === "ExportSpecifier") {
          const orig = exportNameOf(spec.orig);
          if (orig) rec.names.add(orig);
        } else if (spec.type === "ExportNamespaceSpecifier") {
          rec.all = true;
        } else if (spec.type === "ExportDefaultSpecifier") {
          rec.names.add("default");
        }
      }
    } else if (item.type === "ExportAllDeclaration" && item.source?.value) {
      const target = resolveRelativeImport(root, relPath, item.source.value);
      if (!target) continue;
      const rec = getRecord(target);
      rec.all = true;
    }
  }

  // Resolve namespace member usages
  if (nsTargets.size > 0) {
    const nsUsage = analyzeNamespaceUsages(ast, new Set(nsTargets.keys()));
    for (const [local, target] of nsTargets.entries()) {
      const usage = nsUsage.get(local);
      if (!usage) continue;
      const rec = getRecord(target);
      if (usage.all) {
        rec.all = true;
      } else {
        for (const name of usage.names) rec.names.add(name);
      }
    }
  }

  // Dynamic import("./...")
  walkAst(ast, (node) => {
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Import" &&
      node.arguments?.[0]?.expression?.type === "StringLiteral"
    ) {
      const specifier = node.arguments[0].expression.value;
      const target = resolveRelativeImport(root, relPath, specifier);
      if (target) {
        const rec = getRecord(target);
        rec.all = true;
      }
    }
  });

  return records;
}

/**
 * Find the module's entry file (`index.ts` or `index.tsx`), if present.
 * @param {string} root
 * @param {string} modName
 * @returns {string | null}
 */
function findModuleIndex(root, modName) {
  for (const candidate of [`src/modules/${modName}/index.ts`, `src/modules/${modName}/index.tsx`]) {
    if (existsSync(join(root, candidate))) return candidate;
  }
  return null;
}

/**
 * Analyze module health for a project rooted at `root`.
 * @param {string} root
 * @param {{ thresholds?: Partial<HealthThresholds> }} [options]
 * @returns {HealthReport}
 */
export function analyzeHealth(root, options = {}) {
  /** @type {HealthThresholds} */
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
  const modulesDir = join(root, "src", "modules");

  if (!existsSync(modulesDir)) {
    return { ok: true, thresholds, modules: [], warnings: [] };
  }

  const moduleNames = readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (moduleNames.length === 0) {
    return { ok: true, thresholds, modules: [], warnings: [] };
  }

  const allFiles = [
    ...walkSourceFiles(root, join(root, "src")),
    ...walkSourceFiles(root, join(root, "e2e")),
  ];
  /** @type {Map<string, any>} */
  const astCache = new Map();

  // Collect module index files and their exported symbols
  /** @type {Map<string, string | null>} */
  const moduleIndexByName = new Map();
  /** @type {Map<string, string>} index relPath -> module name */
  const moduleNameByIndex = new Map();
  /** @type {Map<string, string[]>} module name -> sorted export names */
  const moduleExports = new Map();

  for (const modName of moduleNames) {
    const indexFile = findModuleIndex(root, modName);
    moduleIndexByName.set(modName, indexFile);
    if (indexFile) {
      moduleNameByIndex.set(indexFile, modName);
      moduleExports.set(modName, [...collectExports(root, indexFile, astCache)].sort());
    } else {
      moduleExports.set(modName, []);
    }
  }

  // Track export usage across the whole project and sibling fan-out per module
  /** @type {Map<string, Set<string>>} */
  const prodUsed = new Map(moduleNames.map((m) => [m, new Set()]));
  /** @type {Map<string, boolean>} */
  const prodUsedAll = new Map(moduleNames.map((m) => [m, false]));
  /** @type {Map<string, Set<string>>} */
  const testUsed = new Map(moduleNames.map((m) => [m, new Set()]));
  /** @type {Map<string, boolean>} */
  const testUsedAll = new Map(moduleNames.map((m) => [m, false]));
  /** @type {Map<string, Set<string>>} */
  const siblingImports = new Map(moduleNames.map((m) => [m, new Set()]));
  /** @type {Map<string, number>} */
  const prodFileCounts = new Map(moduleNames.map((m) => [m, 0]));
  /** @type {Map<string, number>} */
  const prodLocCounts = new Map(moduleNames.map((m) => [m, 0]));

  for (const relPath of allFiles) {
    const fileProd = isProdFile(relPath);
    const fileTest = isTestOrHelperFile(relPath);
    const ownerMod = moduleOf(relPath);

    if (fileProd && ownerMod && prodFileCounts.has(ownerMod)) {
      prodFileCounts.set(ownerMod, (prodFileCounts.get(ownerMod) ?? 0) + 1);
      const source = readFileSync(join(root, relPath), "utf8");
      prodLocCounts.set(ownerMod, (prodLocCounts.get(ownerMod) ?? 0) + countLoc(source));
    }

    if (!fileProd && !fileTest) continue;

    const imports = collectImports(root, relPath, astCache);
    for (const imp of imports) {
      // Sibling fan-out: prod files inside module A importing anything in module B (B !== A)
      if (fileProd && ownerMod && siblingImports.has(ownerMod)) {
        const targetMod = moduleOf(imp.target);
        if (targetMod && targetMod !== ownerMod && siblingImports.has(targetMod)) {
          siblingImports.get(ownerMod)?.add(targetMod);
        }
      }

      // Export usage on a module's index file
      const targetMod = moduleNameByIndex.get(imp.target);
      if (!targetMod) continue;

      if (fileProd && ownerMod !== targetMod) {
        if (imp.all) {
          prodUsedAll.set(targetMod, true);
        } else {
          const set = prodUsed.get(targetMod);
          for (const name of imp.names) set?.add(name);
        }
      } else if (fileTest) {
        if (imp.all) {
          testUsedAll.set(targetMod, true);
        } else {
          const set = testUsed.get(targetMod);
          for (const name of imp.names) set?.add(name);
        }
      }
    }
  }

  const totalSiblings = Math.max(0, moduleNames.length - 1);
  /** @type {ModuleHealth[]} */
  const modules = [];
  /** @type {HealthWarning[]} */
  const warnings = [];

  for (const modName of moduleNames) {
    const indexFile = moduleIndexByName.get(modName) ?? null;
    const allExportNames = moduleExports.get(modName) ?? [];
    const prodSet = prodUsed.get(modName) ?? new Set();
    const prodAll = prodUsedAll.get(modName) ?? false;
    const testSet = testUsed.get(modName) ?? new Set();
    const testAll = testUsedAll.get(modName) ?? false;

    /** @type {string[]} */
    const usedByProd = [];
    /** @type {string[]} */
    const testOnly = [];
    /** @type {string[]} */
    const unused = [];

    for (const name of allExportNames) {
      if (prodAll || prodSet.has(name)) {
        usedByProd.push(name);
      } else if (testAll || testSet.has(name)) {
        testOnly.push(name);
      } else {
        unused.push(name);
      }
    }

    const siblings = [...(siblingImports.get(modName) ?? [])].sort();
    const ratio = totalSiblings > 0 ? Math.round((siblings.length / totalSiblings) * 1000) / 1000 : 0;
    const percent = totalSiblings > 0 ? Math.round((siblings.length / totalSiblings) * 100) : 0;
    const prodFiles = prodFileCounts.get(modName) ?? 0;
    const prodLoc = prodLocCounts.get(modName) ?? 0;

    /** @type {ModuleHealth} */
    const modHealth = {
      name: modName,
      hasIndex: indexFile !== null,
      indexFile,
      prodFiles,
      prodLoc,
      exports: {
        total: allExportNames.length,
        usedByProd,
        testOnly,
        unused,
      },
      siblingFanOut: {
        count: siblings.length,
        totalSiblings,
        ratio,
        percent,
        modules: siblings,
      },
    };
    modules.push(modHealth);

    if (prodFiles > thresholds.maxProdFiles) {
      warnings.push({
        module: modName,
        kind: "prod-files",
        message: `module "${modName}" has ${prodFiles} prod files (threshold: <= ${thresholds.maxProdFiles})`,
      });
    }
    if (allExportNames.length > thresholds.maxIndexExports) {
      warnings.push({
        module: modName,
        kind: "index-exports",
        message: `module "${modName}" has ${allExportNames.length} index exports (threshold: <= ${thresholds.maxIndexExports})`,
      });
    }
    if (totalSiblings >= thresholds.minSiblingsForFanOut && siblings.length / totalSiblings > thresholds.maxSiblingFanOutRatio) {
      warnings.push({
        module: modName,
        kind: "sibling-fan-out",
        message: `module "${modName}" imports ${siblings.length}/${totalSiblings} sibling modules (${percent}%, threshold: <= ${Math.round(thresholds.maxSiblingFanOutRatio * 100)}%)`,
      });
    }
    if (unused.length > 0) {
      warnings.push({
        module: modName,
        kind: "unused-exports",
        message: `module "${modName}" has ${unused.length} unused index export(s): ${unused.join(", ")}`,
      });
    }
  }

  return {
    ok: warnings.length === 0,
    thresholds,
    modules,
    warnings,
  };
}

/**
 * Format a HealthReport as a human-readable table + warnings summary.
 * @param {HealthReport} report
 * @returns {string}
 */
export function formatHealthReport(report) {
  if (report.modules.length === 0) {
    return "No modules found under src/modules/.";
  }

  const headers = ["Module", "Files", "LOC", "Exports", "Prod", "Test-only", "Unused", "Fan-out"];
  const rows = report.modules.map((m) => [
    m.name,
    String(m.prodFiles),
    String(m.prodLoc),
    m.hasIndex ? String(m.exports.total) : "-",
    m.hasIndex ? String(m.exports.usedByProd.length) : "-",
    m.hasIndex ? String(m.exports.testOnly.length) : "-",
    m.hasIndex ? String(m.exports.unused.length) : "-",
    `${m.siblingFanOut.count}/${m.siblingFanOut.totalSiblings} (${m.siblingFanOut.percent}%)`,
  ]);

  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const alignRight = [false, true, true, true, true, true, true, true];

  /** @param {string[]} cols */
  const formatRow = (cols) =>
    cols
      .map((val, i) => {
        const w = widths[i] ?? 0;
        return alignRight[i] ? val.padStart(w) : val.padEnd(w);
      })
      .join("  ");

  const lines = [
    formatRow(headers),
    widths.map((w) => "-".repeat(w)).join("  "),
    ...rows.map(formatRow),
    "",
  ];

  if (report.warnings.length === 0) {
    lines.push("No health warnings.");
  } else {
    lines.push(`Warnings (${report.warnings.length}):`);
    for (const w of report.warnings) {
      lines.push(`  - [${w.kind}] ${w.message}`);
    }
  }

  return lines.join("\n");
}
