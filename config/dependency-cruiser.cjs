// @ts-check
// Import-graph rules for raw-stack projects. A project's .dependency-cruiser.cjs
// extends this file: `extends: require.resolve("raw-stack/dependency-cruiser")`.

const TEST = "\\.test\\.tsx?$";
const TESTING = "^src/testing/";
const ENTRY = "^src/(main|browser)\\.tsx?$";
const MODULE_INTERNAL = "^src/modules/[^/]+/.";
const MODULE_ENTRY = "^src/modules/[^/]+/(?:index|client)\\.tsx?$";
const SUBMODULE_ENTRY = "^src/modules/[^/]+/[^/]+/(?:index|client)\\.tsx?$";
const TOO_DEEP_MODULE = "^src/modules/[^/]+/[^/]+/[^/]+/";
const CLIENT_FILES = [
  "^src/browser\\.tsx?$",
  "^src/modules/[^/]+/client\\.tsx?$",
  "^src/modules/[^/]+/[^/]+/client\\.tsx?$",
  "\\.client\\.tsx?$",
  "/client/",
];
const SERVER_TARGETS = ["\\.server\\.tsx?$", "/server/", "^src/modules/database/"];

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "deep-modules",
      comment:
        "A module is used only through its index.ts(x) or client.ts(x). Import the module entrypoint, not a file inside it.",
      severity: "error",
      from: { path: "^src/modules/([^/]+)/" },
      to: { path: MODULE_INTERNAL, pathNot: ["^src/modules/$1/", MODULE_ENTRY] },
    },
    {
      name: "deep-modules-from-outside",
      comment:
        "Code outside src/modules uses a module only through its index.ts(x) or client.ts(x).",
      severity: "error",
      from: { pathNot: "^src/modules/" },
      to: { path: MODULE_INTERNAL, pathNot: MODULE_ENTRY },
    },
    {
      name: "submodule-encapsulation",
      comment:
        "A submodule is used only through its index.ts(x) or client.ts(x). Import the submodule entrypoint, not a file inside it.",
      severity: "error",
      from: { path: "^src/modules/([^/]+)/([^/]+)/" },
      to: {
        path: "^src/modules/$1/[^/]+/.",
        pathNot: ["^src/modules/$1/$2/", SUBMODULE_ENTRY],
      },
    },
    {
      name: "submodule-encapsulation-from-parent",
      comment:
        "A parent module uses its submodules only through their index.ts(x) or client.ts(x).",
      severity: "error",
      from: { path: "^src/modules/([^/]+)/[^/]+$" },
      to: {
        path: "^src/modules/$1/[^/]+/.",
        pathNot: SUBMODULE_ENTRY,
      },
    },
    {
      name: "module-max-depth",
      comment:
        "Modules may be nested at most 1 submodule level deep (src/modules/<mod>/<submod>/<file>). Flatten deeper directories.",
      severity: "error",
      from: {},
      to: { path: TOO_DEEP_MODULE },
    },
    {
      name: "module-max-depth-from",
      comment:
        "Modules may be nested at most 1 submodule level deep (src/modules/<mod>/<submod>/<file>). Flatten deeper directories.",
      severity: "error",
      from: { path: TOO_DEEP_MODULE },
      to: {},
    },
    {
      name: "module-max-depth-orphan",
      comment:
        "Modules may be nested at most 1 submodule level deep (src/modules/<mod>/<submod>/<file>). Flatten deeper directories.",
      severity: "error",
      from: { path: TOO_DEEP_MODULE, orphan: true },
      to: {},
    },
    {
      name: "client-no-node",
      comment:
        "Browser entrypoints and client files cannot import Node built-ins (type-only imports are allowed).",
      severity: "error",
      from: { path: CLIENT_FILES, pathNot: TEST },
      to: {
        dependencyTypes: ["core"],
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "client-no-server",
      comment:
        "Browser entrypoints and client files cannot reach server-only files (*.server.ts(x), /server/) or src/modules/database/.",
      severity: "error",
      from: { path: CLIENT_FILES, pathNot: TEST },
      to: {
        path: SERVER_TARGETS,
        reachable: true,
      },
    },
    {
      name: "no-circular",
      comment: "Circular imports hide the real dependency direction.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      comment:
        "Production files must be reachable from an entrypoint (src/main.ts(x) or src/browser.ts(x)). Delete dead code or import it.",
      severity: "error",
      from: { path: ENTRY },
      to: {
        path: "^src/",
        pathNot: [TEST, "\\.d\\.ts$", TESTING, ENTRY],
        reachable: false,
      },
    },
    {
      name: "not-to-unresolvable",
      comment: "The import can't be resolved: a typo, or a package that isn't installed.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-undeclared-deps",
      comment: "Packages you import must be in package.json.",
      severity: "error",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "not-to-dev-dep",
      comment: "Shipped code can't import devDependencies. Move the package to dependencies.",
      severity: "error",
      from: { path: "^src/", pathNot: [TEST, TESTING] },
      to: {
        dependencyTypes: ["npm-dev"],
        dependencyTypesNot: ["type-only"],
        pathNot: ["node_modules/@types/"],
      },
    },
    {
      name: "not-to-test",
      comment: "Only tests import tests.",
      severity: "error",
      from: { pathNot: TEST },
      to: { path: TEST },
    },
    {
      name: "not-to-testing",
      comment:
        "Shipped code can't import src/testing/. Only tests and files inside src/testing/ may import it.",
      severity: "error",
      from: { pathNot: [TEST, TESTING] },
      to: { path: TESTING },
    },
  ],
  options: {
    doNotFollow: { path: ["node_modules"] },
    exclude: { path: ["^dist/", "^coverage/"] },
    // TypeScript 7 has no JS compiler API, so parse with swc. Without a parser
    // dependency-cruiser finds no .ts files and passes while checking nothing.
    parser: "swc",
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
      extensions: [".ts", ".tsx", ".d.ts", ".js", ".mjs", ".cjs", ".json"],
    },
    skipAnalysisNotInRules: true,
    cache: { folder: "node_modules/.cache/dependency-cruiser", strategy: "content" },
  },
};
