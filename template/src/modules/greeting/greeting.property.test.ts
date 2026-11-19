// Property tests: instead of a few hand-picked examples, fast-check generates
// many inputs and checks a rule that must hold for all of them. When one fails
// it shrinks the input to the smallest case that still breaks the rule.
// raw-stack sets the number of runs: 100 in the fast tier, 1000 in `pnpm verify`.
import * as fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { greet } from "./index.ts";

const blank = fc.stringMatching(/^\s*$/);
const name = fc.string().filter((s) => s.trim() !== "");

describe("greet properties", () => {
  it("greets any non-blank name by its trimmed self", () => {
    fc.assert(
      fc.property(name, (n) => {
        expect(greet(n)).toBe(`Hello, ${n.trim()}!`);
      }),
    );
  });

  it("greets the world for any blank name", () => {
    fc.assert(
      fc.property(blank, (n) => {
        expect(greet(n)).toBe("Hello, world!");
      }),
    );
  });

  it("ignores whitespace around the name", () => {
    fc.assert(
      fc.property(fc.string(), blank, blank, (n, before, after) => {
        expect(greet(`${before}${n}${after}`)).toBe(greet(n));
      }),
    );
  });
});
