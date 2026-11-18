#!/usr/bin/env bash
# Install template/ in place so editors can type-check it: its tsconfig extends
# raw-stack/tsconfig.json and its tests import vite-plus, and neither resolves
# without node_modules. raw-stack is linked to this checkout, so config edits
# show up live. Skips the prepare script, which would set this repo's git hooks.
# Usage: scripts/install-template.sh
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo/template"
pnpm install --ignore-scripts --no-lockfile --silent
rm -rf node_modules/raw-stack
ln -s ../.. node_modules/raw-stack
echo "template installed; restart your editor's TypeScript server"
