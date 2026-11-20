# raw-stack

Guardrails for TypeScript projects on [Vite+](https://viteplus.dev), built so agents find their mistakes fast:

- **Strict TypeScript** (TS 7): `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `erasableSyntaxOnly` and more.
- **Type-aware Oxlint**, every finding an error: no `any`, no unsafe calls, no floating promises, exhaustive switches, size limits.
- **Deep modules** enforced by dependency-cruiser: each `src/modules/<name>/index.ts` is the module's only way in. Also no cycles, orphans, undeclared deps or dev deps in shipped code.
- **Guard**: no suppression comments, and project config can't loosen the shared rules. It loads `vite.config.ts` and checks the resolved test settings, so a project can't drop the unit or e2e test projects or narrow which tests they run.
- **Browser tests** (opt-in): `raw-stack/playwright` exports `rawStackPlaywright()` for `playwright.config.ts`: fully parallel, Chromium only locally, Chromium and WebKit in CI (inside Playwright's image, so nothing installs), traces kept on failure, no retries. The guard rejects `waitForTimeout`, `waitForSelector` and CSS or XPath selectors, and `verify --full` runs `playwright test` when the config exists.
- **Zero test retries**: a flaky test gets its cause fixed, or is deleted if it no longer states a requirement. The guard rejects `retry` in the config and on test tags, `{ retry }` or Playwright `retries` in test files, `--retry`/`--retries` in package.json scripts and CI workflows, and `vitest.config.*` files, which Vitest reads instead of `vite.config.ts`.
- **Claude Code hooks** for a tiered verify loop: lint after each edit (about 0.4 s), the fast tier on Stop (1 to 3 s, blocking), the full tier before a PR.
- **E2e first**: the template has an `e2e/` test project that runs the real app, a `FEATURES.md` map of what the app does, and a `verify` skill that drives both.
- **Property tests**: [fast-check](https://fast-check.dev) generates inputs and checks a rule holds for all of them. raw-stack sets the run count (100 per property, 1000 in the full tier), and the guard rejects `numRuns`, `seed` and the other settings that weaken a property.
- **Expect tests** that change only by hand: inline snapshots (`toMatchInlineSnapshot`) in `e2e/` only, where they record what the user sees. The full tier never writes a snapshot, the guard rejects them in unit tests and rejects snapshot files, and the template's CI lists every new, changed or removed snapshot, with its old value, in the PR's job summary.

This repo is two things:

- The package `raw-stack` at the root: the shared config, the `raw-stack` CLI and the hook scripts. Projects install it as a git dependency pinned to a tag, so updating every project is a tag bump.
- `template/`: the starter project.

## Start a project

```bash
pnpm dlx giget@3 gh:ryan-a-wood/raw-stack/template#v0.4.0 my-app
cd my-app && git init && pnpm install
```

Then rename the package in `package.json` and the heading in `AGENTS.md`.

## Update a project

Change the tag in `package.json` (`"raw-stack": "github:ryan-a-wood/raw-stack#v0.4.0"`) and run `pnpm install`.

## CLI

- `raw-stack verify`: fast tier. `vp check --fix`, tests related to files changed on this branch, dependency-cruiser on `src/`, guard.
- `raw-stack verify --full`: everything, no fixes: unit tests with 1000 runs per property test, never writing snapshots, the e2e tests in `e2e/` (they run the real app), plus the rest.
- `raw-stack guard [files...]`: suppression comments, fast-check settings that weaken a property, snapshots outside `e2e/` or in separate files, test retries, config overrides, and a verify workflow that no longer runs `pnpm verify` and the snapshot report.
- `raw-stack cloudflare-secrets [--repo owner/name] [--account-id id] [--config file] [--dry-run]`: creates a Cloudflare API token scoped to what the project's wrangler config deploys and stores it as the GitHub Actions secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. See [Deploy to Cloudflare](#deploy-to-cloudflare).
- `raw-stack snapshots [--base <ref>]`: compares the inline snapshots with where the branch left `<ref>` (default: the default branch) and lists the new, changed and removed ones, with the old values. It reports and never fails.

## Deploy to Cloudflare

For a project that deploys a Worker from GitHub Actions, run this on your own machine from the repo root:

```bash
pnpm exec raw-stack cloudflare-secrets --dry-run   # show the permissions, create nothing
pnpm exec raw-stack cloudflare-secrets
```

It reads `wrangler.jsonc`, `wrangler.json` or `wrangler.toml` (the top level and every `env.*`), creates an account-owned API token named `github-actions <owner>/<repo>` with only the permissions that config needs, and sets the repo's `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets with `gh secret set`. A deploy workflow uses those two names:

| The config has | The token gets |
| --- | --- |
| any Worker | Workers Scripts Write, Account Settings Read (account) |
| `d1_databases` | D1 Write (account) |
| `kv_namespaces` | Workers KV Storage Write (account) |
| `r2_buckets` | Workers R2 Storage Write (account) |
| `queues` | Queues Write (account) |
| `routes` or `route`, including custom domains | Workers Routes Write on each route's zone only |

Cloudflare's Workers, D1, KV, R2 and Queues permissions cover the whole account; they can't be limited to one Worker or database. Custom domains need no DNS permission: Workers Routes Write on the zone covers them. Anything else in the config (Vectorize, Hyperdrive, Workers AI, Workflows and so on) stops the command before it creates anything, so add its permission here first.

The token's value is never printed, logged, written to disk or passed as an argument: it goes from Cloudflare's response to `gh`'s stdin. Rerunning is safe: it creates a fresh token, updates the secrets, then revokes the older tokens with the same name, and says so plainly if a revoke fails. If setting a secret fails, it revokes the new token and leaves everything as it was. It checks that `gh` is signed in and can manage the repo's secrets, that the bootstrap token works, and that every zone resolves before it creates anything.

**One-time setup: the bootstrap token.** The command uses a Cloudflare API token that can only create API tokens. Make it once:

1. In the Cloudflare dashboard, go to **Manage Account > Account API Tokens > Create Token > Custom token**.
2. Permissions: **Account > Account API Tokens > Edit**. Add **Zone > Zone > Read** (all zones in the account) so the command can find the zones your routes use; without it, set `zone_id` on each route.
3. Account resources: your account only.
4. Store it where the command looks, in this order:
   - the macOS keychain (recommended): `security add-generic-password -s raw-stack-cloudflare-bootstrap -a "$USER" -w` and paste the token at the prompt;
   - the file `~/.config/raw-stack/cloudflare-bootstrap-token` (or under `$XDG_CONFIG_HOME`), mode 600; the command refuses a file others can read;
   - or `$RAW_STACK_CLOUDFLARE_BOOTSTRAP_TOKEN`, set yourself for one run.

Keep it on your machine only: not in a repo, not in CI, not in an agent's environment.

The account is the `--account-id` flag, then the config's `account_id`, then `$CLOUDFLARE_ACCOUNT_ID`, then the one account the bootstrap token can see.

## Working on raw-stack

`scripts/try-template.sh [dir]` copies the template, points it at this checkout, installs and runs the full tier. Run it after every change. `npm test` runs raw-stack's own tests in `test/` (for example `cloudflare-secrets` against a fake Cloudflare API and a fake `gh`). CI (`.github/workflows/ci.yml`) runs both on every PR and push to `main`.

To edit the template with type checking in your editor, run `scripts/install-template.sh` once. It installs `template/` in place with `raw-stack` linked to this checkout. Without it the editor can't resolve `raw-stack/tsconfig.json` or `vite-plus`, so it falls back to default compiler options and flags every `.ts` import. To release, tag `vX.Y.Z`, push the tag, and bump the ref in `template/package.json`.
