#!/bin/sh
# Canonical soma-feedback v4.1 (2026-08-07), copied verbatim on 2026-09-15.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
canonical=${SOMA_FEEDBACK_SOURCE:-/Users/mikewolf/Projects/SOMA/standards/soma-feedback}
for asset in soma-feedback.js soma-feedback.css; do
  if [ "${1:-}" = '--check' ]; then
    cmp "$canonical/$asset" "$repo/public/vendor/soma-feedback/$asset"
  else
    cp "$canonical/$asset" "$repo/public/vendor/soma-feedback/$asset"
  fi
done
