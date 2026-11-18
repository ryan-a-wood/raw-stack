// @ts-check
// Claude Code Stop hook: run the fast verify tier and block the stop until it
// passes. Skips when nothing changed since the last pass. If Claude stops again
// without changing anything after a failure, it lets the stop through so the
// session can't loop forever.
import { readFileSync } from "node:fs";
import { findRoot, fingerprint, readState, writeState } from "../lib/project.js";
import { report, verifyChanged } from "../lib/verify.js";

const input = JSON.parse(readFileSync(0, "utf8"));
const root = findRoot(input.cwd ?? process.cwd());
const state = readState(root);
const before = fingerprint(root);

if (before === state.pass) process.exit(0);
if (input.stop_hook_active === true && before === state.fail) {
  process.stderr.write("raw-stack: checks still failing and nothing changed since. Stopping anyway.\n");
  process.exit(0);
}

const steps = await verifyChanged(root);
const after = fingerprint(root); // vp check --fix may have reformatted files
if (steps.every((s) => s.ok)) {
  writeState(root, { pass: after });
  process.exit(0);
}
writeState(root, { fail: after });
process.stderr.write(`raw-stack verify failed. Fix these before stopping:\n\n${report(steps)}\n`);
process.exit(2);
