/** Protect old clients' unload snapshots too; client-only fixes cannot protect a deploy. */
import * as Y from 'yjs';
import { Connection } from '@hocuspocus/server';
import { isPendingSuggestion, isSuggestion, SUGGESTION_STATUS_POLICY } from '../src/shared/suggestion-status.js';
import { addDocumentEvent } from './db.js';

const guarded = new WeakSet<Y.Doc>();

export function isClientMarksTransaction(transaction: Y.Transaction): boolean {
  // Hocuspocus MessageReceiver passes Connection to readUpdate/readSyncStep2.
  // local=false alone also matches server-side replay/repair via Y.applyUpdate.
  return !transaction.local && transaction.origin instanceof Connection;
}

export function observeClientMarks(slug: string, doc: Y.Doc): void {
  if (guarded.has(doc)) return;
  guarded.add(doc);
  const marks = doc.getMap('marks');
  marks.observe((event, transaction) => {
    if (!isClientMarksTransaction(transaction)) return;
    for (const [markId, change] of event.changes.keys) {
      const before = change.oldValue;
      if (change.action === 'delete' && isPendingSuggestion(before)) {
        // Map observers run before afterTransaction/update listeners (persistence and
        // broadcast). The replacement is visible immediately, before either can read.
        doc.transact(() => marks.set(markId, before), SUGGESTION_STATUS_POLICY.restoreOrigin);
        addDocumentEvent(slug, 'suggestion.deletion_restored', { markId, kind: before.kind, by: before.by }, 'server');
        continue;
      }
      const after = marks.get(markId);
      if (!isSuggestion(before) || !isSuggestion(after)) continue;
      const wasPending = isPendingSuggestion(before);
      const pending = isPendingSuggestion(after);
      if (wasPending === pending) continue;
      const type = pending ? 'suggestion.reopened' : `suggestion.${after.status}`;
      addDocumentEvent(slug, type, {
        markId, kind: after.kind, by: after.by,
        status: pending ? 'pending' : after.status,
        resolvedBy: after.resolvedBy, resolvedAt: after.resolvedAt,
      }, after.resolvedBy ?? 'unknown');
    }
  });
}
