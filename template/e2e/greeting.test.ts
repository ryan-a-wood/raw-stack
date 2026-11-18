// End-to-end: run the app the way a user does and check what they see.
// One test per feature in FEATURES.md.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vite-plus/test";

const run = promisify(execFile);

async function app(...args: string[]): Promise<string> {
  const { stdout } = await run(process.execPath, ["src/main.ts", ...args]);
  return stdout;
}

describe("greeting", () => {
  it("greets the name given on the command line", async () => {
    expect(await app("Ryan")).toBe("Hello, Ryan!\n");
  });

  it("greets the world when no name is given", async () => {
    expect(await app()).toBe("Hello, world!\n");
  });
});
