#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
tray_dir="$repo_dir/apps/macos/ModelRouterTray"
# One companion per user, not one per checkout. A default inside the
# repository built a separate bundle for every clone and left launchd pointing
# at whichever one installed last; ~/Applications is also a LaunchServices
# location, so the app resolves by name and can be found and quit normally.
# src/tray-install.mjs trayBundleDir() holds the same path for the Node side.
bundle_dir=${1:-"$HOME/Applications/Model Router.app"}
configuration=${MODEL_ROUTER_TRAY_CONFIGURATION:-release}
binary_dir="$tray_dir/.build/$configuration"

# Callers capture this script's stdout as the bundle path, so compiler
# progress must not land there.
swift build -c "$configuration" --package-path "$tray_dir" 1>&2
mkdir -p "$bundle_dir/Contents/MacOS" "$bundle_dir/Contents/Resources"
cp "$binary_dir/ModelRouterTray" "$bundle_dir/Contents/MacOS/ModelRouterTray"
cp "$tray_dir/Resources/Info.plist" "$bundle_dir/Contents/Info.plist"
if [ -d "$binary_dir/ModelRouterTray_ModelRouterTray.bundle" ]; then
  rm -rf "$bundle_dir/Contents/Resources/ModelRouterTray_ModelRouterTray.bundle" \
    "$bundle_dir/ModelRouterTray_ModelRouterTray.bundle"
  cp -R "$binary_dir/ModelRouterTray_ModelRouterTray.bundle" "$bundle_dir/Contents/Resources/"
  # SwiftPM's generated accessor resolves resources from Bundle.main.bundleURL
  # (the .app itself) and falls back to the build directory — it never looks in
  # Contents/Resources. Without this copy the app runs only while .build
  # survives, and dies with a fatalError once that is cleaned.
  cp -R "$binary_dir/ModelRouterTray_ModelRouterTray.bundle" "$bundle_dir/"
fi
printf '%s\n' "$repo_dir" > "$bundle_dir/Contents/Resources/router-root"

printf '%s\n' "$bundle_dir"
