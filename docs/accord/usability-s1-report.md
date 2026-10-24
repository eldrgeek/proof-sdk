1. **What changed**

S1 is implemented. Browser verification remains for the reviewer.

- Sections now fold only through explicit controls or navigation. Choices persist per document and reader. Remote heading edits preserve them. See [folding.ts:99](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s1/src/ui/folding.ts:99). Auto-close, hover peek, fold-to-level and closed-Issue folding were removed.
- Heading marks affect only the heading. “Agree with this section (N lines)” captures text identities and excludes new, changed or ambiguous lines. Existing rejection, permission and Undo protections remain. See [folding.ts:213](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s1/src/shared/folding.ts:213) and [line-marks.ts:2400](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s1/src/ui/line-marks.ts:2400).
- Hover no longer changes the target or ends Writing. J/K visit every visible passage. A collapsed section is one stop. See [reading-walk.ts:957](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s1/src/ui/reading-walk.ts:957) and [edit-session.ts:20](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s1/src/shared/edit-session.ts:20).
- Foreign layout changes preserve the selected passage or writing caret’s screen position. See [caret-anchor.ts:46](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s1/src/editor/caret-anchor.ts:46) and [reading-walk.ts:542](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s1/src/ui/reading-walk.ts:542).
- Incoming review items append without reordering existing items. Focused panel controls survive updates. Rails no longer follow incoming content automatically. Resolution stays expanded until explicit navigation. See [navigator.ts:150](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s1/src/ui/navigator.ts:150), [playmaker-review.ts:148](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s1/src/ui/playmaker-review.ts:148), [threads.ts:191](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s1/src/ui/threads.ts:191) and [rail-follow.ts:69](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s1/src/ui/rail-follow.ts:69).
- Reading writes Seen after dwell. Fast passes write nothing. Provisional acceptance, later-action commits, automatic agreement and their Undo entry were removed. Delayed Seen writes retain text identity. See [reading-walk.ts:142](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s1/src/shared/reading-walk.ts:142) and [reading-walk.ts:1238](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s1/src/ui/reading-walk.ts:1238).
- View now has one Letter shortcuts setting, enabled by default. Fields, Writing, direct Editing and composition block letter commands. See [index.ts:4044](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s1/src/editor/index.ts:4044).

2. **Tests**

`npm run build` passed. `npm test` exited 0: **33 script groups, 45 test files, 492 named checks passed**.

Changed suites:

- `folding`, `reading-walk`, `bundles-alts`, `editing-first`: explicit scope and Seen-only reading.
- `edit-session`, `mike-0921`, `line-tiers`: remaining edit doors, keyboard guards and visible-passage navigation.
- `scroll-camera`, `layout-panels`, `layout-status`, `ux-consistency`: viewport compensation, stable ordering and removal of superseded policies.
- Removed `closed-fold`, as required.

Type checking reports **489 errors**, against **490 on the original tree**. The diagnostic comparison found no new errors. All 14 edited or new browser scripts pass syntax checking. `git diff --check` passes.

Tests used Node **24.14.0**. The installed SQLite native module does not load under the shell’s Node 22.

3. **Browser checks the reviewer must run**

Run `node scripts/<name>-check.mjs` for each name below.

| Checks | Expected result |
|---|---|
| `usability-s1` | Desktop and phone acceptance checks, including remote edits, reader-specific persistence and concurrent section insertion |
| `folding`, `hover-touch` | Explicit folding, heading-only marks and unchanged hover targets/layout |
| `reading-walk`, `honest-reading`, `asks`, `bundles-alts` | Seen-only reading; later actions accept nothing implicitly |
| `layout`, `ux-consistency`, `mike-0921` | Stable targets, panel focus and rail position; explicit decisions retain Undo |
| `scroll-camera`, `caret-stability` | Stable passage/caret position without fighting manual scrolling |
| `line-tiers` | J/K visit visible context passages |
| `threads` | Resolution stays expanded; history folds and opens explicitly |
| `editing-first`, `edit-gesture` | Existing editing protections and remaining edit doors still work |

4. **Unverified work and risks**

Chromium was not run. `.preview/` is untouched. Nothing was committed, deployed or written to live documents.

The server-hook subsection skips `/agent-setup`. A separate isolated loopback run confirmed that route returns **404**. Its remaining **76 checks passed**.

No stored document format or HTTP route changed. Fold-storage keys now include reader identity. Legacy provisional snapshot fields remain empty and are ignored when restored.

Remote layout and focus behavior remain the main browser verification risk.

5. **Issues with the bead or brief**

I found no behavioral requirement to reject.

The literal “no error may name a touched file” gate conflicts with the baseline: `src/editor/index.ts` already has **56 type errors**. Those remain unchanged. I followed the repository’s “no new type errors” rule.