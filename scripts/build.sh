#!/bin/bash
# Builds the engine, the helper binaries, and the macOS app bundle.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
triple="aarch64-apple-darwin"

echo "Building the Swift engine"
# The default build system of Swift 6.4 fails on this package with "Unknown error parsing property list".
# The native build system builds it.
if ! (cd "$root/engine" && swift build -c release); then
  echo "Building the Swift engine again with the native build system"
  (cd "$root/engine" && swift build -c release --build-system native)
fi

echo "Building the MCP server and the Chrome native host"
(cd "$root" && cargo build --release -p tinta-mcp -p tinta-native-host)

mkdir -p "$root/app/src-tauri/binaries"
cp "$root/engine/.build/release/tinta-engine" "$root/app/src-tauri/binaries/tinta-engine-$triple"
cp "$root/target/release/tinta-mcp" "$root/app/src-tauri/binaries/tinta-mcp-$triple"
cp "$root/target/release/tinta-native-host" "$root/app/src-tauri/binaries/tinta-native-host-$triple"

if [[ "${1:-}" == "--binaries-only" ]]; then
  exit 0
fi

echo "Building the app bundle"
# app/pnpm-workspace.yaml uses allowBuilds, which pnpm 9 and older reject with "packages field missing or empty".
pnpm_major="$(pnpm --version | cut -d. -f1)"
if (( pnpm_major < 10 )); then
  echo "Tinta needs pnpm 10 or later, and pnpm $(pnpm --version) is installed. Run: npm install -g pnpm@latest" >&2
  exit 1
fi
(cd "$root/app" && pnpm install --frozen-lockfile && pnpm tauri build)

app="$root/target/release/bundle/macos/Tinta.app"
# macOS keeps the permissions and the Keychain access of an app that has the same certificate in each build.
# An ad hoc signature changes with each build, so macOS asks again after each update.
identity="$(security find-identity -v -p codesigning | grep -i '"Tinta Local"' | awk '{print $2}' | head -1 || true)"
if [[ -n "$identity" ]]; then
  echo "Signing with the Tinta Local certificate"
else
  echo "Signing ad hoc. Make a \"Tinta Local\" code signing certificate to keep the permissions after updates."
  identity="-"
fi
codesign --force --deep --sign "$identity" "$app"
codesign --verify --strict --deep "$app"
echo "Built: $app"
