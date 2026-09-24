1. **What changed**

- `src/shared/participant-status.ts:241` counts current Approved as the approver’s own agreement. Passage states remain Approved. Lapsed and decayed approvals do not count.
- `src/shared/participant-status.ts:352` preserves “Approved by” separately. The header settles when every participant has Agreed or Approved every passage. Related comments are corrected in `src/shared/open-view.ts:383`.
- `server/agent-routes.ts:2320` documents both meanings of `aligned`. `docs/agent-docs.md:330` explains their difference.
- The blind test exposed an objection-reason leak. `server/agent-routes.ts:2282` now omits hidden objections and their Issues. It shares the reveal rule in `src/shared/blind.ts:132` with `viewerParticipantStatus` in `server/line-marks.ts:393`.

2. **Tests**

`npm run build` passed. `npm test` exited 0 across 36 stages and 48 test files, using Node v24.14.0.

Changed suites:

- `participant-status`: **10 passed**. Covers approval, mixed marks, settlement, lapse, and decay.
- `open-view`: **28 passed**. Updates agreement expectations while preserving separate approval labels.
- `honest-reading`: **87 passed**. Adds the open-comment case where the two alignment values differ.
- `bundles-alts`: **12 passed**. Checks the direct status function and `/state` before, during, and after reveal.

TypeScript reports **487 errors**, with **zero naming changed files**. `git diff --check` passed.

3. **Browser checks for the reviewer**

- `scripts/open-view-check.mjs`: verify header settlement. Also exercise an owner approving every passage while another participant remains unfinished, then agrees.
- `scripts/line-marks-check.mjs`, default and `--style proof`: approval must retain its Approved display.
- `scripts/bundles-alts-check.mjs`: hidden positions must remain hidden until reveal.

No browser assertion encoded the superseded approval rule, so these scripts are unchanged.

4. **Limits and risks**

I did not run browsers, change UI/editor files, touch `.preview`, commit, or deploy. I did not write estate claims because those stores are outside the permitted worktree.

No stored formats, field names, routes, events, or selectors changed. Blind `/state` now omits hidden objection rows. Counts remain document-wide, so the visible Issues list can be shorter than its count. This is documented.

Blind coverage here concerns `/state` and `viewerParticipantStatus`; other endpoints were not audited.

5. **Bead or brief concerns**

I found no requirement to reject. The blind work required a server fix as well as tests because the new test reproduced an actual leak. Multi-passage objections retain the existing rule: every surviving passage must be revealed before their shared reason and condition appear.