import { $prose } from '@milkdown/kit/utils';
import { Plugin, PluginKey } from '@milkdown/kit/prose/state';
import { ySyncPluginKey } from 'y-prosemirror';
import type { EditorView } from '@milkdown/kit/prose/view';

import { getMarks, marksPluginKey } from './marks';
import type { Mark, StoredMark } from './marks';

const syncOriginKey = new PluginKey<number>('marksSyncOrigin');

export const marksSyncPlugin = (
  onMarksChange?: (marks: Mark[], view: EditorView, actionMetadata: Record<string, StoredMark>) => void
) =>
  $prose(() => {
    return new Plugin<number>({
      key: syncOriginKey,
      state: {
        init: () => 0,
        apply(tr, revision) {
          const parent = tr.getMeta('appendedTransaction');
          const remote = tr.getMeta(ySyncPluginKey)?.isChangeOrigin
            || parent?.getMeta(ySyncPluginKey)?.isChangeOrigin;
          const local = tr.getMeta('proofLocalMarkChange')
            || (tr.docChanged && tr.getMeta('addToHistory') !== false && !parent);
          return !remote && local ? revision + 1 : revision;
        },
      },
      view() {
        let lastActionMetadataJSON = '';
        let lastLocalRevision = 0;

        return {
          update(view) {
            const pluginState = marksPluginKey.getState(view.state);
            if (!pluginState) return;

            const allMarks = getMarks(view.state);
            const actionMarks = allMarks.filter(mark => mark.kind !== 'authored');
            const rawMetadata = pluginState.metadata ?? {};
            const actionMetadata: Record<string, StoredMark> = {};
            for (const [id, entry] of Object.entries(rawMetadata)) {
              if (!entry || typeof entry !== 'object') continue;
              if (entry.kind === 'authored') continue;
              if (entry.kind === 'comment') {
                const body = typeof entry.text === 'string' ? entry.text.trim() : '';
                if (!body) continue;
              }
              actionMetadata[id] = entry as StoredMark;
            }
            const actionMetadataJSON = JSON.stringify(actionMetadata);

            const revision = syncOriginKey.getState(view.state) ?? 0;
            const localChange = revision !== lastLocalRevision;
            lastLocalRevision = revision;
            const changed = actionMetadataJSON !== lastActionMetadataJSON;
            lastActionMetadataJSON = actionMetadataJSON;
            // Remote normalization is presentation, never an invitation to write back.
            if (localChange && changed) onMarksChange?.(actionMarks, view, actionMetadata);
          }
        };
      }
    });
  });
