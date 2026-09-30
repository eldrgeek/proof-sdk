1. **What changed — ac-b8r and ac-54j**

- One answer group now provides Agree, Suggest change, Discuss, and Reject. Phone dots open that same group. More, tiers, flags, rejection conditions, “Marked by N,” and Undo remain available. See [line-marks.ts:1970](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s2b/src/ui/line-marks.ts:1970) and [reading-walk.ts:1108](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s2b/src/ui/reading-walk.ts:1108).
- Persistent margin markers show comment and proposal counts. Keyboard activation selects the passage and opens its Review details. See [line-marks.ts:1480](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s2b/src/ui/line-marks.ts:1480).
- Discussion and proposal details now live in Review. Duplicate reply and proposal controls were removed. See [reading-walk.ts:1937](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s2b/src/ui/reading-walk.ts:1937).
- The header, completion text, People, agreement gate, Review counts, and dots share the status and Review computation. See [review-list.ts:87](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s2b/src/shared/review-list.ts:87).
- Personal completion stays on screen without switching views. The agreed-copy offer names the wording revision and participants, or explains whom it awaits. See [reading-walk.ts:2052](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s2b/src/ui/reading-walk.ts:2052) and [participant-status.ts:393](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s2b/src/shared/participant-status.ts:393).
- Zero Issues no longer implies Aligned. See [layout-chrome.ts:106](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s2b/src/shared/layout-chrome.ts:106).

2. **Tests**

`npm run build` passed. `npm test` exited **0** under Node **24.14.0**, across **37 command groups and 49 test files**.

Changed suites passed:

| Suite | Passed | Coverage |
|---|---:|---|
| `layout-panels` | 10 | Answer policy and persistent marker counts |
| `layout-chrome` | 6 | Zero Issues does not claim alignment |
| `open-view` | 24 | Shared status, counts, labels, completion, and agreement gate |
| `participant-status` | 11 | People labels and agreed-copy wording |

The optional `/agent-setup` subsection skipped because its external test service was absent. The remaining server/share checks reported **76 passed, 0 failed**.

TypeScript reports **475 errors on both HEAD and the changed tree**. Diagnostic comparison found **zero new errors**. All **21 edited browser scripts** passed syntax checks. `git diff --check` passed.

3. **Browser checks for the reviewer**

Run all **35 `scripts/*-check.mjs` scripts**. Also run `line-marks-check.mjs --style proof`.

The changed flows need particular attention:

- `usability-acceptance`: ac06, ac08, ac09, and ac12 now contain assertions without TODOs or SKIPs.
- `open-view`, `honest-reading`, `line-marks`: honest labels, persistent completion, and the agreement gate.
- `layout`, `mobile`, `hover-touch`, `reading-walk`, `folding`, `usability-s1`, `ux-consistency`: one phone answer group, preserved controls, focus, and viewport.
- `threads`, `comment`, `review-aids`, `bundles-alts`: details and decisions appear in Review without duplicates.
- `edit-gesture`, `caret-stability`: Suggest change opens the draft through the remaining controls.
- `asks`, `do`, `identity`, `invite`, `line-tiers`: existing capabilities and permissions work through the shared sheet.

The remaining scripts should retain their existing results.

4. **Limits and risks**

Chromium was not run. Phone layout, marker placement, and Review focus preservation remain browser verification risks.

`.preview/` is unchanged. Nothing was committed or deployed. Stored formats, API paths, fields, and events were not renamed. Selectors belonging to removed controls were removed or replaced in the checks.

The displayed **wording revision is a deterministic content fingerprint**, not the server’s revision counter.

5. **Instruction conflicts**

The literal requirement that no diagnostic name a touched file conflicts with the baseline. `src/editor/index.ts` already has **56 errors**. Its necessary integration hooks changed, but all 56 diagnostics remain unchanged.

I found no behavioral requirement to reject.