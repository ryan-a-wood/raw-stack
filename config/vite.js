// @ts-check
// The raw-stack blocks for vite.config.ts. Spread rawStack() into defineConfig and
// don't override lint here: `raw-stack guard` fails if vite.config.ts touches lint.

import { fileURLToPath } from "node:url";

const TEST_FILES = ["**/*.test.ts", "**/*.test.tsx"];

/** Sets fast-check's run count for property tests. See property-setup.js. */
const PROPERTY_SETUP = fileURLToPath(new URL("./property-setup.js", import.meta.url));

/**
 * Two test projects. "unit" is src/**: fast, and the Stop hook runs the ones
 * related to changed files. "e2e" is e2e/**: tests that run the real app the way
 * a user would. They import nothing from src/, so only the full tier runs them.
 * Property tests (fast-check) are unit tests: the setup file sets their run count.
 * Mutation testing (RAW_STACK_MUTATION, set by raw-stack verify --full) loads only
 * "unit": the e2e tests run the app in a child process, where Stryker can't
 * switch mutants, so they can't kill any.
 */
const UNIT_PROJECT = {
  extends: true,
  test: { name: "unit", include: ["src/**/*.test.ts", "src/**/*.test.tsx"], setupFiles: [PROPERTY_SETUP] },
};
const E2E_PROJECT = { extends: true, test: { name: "e2e", include: ["e2e/**/*.test.ts"], testTimeout: 30_000 } };
/** Both test projects: what every vite.config.ts must resolve to outside mutation runs. */
export const TEST_PROJECTS = [UNIT_PROJECT, E2E_PROJECT];
const testProjects = () => (process.env["RAW_STACK_MUTATION"] === "1" ? [UNIT_PROJECT] : TEST_PROJECTS);

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
      projects: testProjects(),
      passWithNoTests: true,
    },
    staged: {
      "*": ["vp check --fix", "raw-stack guard"],
    },
  };
}
