# S5 impact report

Run from the repository with its installed dependencies:

```sh
node scripts/usability-impact-report.mjs /path/to/database-copy.sqlite
```

Use a consistent SQLite backup, including committed WAL contents. The script opens
only the supplied file, with `readonly: true` and `fileMustExist: true`. It runs no
migrations and imports no application database initializer. Node must match the
installed better-sqlite3 native module.

Each `doc N` line and the `total` line contain JSON counts. No document identifier,
text or participant identity is printed. Errors omit exception details and paths.

- `old_only` counts marks that carried before S5 and no longer carry, broken down
  by status. `skimmed` is included because it is also a stored status.
- `carried_both`, `exact_both`, `stale_both` and `new_only` complete the partition.
  `stale_both` includes lapsed and unattached marks. `new_only` can occur because
  listed corrections no longer have the old edit-percentage limit.
- The remaining counters describe missing anchor text, invalid statuses, projection
  problems and parser fallback or failure. They overlap the mark counts.

The report counts every stored mark row for every document, including inactive
documents. It does not merge identities or select the winning mark per participant.
It uses the same hash/occurrence resolution and carry search as the server.
Old anchors without full text can carry only when their short excerpt reconstructs
the text and matches its hash. A missing anchor is not guessed.

Markdown selection matches `getProjectedDocumentBySlug`: projection markdown,
then canonical markdown if no projection exists. Parsing matches
`computeServerLines`. The running server can additionally derive newer text from
Yjs or repair a projection. This offline report does neither. Nonzero projection
or parser counters need review before treating the count as the deployed UI impact.
Even zero counters cannot establish that a copied projection includes live edits.

`line-change-old.ts` is an unchanged copy of
`git show 7b5c574:src/shared/line-change.ts`. The carry search in the script mirrors
`src/shared/line-marks.ts`; keep it synchronized if that search changes.

Run the synthetic regression suite with `npm run test:usability-impact`.
