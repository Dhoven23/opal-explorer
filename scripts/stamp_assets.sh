#!/usr/bin/env bash
# Bust browser cache on each deploy by stamping a version string into
# the asset query strings in index.html. Replaces *whatever* is currently
# in ?v=... with a fresh value, so this works on the initial placeholder
# (__ASSET_VERSION__) and on every subsequent commit.
#
# Run from the pre-commit hook (.git/hooks/pre-commit -> ./scripts/stamp_assets.sh)
# or manually: ./scripts/stamp_assets.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# Version: short SHA of HEAD if available, else a timestamp.
if SHA=$(git rev-parse --short HEAD 2>/dev/null); then
  VERSION="${SHA}-$(date +%Y%m%d%H%M%S)"
else
  VERSION="$(date +%Y%m%d%H%M%S)"
fi

# Replace any current ?v=... value with the new one (BSD-sed compatible).
# This regex matches: ?v=<anything except a double-quote>.
sed -i.bak -E "s/\\?v=[^\"]+/?v=${VERSION}/g" index.html
rm -f index.html.bak

git add index.html
echo "stamp_assets: stamped ?v=${VERSION}"
