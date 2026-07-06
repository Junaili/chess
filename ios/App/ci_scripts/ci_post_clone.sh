#!/bin/sh

set -eu

REPOSITORY_PATH="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "$0")/../../.." && pwd)}"
cd "$REPOSITORY_PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not available; installing it with Homebrew."
  brew install node@22
  export PATH="/opt/homebrew/opt/node@22/bin:/usr/local/opt/node@22/bin:$PATH"
fi

echo "Installing JavaScript and Capacitor plugin dependencies."
npm ci

echo "Building web assets and synchronizing the iOS project."
npm run ios:build

test -d node_modules/@capacitor-community/apple-sign-in
test -d node_modules/@capacitor/app
test -d node_modules/@capacitor/browser

echo "Xcode Cloud dependencies are ready."
