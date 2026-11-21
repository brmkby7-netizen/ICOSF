#!/bin/sh
# Run by the PrepareRules target before every Xcode build: bundles the filter
# compiler for the app and (at most daily) recompiles the bundled default rules.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Xcode does not inherit your shell's PATH; look in the usual places.
for dir in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.local/share/fnm/aliases/default/bin"; do
  [ -d "$dir" ] && PATH="$dir:$PATH"
done
if [ -d "$HOME/.nvm/versions/node" ]; then
  NVM_NODE="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | tail -1)"
  [ -n "$NVM_NODE" ] && PATH="$NVM_NODE:$PATH"
fi
export PATH

cd "$ROOT"
if ! command -v node >/dev/null 2>&1; then
  if [ -f apple/App/Resources/bastion-compiler.js ] && [ -f apple/ContentBlocker/Bundled/ads/blockerList.json ]; then
    echo "warning: Node.js not found; using previously generated rules."
    exit 0
  fi
  echo "error: Bastion needs Node.js 20+ to build its filter compiler. Install it (brew install node), then build again."
  exit 1
fi

[ -d node_modules/esbuild ] || npm install --no-audit --no-fund
node scripts/build-compiler.mjs

if [ ! -f apple/ContentBlocker/Bundled/ads/blockerList.json ] || [ -z "$(find build/report.json -mtime -1 2>/dev/null)" ]; then
  node scripts/build-rules.mjs || node scripts/build-rules.mjs --placeholder
fi
