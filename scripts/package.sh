#!/usr/bin/env bash
# Build WASM + package extension zip per target.
# Usage: scripts/package.sh <version> [chromium|firefox|all] [--no-model]
#   version    : dotted numeric, e.g. 0.1.0 (from git tag, without the 'v' prefix)
#   --no-model : omit lib/vendor/models — the extension then downloads the
#                weights from Hugging Face on first use (needs network, and any
#                CDN redirect outside manifest host_permissions will fail).
# Output   : dist/<target>/  and  dist/speaky-<target>-<version>.zip
set -euo pipefail

ARGS=()
BUNDLE_MODEL=1
for a in "$@"; do
  case "$a" in
    --no-model) BUNDLE_MODEL=0 ;;
    *) ARGS+=("$a") ;;
  esac
done
# bash 3.2 (macOS) treats an empty array as unbound under `set -u`.
set -- ${ARGS[@]+"${ARGS[@]}"}

VERSION="${1:?version required, e.g. 0.1.0}"
TARGET="${2:-all}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Files/dirs included in every package (besides the generated manifest).
ASSETS=(pkg background content sidepanel offscreen options lib assets)

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
  # Ship the vendored weights by default: the runtime download is the single
  # biggest source of "no transcript" failures (large files, CDN redirects to
  # hosts outside host_permissions). base is ~40 MB, which packages fine.
  if [[ "$BUNDLE_MODEL" == "0" ]]; then
    rm -rf "$out/lib/vendor/models"
  elif [[ ! -d "$out/lib/vendor/models" ]]; then
    echo "!! no vendored model — run scripts/vendor-model.sh base (or pass --no-model)" >&2
    exit 1
  fi

  if [[ "$target" == "firefox" ]]; then
    # Firefox MV3 differences from Chromium:
    #  - no background.service_worker → event-page background.scripts (module)
    #  - no sidePanel API → use sidebar_action (the caption-only path)
    #  - no offscreen / tabCapture (Chromium-style) → drop them; the Phase 3
    #    audio pipeline is Chromium-only, Firefox runs the caption path.
    jq --arg v "$MANIFEST_VERSION" '
      .version = $v
      | .background = { "scripts": ["background/service_worker.js"], "type": "module" }
      | .permissions = (.permissions - ["sidePanel", "offscreen", "tabCapture"])
      | del(.side_panel)
      | .sidebar_action = {
          "default_panel": "sidepanel/sidepanel.html",
          "default_title": "Speaky",
          "default_icon": "assets/Speaky-48.png"
        }
      | .browser_specific_settings = {
          "gecko": {
            "id": "speaky@dimas.local",
            "strict_min_version": "128.0"
          }
        }
    ' manifest.json > "$out/manifest.json"
  else
    # Chromium (Chrome/Edge/Opera/Brave): use the manifest as-is + version.
    jq --arg v "$MANIFEST_VERSION" '.version = $v' manifest.json > "$out/manifest.json"
  fi

  ( cd "$out" && zip -qr "../speaky-$target-$VERSION.zip" . )
  echo "==> dist/speaky-$target-$VERSION.zip"
}

case "$TARGET" in
  chromium) assemble chromium ;;
  firefox)  assemble firefox ;;
  all)      assemble chromium; assemble firefox ;;
  *) echo "unknown target: $TARGET" >&2; exit 1 ;;
esac
