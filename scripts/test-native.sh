#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
TEST_DIR=$(mktemp -d "${TMPDIR:-/tmp}/arxiv-native-test.XXXXXX")
trap 'rm -rf "$TEST_DIR"' EXIT
xcrun swiftc -framework AppKit native/Recommender.swift tests/native-worker/main.swift -o "$TEST_DIR/check"
"$TEST_DIR/check"
