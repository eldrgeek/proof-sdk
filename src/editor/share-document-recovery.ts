import { stripAllProofSpanTags } from '../../server/proof-span-strip.js';
import { embedMarks } from '../formats/marks.js';
import type { StoredMark } from './plugins/marks.js';

export function reconcileAuthoritativeShareDocument(args: {
  collabConnected: boolean;
  markdown: string;
  serverMarks: Record<string, StoredMark>;
  loadDocument: (markdown: string) => void;
  applyServerMarks: (marks: Record<string, StoredMark>) => void;
}): void {
  if (!args.collabConnected) {
    const spanFreeMarkdown = stripAllProofSpanTags(args.markdown);
    args.loadDocument(embedMarks(spanFreeMarkdown, args.serverMarks));
  }
  args.applyServerMarks(args.serverMarks);
}
