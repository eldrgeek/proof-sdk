Implemented S2a for **ac-q3j**, seat `codex-builder`. The worktree is uncommitted.

1. **What changed**

   - [review-list.ts:22](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s2a/src/shared/review-list.ts:22) computes Needs you and All open through `openView`. It orders rows by document position, retains completed rows, marks incoming items New, and defines scroll compensation.
   - [navigator.ts:58](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s2a/src/ui/navigator.ts:58) provides Review, Outline and Since you. Updates preserve existing buttons and anchor the selected row. Next and Clear completed remove completed rows.
   - [reading-walk.ts:2187](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s2a/src/ui/reading-walk.ts:2187) remembers panel state per document and reader. The phone uses the existing bottom sheet and keeps selected passages above it.
   - [index.ts:3781](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s2a/src/editor/index.ts:3781) wires title, Review, People and Share. View now offers “View agreed copy.” Undo remains in the existing tool host and Edit menu.
   - [folding.ts:142](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s2a/src/ui/folding.ts:142) removes Open filtering. `openLayout`, its switches and the Open/Accord toggle are removed. Completion preserves the chosen view.
   - Protected-file edits are integration hooks in `index.ts`, `reading-walk.ts` and [line-marks.ts:2338](/Users/mikewolf/Projects/.fleet-wt/accord-usability-s2a/src/ui/line-marks.ts:2338). The latter preserves sitting-budget checks during Review navigation.

2. **Tests**

   `npm run build` passed. `npm test` exited **0**, with **606 logged passes** across 36 script groups and 48 test files.

   Changed suites passed:

   - `review-list`: **18**, covering scopes, ordering, completion, identity and anchoring.
   - `open-view`: **24**, removing filtered-layout expectations and asserting no automatic view switch.
   - `layout-chrome`: **6**, asserting the new toolbar.
   - `layout-panels`: **9**, asserting Review replaces Issues.

   The optional server-hook subsection skipped because `localhost:4000/agent-setup` was unavailable.

   Type checking reports **487 errors**. None occur on changed lines. All 15 modified browser/helper scripts passed syntax checks. `git diff --check` passed.

3. **Browser checks the reviewer must run**

   Run `node scripts/<name>-check.mjs`:

   | Names | What they should show |
   |---|---|
   | `open-view` | Full document, scoped counts, ordered incoming rows, stable focus and completion |
   | `layout`, `mobile`, `ux-consistency` | Toolbar, phone sheet, reachable controls and Undo |
   | `usability-acceptance` | Real ac08 and ac11 Review assertions at both viewports; ac07 checks row position |
   | `folding`, `reading-walk`, `scroll-camera`, `honest-reading` | Explicit navigation, preserved folds, immediate scrolling and unchanged Since you |
   | `asks`, `do`, `line-marks`, `proxy-marks`, `review-aids` | Updated navigation, marking protections, flagged review and sitting budgets |
   | `threads`, `usability-s1` | Integration regressions against the unchanged margin and S1 protections |

4. **Unverified work and risks**

   Browsers were not run. Every acceptance-harness case remains unverified at **1280×800** and **375×812**. Anchoring, focus and phone layout require that verification.

   Margin markers, answer controls and discussion-detail placement remain for S2b. The legacy standalone pill/Next fallback and generic editor fold-decoration support remain in protected code.

   No stored document format, API path or event changed. Existing panel selectors retain their names. The retired toggle selectors disappear. Panel preferences use a new reader/document key.

   `.preview/` is untouched. Nothing was committed or deployed.

5. **Issues with the instructions**

   The literal “no error may name a touched file” gate conflicts with the existing **56 errors in `src/editor/index.ts`**. None are on changed lines.

   The broader dead-code cleanup conflicts with S2a’s protected-file boundary. I removed Open filtering from its shared module and UI, and retained the protected fallback code described above.