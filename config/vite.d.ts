export interface RawStackConfig {
  lint: Record<string, unknown>;
  fmt: Record<string, unknown>;
  test: { projects: Array<Record<string, unknown>>; passWithNoTests: boolean };
  staged: Record<string, string | string[]>;
}

/** Lint, format, test and pre-commit settings shared by every raw-stack project. */
export function rawStack(): RawStackConfig;

/** Both test projects, unit and e2e: what the guard expects vite.config.ts to resolve to. */
export const TEST_PROJECTS: Array<Record<string, unknown>>;
