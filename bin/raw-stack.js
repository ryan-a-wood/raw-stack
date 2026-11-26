#!/usr/bin/env node
// @ts-check
// raw-stack verify [--full | --checks | --browser]
//                             fast tier (changed files), full tier, non-browser checks, or browser tests only
// raw-stack guard [files...]  suppression comments and config overrides
// raw-stack health [--json] [--strict]
//                             module health metrics (size, index exports, sibling fan-out)
// raw-stack snapshots [--base <ref>]
//                             list snapshots added, changed or removed since the branch left <ref>
// raw-stack cloudflare-secrets [--repo owner/name] [--account-id id] [--config file] [--dry-run]
//                             scoped Cloudflare deploy token -> GitHub Actions secrets
import { cloudflareSecrets, USAGE as CLOUDFLARE_USAGE } from "../lib/cloudflare/deploy-token.js";
import { guard } from "../lib/guard.js";
import { analyzeHealth, formatHealthReport } from "../lib/health.js";
import { findRoot, projectFiles } from "../lib/project.js";
import { testConfigProblems } from "../lib/test-config.js";
import { compareSnapshots, snapshotReport } from "../lib/snapshots.js";
import { report, verifyBrowser, verifyChanged, verifyChecks, verifyFull } from "../lib/verify.js";

const VERIFY_MODES = new Set(["--full", "--checks", "--browser"]);
const VERIFY_USAGE = "usage: raw-stack verify [--full | --checks | --browser]";

const [command, ...args] = process.argv.slice(2);
const root = findRoot(process.cwd());

if (command === "verify") {
  const unknown = args.filter((a) => !VERIFY_MODES.has(a));
  const modes = [...new Set(args)];
  if (unknown.length > 0) {
    console.error(`raw-stack verify: unknown option(s): ${unknown.join(", ")}\n${VERIFY_USAGE}`);
    process.exitCode = 2;
  } else if (modes.length > 1) {
    console.error(`raw-stack verify: conflicting options: ${modes.join(", ")}\n${VERIFY_USAGE}`);
    process.exitCode = 2;
  } else {
    const mode = modes[0];
    const steps = await (mode === "--full"
      ? verifyFull(root)
      : mode === "--checks"
        ? verifyChecks(root)
        : mode === "--browser"
          ? verifyBrowser(root)
          : verifyChanged(root));
    console.log(report(steps));
    process.exitCode = steps.every((s) => s.ok) ? 0 : 1;
  }
} else if (command === "guard") {
  const files = args.length > 0 ? args.map((f) => (f.startsWith(root) ? f.slice(root.length + 1) : f)) : projectFiles(root);
  const problems = [...guard(root, files), ...(await testConfigProblems(root))];
  if (problems.length > 0) console.error(problems.join("\n"));
  process.exitCode = problems.length > 0 ? 1 : 0;
} else if (command === "health") {
  const unknown = args.filter((a) => a !== "--json" && a !== "--strict");
  if (unknown.length > 0) {
    console.error(`raw-stack health: unknown option(s): ${unknown.join(", ")}\nusage: raw-stack health [--json] [--strict]`);
    process.exitCode = 2;
  } else {
    const json = args.includes("--json");
    const strict = args.includes("--strict");
    const result = analyzeHealth(root);
    console.log(json ? JSON.stringify(result, null, 2) : formatHealthReport(result));
    process.exitCode = strict && !result.ok ? 1 : 0;
  }
} else if (command === "snapshots") {
  const at = args.indexOf("--base");
  const base = at === -1 ? undefined : args[at + 1];
  try {
    console.log(snapshotReport(compareSnapshots(root, base)));
  } catch (err) {
    console.error(`raw-stack snapshots: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
} else if (command === "cloudflare-secrets") {
  process.exitCode = await cloudflareSecrets({
    root,
    args,
    env: process.env,
    out: { log: (line) => console.log(line), error: (line) => console.error(line) },
  });
} else {
  console.error(
    `usage: raw-stack verify [--full | --checks | --browser] | raw-stack guard [files...] | raw-stack health [--json] [--strict] | raw-stack snapshots [--base <ref>]\n${CLOUDFLARE_USAGE}`,
  );
  process.exitCode = 2;
}
