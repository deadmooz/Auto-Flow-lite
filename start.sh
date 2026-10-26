#!/usr/bin/env sh
# Start LiteForeFlow on macOS / Linux:   ./start.sh      (first time: chmod +x start.sh)
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  LiteForeFlow needs Node.js, which is not installed yet."
  echo "  1. Go to https://nodejs.org/en/download and install the LTS version."
  echo "  2. Open a new terminal and run ./start.sh again."
  echo ""
  exit 1
fi

node scripts/preflight.cjs || exit 1

if [ ! -d node_modules/express ]; then
  echo ""
  echo "  First start: installing LiteForeFlow (about a minute, needs internet, only once)..."
  echo ""
  npm install --no-audit --no-fund --loglevel=error || {
    echo ""
    echo "  The install did not finish. Check your internet connection and run ./start.sh again."
    exit 1
  }
fi

LITEFOREFLOW_OPEN="${LITEFOREFLOW_OPEN:-1}" exec node --max-semi-space-size=2 --max-old-space-size=192 server/src/index.js
