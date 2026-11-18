import { describe, expect, it } from "vite-plus/test";
import { greet } from "./index.ts";

describe("greet", () => {
  it("greets by name", () => {
    expect(greet("Ryan")).toBe("Hello, Ryan!");
  });

  it("falls back to world for a blank name", () => {
    expect(greet("  ")).toBe("Hello, world!");
  });
});
