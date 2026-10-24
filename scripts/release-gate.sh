#!/bin/bash
# Release gate for an Accord deploy (lessons of 2026-09-24, steps 1 and 3): EVERY browser check,
# npm test, the three five-in-a-row gates, and the full marks-restart check, on the final commit.
# Also run scripts/all-units.py on this worktree and on the live one, then --compare: npm test
# wires only some of src/tests, and no suite may fail here that passes on live.
# Written by Claude Opus 5.5 (CCc session 1997a29b) for Mike Wolf, 2026-09-24.
# Usage: scripts/release-gate.sh <worktree> <logdir>; then read <logdir>/summary.txt.
WT="$1"; LOG="$2"
cd "$WT" || exit 2
mkdir -p "$LOG"
export PATH="/Users/mikewolf/.local/bin:$PATH"
S="$LOG/summary.txt"
echo "at $(git rev-parse --short HEAD) (+ uncommitted: $(git status --porcelain | grep -vc '\.preview')); node $(node --version)" > "$S"
npm run build > "$LOG/build.log" 2>&1 && echo "build ok" >> "$S" || { echo "build FAILED" >> "$S"; echo "done" >> "$S"; exit 1; }
npm test > "$LOG/npm-test.log" 2>&1; echo "npm test: exit $?" >> "$S"
run() { # check, logfile, label
  local start=$(date +%s)
  node "scripts/$1.mjs" > "$2" 2>&1; local rc=$?
  echo "$1${3:+ $3}: exit $rc, PASS $(grep -c '^PASS' "$2"), FAIL $(grep -c '^FAIL' "$2"), $(( $(date +%s) - start ))s" >> "$S"
  return $rc
}
echo "== every check once" >> "$S"
for f in scripts/*-check.mjs; do
  name=$(basename "$f" .mjs)
  case "$name" in marks-restart-check) continue;; esac
  run "$name" "$LOG/$name.log"
done
echo "== gates (five in a row)" >> "$S"
for check in click-edit-check local-write-resync-check caret-stability-check; do
  for i in 2 3 4 5 6; do run "$check" "$LOG/$check-gate-$i.log" "gate run $i" || break; done
done
echo "== marks-restart (full)" >> "$S"
run marks-restart-check "$LOG/marks-restart-check.log"
echo "done" >> "$S"
