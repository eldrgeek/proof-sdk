# Proof suggesting-mode probes

_Authored 2026-09-14 by Claude Opus 5 (CCc, the Proof session) for Mike Wolf. Rebuilt the same day, after a session
restart wiped the scratchpad they first lived in._

These scripts check the self-hosted Proof at https://proof.vpsmikewolf.duckdns.org in headless Chromium. Each one
takes `PROOF_DOC_URL`, a document's tokenized share link, and never prints it. Playwright comes from
`/Users/mikewolf/Projects/playmaker/node_modules`. Use a fresh document for every run.

## Making a fresh document

Run this on the VPS. It reads the API key from `~/proof-data/proof.env` without printing it, and it saves the new
document's link and tokens to `~/proof-data/<name>.json` with mode 600. Replace `<name>` and the markdown.

```
ssh vps 'cd ~/proof-data && python3 - <<"PY"
import json, os, urllib.request
env = dict(l.rstrip("\n").split("=", 1) for l in open("proof.env") if "=" in l)
md = "# Proof E2E\n\nERIC\\\nI think teh play is ready.\n\nDIANA\\\nThe second act needs one more scene.\n"
name = "<name>"
req = urllib.request.Request("http://127.0.0.1:4400/share/markdown", data=json.dumps({"markdown": md, "title": "Proof E2E (COS) " + name, "role": "editor"}).encode(), method="POST", headers={"Content-Type": "application/json", "Authorization": "Bearer " + env["PROOF_SHARE_MARKDOWN_API_KEY"]})
doc = json.load(urllib.request.urlopen(req, timeout=30))
fd = os.open("/home/ubuntu/proof-data/%s.json" % name, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w") as f: json.dump(doc, f)
print(name, doc["slug"])
PY'
```

Then run a probe with the link read on the fly:

```
PROOF_DOC_URL="$(ssh vps 'python3 -c "import json;print(json.load(open(\"/home/ubuntu/proof-data/<name>.json\"))[\"tokenUrl\"])"')" node <probe>.mjs
```

## The scripts

| Script | What it checks | Document | Settings |
|---|---|---|---|
| `e2e-suggest.mjs` | The 13-step browser test: type, reload, card, Accept, Reject, Accept all, Reject all, final reload, server state. Screenshots and `summary.json` go to `OUT_DIR`. | play format (below) | `OUT_DIR`, `TEXT=plain\|brackets` |
| `two-reviewer-probe.mjs` | Two people typing at the same moment, then resolving each other's suggestions | play format | `MODE=suggest\|edit`, `SEPARATE_BROWSERS=1` |
| `caret-jump-probe.mjs` | Whether another person's typing moves a caret that isn't moving | play format | `MODE=suggest\|edit` |
| `rest-reject-live-probe.mjs` | An AI's REST reject while a person edits: edits kept, reject sticks | play format | — |
| `agent-live-probe.mjs` | An AI's insert suggestion while a person edits | play format | — |
| `close-tab-probe.mjs` | An Accept followed by closing the tab | play format | `CLOSE_DELAY_MS` |
| `ai-block-probe.mjs` | AI inserts of inline text, a paragraph and a table row | block test | `ACTION=accept\|reject` |
| `ai-format-probe.mjs` | Replace quotes near bold and links | the set's document | `SET=1\|2\|3` |

The play-format document is `# Proof E2E\n\nERIC\\\nI think teh play is ready.\n\nDIANA\\\nThe second act needs one more scene.\n`.
The block-test document is `# Block test\n\nIntro paragraph one.\n\n| Name | Role |\n| --- | --- |\n| Eric | Writer |\n| Diana | Director |\n\nClosing paragraph.\n`.
The formatting documents for each set are written at the top of `ai-format-probe.mjs`.
