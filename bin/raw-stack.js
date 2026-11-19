#!/usr/bin/env node
// @ts-check
// raw-stack verify [--full]   fast tier (changed files) or full tier
// raw-stack guard [files...]  suppression comments and config overrides
// raw-stack snapshots [--base <ref>] [--approved]
//                             fail on snapshots changed since the branch left <ref>
import { guard } from "../lib/guard.js";
import { findRoot, projectFiles } from "../lib/project.js";
import { testConfigProblems } from "../lib/test-config.js";
import { compareSnapshots, snapshotReport } from "../lib/snapshots.js";
import { report, verifyChanged, verifyFull } from "../lib/verify.js";

const [command, ...args] = process.argv.slice(2);
const root = findRoot(process.cwd());

if (command === "verify") {
  const steps = await (args.includes("--full") ? verifyFull(root) : verifyChanged(root));
  console.log(report(steps));
  process.exitCode = steps.every((s) => s.ok) ? 0 : 1;
} else if (command === "guard") {
  const files = args.length > 0 ? args.map((f) => (f.startsWith(root) ? f.slice(root.length + 1) : f)) : projectFiles(root);
  const problems = [...guard(root, files), ...(await testConfigProblems(root))];
  if (problems.length > 0) console.error(problems.join("\n"));
  process.exitCode = problems.length > 0 ? 1 : 0;
} else if (command === "snapshots") {
  const at = args.indexOf("--base");
  const base = at === -1 ? undefined : args[at + 1];
  try {
    const { ok, output } = snapshotReport(compareSnapshots(root, base), args.includes("--approved"));
    (ok ? console.log : console.error)(output);
    process.exitCode = ok ? 0 : 1;
  } catch (err) {
    console.error(`raw-stack snapshots: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
} else {
  console.error("usage: raw-stack verify [--full] | raw-stack guard [files...] | raw-stack snapshots [--base <ref>] [--approved]");
  process.exitCode = 2;
}
