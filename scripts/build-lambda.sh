#!/usr/bin/env bash
# Builds backend/dist/lambda.zip (source + production node_modules).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/backend"

rm -rf build dist
mkdir -p build dist
cp -r src migrations package.json build/
[ -f package-lock.json ] && cp package-lock.json build/

cd build
if [ -f package-lock.json ]; then
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund
else
  npm install --omit=dev --ignore-scripts --no-audit --no-fund
fi

# Fixed timestamps + sorted file list => identical zip for identical content,
# so Terraform only redeploys the function when the code really changed.
find . -exec touch -h -d '2020-01-01 00:00:00' {} +
find . -type f | LC_ALL=C sort | zip -X -q ../dist/lambda.zip -@

cd ..
echo "Built $(pwd)/dist/lambda.zip ($(du -h dist/lambda.zip | cut -f1))"
