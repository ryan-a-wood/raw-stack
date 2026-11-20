// @ts-check
// Agents can edit .github/, so the guard checks that CI still runs what makes a
// PR safe to merge: `pnpm verify` on every PR and push, and the snapshot report
// that shows the reviewer every changed snapshot. Retry flags in workflows are
// checked in retries.js.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const VERIFY_WORKFLOW = ".github/workflows/verify.yml";

const REQUIRED = [
  { re: /^\s*pull_request:/m, why: "must run on pull_request" },
  { re: /^\s*push:/m, why: "must run on push" },
  { re: /^\s*(?:-\s*)?run:\s*pnpm verify\s*$/m, why: 'must have a step "run: pnpm verify"' },
  { re: /^\s*run:.*\braw-stack snapshots\b/m, why: "must run raw-stack snapshots" },
];

/** Settings that let a run skip or pass without verify passing. */
const LOOSENERS = /^\s*(continue-on-error|paths|paths-ignore|branches-ignore):/;

/** @param {string} root @returns {string[]} */
export function verifyWorkflowProblems(root) {
  const path = join(root, VERIFY_WORKFLOW);
  if (!existsSync(path)) return [`${VERIFY_WORKFLOW} is missing. CI runs pnpm verify and the snapshot report from it.`];
  const text = readFileSync(path, "utf8");
  const problems = REQUIRED.filter(({ re }) => !re.test(text)).map(({ why }) => `${VERIFY_WORKFLOW} ${why}.`);
  for (const [i, line] of text.split("\n").entries()) {
    const code = line.replace(/\s#.*$/, "");
    const loose = LOOSENERS.exec(code);
    if (loose) problems.push(`${VERIFY_WORKFLOW}:${i + 1}: "${loose[1]}" lets CI skip or pass without verify. Remove it.`);
  }
  return problems;
}
