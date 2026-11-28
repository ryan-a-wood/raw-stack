// @ts-check
// The raw-stack blocks for vite.config.ts. Spread rawStack() into defineConfig and
// don't override lint here: `raw-stack guard` fails if vite.config.ts touches lint.

import { fileURLToPath } from "node:url";

const TEST_FILES = ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts"];

/** Sets fast-check's run count for property tests. See property-setup.js. */
const PROPERTY_SETUP = fileURLToPath(new URL("./property-setup.js", import.meta.url));

/**
 * Two test projects. "unit" is src/**: fast, and the Stop hook runs the ones
 * related to changed files. "e2e" is e2e/**: tests that run the real app the way
 * a user would. They import nothing from src/, so only the full tier runs them.
 * Property tests (fast-check) are unit tests: the setup file sets their run count.
 */
const TEST_PROJECTS = [
  {
    extends: true,
    test: { name: "unit", include: ["src/**/*.test.ts", "src/**/*.test.tsx"], setupFiles: [PROPERTY_SETUP] },
  },
  { extends: true, test: { name: "e2e", include: ["e2e/**/*.test.ts"], testTimeout: 30_000 } },
];

const SMOKE_PROJECT = {
  extends: true,
  test: { name: "smoke", include: ["smoke/**/*.smoke.test.ts"], testTimeout: 30_000 },
};

/** Every rule is an error: there are no warnings to ignore. */
const rules = {
  // No escape hatches from the type system.
  "typescript/no-explicit-any": "error",
  "typescript/no-non-null-assertion": "error",
  "typescript/no-unsafe-argument": "error",
  "typescript/no-unsafe-assignment": "error",
  "typescript/no-unsafe-call": "error",
  "typescript/no-unsafe-member-access": "error",
  "typescript/no-unsafe-return": "error",
  "typescript/no-unnecessary-type-assertion": "error",

  // Promises and control flow.
  "typescript/no-floating-promises": "error",
  "typescript/no-misused-promises": "error",
  "typescript/await-thenable": "error",
  "typescript/switch-exhaustiveness-check": "error",
  "typescript/prefer-nullish-coalescing": [
    "error",
    { ignorePrimitives: { string: true, boolean: true } },
  ],

  // Imports.
  "typescript/consistent-type-imports": "error",
  "import/no-cycle": "off", // dependency-cruiser owns the import graph

  // Size limits keep functions and files small enough to read in one go.
  "eslint/max-lines-per-function": [
    "error",
    { max: 60, skipBlankLines: true, skipComments: true },
  ],
  "eslint/max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
  "eslint/max-params": ["error", { max: 4 }],
  "eslint/max-depth": ["error", { max: 4 }],
};

/**
 * Lint, format, test and pre-commit settings shared by every raw-stack project.
 * @returns {import("./vite.d.ts").RawStackConfig}
 */
export function rawStack() {
  const projects = process.env["SMOKE_BASE_URL"]?.trim() ? [...TEST_PROJECTS, SMOKE_PROJECT] : TEST_PROJECTS;
  return {
    lint: {
      plugins: ["typescript", "unicorn", "oxc", "import"],
      categories: { correctness: "error", suspicious: "error" },
      ignorePatterns: ["dist/**", "coverage/**", ".dependency-cruiser.cjs"],
      options: { typeAware: true, typeCheck: true },
      rules,
      overrides: [{ files: TEST_FILES, rules: { "eslint/max-lines-per-function": "off" } }],
    },
    fmt: {},
    test: {
      projects,
      passWithNoTests: true,
    },
    staged: {
      "*": ["vp check --fix", "raw-stack guard"],
    },
  };
}
