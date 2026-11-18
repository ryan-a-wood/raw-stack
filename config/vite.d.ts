export interface RawStackConfig {
  lint: Record<string, unknown>;
  fmt: Record<string, unknown>;
  test: { include: string[]; passWithNoTests: boolean };
  staged: Record<string, string | string[]>;
}

/** Lint, format, test and pre-commit settings shared by every raw-stack project. */
export function rawStack(): RawStackConfig;
