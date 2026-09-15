# health-and-logs.py <label> — runs ON the VPS (fed over ssh on stdin) after the live checks.
# Prints the live How-To document's health, then, for every document created for <label>, how many times the
# server log shows a clearing rebuild, a dropped live write, or a dropped tombstoned mark for it.
# Never prints tokens.
# Authored 2026-09-14 by Claude Opus 5 (CCc) for Mike Wolf.
import glob
import json
import os
import subprocess
import sys
import urllib.request

label = sys.argv[1]

howto = json.load(open("/home/ubuntu/proof-data/howto-doc.json"))
req = urllib.request.Request(
    "http://127.0.0.1:4400/documents/%s/state" % howto["slug"],
    headers={"Authorization": "Bearer " + howto["accessToken"], "X-Agent-Id": "cos-probe"},
)
state = json.load(urllib.request.urlopen(req, timeout=30))
md = state.get("markdown") or ""
print(
    "HOW-TO", howto["slug"],
    {k: state.get(k) for k in ("readSource", "projectionFresh", "mutationReady", "revision")},
    "chars", len(md),
    "markup-in-text:", any(t in md for t in ("data-id=", "data-kind=", "data-proof=")),
    "pending:", sum(1 for m in (state.get("marks") or {}).values() if m.get("status") == "pending"),
)

lines = subprocess.run(["pm2", "logs", "proof", "--lines", "20000", "--nostream"], capture_output=True, text=True).stdout.splitlines()
for path in sorted(glob.glob(f"/home/ubuntu/proof-data/*-{label}.json")):
    name = os.path.basename(path)[: -len(".json")]
    slug = json.load(open(path))["slug"]

    def count(tag: str) -> int:
        return sum(1 for i, line in enumerate(lines) if tag in line and any(slug in x for x in lines[i:i + 4]))

    print(
        name, slug,
        "rebuilds:", count("Pending Yjs delta before clear"),
        "dropped-live-writes:", count("live client write dropped"),
        "tombstoned-drops:", count("dropped tombstoned mark"),
    )
