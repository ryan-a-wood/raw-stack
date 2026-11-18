// Internal to the greeting module. Other code imports the module's index.ts.
export function formatName(name: string): string {
  const trimmed = name.trim();
  return trimmed === "" ? "world" : trimmed;
}
