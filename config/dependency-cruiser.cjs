// @ts-check
// Import-graph rules for raw-stack projects. A project's .dependency-cruiser.cjs
// extends this file: `extends: require.resolve("raw-stack/dependency-cruiser")`.

const TEST = "\\.test\\.tsx?$";
const MODULE_INTERNAL = "^src/modules/[^/]+/.";
const MODULE_ENTRY = "^src/modules/[^/]+/index\\.tsx?$";

/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "deep-modules",
      comment:
        "A module is used only through its index.ts. Import the module, not a file inside it.",
      severity: "error",
      from: { path: "^src/modules/([^/]+)/" },
      to: { path: MODULE_INTERNAL, pathNot: ["^src/modules/$1/", MODULE_ENTRY] },
    },
    {
      name: "deep-modules-from-outside",
      comment:
        "Code outside src/modules uses a module only through its index.ts.",
      severity: "error",
      from: { pathNot: "^src/modules/" },
      to: { path: MODULE_INTERNAL, pathNot: MODULE_ENTRY },
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
      comment: "Files nothing imports are dead code. Delete them or import them.",
      severity: "error",
      from: {
        orphan: true,
        pathNot: [TEST, "\\.d\\.ts$", "^src/main\\.tsx?$"],
      },
      to: {},
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
      from: { path: "^src/", pathNot: TEST },
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
