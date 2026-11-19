// @ts-check
// Agents can edit .github/, so the guard checks that CI still runs what makes a
// PR safe to merge: `pnpm verify` on every PR and push, and the snapshot check
// that only the snapshots-approved label can pass. Retry flags in workflows are
// checked in retries.js.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const VERIFY_WORKFLOW = ".github/workflows/verify.yml";

/** The only way `--approved` may reach `raw-stack snapshots`: a maintainer's label. */
const LABEL_CHECK = "contains(github.event.pull_request.labels.*.name, 'snapshots-approved')";

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
  if (!existsSync(path)) return [`${VERIFY_WORKFLOW} is missing. CI runs pnpm verify and the snapshot check from it.`];
  const text = readFileSync(path, "utf8");
  const problems = REQUIRED.filter(({ re }) => !re.test(text)).map(({ why }) => `${VERIFY_WORKFLOW} ${why}.`);
  for (const [i, line] of text.split("\n").entries()) {
    const code = line.replace(/\s#.*$/, "");
    const loose = LOOSENERS.exec(code);
    if (loose) problems.push(`${VERIFY_WORKFLOW}:${i + 1}: "${loose[1]}" lets CI skip or pass without verify. Remove it.`);
    if (code.includes("--approved") && !code.includes(LABEL_CHECK)) {
      problems.push(`${VERIFY_WORKFLOW}:${i + 1}: --approved must come only from the snapshots-approved label (${LABEL_CHECK}).`);
    }
  }
  return problems;
}
