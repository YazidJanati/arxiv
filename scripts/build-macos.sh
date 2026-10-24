#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
APP="build/arxiv.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp native/Info.plist "$APP/Contents/Info.plist"
rm -rf "$APP/Contents/Resources/web"
cp -R dist "$APP/Contents/Resources/web"
xcrun swiftc -O -target "$(uname -m)-apple-macos12.0" -framework AppKit -framework WebKit native/App.swift -o "$APP/Contents/MacOS/arxiv"
# Draw a simple type-only icon with native tools; no downloaded image assets.
xcrun swiftc -framework AppKit scripts/icon.swift -o build/draw-icon
build/draw-icon build
iconutil -c icns build/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
echo "Built $APP"
