// @ts-check
// Checks the linters can't do themselves: no suppression comments, and no
// project config that loosens the shared rules.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_FILE } from "./project.js";

const SUPPRESSIONS = [
  /oxlint-disable/,
  /eslint-disable/,
  /@ts-ignore/,
  /@ts-nocheck/,
  /@ts-expect-error/,
  /dependency-cruiser-ignore/,
];

const SKIP = /(^|\/)(node_modules|dist|coverage)\//;

/** @param {string} root @param {string} file @returns {string[]} */
function suppressionProblems(root, file) {
  if (!SOURCE_FILE.test(file) || SKIP.test(file)) return [];
  const path = join(root, file);
  if (!existsSync(path)) return [];
  const problems = [];
  const text = readFileSync(path, "utf8").split("\n");
  for (const [i, line] of text.entries()) {
    const hit = SUPPRESSIONS.find((re) => re.test(line));
    if (hit) problems.push(`${file}:${i + 1}: suppression comment (${hit.source}). Fix the cause instead.`);
  }
  return problems;
}

/** @param {string} text */
function parseJsonc(text) {
  const noComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "");
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, "$1"));
}

/** @param {string} root @returns {string[]} */
function tsconfigProblems(root) {
  const path = join(root, "tsconfig.json");
  if (!existsSync(path)) return ["tsconfig.json is missing."];
  const config = parseJsonc(readFileSync(path, "utf8"));
  const base = parseJsonc(readFileSync(new URL("../config/tsconfig.json", import.meta.url), "utf8"));
  const problems = [];
  if (config.extends !== "raw-stack/tsconfig.json") {
    problems.push('tsconfig.json must have "extends": "raw-stack/tsconfig.json".');
  }
  for (const [key, value] of Object.entries(config.compilerOptions ?? {})) {
    if (key in base.compilerOptions && JSON.stringify(base.compilerOptions[key]) !== JSON.stringify(value)) {
      problems.push(`tsconfig.json overrides the shared "${key}". Remove it.`);
    }
  }
  return problems;
}

const LINT_KEYS = /\b(lint|rules|categories|typeAware|typeCheck|ignorePatterns|jsPlugins)\s*:/;

/** @param {string} root @returns {string[]} */
function viteConfigProblems(root) {
  const path = join(root, "vite.config.ts");
  if (!existsSync(path)) return ["vite.config.ts is missing."];
  const text = readFileSync(path, "utf8");
  const problems = [];
  if (!text.includes("...rawStack()")) problems.push("vite.config.ts must spread ...rawStack() into defineConfig.");
  const hit = text.match(LINT_KEYS);
  if (hit) problems.push(`vite.config.ts sets "${hit[1]}". Lint settings come only from raw-stack.`);
  return problems;
}

const SHARED_RULES = [
  "deep-modules",
  "deep-modules-from-outside",
  "no-circular",
  "no-orphans",
  "not-to-unresolvable",
  "no-undeclared-deps",
  "not-to-dev-dep",
  "not-to-test",
];

/** @param {string} root @returns {string[]} */
function depcruiseProblems(root) {
  const path = join(root, ".dependency-cruiser.cjs");
  if (!existsSync(path)) return [".dependency-cruiser.cjs is missing."];
  const text = readFileSync(path, "utf8");
  const problems = [];
  if (!text.includes("raw-stack/dependency-cruiser")) {
    problems.push('.dependency-cruiser.cjs must extend "raw-stack/dependency-cruiser".');
  }
  for (const name of SHARED_RULES) {
    if (text.includes(`"${name}"`) || text.includes(`'${name}'`)) {
      problems.push(`.dependency-cruiser.cjs redefines the shared rule "${name}". Remove it.`);
    }
  }
  return problems;
}

/**
 * @param {string} root
 * @param {string[]} files files to scan for suppression comments
 * @returns {string[]} one line per problem
 */
export function guard(root, files) {
  return [
    ...files.flatMap((file) => suppressionProblems(root, file)),
    ...tsconfigProblems(root),
    ...viteConfigProblems(root),
    ...depcruiseProblems(root),
  ];
}
