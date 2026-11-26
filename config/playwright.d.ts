export interface RawStackPlaywrightShard {
  current: number;
  total: number;
}

export interface RawStackPlaywrightConfig {
  testDir: string;
  testMatch: string;
  fullyParallel: true;
  retries: 0;
  forbidOnly: boolean;
  use: { trace: "retain-on-failure" };
  projects: Array<{ name: string; use: { browserName: "chromium" | "webkit" } }>;
  shard?: RawStackPlaywrightShard;
}

export declare function parsePlaywrightShard(raw: string | undefined): RawStackPlaywrightShard | undefined;
export declare function rawStackPlaywright(options?: { ci?: boolean }): RawStackPlaywrightConfig;
