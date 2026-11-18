# Features

What the app does, from the user's side. Each feature says how to use it, what the user should see, and which e2e test covers it. Agents use this as the checklist when they verify a change, and reviewers grade against it.

Add a feature here and its e2e test in the same change. Remove both when the feature goes.

## Greeting

Run `node src/main.ts <name>`.

- With a name: prints `Hello, <name>!`. Example: `node src/main.ts Ryan` prints `Hello, Ryan!`.
- With no name, or only spaces: prints `Hello, world!`.

Covered by `e2e/greeting.test.ts`.
