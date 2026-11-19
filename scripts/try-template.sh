#!/usr/bin/env bash
# Scaffold template/ into a temp folder against this checkout of raw-stack,
# install, and run the full verify tier. Usage: scripts/try-template.sh [dir]
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
dir="${1:-$(mktemp -d)/app}"
rm -rf "$dir"
cp -R "$repo/template" "$dir"
cd "$dir"
node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.devDependencies["raw-stack"] = "file:" + process.argv[1];
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
' "$repo"
git init -q -b main
pnpm install --silent
git add -A && git -c user.name=raw-stack -c user.email=raw-stack@localhost -c commit.gpgsign=false commit -qm "scaffold" --no-verify
node_modules/.bin/raw-stack verify --full
echo "template OK at $dir"
