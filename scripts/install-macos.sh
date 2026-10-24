#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
SOURCE="build/arxiv.app"
TARGET="/Applications/arxiv.app"
if [ ! -x "$SOURCE/Contents/MacOS/arxiv" ]; then
  echo "Run npm run bundle first." >&2
  exit 1
fi
if pgrep -f '^/Applications/arxiv.app/Contents/MacOS/arxiv' > /dev/null; then
  osascript -e 'tell application id "app.arxiv.reader" to quit'
  for attempt in {1..20}; do
    if ! pgrep -f '^/Applications/arxiv.app/Contents/MacOS/arxiv' > /dev/null; then break; fi
    sleep 0.25
  done
  if pgrep -f '^/Applications/arxiv.app/Contents/MacOS/arxiv' > /dev/null; then
    echo "arxiv is still open. Save any pending changes and quit it before installing." >&2
    exit 1
  fi
fi
# Verify staging before touching the installed app. Keep the old bundle until
# the replacement is ready, and roll back if installation fails.
codesign --verify --deep --strict "$SOURCE"
BACKUP="build/arxiv-previous.app"
if [ -e "$BACKUP" ]; then echo "Previous install backup exists: $BACKUP" >&2; exit 1; fi
if [ -e "$TARGET" ]; then mv "$TARGET" "$BACKUP"; fi
if ! ditto "$SOURCE" "$TARGET" || ! codesign --verify --deep --strict "$TARGET"; then
  rm -rf "$TARGET"
  if [ -e "$BACKUP" ]; then mv "$BACKUP" "$TARGET"; fi
  exit 1
fi
rm -rf "$BACKUP" "$SOURCE"
open "$TARGET"
echo "Installed /Applications/arxiv.app"
