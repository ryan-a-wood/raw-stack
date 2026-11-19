---
name: verify
description: Prove a change works by running the app, not just the tests. Use before every commit and before opening a PR.
---

# Verify

A change is done when you've seen it work in the running app. Passing unit tests isn't enough.

## Steps

1. **Full tier.** Run `pnpm verify`. It runs format, lint, type checks, the unit tests (property tests at 1000 runs each), the e2e tests in `e2e/`, dependency-cruiser and the guard. Fix everything it reports. A test that fails once and passes on a rerun still failed: treat it as flaky (see below).
2. **Run the app.** Use each feature your change touches, the way `FEATURES.md` describes it, and compare what you see with what it says. For this app that means running `node src/main.ts` with and without a name.
3. **Cover the change end to end.** A new or changed feature needs its `FEATURES.md` entry and an e2e test in `e2e/` that runs the app and checks what the user sees. E2e tests start the real app (a process, a server, or a browser with Playwright) and don't import from `src/`. If the change adds or changes logic over many possible inputs, also add or update a property test in the module (see `AGENTS.md`).
4. **Review.** Do the remaining steps in the home repo's `docs/verify.md`, such as the fresh-context code review.
5. **Evidence.** Put the `pnpm verify` summary and what you saw when you ran the app in the PR description. For a UI, attach screenshots.

If a check still fails after three rounds of fixes, stop and say what's failing instead of working around it. Never skip, retry or loosen a test to get it to pass: fix the cause, or delete the test and say why.

There are zero retries, and the guard rejects them. If a test fails only sometimes, it's flaky: fix the cause now, don't rerun until it passes. If the test no longer states a requirement in `FEATURES.md`, delete it and say why in the PR.

## Keep this skill current

When the app grows a server, a UI or a new way to start it, update step 2 with the exact commands, ports and URLs, so the next agent doesn't have to work them out. Keep it fast: this is the smoke test every change goes through.
