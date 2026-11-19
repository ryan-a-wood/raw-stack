// @ts-check
// Expect tests (inline snapshots) record whatever the code printed, so they can
// only catch a change if a person approves each one. This compares the
// snapshots on a branch with the ones it started from: a new snapshot is listed
// for review, and an edited or removed one fails unless the PR is approved.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { baseCommit, filesAt, projectFiles, readAt, SOURCE_FILE } from "./project.js";

/** Matchers that write their snapshot into the test file. */
export const INLINE_SNAPSHOT = /\.(?:toMatchInlineSnapshot|toThrowErrorMatchingInlineSnapshot)\s*\(/g;

/** Matchers that keep their snapshot in a separate file. raw-stack allows only inline ones. */
export const FILE_SNAPSHOT = /\.(toMatchSnapshot|toMatchFileSnapshot|toThrowErrorMatchingSnapshot)\s*\(/;

/** Where snapshots may live: tests of what the user sees, not of internal code. */
export const SNAPSHOT_DIR = "e2e/";

/**
 * The string literal starting at `start` (a quote or backtick), unescaped.
 * @param {string} source @param {number} start @returns {string | undefined}
 */
function readString(source, start) {
  const quote = source[start];
  let out = "";
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\") {
      out += source[i + 1] ?? "";
      i++;
    } else if (ch === quote) {
      return out;
    } else {
      out += ch;
    }
  }
  return undefined;
}

/**
 * A snapshot's value without the indentation it has in the test file, so
 * reformatting or moving the test doesn't count as a change.
 * @param {string} raw
 */
function dedent(raw) {
  const lines = raw.replace(/^[ \t]*\n|\n[ \t]*$/g, "").split("\n");
  const indents = lines.filter((l) => l.trim() !== "").map((l) => /^[ \t]*/.exec(l)?.[0].length ?? 0);
  const cut = Math.min(...indents, Infinity);
  return lines.map((l) => l.slice(Number.isFinite(cut) ? cut : 0)).join("\n");
}

/**
 * The recorded value of each filled-in inline snapshot in a file. An empty
 * `toMatchInlineSnapshot()` has nothing recorded yet and is left out.
 * @param {string} source @returns {string[]}
 */
export function inlineSnapshots(source) {
  const found = [];
  for (const match of source.matchAll(INLINE_SNAPSHOT)) {
    // Skip an optional property-matcher object: take the first string before the call closes.
    let depth = 0;
    for (let i = (match.index ?? 0) + match[0].length; i < source.length; i++) {
      const ch = source[i] ?? "";
      if (ch === "`" || ch === '"' || ch === "'") {
        const value = readString(source, i);
        if (value !== undefined && depth === 0) found.push(dedent(value));
        break;
      }
      if (ch === "{" || ch === "(") depth++;
      if (ch === "}") depth--;
      if (ch === ")" && depth-- === 0) break;
    }
  }
  return found;
}

/** @typedef {{ value: string, file: string }} Snapshot */

/** @param {Array<[string, string]>} files [path, contents] @returns {Snapshot[]} */
function collect(files) {
  return files.flatMap(([file, source]) =>
    source.includes("Snapshot") ? inlineSnapshots(source).map((value) => ({ value, file })) : [],
  );
}

/**
 * Snapshots in `before` that `after` no longer has, counting duplicates.
 * @param {Snapshot[]} before @param {Snapshot[]} after
 */
function missing(before, after) {
  const left = new Map();
  for (const s of after) left.set(s.value, (left.get(s.value) ?? 0) + 1);
  return before.filter((s) => {
    const n = left.get(s.value) ?? 0;
    if (n > 0) left.set(s.value, n - 1);
    return n === 0;
  });
}

/**
 * Compare the snapshots in the working tree with those at the base commit.
 * Moving a snapshot to another file is not a change; editing its value is.
 * @param {string} root @param {string} [base] ref the branch started from
 * @returns {{ base: string, added: Snapshot[], changed: Snapshot[] }}
 */
export function compareSnapshots(root, base) {
  const commit = baseCommit(root, base);
  const tests = (/** @type {string[]} */ files) => files.filter((f) => SOURCE_FILE.test(f));
  const before = collect(tests(filesAt(root, commit)).map((f) => [f, readAt(root, commit, f)]));
  const after = collect(tests(projectFiles(root)).map((f) => [f, readFileSync(join(root, f), "utf8")]));
  return { base: commit, added: missing(after, before), changed: missing(before, after) };
}

/** @param {Snapshot} s */
const show = (s) => {
  const lines = s.value.split("\n");
  const body = lines.length > 12 ? [...lines.slice(0, 12), "..."] : lines;
  return `${s.file}:\n${body.map((l) => `    ${l}`).join("\n")}`;
};

/**
 * Report the comparison. Fails on changed or removed snapshots unless approved.
 * In GitHub Actions, the report also goes to the job summary.
 * @param {ReturnType<typeof compareSnapshots>} result @param {boolean} approved
 * @returns {{ ok: boolean, output: string }}
 */
export function snapshotReport(result, approved) {
  const { added, changed } = result;
  const parts = [];
  if (changed.length > 0) {
    parts.push(
      `${changed.length} snapshot(s) changed or removed since ${result.base.slice(0, 7)}. The old values were:`,
      ...changed.map(show),
      approved
        ? "Approved: the PR has the snapshots-approved label."
        : "A snapshot records what the app showed when a person approved it, so only a person can change one. Say why in the PR. A maintainer approves it by adding the snapshots-approved label.",
    );
  }
  if (added.length > 0) parts.push(`${added.length} new snapshot value(s). Read each once and check it against FEATURES.md:`, ...added.map(show));
  if (parts.length === 0) parts.push("No snapshot changes.");
  const output = parts.join("\n\n");
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) appendFileSync(summary, `## Snapshots\n\n\`\`\`\n${output}\n\`\`\`\n`);
  return { ok: approved || changed.length === 0, output };
}
