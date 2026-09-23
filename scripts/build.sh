#!/bin/bash
# Builds the engine, the helper binaries, and the macOS app bundle.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
triple="aarch64-apple-darwin"

echo "Building the Swift engine"
(cd "$root/engine" && swift build -c release)

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
(cd "$root/app" && pnpm install --frozen-lockfile && pnpm tauri build)

app="$root/target/release/bundle/macos/Tinta.app"
codesign --force --deep --sign - "$app"
codesign --verify --strict --deep "$app"
echo "Built: $app"
