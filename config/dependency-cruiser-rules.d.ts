import type { IForbiddenRuleType } from "dependency-cruiser";

/** Default regex identifying client-side code: `*.client.ts(x)`, `.../client/...`, and `src/browser.ts(x)`. */
export declare const DEFAULT_CLIENT_PATTERN: string;

export interface ClientBoundaryOptions {
  /**
   * Server-only targets that client code must not import (directly or transitively).
   * Each entry may be:
   * - a module name under `src/modules/` (e.g. `"db"`, `"secrets"`),
   * - a Node.js built-in specifier (e.g. `"node:fs"`, or `"node:*"` for all Node core modules), or
   * - a regex path pattern (e.g. `"^src/server/"`, `"\\.server\\.tsx?$"`).
   */
  serverModules: string[];
  /** Regex pattern (or list of patterns) matching client-side source files. Defaults to `DEFAULT_CLIENT_PATTERN`. */
  clientPattern?: string | string[];
  /** Optional custom rule name (must not collide with raw-stack's shared rules). Defaults to `"client-boundary"`. */
  name?: string;
}

export interface DeepSubmodulesOptions {
  /**
   * Module names under `src/modules/` whose subdirectories are treated as encapsulated submodules.
   * Omit to apply to all modules under `src/modules/`.
   */
  modules?: string[];
  /** Optional custom base rule name (must not collide with raw-stack's shared rules). Defaults to `"deep-submodules"`. */
  name?: string;
}

/**
 * Build dependency-cruiser rules preventing client-side files from importing server-only modules.
 * Spread the returned array into `forbidden` in `.dependency-cruiser.cjs`.
 */
export declare function clientBoundary(options: ClientBoundaryOptions): IForbiddenRuleType[];

/**
 * Build dependency-cruiser rules enforcing `src/modules/<mod>/<submod>/index.ts(x)` encapsulation.
 * Spread the returned array into `forbidden` in `.dependency-cruiser.cjs`.
 */
export declare function deepSubmodules(options?: DeepSubmodulesOptions): IForbiddenRuleType[];
