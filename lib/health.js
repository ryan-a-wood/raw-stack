// @ts-check
// Module health metrics for raw-stack projects: per-unit prod file count & LOC
// (top-level modules and 1-level submodules counted independently), index.ts(x)
// and client.ts(x) export utilization (value vs signature-referenced type vs
// test-only vs unused), top-level sibling module fan-out, and strict checks.
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
  minSiblingsForFanOut: 6,
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
 *   total: number,
 *   usedByProd: string[],
 *   usedBySignature: string[],
 *   testOnly: string[],
 *   unused: string[],
 * }} ExportSummary
 */

/**
 * @typedef {{
 *   file: string,
 *   kind: "index" | "client",
 *   total: number,
 *   usedByProd: string[],
 *   usedBySignature: string[],
 *   testOnly: string[],
 *   unused: string[],
 * }} EntrypointHealth
 */

/**
 * @typedef {{
 *   count: number,
 *   totalSiblings: number,
 *   ratio: number,
 *   percent: number,
 *   modules: string[],
 * }} SiblingFanOut
 */

/**
 * @typedef {{
 *   name: string,
 *   isSubmodule: boolean,
 *   hasIndex: boolean,
 *   indexFile: string | null,
 *   hasClient: boolean,
 *   clientFile: string | null,
 *   prodFiles: number,
 *   prodLoc: number,
 *   exports: ExportSummary,
 *   clientExports: ExportSummary | null,
 *   entrypoints: EntrypointHealth[],
 *   siblingFanOut: SiblingFanOut | null,
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
 * @typedef {{
 *   name: string,
 *   kind: "value" | "type",
 *   origins: Array<{ file: string, name: string }>,
 * }} ExportSymbolInfo
 */

/**
 * @typedef {{
 *   localDecls: Map<string, Array<{ kind: "value" | "type", node: any }>>,
 *   localImports: Map<string, { target: string, origName: string, isNamespace: boolean, typeOnly: boolean }>,
 * }} FileSymbolInfo
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
  return (
    TEST_FILE.test(relPath) ||
    relPath.startsWith("src/testing/") ||
    relPath.startsWith("e2e/") ||
    relPath.startsWith("smoke/")
  );
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

/**
 * Top-level module name for a path under `src/modules/<mod>/...`.
 * @param {string} relPath
 * @returns {string | null}
 */
function moduleOf(relPath) {
  const match = /^src\/modules\/([^/]+)\//.exec(relPath);
  return match ? match[1] ?? null : null;
}

/**
 * Encapsulated unit name for a path under `src/modules/`:
 * - `src/modules/<mod>/<file>` -> `<mod>`
 * - `src/modules/<mod>/<submod>/<file>` (or deeper) -> `<mod>/<submod>`
 * @param {string} relPath
 * @returns {string | null}
 */
function unitOf(relPath) {
  const sub = /^src\/modules\/([^/]+)\/([^/]+)\//.exec(relPath);
  if (sub && sub[1] && sub[2]) return `${sub[1]}/${sub[2]}`;
  const top = /^src\/modules\/([^/]+)\/[^/]+$/.exec(relPath);
  if (top && top[1]) return top[1];
  return null;
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
 * Register a local declaration in `localDecls`.
 * @param {Map<string, Array<{ kind: "value" | "type", node: any }>>} localDecls
 * @param {string} name
 * @param {"value" | "type"} kind
 * @param {any} node
 */
function addLocalDecl(localDecls, name, kind, node) {
  let list = localDecls.get(name);
  if (!list) {
    list = [];
    localDecls.set(name, list);
  }
  list.push({ kind, node });
}

/**
 * Register a declaration AST node (top-level or inside `ExportDeclaration`).
 * @param {Map<string, Array<{ kind: "value" | "type", node: any }>>} localDecls
 * @param {any} decl
 */
function registerDeclaration(localDecls, decl) {
  if (!decl || typeof decl !== "object") return;
  if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
    if (decl.identifier?.value) addLocalDecl(localDecls, decl.identifier.value, "value", decl);
  } else if (decl.type === "TsInterfaceDeclaration" || decl.type === "TsTypeAliasDeclaration") {
    const name = exportNameOf(decl.id);
    if (name) addLocalDecl(localDecls, name, "type", decl);
  } else if (decl.type === "TsEnumDeclaration" || decl.type === "TsModuleDeclaration") {
    const name = exportNameOf(decl.id);
    if (name) addLocalDecl(localDecls, name, "value", decl);
  } else if (decl.type === "VariableDeclaration") {
    for (const declarator of decl.declarations ?? []) {
      /** @type {Set<string>} */
      const names = new Set();
      collectPatternNames(declarator.id, names);
      for (const name of names) addLocalDecl(localDecls, name, "value", declarator);
    }
  }
}

/**
 * Build and cache local declarations and relative imports for a file.
 * @param {string} root
 * @param {string} relPath
 * @param {Map<string, any>} astCache
 * @param {Map<string, FileSymbolInfo>} symbolCache
 * @returns {FileSymbolInfo}
 */
