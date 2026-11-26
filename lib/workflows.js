// @ts-check
// Agents can edit .github/, so the guard checks that CI still runs what makes a
// PR safe to merge: `pnpm verify` (or split `raw-stack verify --checks` +
// `raw-stack verify --browser`) on every PR and push, and the snapshot report
// that shows the reviewer every changed snapshot.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_RETRIES } from "./retries.js";

export const VERIFY_WORKFLOW = ".github/workflows/verify.yml";

const REQUIRED_BASE = [
  { re: /^\s*pull_request:/m, why: "must run on pull_request" },
  { re: /^\s*push:/m, why: "must run on push" },
  { re: /^\s*(?:-\s*)?run:.*\braw-stack snapshots\b/m, why: "must run raw-stack snapshots" },
];

const RUN_FULL = /^\s*(?:-\s*)?run:\s*(?:pnpm verify|pnpm exec raw-stack verify --full)\s*$/m;
const RUN_CHECKS_DIRECT = /^\s*(?:-\s*)?run:\s*pnpm exec raw-stack verify --checks\s*$/m;
const RUN_CHECKS_SCRIPT = /^\s*(?:-\s*)?run:\s*pnpm (?:run )?verify:checks\s*$/m;
const RUN_BROWSER_DIRECT = /^\s*(?:-\s*)?run:\s*pnpm exec raw-stack verify --browser\s*$/m;
const RUN_BROWSER_SCRIPT = /^\s*(?:-\s*)?run:\s*pnpm (?:run )?verify:browser\s*$/m;

/** Settings that let a run skip or pass without verify passing. */
const LOOSENERS = /^\s*(continue-on-error|paths|paths-ignore|branches-ignore):/;

/** `--retry` (Vitest) or `--retries` (Playwright) in a workflow command. */
const RETRY_FLAG = /--retr(?:y|ies)\b/;

/** @param {string} root @param {string} name @returns {string | undefined} */
function packageScript(root, name) {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const script = pkg?.scripts?.[name];
    return typeof script === "string" ? script.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} root @param {string} text @returns {string[]} */
function verifyStepProblems(root, text) {
  if (RUN_FULL.test(text)) return [];

  const hasChecksDirect = RUN_CHECKS_DIRECT.test(text);
  const hasChecksScript = RUN_CHECKS_SCRIPT.test(text);
  const hasBrowserDirect = RUN_BROWSER_DIRECT.test(text);
  const hasBrowserScript = RUN_BROWSER_SCRIPT.test(text);
  const hasAnySplit = hasChecksDirect || hasChecksScript || hasBrowserDirect || hasBrowserScript;

  if (!hasAnySplit) {
    return [
      `${VERIFY_WORKFLOW} must have a step "run: pnpm verify" (or split "run: pnpm exec raw-stack verify --checks" / "run: pnpm verify:checks").`,
    ];
  }

  const problems = [];
  if (!hasChecksDirect && !hasChecksScript) {
    problems.push(
      `${VERIFY_WORKFLOW} must have a checks step ("run: pnpm exec raw-stack verify --checks" or "run: pnpm verify:checks") or "run: pnpm verify".`,
    );
  } else if (!hasChecksDirect && hasChecksScript) {
    if (packageScript(root, "verify:checks") !== "raw-stack verify --checks") {
      problems.push(`package.json script "verify:checks" must be "raw-stack verify --checks" (used by ${VERIFY_WORKFLOW}).`);
    }
  }

  const hasPlaywright = existsSync(join(root, "playwright.config.ts"));
  if (hasPlaywright && !hasBrowserDirect && !hasBrowserScript) {
    problems.push(
      `${VERIFY_WORKFLOW} must have a browser step ("run: pnpm exec raw-stack verify --browser" or "run: pnpm verify:browser") because playwright.config.ts exists.`,
    );
  } else if (!hasBrowserDirect && hasBrowserScript) {
    if (packageScript(root, "verify:browser") !== "raw-stack verify --browser") {
      problems.push(`package.json script "verify:browser" must be "raw-stack verify --browser" (used by ${VERIFY_WORKFLOW}).`);
    }
  }

  return problems;
}

/** @param {string} root @returns {string[]} */
export function verifyWorkflowProblems(root) {
  const path = join(root, VERIFY_WORKFLOW);
  if (!existsSync(path)) return [`${VERIFY_WORKFLOW} is missing. CI runs pnpm verify and the snapshot report from it.`];
  const codeLines = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.replace(/(?:^|\s)#.*$/, ""));
  const codeText = codeLines.join("\n");
  const problems = [
    ...REQUIRED_BASE.filter(({ re }) => !re.test(codeText)).map(({ why }) => `${VERIFY_WORKFLOW} ${why}.`),
    ...verifyStepProblems(root, codeText),
  ];
  for (const [i, code] of codeLines.entries()) {
    const loose = LOOSENERS.exec(code);
    if (loose) problems.push(`${VERIFY_WORKFLOW}:${i + 1}: "${loose[1]}" lets CI skip or pass without verify. Remove it.`);
    if (RETRY_FLAG.test(code)) {
      problems.push(`${VERIFY_WORKFLOW}:${i + 1}: passes a retry flag to the tests. ${NO_RETRIES}`);
    }
  }
  return problems;
}
