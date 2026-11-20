// @ts-check
// RAW_STACK_PR_BROWSER_TESTS=off skips browser tests on PR runs only, so the
// push to main, which gates a deploy, always runs them.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { browserTestsOffForThisRun } from "../lib/verify.js";

describe("browser tests off on PRs", () => {
  test("skips them on a PR run when off", () => {
    assert.equal(browserTestsOffForThisRun({ RAW_STACK_PR_BROWSER_TESTS: "off", GITHUB_EVENT_NAME: "pull_request" }), true);
  });

  test("runs them on the push to main even when off", () => {
    assert.equal(browserTestsOffForThisRun({ RAW_STACK_PR_BROWSER_TESTS: "off", GITHUB_EVENT_NAME: "push" }), false);
  });

  test("runs them locally, outside CI, even when off", () => {
    assert.equal(browserTestsOffForThisRun({ RAW_STACK_PR_BROWSER_TESTS: "off" }), false);
  });

  test("runs them on PRs by default", () => {
    assert.equal(browserTestsOffForThisRun({ GITHUB_EVENT_NAME: "pull_request" }), false);
  });

  test("runs them for any other value", () => {
    assert.equal(browserTestsOffForThisRun({ RAW_STACK_PR_BROWSER_TESTS: "false", GITHUB_EVENT_NAME: "pull_request" }), false);
  });
});