function analyzeFileSymbols(root, relPath, astCache, symbolCache) {
  const cached = symbolCache.get(relPath);
  if (cached) return cached;

  const { ast } = parseFile(root, relPath, astCache);
  /** @type {Map<string, Array<{ kind: "value" | "type", node: any }>>} */
  const localDecls = new Map();
  /** @type {Map<string, { target: string, origName: string, isNamespace: boolean, typeOnly: boolean }>} */
  const localImports = new Map();

  for (const item of ast.body ?? []) {
    if (item.type === "ImportDeclaration") {
      const specifier = item.source?.value;
      if (typeof specifier !== "string") continue;
      const target = resolveRelativeImport(root, relPath, specifier);
      if (!target) continue;
      for (const spec of item.specifiers ?? []) {
        if (spec.type === "ImportSpecifier" && spec.local?.value) {
          const origName = exportNameOf(spec.imported ?? spec.local);
          if (origName) {
            localImports.set(spec.local.value, {
              target,
              origName,
              isNamespace: false,
              typeOnly: Boolean(item.typeOnly || spec.isTypeOnly),
            });
          }
        } else if (spec.type === "ImportDefaultSpecifier" && spec.local?.value) {
          localImports.set(spec.local.value, {
            target,
            origName: "default",
            isNamespace: false,
            typeOnly: Boolean(item.typeOnly),
          });
        } else if (spec.type === "ImportNamespaceSpecifier" && spec.local?.value) {
          localImports.set(spec.local.value, {
            target,
            origName: "*",
            isNamespace: true,
            typeOnly: Boolean(item.typeOnly),
          });
        }
      }
    } else if (item.type === "ExportDeclaration") {
      registerDeclaration(localDecls, item.declaration);
    } else if (item.type === "ExportDefaultDeclaration") {
      const decl = item.decl;
      if (decl?.type === "TsInterfaceDeclaration") {
        addLocalDecl(localDecls, "default", "type", decl);
        const name = exportNameOf(decl.id);
        if (name) addLocalDecl(localDecls, name, "type", decl);
      } else if (decl) {
        addLocalDecl(localDecls, "default", "value", decl);
        if (decl.identifier?.value) addLocalDecl(localDecls, decl.identifier.value, "value", decl);
      }
    } else if (item.type === "ExportDefaultExpression") {
      addLocalDecl(localDecls, "default", "value", item.expression);
    } else {
      registerDeclaration(localDecls, item);
    }
  }

  const info = { localDecls, localImports };
  symbolCache.set(relPath, info);
  return info;
}

/**
 * Merge an exported symbol entry into `exports` (preserving `"value"` over `"type"` on declaration merging).
 * @param {Map<string, ExportSymbolInfo>} exports
 * @param {string} name
 * @param {"value" | "type"} kind
 * @param {Array<{ file: string, name: string }>} origins
 */
function mergeExportSymbol(exports, name, kind, origins) {
  const existing = exports.get(name);
  if (!existing) {
    exports.set(name, { name, kind, origins: [...origins] });
    return;
  }
  if (kind === "value") existing.kind = "value";
  for (const origin of origins) {
    if (!existing.origins.some((o) => o.file === origin.file && o.name === origin.name)) {
      existing.origins.push(origin);
    }
  }
}

/**
 * Collect all exported symbols from `relPath` with value/type kind and origin declarations,
 * following re-exports (`export { ... } from`, `export * from`).
 * @param {string} root
 * @param {string} relPath
 * @param {Map<string, any>} astCache
 * @param {Map<string, FileSymbolInfo>} symbolCache
 * @param {Map<string, Map<string, ExportSymbolInfo>>} exportCache
 * @param {Set<string>} [seen]
 * @returns {Map<string, ExportSymbolInfo>}
 */
