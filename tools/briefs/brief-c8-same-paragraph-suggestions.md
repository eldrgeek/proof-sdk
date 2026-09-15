# C8: two people typing in one paragraph in Suggesting mode split one person's suggestion, leave characters unmarked, and Reject leaves text behind

Your branch is based on 00c0e15 in the fork (branch `deploy/vps`, live on the VPS): upstream fb25787 plus B7,
C4/C4b/C4c, C5, C6, B8c, B2d, B2e and B8d. B2d and B2e made the server save both people's text when they type in
the same paragraph. C6 removed the caret "stabilizer" and gave mark ids a per-browser nonce (ids look like
`m<ms>_<nonce>_<n>`).

Two other workers are running on the same base: C7 (tests around `resolveOnStoreConflict` in server/collab.ts and
`mutateCanonicalDocument` in server/canonical-document.ts) and B8e (accepting AI block inserts; the projection's table
layout and the page accept path). Stay out of their areas unless this bug needs them, and say so if it does.

## Setup
- `ln -s /Users/mikewolf/Projects/proof-sdk/node_modules node_modules`; if anything is missing run
  `npm install --no-package-lock`. `npm run build`; `npm test`. Never touch the live VPS server.
- Known baseline failures (they also fail on untouched upstream fb25787; not yours): src/tests/marks.test.ts (3),
  share-event-poll-fallback-wiring, marks-accept-live-viewer-stability-regression, agent-edit-v2-live-viewer-regression,
  agent-edit-v2-live-structural-drift-regression, collab-onstore-drift-quarantine, share-server-startup.
- The browser tests need `PROOF_PLAYWRIGHT_PACKAGE_JSON=/Users/mikewolf/Projects/playmaker/package.json`
  (see src/tests/collab-concurrent-typing-browser.test.ts for a two-browser harness).

## Facts the COS (Claude) verified on the live instance (build 00c0e15, fresh documents, two browser processes)
The document is `# Proof E2E\n\nERIC\\\nI think teh play is ready.\n\nDIANA\\\nThe second act needs one more scene.\n`.
Both people are in Suggesting mode. Mike's caret is after "The second act" in the DIANA paragraph and he types
` mike typed words` at 60 ms per key. At the same moment Eric types ` eric typed words` at the end of the same
paragraph. (Probe: `two-reviewer-probe.mjs` with `MODE=suggest SEPARATE_BROWSERS=1 SAME_PARAGRAPH=1`; it is in the
evidence branch under `tools/probes/`.)
1. **Mike's run splits into six insert suggestions**, created about 190 ms apart (every third keystroke). The server
   stores them as (doc vclgtxre): content ` mi`, `ke `, `typ`, `ed `, `wor`, `ds`; ranges 65–67, 68–70, 71–73,
   74–76, 77–79, 80–82; quotes `m`, `ke`, `ty`, `ed`, `wo`, `ds`. Each mark's content is one character longer than
   the text its range covers, and the contents together spell the whole phrase.
2. **Five characters carry no suggestion at all.** On both pages, and after a reload, the characters `i`, ` `, `p`,
   ` ` and `r` are in no inline suggestion mark and in no mark range from `window.proof.getAllMarks()`. In Suggesting
   mode, unmarked text is text that skips review. Four runs out of four show the same six fragments and the same five
   unmarked characters (docs vclgtxre, r5a4tzum, g8i4mtm0, rgijrutz).
3. **Eric's run stays whole.** His run, typed at the same moment at the end of the same paragraph, is one suggestion
   covering every character. When the two people type in different paragraphs, both runs are single suggestions with
   full coverage, and rejecting all of Mike's inserts removes his phrase cleanly (doc 8xz3uqy4).
4. **Reject leaves text behind.** Eric then rejects each of Mike's six inserts with `window.proof.markReject(id)`;
   every call returns true. After a reload the page and the server both read
   `The second act mi typ wor needs one more scene. eric typed words ` (doc rgijrutz, server fresh). So only the
   fragments `ke`, `ed` and `ds` were removed; the rejects of ` m`, `ty` and `wo` returned true and removed nothing,
   and the unmarked characters stayed. In another run (doc g8i4mtm0) the text was the same and the server was no longer
   fresh afterwards (`readSource: canonical_row`).
5. **A stray trailing space.** Before step 4, Mike accepted Eric's insert and Eric rejected Mike's suggested deletion
   of "teh". After that the DIANA paragraph ends with a space (server markdown ends `&#x20;`). The different-paragraph
   run shows no such space.
6. For both same-paragraph documents the server logged `[collab] allowing projection write across small stale
   baseline during live authoritative collab` with baselineChars 91 and candidateChars 1232. A guess to check: the
   projection candidate contained suggestion span markup for the many fragments. The B8e brief sees a similar size
   jump with a table.

## Task
1. Reproduce facts 1, 2 and 4 in a test with two live clients in Suggesting mode typing in the same paragraph at the
   same moment, key by key.
2. Find why a remote update in the same paragraph splits the local insert suggestion, and why each new fragment's
   range is one character shorter than its content. Fix it so that every character a person types in Suggesting mode
   is inside an insert suggestion credited to that person, and each suggestion's content equals the text its range
   covers. One suggestion per uninterrupted run is the goal; adjacent suggestions with no gap are acceptable if you
   explain why.
3. Find why `markReject` can return true and remove nothing, and fix it: a reject removes exactly its suggestion's
   text, or it returns false.
4. Find the trailing space of fact 5; fix it if the fix is small and safe, otherwise report it.
5. Tests: (a) the same-paragraph sequence ends with full coverage for both people; (b) rejecting all of one person's
   inserts leaves the paragraph exactly as it was plus the other person's text; (c) accepting all of them keeps
   exactly the typed text with no suggestion left; (d) the different-paragraph case still passes. Keep the existing
   tests passing.
6. Run `npm run build`, your tests, `npx tsx src/tests/marks.test.ts` (3 known failures only) and `npm test`. Report
   honestly, with each test's exit code captured on its own statement.

## Commit
- `fix(suggestions): typing in a paragraph someone else is editing keeps each person's suggestion whole`
- Every factual claim in your report must come from code you read or a command you ran. Label anything else a guess.
- A run that ends without a commit is a failure.

<!-- Authored 2026-09-15 by Claude Opus 5 (CCc, COS) for Mike Wolf; Proof suggesting-mode work, fork eldrgeek/proof-sdk. -->
