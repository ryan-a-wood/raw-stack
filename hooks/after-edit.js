// @ts-check
// Claude Code PostToolUse hook (Edit|Write|MultiEdit): lint the edited file and
// check it for suppression comments. Exit 2 hands the problems back to Claude.
import { readFileSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { guard } from "../lib/guard.js";
import { findRoot, run, SOURCE_FILE, vpCommand } from "../lib/project.js";

const input = JSON.parse(readFileSync(0, "utf8"));
const root = findRoot(input.cwd ?? process.cwd());
const filePath = input.tool_input?.file_path;
const file = typeof filePath === "string" ? relative(root, filePath) : "";
const inProject = file !== "" && !file.startsWith("..") && !isAbsolute(file);

if (inProject && !/(^|\/)node_modules\//.test(file)) {
  const problems = guard(root, [file]);
  if (SOURCE_FILE.test(file)) {
    const lint = await run("lint", vpCommand(root), ["lint", "--format", "agent", file], root);
    if (!lint.ok) problems.unshift(lint.output.trim());
  }
  if (problems.length > 0) {
    process.stderr.write(`raw-stack found problems after editing ${file}:\n${problems.join("\n")}\n`);
    process.exit(2);
  }
}
