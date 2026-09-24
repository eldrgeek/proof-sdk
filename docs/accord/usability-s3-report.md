**ac-nkn is built. Browser verification remains with the reviewer.**

1. **What changed**

   - Draft policy permits publication only through Propose change or Cmd/Ctrl+Enter. Direct-edit conversion remains off. [edit-session.ts:8](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s3/src/shared/edit-session.ts:8)
   - Inline drafts persist per document, passage identity and reader. Resume restores the text. Changed passages show a warning. Cancel discards. [edit-gesture.ts:69](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s3/src/ui/edit-gesture.ts:69)
   - Submission creates one attributed replacement suggestion. Its Undo preserves document text and refuses a proposal another participant revised. [edit-gesture.ts:220](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s3/src/ui/edit-gesture.ts:220)
   - Clicks select passages. S opens a draft. Draft fields suppress reading shortcuts. [reading-walk.ts:1039](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s3/src/ui/reading-walk.ts:1039)
   - Direct Editing uses Enter Editing / Leave Editing controls and a named status. Click, Enter, hover, blur and Esc no longer enter or leave it. [index.ts:4648](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s3/src/editor/index.ts:4648)
   - Ported the resync fix from `b8a7c97` because submission is a local programmatic write. [local-write-resync.ts:109](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s3/src/editor/local-write-resync.ts:109)

2. **Tests**

   - `npm run build`: passed.
   - `npm test`: exit 0 under Node **24.14.0**. All **34 wired commands** completed. The log contains **522 passing check lines**.
   - The optional server-hook block skipped because no server answered at `localhost:4000`.
   - Changed suites: `edit-session` **9 passed**, `editing-first` **5 passed**, `mike-0921` **9 passed**, and `layout-chrome` **6 passed**. They now assert local drafts, explicit Editing and revised shortcut help.
   - `caret-stability` passed with the ported resync tests.
   - Type checking: **490 before, 490 after; zero new diagnostics**.
   - Browser-script syntax checks and `git diff --check` passed.
   - Node 22 initially failed against the installed SQLite binary. Node 24 matched its ABI. Dependencies were unchanged.

3. **Browser checks to run**

   Run these in both review styles and at desktop and phone widths:

   | Check under `scripts/` | Expected result |
   |---|---|
   | `edit-gesture-check.mjs` | Draft recovery, explicit submission, attribution, one Undo, concurrent passage editing without duplication, and Yjs/ProseMirror agreement |
   | `local-write-resync-check.mjs` | Local writes and draft submission produce no redundant document resync |
   | `caret-stability-check.mjs` | Text, caret and viewport integrity remain intact |
   | `editing-first-check.mjs` | Draft typing stays local; direct Editing preserves its existing protections |
   | `insert-suggestion-check.mjs` | Existing inserts render once and remain decidable |
   | `suggestion-positions-check.mjs` | Existing proposals retain their anchors |
   | `mike-0921-check.mjs` | Revised entry controls and keyboard behavior work |
   | `layout-check.mjs` | Desktop and phone controls show the revised mode and status |
   | `line-marks-check.mjs` | Marks survive direct editing through the new control |

   Also run these updated browser suites under `src/tests/`: `review-decision-collab-browser.test.ts`, `review-history-authors-browser.test.ts`, `review-history-routes-browser.test.ts`, `review-style-browser.test.ts`, and `review-unified-history-browser.test.ts`.

4. **Unverified work and risks**

   Browser checks were not run. `.preview/` was untouched. Nothing was committed or deployed.

   Preserve S1’s stability changes when merging the overlapping guard, reading-key and reading-walk files.

   Existing shared formats and agent routes are unchanged. Draft storage is new local browser state. The obsolete segmented mode controls and their child selectors were removed; affected checks were updated.

5. **Brief issue**

   “No error may name a touched file” conflicts with this base. Before editing, `src/editor/index.ts` had **56** diagnostics and `editing-first.test.ts` had **1**. Those remain unchanged. No new diagnostics were introduced.