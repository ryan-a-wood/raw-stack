// @ts-check
// URL and custom header parsing/validation for `raw-stack smoke` and `rawStackPlaywright()`.
// Header values are treated as secrets and are never echoed in error messages.

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Validate and normalize a smoke-test base URL.
 * Rejects non-strings, empty strings, non-http(s) protocols, missing hostnames,
 * and query strings or hash fragments. Strips trailing slashes.
 * @param {string} raw
 * @returns {string}
 */
export function validateSmokeUrl(raw) {
  if (typeof raw !== "string") {
    throw new Error("Invalid smoke URL: expected a non-empty http(s) URL string.");
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error("Invalid smoke URL: URL must not be empty.");
  }
  if (trimmed.includes("?") || trimmed.includes("#")) {
    throw new Error("Invalid smoke URL: base URL must not include a query string or hash fragment.");
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid smoke URL ${JSON.stringify(trimmed)}: must be a valid http(s) URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid smoke URL ${JSON.stringify(trimmed)}: protocol must be http: or https:.`);
  }
  if (!parsed.hostname) {
    throw new Error(`Invalid smoke URL ${JSON.stringify(trimmed)}: URL must include a hostname.`);
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("Invalid smoke URL: base URL must not include a query string or hash fragment.");
  }
  return parsed.href.replace(/\/+$/, "");
}

/**
 * Parse and validate SMOKE_HEADERS_JSON into a plain Record<string, string>.
 * Security: never includes raw input, JSON.parse error messages, or header values in thrown errors.
 * @param {string | undefined} raw
 * @returns {Record<string, string>}
 */
export function parseSmokeHeaders(raw) {
  if (raw === undefined) return {};
  if (typeof raw !== "string") {
    throw new Error("Invalid SMOKE_HEADERS_JSON: expected a JSON string.");
  }
  if (raw.trim() === "") return {};

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "Invalid SMOKE_HEADERS_JSON: could not parse JSON (expected a JSON object mapping header names to string values).",
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      "Invalid SMOKE_HEADERS_JSON: expected a JSON object mapping header names to string values.",
    );
  }

  /** @type {Record<string, string>} */
  const headers = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (!HEADER_NAME_RE.test(key)) {
      throw new Error("Invalid SMOKE_HEADERS_JSON: header names must be valid HTTP header tokens.");
    }
    if (typeof val !== "string") {
      throw new Error(`Invalid SMOKE_HEADERS_JSON: value for header "${key}" must be a string.`);
    }
    if (/[\r\n]/.test(val)) {
      throw new Error(
        `Invalid SMOKE_HEADERS_JSON: value for header "${key}" must not contain CR or LF characters.`,
      );
    }
    Object.defineProperty(headers, key, {
      value: val,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return headers;
}
