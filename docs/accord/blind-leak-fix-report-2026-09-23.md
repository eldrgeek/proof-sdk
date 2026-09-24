**1. What changed**

Built ac-0f4 on `codex/accord-blind-leaks`. The existing reveal rule now protects all 13 confirmed findings. The owner credential retains its administrative view.

| Finding | Change and location |
|---|---|
| 1 | Page and agent objections require whole-span reveal. [blind-view.ts:28](/Users/mikewolf/Projects/.fleet-wt/accord-blind-leaks/server/blind-view.ts:28) |
| 2 | Event reads filter stored history, including acknowledged events. [blind-view.ts:54](/Users/mikewolf/Projects/.fleet-wt/accord-blind-leaks/server/blind-view.ts:54) |
| 3 | Exports filter objections, proxies, history, and counts. Blind `/state` omits imported history. [proof-dialect.ts:341](/Users/mikewolf/Projects/.fleet-wt/accord-blind-leaks/server/proof-dialect.ts:341) |
| 4 | Blind `?for=` briefs require the person, their Familiar, or the administrative owner. [agent-routes.ts:3866](/Users/mikewolf/Projects/.fleet-wt/accord-blind-leaks/server/agent-routes.ts:3866) |
| 5 | One ask serializer hides answers and answer-dependent state. [blind-view.ts:37](/Users/mikewolf/Projects/.fleet-wt/accord-blind-leaks/server/blind-view.ts:37) |
| 6 | Blind snapshot-file downloads deny non-administrative readers. Stored snapshots remain intact. [alignment.ts:271](/Users/mikewolf/Projects/.fleet-wt/accord-blind-leaks/server/alignment.ts:271) |
| 7 | Typed guest and unbound AI identities grant no reveal, including through `since-you`. [routes.ts:2048](/Users/mikewolf/Projects/.fleet-wt/accord-blind-leaks/server/routes.ts:2048), [agent-routes.ts:3940](/Users/mikewolf/Projects/.fleet-wt/accord-blind-leaks/server/agent-routes.ts:3940) |
| 8 | Unrevealed Issue rows and secret-dependent alignment counts are omitted. [proof-extras-eval.ts:283](/Users/mikewolf/Projects/.fleet-wt/accord-blind-leaks/server/proof-extras-eval.ts:283) |
| 9 | Tier signals use visible marks and authorized proxies. [line-tiers.ts:97](/Users/mikewolf/Projects/.fleet-wt/accord-blind-leaks/server/line-tiers.ts:97) |
| 10 | Blind proxy briefs use neutral holds. Ratification also checks the complete internal report. [proxy-marks.ts:344](/Users/mikewolf/Projects/.fleet-wt/accord-blind-leaks/server/proxy-marks.ts:344) |
| 11 | Hidden TTL reports and expiry events omit decision-dependent fields. [blind-view.ts:88](/Users/mikewolf/Projects/.fleet-wt/accord-blind-leaks/server/blind-view.ts:88) |
| 12 | Hidden marks omit revealing origin metadata. [blind.ts:90](/Users/mikewolf/Projects/.fleet-wt/accord-blind-leaks/src/shared/blind.ts:90) |
| 13 | Alternative summaries hide disagreement. Closed history requires reveal, and choice events are withheld. [agent-routes.ts:3953](/Users/mikewolf/Projects/.fleet-wt/accord-blind-leaks/server/agent-routes.ts:3953) |

**2. Tests**

Added [blind-leaks.test.ts](/Users/mikewolf/Projects/.fleet-wt/accord-blind-leaks/src/tests/blind-leaks.test.ts) to `npm test`.

| Finding | Representative test name | Result |
|---|---|---|
| 1 | `1 objections page require whole-span reveal` | Failed before; passes after |
| 2 | `2 pending events filter existing acknowledged objections, proxy and withdrawn answers at read time` | Failed before; passes after |
| 3 | `3 agent dialect filters objections, proxies and imported history` | Failed before; passes after |
| 4 | `4 proxy for query authorizes person, Familiar or administrative owner` | Failed before; passes after |
| 5 | `5 asks state hides answers and answer-dependent state` | Failed before; passes after |
| 6 | `6 page snapshot JSON and ledger deny blind non-owners` | Failed before; passes after |
| 7 | `7 unbound AI cannot borrow reveal` | Failed before; passes after |
| 8 | `8 state Issues and alignment counts do not reveal hidden rejection` | Failed before; passes after |
| 9 | `9 poll tier signals hide others' proxy rejection and positive read` | Failed before; passes after |
| 10 | `10 own proxy brief uses the same neutral hold with and without hidden objections` | Failed before; passes after |
| 11 | `11 state TTL conceals decayed mark IDs and named decision lists` | Failed before; passes after |
| 12 | `12 hidden mark origin cannot prove proxy agreement` | Failed before; passes after |
| 13 | `13 alternative summaries and Issue priorities hide disagreement` | Failed before; passes after |

The complete regression suite produced **36 failures and one passing control before**, then **37 passes after**. The baseline was `51324e9`, whose only change from `63372d6` is the audit document.

Updated the existing dialect test because an export must reveal another person’s mark on a line the reader already marked.

- `npm run build`: passed.
- `npm test`: passed all **37 script groups / 49 test files**.
- TypeScript: **476 errors**, with none in touched files.
- Browser-script syntax and `git diff --check`: passed.

Tests used Node **24.14.0**. The initial Node 22 attempt encountered a SQLite binary mismatch. The tested dependencies are recorded in [npm ls output](/private/tmp/ac-0f4-dependencies.log).

**3. Browser checks for the reviewer**

- `scripts/blind-leaks-check.mjs`: verify hidden payloads, working placeholders, partial-span concealment, and full reveal in both styles at desktop and phone widths.
- `scripts/bundles-alts-check.mjs`: verify existing blind marks, asks, alternatives, and TTL controls.
- `scripts/proxy-marks-check.mjs`: verify ordinary proxy ratification and undo.
- `scripts/line-tiers-check.mjs`: verify ordinary tier behavior.
- `scripts/dialect-check.mjs`: verify download and import behavior.

**4. Limits and risks**

I did not run Chromium or live checks. I did not change UI/editor files, `.preview/`, stored formats, route names, or selectors. I left the work uncommitted.

Blind responses intentionally omit fields documented in [agent-docs.md](/Users/mikewolf/Projects/.fleet-wt/accord-blind-leaks/docs/agent-docs.md:343).

The page computes proxy briefs locally, so it may still offer “Ratify all” before the server permits it. The server returns a neutral refusal. The audit’s unconfirmed legacy-mark concern remains uninvestigated.

**5. Bead and brief discrepancies**

The audit contains 13 confirmed findings, although the bead names nine. I addressed all 13.

The neutral proxy hold covers the whole document until full reveal. Holding only individual unrevealed lines would leave a gap for objections spanning revealed and hidden lines. A dedicated regression verifies that case.