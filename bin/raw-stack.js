#!/usr/bin/env node
// @ts-check
// raw-stack verify [--full]   fast tier (changed files) or full tier
// raw-stack guard [files...]  suppression comments and config overrides
import { guard } from "../lib/guard.js";
import { findRoot, projectFiles } from "../lib/project.js";
import { report, verifyChanged, verifyFull } from "../lib/verify.js";

const [command, ...args] = process.argv.slice(2);
const root = findRoot(process.cwd());

if (command === "verify") {
  const steps = await (args.includes("--full") ? verifyFull(root) : verifyChanged(root));
  console.log(report(steps));
  process.exitCode = steps.every((s) => s.ok) ? 0 : 1;
} else if (command === "guard") {
  const files = args.length > 0 ? args.map((f) => (f.startsWith(root) ? f.slice(root.length + 1) : f)) : projectFiles(root);
  const problems = guard(root, files);
  if (problems.length > 0) console.error(problems.join("\n"));
  process.exitCode = problems.length > 0 ? 1 : 0;
} else {
  console.error("usage: raw-stack verify [--full] | raw-stack guard [files...]");
  process.exitCode = 2;
}
