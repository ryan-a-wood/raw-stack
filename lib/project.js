// @ts-check
// Facts about the project being checked: its root, its files, what changed, and
// where to find the tools.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

/** @param {string} root @param {string[]} args */
function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** @param {string} cwd */
export function findRoot(cwd) {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return cwd;
  }
}

/** @param {string} out */
const lines = (out) => out.split("\n").filter(Boolean);

/** Tracked and untracked files, minus what .gitignore excludes. @param {string} root */
export function projectFiles(root) {
  return lines(git(root, ["ls-files", "-co", "--exclude-standard"])).filter((f) =>
    existsSync(join(root, f)),
  );
}

/**
 * The commit this branch started from, or HEAD on the default branch.
 * @param {string} root @param {string} [base] a ref to start from instead of the default branch
 */
export function baseCommit(root, base) {
  for (const ref of base ? [base] : ["origin/HEAD", "origin/main", "main", "master"]) {
    try {
      return git(root, ["merge-base", "HEAD", ref]).trim();
    } catch {
      // try the next candidate
    }
  }
  if (base) throw new Error(`can't find where this branch left ${base}. Fetch it first (in CI, check out with fetch-depth: 0).`);
  return "HEAD";
}

/** Files tracked at a commit. @param {string} root @param {string} commit */
export function filesAt(root, commit) {
  return lines(git(root, ["ls-tree", "-r", "--name-only", commit]));
}

/** A file's contents at a commit. @param {string} root @param {string} commit @param {string} file */
export function readAt(root, commit, file) {
  return git(root, ["show", `${commit}:${file}`]);
}

/** Files changed on this branch, committed or not. @param {string} root */
export function changedFiles(root) {
  let committed = [];
  try {
    committed = lines(git(root, ["diff", "--name-only", baseCommit(root)]));
  } catch {
    committed = []; // no commits yet
  }
  const untracked = lines(git(root, ["ls-files", "-o", "--exclude-standard"]));
  return [...new Set([...committed, ...untracked])].filter((f) => existsSync(join(root, f)));
}

/** A hash of the working tree: changes when any tracked or untracked file does. @param {string} root */
export function fingerprint(root) {
  const hash = createHash("sha256");
  try {
    hash.update(git(root, ["rev-parse", "HEAD"]));
    hash.update(git(root, ["diff", "HEAD", "--binary"]));
  } catch {
    // no commits yet: the file list below covers everything
  }
  for (const file of lines(git(root, ["ls-files", "-o", "--exclude-standard"]))) {
    const path = join(root, file);
    if (existsSync(path)) hash.update(file).update(readFileSync(path));
  }
  return hash.digest("hex");
}

/** @param {string} root */
const statePath = (root) => join(root, "node_modules", ".cache", "raw-stack", "state.json");

/** @param {string} root @returns {{ pass?: string, fail?: string }} */
export function readState(root) {
  try {
    return JSON.parse(readFileSync(statePath(root), "utf8"));
  } catch {
    return {};
  }
}

/** @param {string} root @param {{ pass?: string, fail?: string }} state */
export function writeState(root, state) {
  const path = statePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state));
}

/** The project's vp, or the global one. @param {string} root */
export function vpCommand(root) {
  const local = join(root, "node_modules", ".bin", "vp");
  return existsSync(local) ? local : "vp";
}

export function depcruiseScript() {
  const main = fileURLToPath(import.meta.resolve("dependency-cruiser")); // <pkg>/src/main/index.mjs
  return join(dirname(main), "..", "..", "bin", "dependency-cruiser.mjs");
}

/**
 * Run a command and capture its output.
 * @param {string} label @param {string} cmd @param {string[]} args @param {string} cwd
 * @param {Record<string, string>} [env] extra environment variables
 * @returns {Promise<{ label: string, ok: boolean, output: string, ms: number }>}
 */
export function run(label, cmd, args, cwd, env = {}) {
  const started = performance.now();
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", ...env } });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const done = (/** @type {boolean} */ ok) =>
      resolve({ label, ok, output, ms: Math.round(performance.now() - started) });
    child.on("error", (err) => {
      output += String(err);
      done(false);
    });
    child.on("close", (code) => done(code === 0));
  });
}
