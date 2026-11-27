// @ts-check
// Tests for template skill files shipped in template/.claude/skills/.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const AUDIT_SKILL = fileURLToPath(
  new URL("../template/.claude/skills/audit/SKILL.md", import.meta.url),
);

/**
 * Parse simple `key: value` YAML frontmatter from a Markdown skill file.
 * @param {string} content
 * @returns {{ fields: Record<string, string>, body: string }}
 */
function parseFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  assert.ok(match, "expected YAML frontmatter delimited by --- lines");
  /** @type {Record<string, string>} */
  const fields = {};
  for (const rawLine of (match[1] ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    assert.ok(colon > 0, `expected key: value frontmatter line, got: ${rawLine}`);
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    fields[key] = value;
  }
  return { fields, body: (match[2] ?? "").trim() };
}

describe("template audit skill", () => {
  test("ships template/.claude/skills/audit/SKILL.md with valid frontmatter", () => {
    assert.equal(existsSync(AUDIT_SKILL), true, "expected template/.claude/skills/audit/SKILL.md to exist");

    const content = readFileSync(AUDIT_SKILL, "utf8");
    const { fields, body } = parseFrontmatter(content);

    assert.equal(fields["name"], "audit");
    assert.equal(typeof fields["description"], "string");
    assert.ok((fields["description"] ?? "").length > 0, "expected non-empty description in frontmatter");
    assert.ok(body.length > 0, "expected non-empty skill body");
  });
});