function collectExportSymbols(root, relPath, astCache, symbolCache, exportCache, seen = new Set()) {
  const cached = exportCache.get(relPath);
  if (cached) return cached;
  /** @type {Map<string, ExportSymbolInfo>} */
  const exports = new Map();
  if (seen.has(relPath)) return exports;
  const nextSeen = new Set(seen);
  nextSeen.add(relPath);

  const { ast } = parseFile(root, relPath, astCache);
  const fileInfo = analyzeFileSymbols(root, relPath, astCache, symbolCache);

  for (const item of ast.body ?? []) {
    switch (item.type) {
      case "ExportDeclaration": {
        const decl = item.declaration;
        if (!decl) break;
        if (decl.type === "FunctionDeclaration" || decl.type === "ClassDeclaration") {
          if (decl.identifier?.value) {
            mergeExportSymbol(exports, decl.identifier.value, "value", [{ file: relPath, name: decl.identifier.value }]);
          }
        } else if (decl.type === "TsTypeAliasDeclaration" || decl.type === "TsInterfaceDeclaration") {
          const name = exportNameOf(decl.id);
          if (name) mergeExportSymbol(exports, name, "type", [{ file: relPath, name }]);
        } else if (decl.type === "TsEnumDeclaration" || decl.type === "TsModuleDeclaration") {
          const name = exportNameOf(decl.id);
          if (name) mergeExportSymbol(exports, name, "value", [{ file: relPath, name }]);
        } else if (decl.type === "VariableDeclaration") {
          for (const declarator of decl.declarations ?? []) {
            /** @type {Set<string>} */
            const names = new Set();
            collectPatternNames(declarator.id, names);
            for (const name of names) {
              mergeExportSymbol(exports, name, "value", [{ file: relPath, name }]);
            }
          }
        }
        break;
      }
      case "ExportDefaultDeclaration": {
        const isIface = item.decl?.type === "TsInterfaceDeclaration";
        mergeExportSymbol(exports, "default", isIface ? "type" : "value", [{ file: relPath, name: "default" }]);
        break;
      }
      case "ExportDefaultExpression": {
        /** @type {Array<{ file: string, name: string }>} */
        let origins = [{ file: relPath, name: "default" }];
        if (item.expression?.type === "Identifier") {
          const localName = item.expression.value;
          if (fileInfo.localDecls.has(localName)) {
            origins = [{ file: relPath, name: localName }];
          } else if (fileInfo.localImports.has(localName)) {
            const imp = fileInfo.localImports.get(localName);
            if (imp && !imp.isNamespace) {
              const targetExports = collectExportSymbols(root, imp.target, astCache, symbolCache, exportCache, nextSeen);
              const sym = targetExports.get(imp.origName);
              origins = sym?.origins.length ? sym.origins : [{ file: imp.target, name: imp.origName }];
            }
          }
        }
        mergeExportSymbol(exports, "default", "value", origins);
        break;
      }
      case "ExportNamedDeclaration": {
        if (item.source?.value) {
          const target = resolveRelativeImport(root, relPath, item.source.value);
          const targetExports = target
            ? collectExportSymbols(root, target, astCache, symbolCache, exportCache, nextSeen)
            : null;
          for (const spec of item.specifiers ?? []) {
            if (spec.type === "ExportSpecifier") {
              const origName = exportNameOf(spec.orig);
              const expName = exportNameOf(spec.exported ?? spec.orig);
              if (!origName || !expName) continue;
              const targetSym = targetExports?.get(origName);
              const isType = Boolean(item.typeOnly || spec.isTypeOnly) || targetSym?.kind === "type";
              const origins = targetSym?.origins.length
                ? targetSym.origins
                : target
                  ? [{ file: target, name: origName }]
                  : [];
              mergeExportSymbol(exports, expName, isType ? "type" : "value", origins);
            } else if (spec.type === "ExportNamespaceSpecifier") {
              const expName = exportNameOf(spec.name);
              if (expName) mergeExportSymbol(exports, expName, item.typeOnly ? "type" : "value", []);
            } else if (spec.type === "ExportDefaultSpecifier") {
              const expName = exportNameOf(spec.exported);
              if (!expName) continue;
              const targetSym = targetExports?.get("default");
              const isType = Boolean(item.typeOnly) || targetSym?.kind === "type";
              const origins = targetSym?.origins.length
                ? targetSym.origins
                : target
                  ? [{ file: target, name: "default" }]
                  : [];
              mergeExportSymbol(exports, expName, isType ? "type" : "value", origins);
            }
          }
        } else {
          for (const spec of item.specifiers ?? []) {
            if (spec.type !== "ExportSpecifier") continue;
            const origName = exportNameOf(spec.orig);
            const expName = exportNameOf(spec.exported ?? spec.orig);
            if (!origName || !expName) continue;
            const localDecls = fileInfo.localDecls.get(origName);
            const localImp = fileInfo.localImports.get(origName);
            if (localDecls && localDecls.length > 0) {
              const hasValue = localDecls.some((d) => d.kind === "value");
              const isType = Boolean(item.typeOnly || spec.isTypeOnly) || !hasValue;
              mergeExportSymbol(exports, expName, isType ? "type" : "value", [{ file: relPath, name: origName }]);
            } else if (localImp) {
              if (localImp.isNamespace) {
                const isType = Boolean(item.typeOnly || spec.isTypeOnly || localImp.typeOnly);
                mergeExportSymbol(exports, expName, isType ? "type" : "value", []);
              } else {
                const targetExports = collectExportSymbols(root, localImp.target, astCache, symbolCache, exportCache, nextSeen);
                const targetSym = targetExports.get(localImp.origName);
                const isType = Boolean(item.typeOnly || spec.isTypeOnly || localImp.typeOnly) || targetSym?.kind === "type";
                const origins = targetSym?.origins.length
                  ? targetSym.origins
                  : [{ file: localImp.target, name: localImp.origName }];
                mergeExportSymbol(exports, expName, isType ? "type" : "value", origins);
              }
            } else {
              const isType = Boolean(item.typeOnly || spec.isTypeOnly);
              mergeExportSymbol(exports, expName, isType ? "type" : "value", [{ file: relPath, name: origName }]);
            }
          }
        }
        break;
      }
      case "ExportAllDeclaration": {
        const specifier = item.source?.value;
        if (typeof specifier === "string") {
          const target = resolveRelativeImport(root, relPath, specifier);
          if (target) {
            const targetExports = collectExportSymbols(root, target, astCache, symbolCache, exportCache, nextSeen);
            for (const [name, sym] of targetExports.entries()) {
              if (name === "default") continue;
              const kind = item.typeOnly ? "type" : sym.kind;
              mergeExportSymbol(exports, name, kind, sym.origins);
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  // Only cache when not inside a cycle-truncated call
  if (seen.size === 0) exportCache.set(relPath, exports);
  return exports;
}

/**
 * Collect parameter type annotations from an array of SWC function/method/constructor parameters.
 * @param {any[]} params
 * @param {any[]} out
 */
function collectParamTypeSubtrees(params, out) {
  for (const p of params ?? []) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "Parameter") {
      if (p.pat) collectPatternTypeAnnotations(p.pat, out);
    } else if (p.type === "TsParameterProperty") {
      if (p.param) collectPatternTypeAnnotations(p.param, out);
    } else {
      collectPatternTypeAnnotations(p, out);
    }
  }
}

/**
 * Collect type annotations attached to a parameter/destructuring pattern.
 * @param {any} pat
 * @param {any[]} out
 */
function collectPatternTypeAnnotations(pat, out) {
  if (!pat || typeof pat !== "object") return;
  if (pat.typeAnnotation) out.push(pat.typeAnnotation);
  if (pat.type === "AssignmentPattern" && pat.left) {
    collectPatternTypeAnnotations(pat.left, out);
  } else if (pat.type === "RestElement" && pat.argument) {
    collectPatternTypeAnnotations(pat.argument, out);
  }
}

/**
 * Collect type parameter names declared by a TsTypeParameterDeclaration so they aren't
 * confused with outer exported types of the same name.
 * @param {any} tpDecl
 * @param {Set<string>} bound
 */
function collectBoundTypeParams(tpDecl, bound) {
  for (const param of tpDecl?.parameters ?? []) {
    if (param?.name?.value) bound.add(param.name.value);
  }
}

/**
 * Extract the leftmost identifier and optional immediate member name from a TsQualifiedName.
 * @param {any} qname
 * @returns {{ localName: string, memberName: string | null } | null}
 */
function splitQualifiedName(qname) {
  /** @type {string[]} */
  const parts = [];
  let cur = qname;
  while (cur && cur.type === "TsQualifiedName") {
    if (cur.right?.type === "Identifier") parts.unshift(cur.right.value);
    cur = cur.left;
  }
  if (cur?.type === "Identifier") {
    return { localName: cur.value, memberName: parts[0] ?? null };
  }
  return null;
}

/**
 * Collect all type/symbol references appearing in the public signature of a declaration AST node.
 * @param {any} declNode
 * @returns {Array<{ localName: string, memberName: string | null }>}
 */
function extractDeclSignatureRefs(declNode) {
  /** @type {any[]} */
  const subtrees = [];
  /** @type {Set<string>} */
  const bound = new Set();
  /** @type {Array<{ localName: string, memberName: string | null }>} */
  const refs = [];

  /** @param {any} fn */
  const collectFunctionSig = (fn) => {
    if (!fn) return;
    if (fn.typeParameters) {
      collectBoundTypeParams(fn.typeParameters, bound);
      subtrees.push(fn.typeParameters);
    }
    collectParamTypeSubtrees(fn.params, subtrees);
    if (fn.returnType) subtrees.push(fn.returnType);
  };

  /** @param {any} expr */
  const collectExprSig = (expr) => {
    if (!expr || typeof expr !== "object") return;
    if (expr.type === "ArrowFunctionExpression" || expr.type === "FunctionExpression") {
      collectFunctionSig(expr);
    } else if (expr.type === "ClassExpression") {
      collectClassSig(expr);
    } else if (expr.type === "ObjectExpression") {
      for (const prop of expr.properties ?? []) {
        if (!prop || typeof prop !== "object") continue;
        if (prop.type === "MethodProperty") {
          collectFunctionSig(prop);
        } else if (prop.type === "KeyValueProperty") {
          collectExprSig(prop.value);
        } else if (prop.type === "GetterProperty") {
          if (prop.typeAnnotation) subtrees.push(prop.typeAnnotation);
          if (prop.function) collectFunctionSig(prop.function);
        } else if (prop.type === "SetterProperty") {
          if (prop.param) collectPatternTypeAnnotations(prop.param, subtrees);
          if (prop.function) collectFunctionSig(prop.function);
        } else if (prop.type === "Identifier" && typeof prop.value === "string") {
          refs.push({ localName: prop.value, memberName: null });
        } else if (prop.type === "SpreadElement") {
          collectExprSig(prop.arguments);
        }
      }
    } else if (expr.type === "TsAsExpression" || expr.type === "TsSatisfiesExpression" || expr.type === "TsTypeAssertion") {
      if (expr.typeAnnotation) subtrees.push(expr.typeAnnotation);
      collectExprSig(expr.expression);
    } else if (expr.type === "TsInstantiation") {
      if (expr.typeArguments) subtrees.push(expr.typeArguments);
      collectExprSig(expr.expression);
    } else if (expr.type === "CallExpression") {
      if (expr.typeArguments) subtrees.push(expr.typeArguments);
    } else if (expr.type === "ParenthesisExpression") {
      collectExprSig(expr.expression);
    } else if (expr.type === "Identifier") {
      refs.push({ localName: expr.value, memberName: null });
    } else if (
      expr.type === "MemberExpression" &&
      expr.object?.type === "Identifier" &&
      expr.property?.type === "Identifier"
    ) {
      refs.push({ localName: expr.object.value, memberName: expr.property.value });
    }
  };

  /** @param {any} cls */
  const collectClassSig = (cls) => {
    if (!cls) return;
    if (cls.typeParams) {
      collectBoundTypeParams(cls.typeParams, bound);
      subtrees.push(cls.typeParams);
    }
    if (cls.superClass) collectExprSig(cls.superClass);
    if (cls.superTypeParams) subtrees.push(cls.superTypeParams);
    if (cls.implements) subtrees.push(cls.implements);
    for (const member of cls.body ?? []) {
      if (!member || member.accessibility === "private" || member.type === "PrivateProperty" || member.type === "PrivateMethod") {
        continue;
      }
      if (member.type === "ClassProperty") {
        if (member.typeAnnotation) subtrees.push(member.typeAnnotation);
      } else if (member.type === "ClassMethod") {
        collectFunctionSig(member.function);
      } else if (member.type === "Constructor") {
        collectParamTypeSubtrees(member.params, subtrees);
      }
    }
  };

  if (!declNode || typeof declNode !== "object") return refs;

  switch (declNode.type) {
    case "TsInterfaceDeclaration":
      if (declNode.typeParams) {
        collectBoundTypeParams(declNode.typeParams, bound);
        subtrees.push(declNode.typeParams);
      }
      if (declNode.extends) subtrees.push(declNode.extends);
      if (declNode.body) subtrees.push(declNode.body);
      break;
    case "TsTypeAliasDeclaration":
      if (declNode.typeParams) {
        collectBoundTypeParams(declNode.typeParams, bound);
        subtrees.push(declNode.typeParams);
      }
      if (declNode.typeAnnotation) subtrees.push(declNode.typeAnnotation);
      break;
    case "FunctionDeclaration":
    case "FunctionExpression":
    case "ArrowFunctionExpression":
      collectFunctionSig(declNode);
      break;
    case "ClassDeclaration":
    case "ClassExpression":
      collectClassSig(declNode);
      break;
    case "VariableDeclarator":
      if (declNode.id) collectPatternTypeAnnotations(declNode.id, subtrees);
      if (declNode.init) collectExprSig(declNode.init);
      break;
    default:
      collectExprSig(declNode);
      break;
  }

  for (const tree of subtrees) {
    walkAst(tree, (node) => {
      if (node.type === "TsTypeReference") {
        if (node.typeName?.type === "Identifier") {
          refs.push({ localName: node.typeName.value, memberName: null });
        } else if (node.typeName?.type === "TsQualifiedName") {
          const split = splitQualifiedName(node.typeName);
          if (split) refs.push(split);
        }
      } else if (node.type === "TsExpressionWithTypeArguments") {
        if (node.expression?.type === "Identifier") {
          refs.push({ localName: node.expression.value, memberName: null });
        }
      } else if (node.type === "TsTypeQuery") {
        if (node.exprName?.type === "Identifier") {
          refs.push({ localName: node.exprName.value, memberName: null });
        } else if (node.exprName?.type === "TsQualifiedName") {
          const split = splitQualifiedName(node.exprName);
          if (split) refs.push(split);
        }
      }
    });
  }

  return refs.filter((r) => !bound.has(r.localName));
}

/**
 * Determine which exported type symbols of an entrypoint are transitively referenced
 * in the public signature of any `usedByProd` export of that same entrypoint.
 * @param {string} root
 * @param {Map<string, ExportSymbolInfo>} exportSymbols
 * @param {Set<string>} usedByProdNames
 * @param {Map<string, any>} astCache
 * @param {Map<string, FileSymbolInfo>} symbolCache
 * @param {Map<string, Map<string, ExportSymbolInfo>>} exportCache
 * @returns {Set<string>}
 */
function findSignatureReferencedTypes(root, exportSymbols, usedByProdNames, astCache, symbolCache, exportCache) {
  /** @type {Map<string, Set<string>>} canonical "file::name" -> exported type names */
  const exportedTypesByOrigin = new Map();
  for (const [expName, sym] of exportSymbols.entries()) {
    if (sym.kind !== "type" || usedByProdNames.has(expName)) continue;
    for (const origin of sym.origins) {
      const key = `${origin.file}::${origin.name}`;
      let set = exportedTypesByOrigin.get(key);
      if (!set) {
        set = new Set();
        exportedTypesByOrigin.set(key, set);
      }
      set.add(expName);
    }
  }

  /** @type {Set<string>} */
  const signatureUsed = new Set();
  if (exportedTypesByOrigin.size === 0 || usedByProdNames.size === 0) return signatureUsed;

  /** @type {Array<{ file: string, name: string }>} */
  const queue = [];
  for (const expName of usedByProdNames) {
    const sym = exportSymbols.get(expName);
    if (!sym) continue;
    for (const origin of sym.origins) queue.push(origin);
  }

  /** @type {Set<string>} */
  const visited = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const key = `${current.file}::${current.name}`;
    if (visited.has(key)) continue;
    visited.add(key);

    if (!current.file.startsWith("src/")) continue;
    let fileInfo;
    try {
      fileInfo = analyzeFileSymbols(root, current.file, astCache, symbolCache);
    } catch {
      continue;
    }

    const decls = fileInfo.localDecls.get(current.name) ?? [];
    for (const decl of decls) {
      const refs = extractDeclSignatureRefs(decl.node);
      for (const ref of refs) {
        /** @type {Array<{ file: string, name: string }>} */
        const targets = [];
        if (fileInfo.localDecls.has(ref.localName)) {
          targets.push({ file: current.file, name: ref.localName });
        } else if (fileInfo.localImports.has(ref.localName)) {
          const imp = fileInfo.localImports.get(ref.localName);
          if (imp) {
            if (imp.isNamespace && ref.memberName) {
              const targetExports = collectExportSymbols(root, imp.target, astCache, symbolCache, exportCache);
              const sym = targetExports.get(ref.memberName);
              if (sym?.origins.length) targets.push(...sym.origins);
              else targets.push({ file: imp.target, name: ref.memberName });
            } else if (!imp.isNamespace) {
              const targetExports = collectExportSymbols(root, imp.target, astCache, symbolCache, exportCache);
              const sym = targetExports.get(imp.origName);
              if (sym?.origins.length) targets.push(...sym.origins);
              else targets.push({ file: imp.target, name: imp.origName });
            }
          }
        }

        for (const target of targets) {
          const targetKey = `${target.file}::${target.name}`;
          const matchedTypes = exportedTypesByOrigin.get(targetKey);
          if (matchedTypes) {
            for (const typeName of matchedTypes) signatureUsed.add(typeName);
          }
          if (!visited.has(targetKey)) {
            queue.push(target);
          }
        }
      }
    }
  }

  return signatureUsed;
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
      if (parent.type === "ImportNamespaceSpecifier") return;
      if (parent.type === "MemberExpression" && parent.object === node) return;
      if (parent.type === "TsQualifiedName" && parent.left === node) return;
      if (parent.type === "VariableDeclarator" && parent.init === node && parent.id?.type === "ObjectPattern") return;
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
 * Find an entrypoint file (`index.ts(x)` or `client.ts(x)`) inside `unitDir` (relative to `root`).
 * @param {string} root
 * @param {string} unitDir
 * @param {"index" | "client"} kind
 * @returns {string | null}
 */
function findEntrypoint(root, unitDir, kind) {
  for (const candidate of [`${unitDir}/${kind}.ts`, `${unitDir}/${kind}.tsx`]) {
    if (existsSync(join(root, candidate))) return candidate;
  }
  return null;
}

/** @returns {ExportSummary} */
function emptyExportSummary() {
  return { total: 0, usedByProd: [], usedBySignature: [], testOnly: [], unused: [] };
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

  const topModuleNames = readdirSync(modulesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (topModuleNames.length === 0) {
    return { ok: true, thresholds, modules: [], warnings: [] };
  }

  /** @type {Array<{ name: string, topModule: string, isSubmodule: boolean, dir: string }>} */
  const units = [];
  for (const modName of topModuleNames) {
    const modDir = `src/modules/${modName}`;
    units.push({ name: modName, topModule: modName, isSubmodule: false, dir: modDir });
    const subNames = readdirSync(join(root, modDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !SKIP_DIRS.has(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const subName of subNames) {
      units.push({
        name: `${modName}/${subName}`,
        topModule: modName,
        isSubmodule: true,
        dir: `${modDir}/${subName}`,
      });
    }
  }

  const allFiles = [
    ...walkSourceFiles(root, join(root, "src")),
    ...walkSourceFiles(root, join(root, "e2e")),
  ];
  /** @type {Map<string, any>} */
  const astCache = new Map();
  /** @type {Map<string, FileSymbolInfo>} */
  const symbolCache = new Map();
  /** @type {Map<string, Map<string, ExportSymbolInfo>>} */
  const exportCache = new Map();

  // Discover entrypoints (index.ts(x) and client.ts(x)) per unit and collect their export symbols
  /** @type {Map<string, { unitName: string, topModule: string, isSubmodule: boolean, kind: "index" | "client", file: string, symbols: Map<string, ExportSymbolInfo> }>} */
  const entrypointByPath = new Map();
  /** @type {Map<string, { indexFile: string | null, clientFile: string | null }>} */
  const unitEntryFiles = new Map();

  for (const unit of units) {
    const indexFile = findEntrypoint(root, unit.dir, "index");
    const clientFile = findEntrypoint(root, unit.dir, "client");
    unitEntryFiles.set(unit.name, { indexFile, clientFile });
    for (const [kind, file] of /** @type {Array<["index" | "client", string | null]>} */ ([
      ["index", indexFile],
      ["client", clientFile],
    ])) {
      if (!file) continue;
      const symbols = collectExportSymbols(root, file, astCache, symbolCache, exportCache);
      entrypointByPath.set(file, {
        unitName: unit.name,
        topModule: unit.topModule,
        isSubmodule: unit.isSubmodule,
        kind,
        file,
        symbols,
      });
    }
  }

  // Track export usage per entrypoint file, sibling fan-out per top-level module, and prod files/LOC per unit
  /** @type {Map<string, Set<string>>} */
  const prodUsed = new Map([...entrypointByPath.keys()].map((f) => [f, new Set()]));
  /** @type {Map<string, boolean>} */
  const prodUsedAll = new Map([...entrypointByPath.keys()].map((f) => [f, false]));
  /** @type {Map<string, Set<string>>} */
  const testUsed = new Map([...entrypointByPath.keys()].map((f) => [f, new Set()]));
  /** @type {Map<string, boolean>} */
  const testUsedAll = new Map([...entrypointByPath.keys()].map((f) => [f, false]));
  /** @type {Map<string, Set<string>>} top-level module -> imported sibling top-level modules */
  const siblingImports = new Map(topModuleNames.map((m) => [m, new Set()]));
  /** @type {Map<string, number>} unit name -> prod file count */
  const prodFileCounts = new Map(units.map((u) => [u.name, 0]));
  /** @type {Map<string, number>} unit name -> prod LOC */
  const prodLocCounts = new Map(units.map((u) => [u.name, 0]));

  for (const relPath of allFiles) {
    const fileProd = isProdFile(relPath);
    const fileTest = isTestOrHelperFile(relPath);
    const ownerTopMod = moduleOf(relPath);
    const ownerUnit = unitOf(relPath);

    if (fileProd && ownerUnit && prodFileCounts.has(ownerUnit)) {
      prodFileCounts.set(ownerUnit, (prodFileCounts.get(ownerUnit) ?? 0) + 1);
      const source = readFileSync(join(root, relPath), "utf8");
      prodLocCounts.set(ownerUnit, (prodLocCounts.get(ownerUnit) ?? 0) + countLoc(source));
    }

    if (!fileProd && !fileTest) continue;

    const imports = collectImports(root, relPath, astCache);
    for (const imp of imports) {
      // Sibling fan-out: evaluated at the top-level module across all its files (including submodules)
      if (fileProd && ownerTopMod && siblingImports.has(ownerTopMod)) {
        const targetTopMod = moduleOf(imp.target);
        if (targetTopMod && targetTopMod !== ownerTopMod && siblingImports.has(targetTopMod)) {
          siblingImports.get(ownerTopMod)?.add(targetTopMod);
        }
      }

      // Export usage on an entrypoint file (index.ts(x) or client.ts(x))
      const ep = entrypointByPath.get(imp.target);
      if (!ep) continue;

      const isExternalProd = fileProd && (ep.isSubmodule ? ownerUnit !== ep.unitName : ownerTopMod !== ep.topModule);
      if (isExternalProd) {
        if (imp.all) {
          prodUsedAll.set(ep.file, true);
        } else {
          const set = prodUsed.get(ep.file);
          for (const name of imp.names) set?.add(name);
        }
      } else if (fileTest) {
        if (imp.all) {
          testUsedAll.set(ep.file, true);
        } else {
          const set = testUsed.get(ep.file);
          for (const name of imp.names) set?.add(name);
        }
      }
    }
  }

  const totalSiblings = Math.max(0, topModuleNames.length - 1);
  /** @type {ModuleHealth[]} */
  const modules = [];
  /** @type {HealthWarning[]} */
  const warnings = [];

  for (const unit of units) {
    const { indexFile, clientFile } = unitEntryFiles.get(unit.name) ?? { indexFile: null, clientFile: null };
    const unitLabel = unit.isSubmodule ? `submodule "${unit.name}"` : `module "${unit.name}"`;

    /** @type {EntrypointHealth[]} */
    const entrypoints = [];
    /** @type {ExportSummary} */
    let indexSummary = emptyExportSummary();
    /** @type {ExportSummary | null} */
    let clientSummary = null;

    for (const epFile of [indexFile, clientFile]) {
      if (!epFile) continue;
      const ep = entrypointByPath.get(epFile);
      if (!ep) continue;

      const allExportNames = [...ep.symbols.keys()].sort();
      const prodSet = prodUsed.get(epFile) ?? new Set();
      const prodAll = prodUsedAll.get(epFile) ?? false;
      const testSet = testUsed.get(epFile) ?? new Set();
      const testAll = testUsedAll.get(epFile) ?? false;

      /** @type {Set<string>} */
      const usedByProdSet = new Set();
      for (const name of allExportNames) {
        if (prodAll || prodSet.has(name)) usedByProdSet.add(name);
      }

      const signatureUsedSet = findSignatureReferencedTypes(
        root,
        ep.symbols,
        usedByProdSet,
        astCache,
        symbolCache,
        exportCache,
      );

      /** @type {string[]} */
      const usedByProd = [];
      /** @type {string[]} */
      const usedBySignature = [];
      /** @type {string[]} */
      const testOnly = [];
      /** @type {string[]} */
      const unused = [];

      for (const name of allExportNames) {
        if (usedByProdSet.has(name)) {
          usedByProd.push(name);
        } else if (signatureUsedSet.has(name)) {
          usedBySignature.push(name);
        } else if (testAll || testSet.has(name)) {
          testOnly.push(name);
        } else {
          unused.push(name);
        }
      }

      /** @type {ExportSummary} */
      const summary = {
        total: allExportNames.length,
        usedByProd,
        usedBySignature,
        testOnly,
        unused,
      };
      if (ep.kind === "index") indexSummary = summary;
      else clientSummary = summary;

      entrypoints.push({
        file: ep.file,
        kind: ep.kind,
        ...summary,
      });

      if (allExportNames.length > thresholds.maxIndexExports) {
        warnings.push({
          module: unit.name,
          kind: "index-exports",
          message: `${unitLabel} (${ep.file}) has ${allExportNames.length} exports (threshold: <= ${thresholds.maxIndexExports}). Narrow the public interface or split into 1-level submodules.`,
        });
      }

      if (unused.length > 0 || testOnly.length > 0) {
        let message;
        if (unused.length > 0 && testOnly.length > 0) {
          message = `${unitLabel} (${ep.file}) has ${unused.length + testOnly.length} unused/test-only export(s) (unused: ${unused.join(", ")}; test-only: ${testOnly.join(", ")}). Remove unused exports from the entrypoint; test pure internal helpers directly from *.property.test.ts(x) inside the module.`;
        } else if (testOnly.length > 0) {
          message = `${unitLabel} (${ep.file}) has ${testOnly.length} test-only export(s) with no external prod importers: ${testOnly.join(", ")}. Remove them from the entrypoint; test pure internal helpers directly from *.property.test.ts(x) inside the module.`;
        } else {
          message = `${unitLabel} (${ep.file}) has ${unused.length} unused export(s): ${unused.join(", ")}. Remove unused exports or keep internal helpers unexported.`;
        }
        warnings.push({
          module: unit.name,
          kind: "unused-exports",
          message,
        });
      }
    }

    const prodFiles = prodFileCounts.get(unit.name) ?? 0;
    const prodLoc = prodLocCounts.get(unit.name) ?? 0;

    /** @type {SiblingFanOut | null} */
    let siblingFanOut = null;
    if (!unit.isSubmodule) {
      const siblings = [...(siblingImports.get(unit.name) ?? [])].sort();
      const ratio = totalSiblings > 0 ? Math.round((siblings.length / totalSiblings) * 1000) / 1000 : 0;
      const percent = totalSiblings > 0 ? Math.round((siblings.length / totalSiblings) * 100) : 0;
      siblingFanOut = {
        count: siblings.length,
        totalSiblings,
        ratio,
        percent,
        modules: siblings,
      };
      if (totalSiblings >= thresholds.minSiblingsForFanOut && siblings.length / totalSiblings > thresholds.maxSiblingFanOutRatio) {
        warnings.push({
          module: unit.name,
          kind: "sibling-fan-out",
          message: `module "${unit.name}" imports ${siblings.length}/${totalSiblings} sibling modules (${percent}%, threshold: <= ${Math.round(thresholds.maxSiblingFanOutRatio * 100)}%: ${siblings.join(", ")}). Lift cross-module wiring to src/main.ts or invert dependencies.`,
        });
      }
    }

    if (prodFiles > thresholds.maxProdFiles) {
      const fix = unit.isSubmodule
        ? `Extract a sibling submodule under src/modules/${unit.topModule}/ or promote to a top-level module under src/modules/.`
        : `Split cohesive parts into 1-level submodules under src/modules/${unit.name}/<submodule>/ or split into a separate module.`;
      warnings.push({
        module: unit.name,
        kind: "prod-files",
        message: `${unitLabel} has ${prodFiles} prod files (threshold: <= ${thresholds.maxProdFiles}). ${fix}`,
      });
    }

    modules.push({
      name: unit.name,
      isSubmodule: unit.isSubmodule,
      hasIndex: indexFile !== null,
      indexFile,
      hasClient: clientFile !== null,
      clientFile,
      prodFiles,
      prodLoc,
      exports: indexSummary,
      clientExports: clientSummary,
      entrypoints,
      siblingFanOut,
    });
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
  const rows = report.modules.map((m) => {
    const hasEntry = m.entrypoints.length > 0;
    const total = m.entrypoints.reduce((acc, ep) => acc + ep.total, 0);
    const prod = m.entrypoints.reduce((acc, ep) => acc + ep.usedByProd.length + ep.usedBySignature.length, 0);
    const testOnly = m.entrypoints.reduce((acc, ep) => acc + ep.testOnly.length, 0);
    const unused = m.entrypoints.reduce((acc, ep) => acc + ep.unused.length, 0);
    const fanOut = m.siblingFanOut
      ? `${m.siblingFanOut.count}/${m.siblingFanOut.totalSiblings} (${m.siblingFanOut.percent}%)`
      : "-";
    return [
      m.name,
      String(m.prodFiles),
      String(m.prodLoc),
      hasEntry ? String(total) : "-",
      hasEntry ? String(prod) : "-",
      hasEntry ? String(testOnly) : "-",
      hasEntry ? String(unused) : "-",
      fanOut,
    ];
  });

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
