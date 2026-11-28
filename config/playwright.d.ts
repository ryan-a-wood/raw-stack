export interface RawStackPlaywrightShard {
  current: number;
  total: number;
}

export interface RawStackPlaywrightOptions {
  ci?: boolean;
  baseURL?: string;
  webServer?: unknown;
  use?: Record<string, unknown>;
}

export interface RawStackPlaywrightUse extends Record<string, unknown> {
  trace: "retain-on-failure";
  baseURL?: string;
  extraHTTPHeaders?: Record<string, string>;
}

export interface RawStackPlaywrightConfig {
  testDir: string;
  testMatch: string;
  fullyParallel: true;
  retries: 0;
  forbidOnly: boolean;
  use: RawStackPlaywrightUse;
  projects: Array<{ name: string; use: { browserName: "chromium" | "webkit" } }>;
  shard?: RawStackPlaywrightShard;
  webServer?: unknown;
}

export declare function parsePlaywrightShard(raw: string | undefined): RawStackPlaywrightShard | undefined;
export declare function rawStackPlaywright(options?: RawStackPlaywrightOptions): RawStackPlaywrightConfig;
