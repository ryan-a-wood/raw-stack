import { formatName } from "./format.ts";

/** The greeting module's whole interface. */
export function greet(name: string): string {
  return `Hello, ${formatName(name)}!`;
}
