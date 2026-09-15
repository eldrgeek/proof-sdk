# make-docs.py <label> — runs ON the VPS (fed over ssh on stdin): create one fresh Proof document per live check.
# Reads the API key from ~/proof-data/proof.env and never prints it. Saves each document's tokenUrl and tokens to
# ~/proof-data/<check>-<label>.json with mode 600, and prints "<name> <slug>" only.
# Authored 2026-09-14 by Claude Opus 5 (CCc) for Mike Wolf.
import json
import os
import sys
import urllib.request

label = sys.argv[1]
env = dict(l.rstrip("\n").split("=", 1) for l in open("/home/ubuntu/proof-data/proof.env") if "=" in l)

PLAY = "# Proof E2E\n\nERIC\\\nI think teh play is ready.\n\nDIANA\\\nThe second act needs one more scene.\n"
BLOCK = "# Block test\n\nIntro paragraph one.\n\n| Name | Role |\n| --- | --- |\n| Eric | Writer |\n| Diana | Director |\n\nClosing paragraph.\n"
FMT1 = "# Format test\n\nThe **Format** line sets the style for the play.\n\nRead [the guide](https://example.com/guide) before you start.\n\nPlain closing line.\n"
FMT2 = ("# Format test 2\n\nThe **Format** line sets the style for the play.\n\nEach **Scene** heading starts a new scene in the play."
        "\n\nThe **Cue** name comes before the speech.\n\nA plain paragraph with no formatting.\n")
FMT3 = ("# Format test 3\n\n**Today:** the editor keeps line breaks after a name.\n\n**Fixed on 14 September.** The caret lands in the"
        " **new** line after Enter.\n\n**Note:** plain words after the label.\n")

DOCS = {
    "e2e-plain": PLAY, "e2e-brackets": PLAY, "two-rev-suggest": PLAY, "two-rev-edit": PLAY,
    "two-rev-same-suggest": PLAY, "two-rev-same-edit": PLAY,
    "rest-reject": PLAY, "agent-live": PLAY, "closetab": PLAY, "agent-concurrent": PLAY,
    "ai-block-accept": BLOCK, "ai-block-reject": BLOCK,
    "ai-format-1": FMT1, "ai-format-2": FMT2, "ai-format-3": FMT3,
}

# Optional check names after the label limit the run to those checks, e.g. `python3 - retry1 agent-concurrent`.
only = set(sys.argv[2:])

for base, markdown in DOCS.items():
    if only and base not in only:
        continue
    name = f"{base}-{label}"
    req = urllib.request.Request(
        "http://127.0.0.1:4400/share/markdown",
        data=json.dumps({"markdown": markdown, "title": "Proof E2E (COS) " + name, "role": "editor"}).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + env["PROOF_SHARE_MARKDOWN_API_KEY"]},
    )
    doc = json.load(urllib.request.urlopen(req, timeout=30))
    fd = os.open(f"/home/ubuntu/proof-data/{name}.json", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(doc, f)
    print(name, doc["slug"])
