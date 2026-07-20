#!/usr/bin/env bash
# Build WASM + package extension zip per target.
# Usage: scripts/package.sh <version> [chromium|firefox|all]
#   version : dotted numeric, e.g. 0.1.0 (from git tag, without the 'v' prefix)
# Output   : dist/<target>/  and  dist/meet-transcriber-<target>-<version>.zip
set -euo pipefail

VERSION="${1:?version required, e.g. 0.1.0}"
TARGET="${2:-all}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Files/dirs included in every package (besides the generated manifest).
ASSETS=(pkg background content popup)

# manifest.version must be 1–4 dot-separated integers — browsers reject SemVer
# prerelease strings like "0.2.0-beta.1". Map beta → a numeric 4th component so
# the package still loads (0.2.0-beta.3 → 0.2.0.3). Zip name keeps the full tag.
if [[ "$VERSION" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-beta\.([0-9]+)$ ]]; then
  MANIFEST_VERSION="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
else
  MANIFEST_VERSION="$VERSION"
fi

echo "==> wasm-pack build"
wasm-pack build --target web --out-dir pkg --release

# Drop WASM glue files not needed in the release package.
rm -f pkg/.gitignore pkg/package.json pkg/README.md 2>/dev/null || true

assemble() {
  local target="$1"
  local out="dist/$target"
  rm -rf "$out"
  mkdir -p "$out"
  cp -R "${ASSETS[@]}" "$out/"

  if [[ "$target" == "firefox" ]]; then
    # Firefox MV3 does NOT support background.service_worker (chromium-only).
    # Convert to an event-page background.scripts (module) + add a gecko id.
    jq --arg v "$MANIFEST_VERSION" '
      .version = $v
      | .background = { "scripts": ["background/service_worker.js"], "type": "module" }
      | .browser_specific_settings = {
          "gecko": {
            "id": "meet-transcriber@dimas.local",
            "strict_min_version": "128.0"
          }
        }
    ' manifest.json > "$out/manifest.json"
  else
    # Chromium (Chrome/Edge/Opera/Brave): use the manifest as-is + version.
    jq --arg v "$MANIFEST_VERSION" '.version = $v' manifest.json > "$out/manifest.json"
  fi

  ( cd "$out" && zip -qr "../meet-transcriber-$target-$VERSION.zip" . )
  echo "==> dist/meet-transcriber-$target-$VERSION.zip"
}

case "$TARGET" in
  chromium) assemble chromium ;;
  firefox)  assemble firefox ;;
  all)      assemble chromium; assemble firefox ;;
  *) echo "unknown target: $TARGET" >&2; exit 1 ;;
esac
