// End-to-end: run the app the way a user does and check what they see.
// One test per feature in FEATURES.md.
//
// The second test is an expect test: toMatchInlineSnapshot() records what the
// app printed, right here in the file. Write it empty and run `vp test --project
// e2e` to fill it in, then read what it recorded. Changing a recorded snapshot
// needs a maintainer's approval on the PR.
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
    expect(await app()).toMatchInlineSnapshot(`
      "Hello, world!
      "
    `);
  });
});
