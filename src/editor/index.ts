import { startAgentJoinNotices } from '../ui/agent-join';
import type { Transaction } from '@milkdown/kit/prose/state';
import { commitLiveTextInput, liveSuggestionInputEvent, focusLiveSuggestion, type LiveSuggestionInput } from './live-suggestion-input';
import { readPointerSelectionSoon } from './pointer-selection';
import { EDIT_SESSION_POLICY } from '../shared/edit-session';
import { markApiView, isOwnHumanMarkChange, withHumanReviewWrite } from './review-mark-origin';
/**
 * Proof Editor
 *
 * A Milkdown-based markdown editor with unified marks tracking.
 *
 * DESIGN:
 * - Marks automatically handle position mapping through edits
 * - Marks survive copy/paste, undo/redo
 * - Inline spans are derived from marks when saving/displaying
 */

import { PlayMakerReview, type ReviewAction } from '../ui/playmaker-review';
import { LineMarksUI } from '../ui/line-marks';
import { ReadingWalkUI } from '../ui/reading-walk';
import { ChatUI } from '../ui/chat';
import { FoldingUI } from '../ui/folding';
import { UndoUI } from '../ui/undo';
import { MenuBar, buildMenuItems, type MenuItemSpec, type MenuSpec } from '../ui/menu-bar';
import { OpenViewUI } from '../ui/open-view';
import { showShareDialog } from '../ui/share-dialog';
import { FindBar, showAboutDialog, showKeysDialog, showMarksLegend, showOpenDialog, showWhoDialog } from '../ui/chrome-dialogs';
import { SCROLL_CAMERA_POLICY, cameraScroll, deadZone } from '../shared/scroll-camera';
import { MENU_BAR_POLICY, TOOLBAR_POLICY, type ShareTab } from '../shared/layout-chrome';
import { ClarifyUI } from '../ui/clarify';
import { EditGestureUI, draftViewPlugin } from '../ui/edit-gesture';
import { lineMarksViewPlugin } from './plugins/line-marks-view';
import { foldViewPlugin, FOLD_USER_EDIT } from './plugins/fold-view';
import { askViewPlugin } from './plugins/ask-view';
import { doViewPlugin } from './plugins/do-view';
import { proofExtrasViewPlugin } from './plugins/proof-extras-view';
import { tierViewPlugin } from './plugins/tier-view';
import { getReviewStyle, setReviewStyle, REVIEW_STYLE_POLICY } from './review-style';
import { isEditing, isWriting, onWritingChange, setDirectEditing } from './editing-guard';
import { ReviewDecisionHistory, keepUndoGroupOpen, reconnectNativeUndoManager } from './review-decision-history';
import { TypedDiscussionController, type TypedDiscussionRun } from './typed-discussion';
import { typedDiscussionId, typedDiscussionInsertId, typedItemAt, TYPED_DISCUSSION_POLICY } from '../shared/typed-discussion';
import { actorKey } from '../shared/line-marks';

import { getAgentPresenceDisplay } from '../shared/agent-presence';

import {
  Editor,
  rootCtx,
  defaultValueCtx,
  editorViewCtx,
  parserCtx,
  serializerCtx,
  remarkStringifyOptionsCtx,
  prosePluginsCtx,
} from '@milkdown/core';
import { commonmark, hardbreakClearMarkPlugin } from '@milkdown/preset-commonmark';
import { hardbreakClearMarksPlugin } from './plugins/hardbreak-clear-marks';
import { gfm, remarkGFMPlugin } from '@milkdown/preset-gfm';
import { history } from '@milkdown/plugin-history';
import { collab, collabServiceCtx } from '@milkdown/plugin-collab';
import { listener, listenerCtx } from '@milkdown/plugin-listener';
import { cursor } from '@milkdown/plugin-cursor';
import { clipboard } from '@milkdown/plugin-clipboard';
import { nord } from '@milkdown/theme-nord';
import {
  yCursorPlugin,
  yCursorPluginKey,
  ySyncPluginKey,
  yUndoPluginKey,
  absolutePositionToRelativePosition,
} from 'y-prosemirror';
import { applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { installLocalWriteResyncPolicy } from './local-write-resync';
import { installRemoteChangeScrollPolicy } from './remote-change-scroll';
import { anchorCaretAround } from './caret-anchor';
import * as encoding from 'lib0/encoding';

import { proofMarkPlugins } from './schema/proof-marks';
import { codeBlockExtPlugins } from './schema/code-block-ext';
import { frontmatterSchema } from './schema/frontmatter';
import { remarkFrontmatterPlugin } from './schema/remark-frontmatter-plugin';
import { authoredTrackerPlugin } from './plugins/authored-tracker';
import { heatmapPlugin, heatmapCtx } from './plugins/heatmap-decorations';
import { marksSyncPlugin } from './plugins/marks-sync';
import {
  agentCursorPlugin,
  agentCursorCtx,
  setAgentCursor,
  setAgentSelection,
  clearAgentCursor,
  getAgentCursorState,
} from './plugins/agent-cursor';
import {
  suggestionsPlugins,
  suggestionsPluginKey,
  enableSuggestions,
  disableSuggestions,
  toggleSuggestions,
  isSuggestionsEnabled,
  wrapTransactionForSuggestions,
  clickEditDecisionsMeta,
} from './plugins/suggestions';
import {
  markPopoverPlugin,
  openCommentComposer,
  openMarkPopover,
  captureCommentPopoverDraft,
  restoreCommentPopoverDraft,
  type CommentPopoverDraftSnapshot,
} from './plugins/mark-popover';
import { markSelectionBarPlugin } from './plugins/mark-selection-bar';
import {
  shareContentFilterPlugin,
  enableShareContentFilter,
  disableShareContentFilter,
  SHARE_CONTENT_FILTER_ALLOW_META,
} from './plugins/share-content-filter';
import {
  setShareRuntimeCapabilities,
  resetShareRuntimeCapabilities,
} from './plugins/share-permissions';
import { findHighlightsPlugin, setFindHighlights, clearFindHighlights } from './plugins/find-highlights';
import { arrowCommentPlugin } from './plugins/arrow-comment';
import { markdownLinkClickPlugin } from './plugins/markdown-link-click';
import { mermaidDiagramsPlugin } from './plugins/mermaid-diagrams';
import { taskCheckboxesPlugin } from './plugins/task-checkboxes';
import type { Node as ProseMirrorNode } from '@milkdown/kit/prose/model';
import type { EditorView } from '@milkdown/kit/prose/view';
import { TextSelection } from '@milkdown/kit/prose/state';
import {
  marksPlugins,
  marksPluginKey,
  proofMarkActionMeta,
  prepareSuggestionBatch,
  getMarks,
  getActiveMarkId,
  getMarkMetadata,
  getMarkMetadataForDisk,
  getMarkMetadataWithQuotes,
  setMarkMetadata,
  applyRemoteMarks,
  setActiveMark,
  approve,
  unapprove,
  flag,
  unflag,
  comment as markComment,
  reply as markReply,
  resolve as markResolve,
  unresolve as markUnresolve,
  suggestInsert,
  suggestDelete,
  suggestReplace,
  debugAnalyzeReplace as debugAnalyzeReplaceMark,
  debugResolveRangeWithValidation as debugResolveRangeWithValidationMark,
  rangeCrossesTableCellBoundary,
  modifySuggestionContent,
  setDefaultMarkdownParser,
  accept as acceptMark,
  reject as rejectMark,
  acceptAll,
  rejectAll,
  deleteMark,
  addAuthoredMark,
  setAuthoredMark,
  getAuthorshipStats,
  coalesceMarks,
  updateMarksAfterEdit,
  clearResolvedMarkTombstones,
  type Mark,
  type MarkKind,
  type MarkRange,
  type CommentData,
  type StoredMark,
  mergePendingServerMarks,
  getMarksByKind,
  getPendingSuggestions,
  getUnresolvedComments as getUnresolvedMarkComments,
  findMark,
  resolveMarks,
} from './plugins/marks';
import { evaluateShareEditHydrationGate } from './share-collab-hydration-equivalence';
import {
  executeBatch as executeBatchImpl,
  type BatchOperation,
  type BatchResult,
} from './batch-executor';
import { syncAgentSessions } from '../analytics/agent-sessions';
import { initThemePicker, getThemePicker } from '../ui/theme-picker';
import { fileClient } from '../bridge/file-client';
import {
  getShareSuggestionResolutionTransport,
  runShareSuggestionRestFallback,
  shareClient,
  type CollabSessionInfo,
  type ShareOpenContext,
  type SharePendingEvent,
  type ShareSuggestionResolutionTransport,
} from '../bridge/share-client';
import { collabClient, type CollabSyncStatus } from '../bridge/collab-client';
import { shouldDeferShareMarksRefresh } from './share-marks-refresh';
import {
  reconcileShareMarkMutationBatch,
  recoverShareMarksAfterMutationFailure,
  type ShareSuggestionFinalStatus,
} from './share-mark-mutation';
import { reconcileAuthoritativeShareDocument } from './share-document-recovery';
import {
  createShareSuggestionReviewUpdateScheduler,
  shouldUpdateShareSuggestionReviewDisplay,
} from './share-suggestion-review';
import { collabCursorBuilder, collabSelectionBuilder } from './plugins/collab-cursors';
import { isAgentScopedId } from '../shared/agent-identity';
import { documentNoun, pageTitle, productIdentity, productName } from '../shared/product-identity';
import {
  assignDistinctAgentFamilies,
  createAgentFaceElement,
  getAgentFaceAssetUrl,
  getAgentFacePalette,
  type AgentFamily,
} from '../ui/agent-identity-icon';
import { getViewerName, promptForName } from '../ui/name-prompt';
import {
  initAgentIntegration,
  handleMarksChange as agentHandleMarksChange,
  sweepForActionableItems as agentSweep,
  setAlwaysOnEnabled as agentSetAlwaysOnEnabled,
} from '../agent/editor-integration';
import { initSessionManager, getSessionManager } from '../agent/session-manager';
import { getTriggerService } from '../agent/trigger-service';
import { extractEmbeddedProvenance } from '../formats/provenance-sidecar';
import type { CommentSelector, Comment } from '../formats/provenance-sidecar';
import { normalizeQuote, extractMarks, embedMarks, getThread, migrateProvenanceToMarks, type OrchestratedMarkMeta } from '../formats/marks';
import { proofMarkHandler } from '../formats/remark-proof-marks';
import { remarkProofMarksPlugin } from './schema/remark-proof-marks-plugin';
import { getCurrentActor, setCurrentActor as setCurrentActorValue, normalizeActor } from './actor';
import {
  shouldKeepalivePersistShareContent,
  shouldKeepalivePersistShareMarks,
  shouldUseLocalKeepaliveBaseToken,
} from './share-refresh-persist';
import { keybindingsPlugin, setShowAgentInputCallback, type AgentInputContext } from './plugins/keybindings';
import { tableKeyboardPlugin } from './plugins/table-keyboard';
import { showAgentInputDialog } from '../ui/agent-input-dialog';
import type { InviteResult, TeamState } from '../ui/invite-person-dialog';
import { ShareEventPoller } from '../bridge/share-event-poller';
import { initContextMenu } from '../ui/context-menu';
import {
  initAgentNavigation,
  navigateToAgent as navigateToAgentInEditor,
  followAgent as followAgentInEditor,
  unfollowAgent as unfollowAgentInEditor,
  getFollowedAgent as getFollowedAgentInEditor,
} from './agent-navigation';
import { captureEvent, initTelemetry } from '../analytics/telemetry';
import { getSkillsRegistry } from '../agent/skills/registry';
import {
  runReview,
  cancelActiveReview,
  debugPlanOnly as debugPlanOnlyReview,
  debugRunSingleFocusArea as debugRunSingleFocusAreaReview,
  debugGetCachedPlan as debugGetCachedPlanReview,
  debugClearPlanCache as debugClearPlanCacheReview,
  type OrchestrationRunOptions,
  type ReviewScope,
} from '../agent/review-executor';
import { setApiKey as setAgentApiKey } from '../agent/config';
import { getAgentStatus, getAgentSessionsSummary, cancelAllAgentSessions } from '../agent/index';
import {
  buildTextIndex,
  getTextForRange,
  mapTextOffsetsToRange,
  resolvePatternRange,
  resolveQuoteRange,
} from './utils/text-range';
import {
  computeLineDiff,
  linesToCharOffsets,
  computeChangeStats,
  classifyChangeMode,
  classifyRewriteMode,
  type LineDiffChange,
  type ChangeStats,
} from './utils/diff';
import { WebHaptics } from 'web-haptics';

import '../agent/external-agent-bridge';

// Remote Yjs changes never scroll the view (caret stability, 2026-09-19).
installRemoteChangeScrollPolicy();
installLocalWriteResyncPolicy();

const LEGACY_REST_FALLBACK = false;

// Global proof interface for the web editor runtime
declare global {
  interface Window {
    proof: ProofEditor;
  }
}

type MilkdownPlugin = (ctx: unknown) => unknown;

async function loadPrismPlugin(): Promise<MilkdownPlugin | null> {
  try {
    await import('prismjs');

    await Promise.all([
      import('prismjs/components/prism-markup'),
      import('prismjs/components/prism-css'),
      import('prismjs/components/prism-clike'),
      import('prismjs/components/prism-javascript'),
      import('prismjs/components/prism-typescript'),
      import('prismjs/components/prism-jsx'),
      import('prismjs/components/prism-tsx'),
      import('prismjs/components/prism-ruby'),
      import('prismjs/components/prism-python'),
      import('prismjs/components/prism-go'),
      import('prismjs/components/prism-rust'),
      import('prismjs/components/prism-json'),
      import('prismjs/components/prism-yaml'),
      import('prismjs/components/prism-bash'),
      import('prismjs/components/prism-sql'),
      import('prismjs/components/prism-markdown'),
      import('prismjs/components/prism-mermaid'),
      import('prismjs/components/prism-swift'),
      import('prismjs/components/prism-c'),
      import('prismjs/components/prism-cpp'),
      import('prismjs/components/prism-java'),
      import('prismjs/components/prism-kotlin'),
      import('prismjs/components/prism-php'),
    ]);

    const { prism } = await import('@milkdown/plugin-prism');
    return prism as unknown as MilkdownPlugin;
  } catch (error) {
    console.error('[editor] Failed to initialize Prism syntax highlighting. Continuing without it.', error);
    return null;
  }
}

function resolveSelectorRange(doc: ProseMirrorNode, selector: CommentSelector): MarkRange | null {
  if (selector.range) {
    const size = doc.content.size;
    const from = Math.max(1, Math.min(selector.range.from, size));
    const to = Math.max(from, Math.min(selector.range.to, size));
    if (from < to) {
      return { from, to };
    }
  }

  if (selector.quote) {
    const range = resolveQuoteRange(doc, selector.quote);
    if (range) return range;
  }

  if (selector.pattern) {
    const range = findPatternInDoc(doc, selector.pattern);
    if (range) return range;
  }

  if (selector.anchor?.heading) {
    const range = findAnchorInDoc(doc, selector.anchor);
    if (range) return range;
  }

  return null;
}

// Quote resolution handled via resolveQuoteRange in utils/text-range.

function findPatternInDoc(doc: ProseMirrorNode, pattern: string): MarkRange | null {
  return resolvePatternRange(doc, pattern);
}

function findAnchorInDoc(
  doc: ProseMirrorNode,
  anchor: { heading?: string; offset?: number }
): MarkRange | null {
  if (!anchor.heading) return null;

  let headingPos: number | null = null;
  doc.descendants((node, pos) => {
    if (headingPos !== null) return false;
    if (node.type.name === 'heading') {
      const headingText = node.textContent.toLowerCase();
      if (headingText.includes(anchor.heading!.toLowerCase())) {
        headingPos = pos + node.nodeSize;
        return false;
      }
    }
    return true;
  });

  if (headingPos === null) return null;

  const offset = anchor.offset || 0;
  const from = Math.min(headingPos + offset, doc.content.size);
  const to = Math.min(from + 10, doc.content.size);
  return { from, to };
}

type FindOptions = {
  regex?: boolean;
  caseSensitive?: boolean;
  maxMatches?: number;
  scope?: 'all' | 'selection' | 'visible';
  normalizeWhitespace?: boolean;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Dry-run position validation: checks all diff positions map correctly
 * before creating any marks. Returns valid=false if any fail.
 */
function validateDiffPositions(
  index: { text: string; positions: Array<number | null> },
  changes: LineDiffChange[],
  oldLines: string[]
): { valid: boolean; failedCount: number } {
  let failedCount = 0;
  for (const change of changes) {
    if (change.type === 'insert') continue; // inserts anchor after preceding line

    const offsets = linesToCharOffsets(oldLines, change.oldLineStart!, change.oldLineEnd!);
    const range = mapTextOffsetsToRange(index, offsets.from, offsets.to);
    if (!range) failedCount++;
  }
  return { valid: failedCount === 0, failedCount };
}

function findMatchesInDoc(
  doc: ProseMirrorNode,
  find: string,
  options: FindOptions = {}
): Array<{ from: number; to: number; match: string }> {
  if (!find) return [];

  const {
    regex = false,
    caseSensitive = false,
    maxMatches = 200,
    normalizeWhitespace = true,
  } = options;

  let source = find;
  if (!regex) {
    if (normalizeWhitespace) {
      const tokens = find.trim().split(/\s+/).filter(Boolean);
      source = tokens.length > 0 ? tokens.map(escapeRegExp).join('\\s+') : '';
    } else {
      source = escapeRegExp(find);
    }
  }

  if (!source) return [];

  // Always enable multiline mode so ^/$ anchors work on line boundaries.
  const flags = caseSensitive ? 'gm' : 'gim';
  let matcher: RegExp;
  try {
    matcher = new RegExp(source, flags);
  } catch {
    return [];
  }

  const index = buildTextIndex(doc);
  if (!index) return [];
  const text = index.text;
  const matches: Array<{ from: number; to: number; match: string }> = [];

  let result: RegExpExecArray | null;
  while ((result = matcher.exec(text)) !== null) {
    if (matches.length >= maxMatches) break;
    const matchText = result[0];
    if (!matchText) {
      matcher.lastIndex += 1;
      continue;
    }

    const startOffset = result.index;
    const endOffset = result.index + matchText.length;
    const mapped = mapTextOffsetsToRange(index, startOffset, endOffset);
    if (mapped) {
      matches.push({ from: mapped.from, to: mapped.to, match: matchText });
    }
  }

  return matches;
}

function migrateLegacyCommentsToMarks(doc: ProseMirrorNode, comments: Comment[]): Mark[] {
  const migrated: Mark[] = [];

  for (const comment of comments) {
    const range = resolveSelectorRange(doc, comment.selector);
    const quoteSource = comment.selector.quote || (range ? doc.textBetween(range.from, range.to, '\n', '\n') : '');
    const quote = normalizeQuote(quoteSource);
    const threadId = comment.id;
    const baseMark: Mark = {
      id: comment.id,
      kind: 'comment',
      by: normalizeActor(comment.author),
      at: comment.createdAt || new Date().toISOString(),
      range: range ?? undefined,
      quote,
      data: {
        text: comment.text,
        thread: threadId,
        resolved: comment.resolved,
      },
    };
    migrated.push(baseMark);

    for (const reply of comment.replies || []) {
      const replyMark: Mark = {
        id: reply.id,
        kind: 'comment',
        by: normalizeActor(reply.author),
        at: reply.createdAt || new Date().toISOString(),
        range: range ?? undefined,
        quote,
        data: {
          text: reply.text,
          thread: threadId,
          resolved: comment.resolved,
        },
      };
      migrated.push(replyMark);
    }
  }

  return migrated;
}

/**
 * Remove authored span wrappers from markdown snapshots returned via the bridge
 * without changing the saved document content.
 */
function stripAuthoredSpanTags(markdown: string): string {
  const spanTagRegex = /<\/?span\b[^>]*>/gi;
  const authoredAttrRegex = /data-proof\s*=\s*(?:"authored"|'authored'|authored)/i;
  const authoredStack: boolean[] = [];
  let result = '';
  let lastIndex = 0;

  for (const match of markdown.matchAll(spanTagRegex)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const tag = match[0];

    result += markdown.slice(lastIndex, index);
    lastIndex = index + tag.length;

    const isClosing = tag.startsWith('</');
    if (isClosing) {
      if (authoredStack.length === 0) {
        result += tag;
        continue;
      }
      const authored = authoredStack.pop();
      if (!authored) {
        result += tag;
      }
      continue;
    }

    const isAuthored = authoredAttrRegex.test(tag);
    authoredStack.push(isAuthored);
    if (!isAuthored) {
      result += tag;
    }
  }

  result += markdown.slice(lastIndex);
  return result;
}

function stripProofSpanTags(markdown: string): string {
  const spanTagRegex = /<\/?span\b[^>]*>/gi;
  const proofAttrRegex = /data-proof\s*=/i;
  const proofStack: boolean[] = [];
  let result = '';
  let lastIndex = 0;

  for (const match of markdown.matchAll(spanTagRegex)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const tag = match[0];

    result += markdown.slice(lastIndex, index);
    lastIndex = index + tag.length;

    const isClosing = tag.startsWith('</');
    if (isClosing) {
      if (proofStack.length === 0) {
        result += tag;
        continue;
      }
      const isProof = proofStack.pop();
      if (!isProof) {
        result += tag;
      }
      continue;
    }

    const isProof = proofAttrRegex.test(tag);
    proofStack.push(isProof);
    if (!isProof) {
      result += tag;
    }
  }

  result += markdown.slice(lastIndex);
  return result;
}

function normalizeMarkdownForComparison(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n').trimEnd();
}

function deepEqualValues(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqualValues(a[i], b[i])) return false;
    }
    return true;
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!deepEqualValues(aObj[key], bObj[key])) return false;
  }
  return true;
}

/**
 * Heuristic markdown detector for bridge safety checks.
 * Conservative by design: if this returns true, content likely carries markdown semantics.
 */
function looksLikeMarkdownSyntax(text: string): boolean {
  if (typeof text !== 'string' || text.length === 0) return false;
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>|```)|\[[^\]]+\]\([^\)]+\)|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_|`[^`]+`/.test(text);
}

function structureSignature(doc: ProseMirrorNode): string {
  const parts: string[] = [];
  doc.descendants((node) => {
    if (node.isText) return true;
    const attrs = Object.keys(node.attrs ?? {})
      .sort()
      .map((key) => `${key}:${String((node.attrs as Record<string, unknown>)[key])}`)
      .join(',');
    parts.push(attrs ? `${node.type.name}[${attrs}]` : node.type.name);
    return true;
  });
  return parts.join('|');
}

export interface EditorFullState {
  /**
   * Markdown serialization of the current document, including embedded mark metadata.
   * Use this for round-tripping content and rewrite payloads.
   */
  content: string;
  /**
   * Plain-text projection of the document for stable offsets and position mapping.
   */
  plainText: string;
  /**
   * Legacy alias for markdown `content` (kept for backward compatibility).
   */
  markdownContent?: string;
  /**
   * Monotonic document revision incremented on every doc-changing transaction.
   */
  revision: number;
  cursor: {
    line: number;
    column: number;
    offset: number;
  };
  selection: {
    hasSelection: boolean;
    from: number;
    to: number;
    text: string;
    fromLine: number;
    toLine: number;
  } | null;
  focusHeading: string | null;
  scroll: {
    visibleFromLine: number;
    visibleToLine: number;
    visibleHeadings: string[];
  };
  activeMark: {
    id: string;
    kind: MarkKind;
    by: string;
    at?: string;
    quote?: string;
    range?: MarkRange | null;
    resolvedRange?: { from: number; to: number } | null;
    data?: Record<string, unknown> | null;
    thread?: Array<{
      id: string;
      by: string;
      at?: string;
      text?: string;
      resolved?: boolean;
    }>;
  } | null;
  structure: {
    sections: Array<{
      heading: string;
      level: number;
      line: number;
      wordCount: number;
    }>;
    totalWords: number;
  };
  authorshipStats: {
    humanPercent: number;
    aiPercent: number;
    humanChars: number;
    aiChars: number;
  } | null;
}

/**
 * Visual layout information for agent-native testing
 * Returns pixel positions of marks and UI elements for overlap detection
 */
export interface VisualLayoutInfo {
  viewport: {
    width: number;
    height: number;
    scrollTop: number;
    scrollLeft: number;
  };
  marks: Array<{
    id: string;
    kind: string;
    textBounds: { top: number; left: number; width: number; height: number } | null;
    gutterBounds: { top: number; left: number; width: number; height: number } | null;
  }>;
  popovers: Array<{
    markId: string;
    bounds: { top: number; left: number; width: number; height: number };
  }>;
  overlaps: Array<{
    element1: { type: string; id?: string };
    element2: { type: string; id?: string };
    overlapArea: number;
  }>;
  gutterAlignments: Array<{
    markId: string;
    textMidY: number;
    gutterMidY: number;
    delta: number;
    aligned: boolean;
  }>;
}

type ShareRuntimeActivationOptions = {
  promptForName?: boolean;
  preserveCurrentDocument?: boolean;
};

export interface ProofEditor {
  editor: Editor | null;
  heatMapMode: 'hidden' | 'subtle' | 'background' | 'full';

  init(): Promise<void>;
  loadDocument(content: string, options?: { allowShareContentMutation?: boolean }): void;
  getContent(): string;
  looksLikeMarkdown(content: string): boolean;
  getMarkdownSnapshot(): { content: string } | null;
  getFullState(): EditorFullState | null;
  setHeatMapMode(mode: string): void;
  setTheme(theme: string): void;
  setCurrentActor(actor: string): void;
  scrollToLine(line: number): void;
  scrollToOffset(offset: number): void;
  navigateToAgent(sessionId: string): void;
  followAgent(sessionId: string): void;
  unfollowAgent(showToast?: boolean): void;
  getFollowedAgent(): string | null;
  isFollowingAgent(sessionId?: string): boolean;

  // Editor operations (for AI agent)
  // author parameter creates an authored mark if specified (e.g., 'ai:claude', 'human:dan')
  insertAt(offset: number, text: string, author?: string): void;
  insertAtCursor(text: string, author?: string): void;
  replaceSelection(text: string, author?: string): void;
  replaceRange(from: number, to: number, text: string, author?: string): void;

  // Agent cursor methods (for AI agent navigation)
  setAgentCursor(position: number, animateOrActor?: boolean | string, actor?: string): void;
  setAgentSelection(from: number, to: number, animateOrActor?: boolean | string, actor?: string): void;
  clearAgentCursor(): void;
  getAgentCursorState(): { cursorPos: number | null; selectionFrom: number | null; selectionTo: number | null } | null;

  // Batch operations (atomic multi-step edits)
  executeBatch(operations: BatchOperation[]): BatchResult;

  // Suggestions (track changes) methods
  enableSuggestions(): void;
  disableSuggestions(): void;
  toggleSuggestions(): boolean;
  isSuggestionsEnabled(): boolean;
  getSuggestions(): Mark[];
  acceptSuggestion(id: string): boolean;
  rejectSuggestion(id: string): boolean;
  acceptAllSuggestions(): number;
  rejectAllSuggestions(): number;

  // Inline comment composer (marks-based)
  beginAddComment(by: string): boolean;

  // === Unified Marks API (new system) ===
  // Reading marks
  getAllMarks(): Mark[];
  getMarksByKind(kind: MarkKind): Mark[];
  getPendingMarkSuggestions(): Mark[];
  getPendingMarkIds(): string[];
  getUnresolvedMarkComments(): Mark[];
  findMarkById(id: string): Mark | undefined;

  // Visual layout (for agent-native testing)
  getVisualLayout(): VisualLayoutInfo;

  // Approvals & Flags
  markApprove(quote: string, by: string): Mark | null;
  markApproveSelector(selector: CommentSelector, by: string): Mark | null;
  markUnapprove(quote: string, by: string): boolean;
  markFlag(quote: string, by: string, note?: string): Mark | null;
  markFlagSelector(selector: CommentSelector, by: string, note?: string): Mark | null;
  markUnflag(quote: string, by: string): boolean;
  markApproveSelection(by: string): Mark | null;
  markFlagSelection(by: string, note?: string): Mark | null;

  // Comments (unified marks style)
  markComment(quote: string, by: string, text: string, meta?: OrchestratedMarkMeta): Mark;
  markCommentSelection(by: string, text: string): Mark | null;
  markCommentSelector(selector: CommentSelector, by: string, text: string, meta?: OrchestratedMarkMeta): Mark | null;
  markReply(markId: string, by: string, text: string): Mark | null;
  markResolve(markId: string): boolean;
  markUnresolve(markId: string): boolean;
  markDeleteThread(markId: string): boolean;

  // Suggestions (unified marks style)
  markSuggestInsert(quote: string, by: string, content: string, range?: MarkRange, meta?: OrchestratedMarkMeta): Mark | null;
  markSuggestDelete(quote: string, by: string, range?: MarkRange, meta?: OrchestratedMarkMeta): Mark | null;
  markSuggestReplace(quote: string, by: string, content: string, range?: MarkRange, meta?: OrchestratedMarkMeta): Mark | null;
  markSuggestEdit(
    find: string,
    replace: string,
    by: string,
    options?: FindOptions
  ): { success: boolean; count: number; marks?: Mark[]; error?: string };
  markFind(
    find: string,
    options?: FindOptions
  ): { success: boolean; count: number; matches?: Array<{ from: number; to: number; match: string; line: number; column: number; snippet: string }>; error?: string };
  searchDocument(
    query: string,
    options?: FindOptions
  ): {
    success: boolean;
    count: number;
    matches: Array<{ text: string; position: number; context: string; from: number; to: number }>;
    error?: string;
  };
  markModifySuggestion(markId: string, content: string): boolean;
  markAccept(markId: string): boolean;
  markReject(markId: string): boolean;
  markAcceptAll(): number;
  markRejectAll(): number;

  // Mark management
  markDelete(markId: string): boolean;
  markSetActive(markId: string | null): void;

  // Mark navigation
  navigateToMark(markId: string): boolean;
  navigateToNextComment(): string | null;
  navigateToPrevComment(): string | null;
  navigateToNextSuggestion(): string | null;
  navigateToPrevSuggestion(): string | null;
  resolveActiveComment(): boolean;
  setAlwaysOnEnabled(enabled: boolean): void;
  sweepForActionableItems(triggerOnFirstSweep?: boolean): void;

  // Find functionality
  showFindBar(): void;
  hideFindBar(): void;
  findNext(query: string): boolean;
  findPrev(query: string): boolean;

  // === Share / Marks Metadata ===
  activateShareRuntime(options?: ShareRuntimeActivationOptions): boolean;
  deactivateShareRuntime(): void;
  /**
   * Debug helper for staging QA. Exposes a safe, redacted snapshot of the Yjs state
   * so we can distinguish "ydoc not receiving remote updates" from "editor not applying them".
   */
  debugCollabYDocSummary(): {
    connected: boolean;
    synced: boolean;
    shareSlug: string | null;
    wsBase: string | null;
    prosemirrorLen: number | null;
    prosemirrorPreview: string | null;
    markdownLen: number | null;
    markdownPreview: string | null;
  };
  // Get marks metadata for the current editor state (used by native sync)
  getMarkMetadata(): Record<string, unknown>;
  getMarkMetadataWithQuotes(): Record<string, unknown>;

  // === Authorship (Provenance) ===
  // Get authorship statistics
  getAuthorshipStats(): { humanPercent: number; aiPercent: number; humanChars: number; aiChars: number };
  // Add an authored mark for a range of content
  addAuthoredMark(by: string, range: MarkRange, quote?: string): Mark;
  // Override authored marks for the current selection (or block)
  markAuthoredSelection(by: string): Mark | null;
  // Coalesce adjacent authored marks by the same actor
  coalesceMarks(): void;
  // Update mark positions after a document edit
  updateMarksAfterEdit(editFrom: number, editTo: number, newLength: number): void;

  // === Navigation ===
  // Navigate to a specific mark and highlight it
  navigateToMark(markId: string): boolean;
  // Navigate to comments (cycles through unresolved comments)
  navigateToFirstComment(): string | null;
  navigateToNextComment(): string | null;
  navigateToPrevComment(): string | null;
  // Navigate to suggestions (cycles through pending suggestions)
  navigateToFirstSuggestion(): string | null;
  navigateToNextSuggestion(): string | null;
  navigateToPrevSuggestion(): string | null;
  // Resolve the currently active comment (if any)
  resolveActiveComment(): boolean;
  // Enable/disable always-on processing state
  setAlwaysOnEnabled(enabled: boolean): void;
  // Sweep for actionable items (used by always-on timer)
  sweepForActionableItems(triggerOnFirstSweep?: boolean): void;

  // === Find (Cmd+F) ===
  // Show/hide the find bar
  showFindBar(): void;
  hideFindBar(): void;
  // Find text in document
  find(query: string): { total: number; current: number };
  // Navigate between matches
  findNext(): { total: number; current: number };
  findPrev(): { total: number; current: number };
  // Clear find highlighting
  clearFind(): void;

  // === Skills & Review ===
  // Set API key for agent
  setApiKey(apiKey: string): void;
  // Get available review skills
  getSkills(): Array<{
    id: string;
    name: string;
    description: string;
    icon?: string;
    parallelStrategy: string;
    debugLoop?: string;
    maxAgents?: number;
    batchSize?: number;
    orchestratedVisibleMarks?: boolean;
    promptCharCount: number;
    styleGuideVersion?: string;
    styleGuideCharCount?: number;
  }>;
  // Run a skill-based review
  runSkillReview(skillId: string, scope: 'selection' | 'document'): Promise<void>;
  // Debug: run orchestrator only and return the focus-area plan
  debugPlanOnly(
    skillId: string,
    options?: {
      forceFresh?: boolean;
      cancelActive?: boolean;
      timeoutMs?: number;
      focusAreaIds?: string[];
      maxFocusAreas?: number;
      singleWriter?: boolean;
      visibleProvisionalMarks?: boolean;
      markStrategy?: 'propose' | 'visible-provisional';
      useGlobalConfig?: boolean;
    }
  ): Promise<unknown>;
  // Debug: run a single focus area via one sub-agent (no marks)
  debugRunSingleFocusArea(
    skillId: string,
    options?: {
      focusAreaIndex?: number;
      focusAreaId?: string;
      useCachedPlan?: boolean;
      forceFreshPlan?: boolean;
      cancelActive?: boolean;
      timeoutMs?: number;
      focusAreaIds?: string[];
      maxFocusAreas?: number;
      singleWriter?: boolean;
      visibleProvisionalMarks?: boolean;
      markStrategy?: 'propose' | 'visible-provisional';
      useGlobalConfig?: boolean;
    }
  ): Promise<unknown>;
  // Debug: inspect/clear cached orchestrator plans
  debugGetCachedPlan(skillId: string): unknown;
  debugClearPlanCache(skillId?: string): void;
  // Debug: run the orchestrator path with explicit orchestration options (creates marks)
  debugRunOrchestrated(
    skillId: string,
    options?: {
      scope?: ReviewScope;
      selection?: { from: number; to: number };
      orchestration?: OrchestrationRunOptions;
      cancelActive?: boolean;
    }
  ): Promise<unknown>;
  // Debug: map plain-text offsets to doc positions and inspect textblocks
  debugMapTextOffsets(from: number, to: number): { range: MarkRange | null; quote: string | null } | null;
  debugDescribeTextblocks(range: { from: number; to: number }): unknown;
  debugTextForRange(range: MarkRange): { range: MarkRange; text: string } | null;
  debugGetParagraphCandidate(minWords?: number): { range: MarkRange; quote: string; line: number } | null;
  debugFindBlockByText(text: string): { range: MarkRange; nodeType: string; line: number } | null;
  debugInspectMarksForText(target: string): {
    found: boolean;
    range?: MarkRange;
    markNames?: string[];
    hasEm?: boolean;
    hasStrong?: boolean;
  } | null;
  debugResolveRangeWithValidation(quote: string, range?: MarkRange): unknown;
  debugAnalyzeReplace(quote: string, content: string, range?: MarkRange): unknown;
  debugQuoteSpansMultipleTableCells(quote: string, range?: MarkRange): boolean;
  // Cancel the currently running review, if any
  cancelReview(): Promise<void>;
  // Stop all in-progress reviews and clear review locks
  stopAllReviews(): Promise<{ cancelledSessions: number; unlocked: boolean; lockCount: number }>;
  // Lock/unlock the editor during orchestrated review runs
  reviewLock(reason?: string): { locked: boolean; lockCount: number; reason?: string };
  reviewUnlock(): { locked: boolean; lockCount: number };
  reviewLockStatus(): { locked: boolean; lockCount: number; reason?: string };
  isReviewLocked(): boolean;
}


/**
 * Top bar spacing (Mike, 2026-09-21: "The bar at the top has excess whitespace above and below the
 * buttons."). Touch targets stay at least 44 px on phones and touch screens.
 */
const TOP_BAR_LAYOUT = {
  /** Desktop: the bar's distance from the top edge (was 18). */
  desktopTopPx: 8,
  /** Desktop: padding above and below the buttons (was 16). */
  desktopPadY: 4,
  /** Desktop with a mouse: button height (was 48). */
  desktopTargetPx: 36,
  /** Phone: the bar's height (44 px targets + 2 px above and below; was 52). */
  phoneBarPx: 48,
  /** Space between the bar and the first line of text (was 32; phones also added the desktop's 18 by mistake). */
  textGapDesktopPx: 16,
  textGapPhonePx: 12,
} as const;

class ProofEditorImpl implements ProofEditor {
  editor: Editor | null = null;
  heatMapMode: 'hidden' | 'subtle' | 'background' | 'full' = 'background';
  private isCliMode: boolean = false;
  private isShareMode: boolean = false;
  private shareBannerSuggestBtnEl: HTMLButtonElement | null = null;
  private suggestToggleWritingUnsub: (() => void) | null = null;
  private shareBannerSuggestionReviewBtnEl: HTMLButtonElement | null = null;
  private shareSuggestionReviewSignature: string = '';
  private readonly shareSuggestionReviewUpdateScheduler = createShareSuggestionReviewUpdateScheduler(
    (run: () => void) => {
      if (typeof window.requestAnimationFrame === 'function') {
        return window.requestAnimationFrame(() => run());
      }
      return window.setTimeout(run, 16);
    },
    (frameId: number) => {
      if (typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(frameId);
        return;
      }
      window.clearTimeout(frameId);
    },
  );
  private pendingShareSuggestionReviewView: EditorView | null = null;
  private suggestDefaultApplied = false;
  private shareViewerName: string | null = null;
  private isReadOnly: boolean = false;
  private shareAllowLocalEdits: boolean = true;
  private shareContentFilterEnabled: boolean = false;
  private readOnlyBanner: HTMLElement | null = null;
  private reviewLockCount: number = 0;
  private reviewLockReason: string | null = null;
  private reviewLockBanner: HTMLElement | null = null;
  private reviewInFlight: Promise<unknown> | null = null;
  private lastMarkdown: string = '';
  private suppressMarksSync: boolean = false;
  private collabEnabled: boolean = false;
  private collabCanComment: boolean = false;
  private collabCanEdit: boolean = false;
  private applyingCollabRemote: boolean = false;
  private activeCollabSession: CollabSessionInfo | null = null;
  private collabRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private collabSessionRefreshInFlight: boolean = false;
  private shareOtherViewerCount: number = 0;
  private collabConnectionStatus: 'connecting' | 'connected' | 'disconnected' = 'disconnected';
  private collabIsSynced: boolean = false;
  private collabUnsyncedChanges: number = 0;
  private collabPendingLocalUpdates: number = 0;
  private collabUnhealthySinceMs: number | null = null;
  private collabLastRecoveryAttemptMs: number = 0;
  private pendingCollabTemplateMarkdown: string | null = null;
  // During session refresh we defer rebinding Milkdown collab until the new provider is synced.
  // This prevents transient empty-doc renders while reconnecting to a fresh Yjs room.
  private pendingCollabRebindOnSync: boolean = false;
  private collabHydrationAttemptSeq: number = 0;
  private collabHydrationRunning: boolean = false;
  private hasCompletedInitialCollabHydration: boolean = false;
  private hasLocalContentEditSinceHydration: boolean = false;
  private lastContentChangeSource: 'local' | 'remote' | 'system' | null = null;
  private pendingProjectionPublish: boolean = false;
  private initialMarksSynced: boolean = false;
  private lastReceivedServerMarks: Record<string, StoredMark> = {};
  private shareRejectedSuggestionIdsBlockedFromAcceptAll = new Set<string>();
  private liveCollabSuggestionResolutionDepth: number = 0;
  private collabTemplateSeedClaimId: string | null = null;
  private collabTemplateClaimCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private collabTemplateRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private contentSyncTimeout: ReturnType<typeof setTimeout> | null = null;
  private shareRuntimeActivationInFlight: boolean = false;
  private shareInitRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private shareInitRetryCount: number = 0;
  private readonly maxShareInitRetries: number = 5;
  private shareInitAttemptSeq: number = 0;
  // External change state
  private preRefreshRevertContent: string | null = null;
  private preRefreshRevertTimestamp: number = 0;
  private refreshBanner: HTMLElement | null = null;
  private toastElement: HTMLElement | null = null;
  private shareMenuCleanup: (() => void) | null = null;
  /** Invite person: whether this viewer is an Owner who may invite people (null: not checked yet). */
  private teamCanManage: boolean | null = null;
  private somaSessionListener: (() => void) | null = null;
  private presenceMenuCleanup: (() => void) | null = null;
  private agentMenuCleanup: (() => void) | null = null;
  private playmakerReview: PlayMakerReview | null = null;
  private lineMarks: LineMarksUI | null = null;
  private readingWalk: ReadingWalkUI | null = null;
  /** Proof Documents Step B7: chat in the right rail (desktop) or a bottom sheet (phone). */
  private chat: ChatUI | null = null;
  private chatUnread = 0;
  private folding: FoldingUI | null = null;
  /** Accord round 2 stage C: the Open / Accord toggle, the honest header and the zero moment. */
  private openViewUI: OpenViewUI | null = null;
  /** The one Undo (Mike, 2026-09-19): the rail button and Cmd/Ctrl+Z. */
  private undoUI: UndoUI | null = null;
  /** Accord layout stage 2: the menu bar, the toolbar's Undo slot, Edit › Find. */
  private menuBar: MenuBar | null = null;
  private findBar: FindBar | null = null;
  private undoPlacementQuery: MediaQueryList | null = null;
  /** Item 3 (Mike, 2026-09-19): typing "?" after a sentence asks the AIs to clarify it. */
  private clarifyUI: ClarifyUI | null = null;
  /** Accord round 2 stage A: leaving an edit posts what was typed (src/ui/edit-gesture.ts). */
  private editGesture: EditGestureUI | null = null;
  private reviewDecisionHistory: ReviewDecisionHistory | null = null;
  private typedDiscussions: TypedDiscussionController | null = null;
  private readonly typedDiscussionHistory = new Map<string, { checkpoint: ReturnType<ReviewDecisionHistory['checkpoint']>; entryId?: string }>();
  private readonly returningTypedThreads = new Set<string>();
  private reviewDecisionIds = new Set<string>();
  private capturingReviewDecision = false;
  private restoringReviewDecision = false;
  private suggestionReviewMenuCleanup: (() => void) | null = null;
  private shareWelcomeToast: HTMLElement | null = null;
  private shareDocTitle: string = 'Untitled';
  private shareBannerTitleEl: HTMLElement | null = null;
  private shareBannerResizeObserver: ResizeObserver | null = null;
  private shareBannerAvatarsEl: HTMLElement | null = null;
  private shareBannerAgentSlotEl: HTMLElement | null = null;
  private shareBannerSyncDotEl: HTMLElement | null = null;
  private shareBannerSyncLabelEl: HTMLElement | null = null;
  private shareBannerTitleEditing: boolean = false;
  private shareTitlePersistSeq: number = 0;
  private shareLastStatusLabel: string = '';
  private shareStatusTextVisibleUntilMs: number = 0;
  private shareStatusHideTimer: ReturnType<typeof setTimeout> | null = null;
  private shareWsUnsubscribe: (() => void) | null = null;
  private shareEventPoller: ShareEventPoller | null = null;
  private shareEventCursor: number = 0;
  private shareLastForcedCollabEventId: number = 0;
  private shareDocumentUpdatedTimer: ReturnType<typeof setTimeout> | null = null;
  private shareMarksRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingShareMarksRefresh: boolean = false;
  private pendingCommentDraftRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCommentDraftSnapshot: CommentPopoverDraftSnapshot | null = null;
  private shareAgentPresenceSummary: string = '';
  private shareAgentActivitySignature: string = '';
  private shareAgentActivityItems: Array<Record<string, any>> = [];
  private shareAgentPresenceFallback = new Map<string, {
    id: string;
    name: string;
    status: string;
    color: string;
    avatar?: string;
    at: string;
    expiresAt?: string;
  }>();
  private shareAgentPresenceExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private shareAgentPresenceCleanup: (() => void) | null = null;
  private shareAgentPresenceIcons = new Map<string, AgentFamily>();
  private shareAgentAwarenessClientIds = new Map<string, number>();
  private shareAgentAwarenessClocks = new Map<string, number>();
  // Navigation state
  private currentCommentIndex: number = -1;
  private currentSuggestionIndex: number = -1;
  // Find state
  private findQuery: string = '';
  private findMatches: Array<{ from: number; to: number }> = [];
  private currentFindIndex: number = -1;
  private cleanupNavigation: (() => void) | null = null;
  private lastEditorInputActivitySentAt: number = 0;
  private lastLocalTypingAt: number = 0;
  private lifecycleHandlersInstalled: boolean = false;
  private readonly webHaptics = new WebHaptics();
  private readonly collabTemplateClaimStaleMs: number = 3_000;
  private readonly collabTemplateClaimSettleMs: number = 250;
  private readonly collabTemplateRetryMs: number = 450;
  private readonly collabRecoveryDelayMs: number = 4_000;
  private readonly collabRecoveryBackoffMs: number = 5_000;
  private readonly collabTypingRecoveryGraceMs: number = 3_000;
  private readonly shareEventPollMs: number = 1500;
  private readonly shareDocumentUpdatedDebounceMs: number = 600;
  private readonly commentPopoverDraftRestoreDelayMs: number = 120;
  private readonly commentPopoverDraftRestoreMaxAttempts: number = 10;
  // Content/reporting state (used by agent integration + telemetry)
  private initState: 'idle' | 'initializing' | 'ready' = 'idle';
  private revision: number = 0;
  private hasTrackedDocumentOpened: boolean = false;

  constructor() {
    const proofConfig = (window as Window & {
      __PROOF_CONFIG__?: { windowId?: string; documentId?: string };
    }).__PROOF_CONFIG__ ?? {};

    if (!proofConfig.windowId) {
      proofConfig.windowId = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    if (!proofConfig.documentId) {
      proofConfig.documentId = document.location.pathname || 'unknown';
    }

    (window as Window & { __PROOF_CONFIG__?: { windowId?: string; documentId?: string } }).__PROOF_CONFIG__ = proofConfig;

    const windowId = proofConfig.windowId;
    const documentId = proofConfig.documentId;

    initTelemetry({ windowId, documentId });

    initSessionManager({
      persistenceKey: `proof-agent-sessions:${windowId ?? 'default'}:${documentId ?? 'unknown'}`,
      onSessionChange: syncAgentSessions,
    });

    this.isCliMode = fileClient.isCliMode();
    this.isShareMode = shareClient.isShareMode();
  }

  async init(): Promise<void> {
    const root = document.getElementById('editor');
    if (!root) {
      console.error('Editor root element not found');
      return;
    }
    this.applyTopChromeForMode();

    const prismPlugin = await loadPrismPlugin();

    // Clear the loading indicator
    root.innerHTML = '';

    let editorBuilder = Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, '');
      })
      .config(nord)
      // Milkdown's own hard-break plugin appends an empty transaction after every mark change,
      // which made server mark updates into invisible Undo steps; ours appends only real changes.
      .use(commonmark.filter(plugin => plugin !== hardbreakClearMarkPlugin))
      .use(hardbreakClearMarksPlugin)
      .use(gfm)
      // Frontmatter must be registered after commonmark so remark-frontmatter
      // claims `---` before commonmark parses it as a thematic break.
      .use(remarkFrontmatterPlugin)
      .use(frontmatterSchema)
      .use(codeBlockExtPlugins)
      .use(history)
      .use(listener)
      .use(collab)
      .use(cursor)
      .use(clipboard);

    if (prismPlugin) {
      editorBuilder = editorBuilder.use(prismPlugin);
    }

    this.editor = await editorBuilder
      // Register proof mark schemas
      .use(proofMarkPlugins)
      // Register remark plugin for proof marks parsing
      .use(remarkProofMarksPlugin)
      // Register contexts
      .use(heatmapCtx)
      .use(agentCursorCtx)
      // Register plugins
      .use(authoredTrackerPlugin)
      .use(heatmapPlugin)
      .use(agentCursorPlugin)
      // Register suggestions plugin
      .use(suggestionsPlugins)
      // Inline mark UI (popover + selection bar)
      .use(markPopoverPlugin)
      .use(markSelectionBarPlugin)
      .use(arrowCommentPlugin)
      .use(findHighlightsPlugin)
      .use(shareContentFilterPlugin)
      .use(taskCheckboxesPlugin)
      .use(mermaidDiagramsPlugin)
      .use(markdownLinkClickPlugin)
      // Register unified marks plugin
      .use(marksPlugins)
      // Register keybindings plugin for agent shortcuts
      .use(keybindingsPlugin)
      // Allow Backspace to delete empty table rows
      .use(tableKeyboardPlugin)
      // Proof Documents Step 1: line marks overlay (no decorations, no document changes)
      .use(lineMarksViewPlugin)
      .use(draftViewPlugin)
      // Proof Documents Step B2: folded sections (view-only node decorations)
      .use(foldViewPlugin)
      // Proof Documents Step B3: {ask} tags and answer controls (view-only widgets)
      .use(askViewPlugin)
      // {do} action lines: Do tags and action controls (view-only widgets; Run is disabled)
      .use(doViewPlugin)
      // Proof Documents Step B4f: alternatives stacks and term links (view-only decorations)
      .use(proofExtrasViewPlugin)
      // Line tiers: context lines quieter, "Show only decisions" folds them (view-only decorations)
      .use(tierViewPlugin)
      // Closed Issues fold for the person who closed them (view-only decorations)
      .use(marksSyncPlugin((actionMarks, view, actionMetadata) => {
        this.handleMarksChange(actionMarks, view, actionMetadata);
      }))
      .config((ctx) => {
        // remark-gfm otherwise measures serialized Proof <span> wrappers when
        // aligning table columns, leaving large invisible padding after stripping.
        ctx.set(remarkGFMPlugin.options.key, {
          stringLength: (value: string) => stripProofSpanTags(value).length,
        });
        // Note: remarkProofMarks is now registered via .use(remarkProofMarksPlugin)
        ctx.update(remarkStringifyOptionsCtx, (prev) => ({
          ...prev,
          handlers: {
            ...(prev.handlers ?? {}),
            proofMark: proofMarkHandler,
          },
        }));

        // Set up listener for content changes
        ctx.get(listenerCtx).updated((_ctx, doc, prevDoc) => {
          if (prevDoc && doc.eq(prevDoc)) return;
          this.scheduleContentSync();
        });

        // Initialize heatmap context
        ctx.set(heatmapCtx.key, { mode: this.heatMapMode });
      })
      .create();

    this.editor.action((ctx) => {
      const parser = ctx.get(parserCtx);
      setDefaultMarkdownParser(parser);
    });

    const view = this.editor.ctx.get(editorViewCtx);
    (window as any).__editorView = view;
    this.updateEditableState(view);
    this.cleanupNavigation = initAgentNavigation(view);

    this.installLifecycleHandlers();

    // Add cursor tracking
    this.setupCursorTracking();

    // Set up suggestions interceptor to wrap transactions for track changes.
    // This uses dispatchTransaction decorator to intercept edits BEFORE they're applied,
    // which is necessary for proper deletion tracking (converting deletes to deletion marks).
    this.setupSuggestionsInterceptor();

    // Initialize agent integration for @proof mentions
    this.initAgentIntegration();

    // Theme picker only applies to regular editor mode.
    if (!this.isShareMode) {
      initThemePicker();
    }

    // If in CLI mode, load the file from the API
    if (this.isCliMode) {
      await this.initFromCli();
    }

    // If in share mode, load from share server
    if (this.isShareMode) {
      await this.initFromShare();
    }
  }

  private installLifecycleHandlers(): void {
    if (this.lifecycleHandlersInstalled) return;
    this.lifecycleHandlersInstalled = true;

    window.addEventListener('beforeunload', () => {
      if (this.isShareMode) {
        this.flushShareMarks({ keepalive: true, persistContent: true });
        collabClient.flushPendingLocalStateForUnload();
      }
      this.clearPendingCommentDraftRestore();
      if (this.collabRefreshTimer) {
        clearInterval(this.collabRefreshTimer);
        this.collabRefreshTimer = null;
      }
      this.resetPendingCollabTemplateState(true);
      this.resetShareMarksSyncState();
      this.disconnectCollabService();
      collabClient.disconnect();
      if (this.shareWsUnsubscribe) {
        this.shareWsUnsubscribe();
        this.shareWsUnsubscribe = null;
      }
      this.stopShareEventPoll();
      shareClient.disconnect();
      this.cleanupNavigation?.();
    });

    window.addEventListener('pagehide', () => {
      if (this.isShareMode) {
        this.flushShareMarks({ keepalive: true, persistContent: true });
        collabClient.flushPendingLocalStateForUnload();
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.isShareMode) {
        this.flushShareMarks({ keepalive: true, persistContent: true });
        collabClient.flushPendingLocalStateForUnload();
      }
    });
  }

  private async initFromCli(): Promise<void> {
    try {
      // Fetch configuration first
      const config = await fileClient.fetchConfig();
      if (config) {
        this.isReadOnly = config.readOnly;
        fileClient.setInitialTitle();

        // Show read-only indicator if applicable
        if (this.isReadOnly) {
          this.showReadOnlyBanner();
        }
      }

      // Load the file
      const fileData = await fileClient.loadFile();
      if (fileData) {
        this.loadDocument(fileData.content);
      }
    } catch (error) {
      console.error('Failed to initialize from CLI:', error);
      this.showErrorBanner((error as Error).message);
    }
  }

  private async initFromShare(options?: ShareRuntimeActivationOptions): Promise<void> {
    const attemptSeq = ++this.shareInitAttemptSeq;
    this.resetPendingCollabTemplateState(true);
    this.collabHydrationAttemptSeq += 1;
    this.collabHydrationRunning = false;
    this.resetShareMarksSyncState();
    try {
      const preserveCurrentDocument = options?.preserveCurrentDocument === true;
      const contextResponse = await shareClient.fetchOpenContext();
      if (this.isShareRequestError(contextResponse)) {
        throw new Error(contextResponse.error.message);
      }
      const context = contextResponse && 'doc' in contextResponse
        ? contextResponse
        : null;
      const wantsNamePrompt = options?.promptForName ?? true;
      const canActInDocument = Boolean(context?.capabilities?.canComment || context?.capabilities?.canEdit);
      const existingViewerName = getViewerName();
      this.shareViewerName = existingViewerName ?? this.shareViewerName ?? this.deriveDefaultShareViewerName();
      setCurrentActorValue(`human:${this.shareViewerName || 'Anonymous'}`);
      shareClient.setViewerName(this.shareViewerName || 'Anonymous');
      collabClient.setLocalUser(
        { name: this.shareViewerName || 'Anonymous' },
        shareClient.getSlug() ?? undefined
      );
      if (wantsNamePrompt && canActInDocument && !existingViewerName) {
        void promptForName()
          .then((name) => {
            const resolvedName = typeof name === 'string' && name.trim().length > 0
              ? name.trim()
              : this.deriveDefaultShareViewerName();
            this.shareViewerName = resolvedName;
            setCurrentActorValue(`human:${resolvedName}`);
            shareClient.setViewerName(resolvedName);
            collabClient.setLocalUser(
              { name: resolvedName },
              shareClient.getSlug() ?? undefined
            );
          })
          .catch((error) => {
            console.warn('[share] name prompt failed', error);
          });
      }

      const doc = context?.doc ?? await shareClient.fetchDocument();
      if (!doc) {
        this.showErrorBanner('Document not found or has been unshared.', {
          retryLabel: 'Retry',
          onRetry: () => {
            this.resetShareInitRetryState();
            void this.initFromShare(options);
          },
        });
        return;
      }

      // Set title
      document.title = pageTitle(typeof doc.title === 'string' && doc.title.trim() ? doc.title : 'Shared Document', ' - ');
      this.shareDocTitle = typeof doc.title === 'string' && doc.title.trim().length > 0
        ? doc.title.trim()
        : 'Untitled';

      let collabTemplateMarkdown: string | null = null;

	      if (!preserveCurrentDocument) {
	        collabTemplateMarkdown = this.normalizeMarkdownForCollab(doc.markdown);
	        this.lastMarkdown = this.normalizeMarkdownForRuntime(doc.markdown);
	      } else {
	        collabTemplateMarkdown = this.captureCollabTemplateFromCurrentDocument();
	      }
	      if (collabTemplateMarkdown !== null && collabTemplateMarkdown.trim().length === 0) {
	        collabTemplateMarkdown = null;
	      }

      this.showShareBanner(doc.viewers ?? 0);
      this.ensureShareWebSocketConnection();

      // Prefer collab runtime path when available.
      const collabSession = context
        ? { session: context.session, capabilities: context.capabilities }
        : await shareClient.fetchCollabSession();
      if (this.isShareRequestError(collabSession)) {
        throw new Error(collabSession.error.message);
      }
      const shareCapabilities = context?.capabilities
        ?? (collabSession && 'capabilities' in collabSession ? collabSession.capabilities : null);
      this.collabCanComment = Boolean(shareCapabilities?.canComment);
      this.showShareWelcomeToastOnce(shareCapabilities);

      if (collabSession && 'session' in collabSession && collabSession.session) {
        if (this.collabRefreshTimer) {
          clearInterval(this.collabRefreshTimer);
          this.collabRefreshTimer = null;
        }
        const initialMarks = (context?.doc?.marks && typeof context.doc.marks === 'object' && !Array.isArray(context.doc.marks))
          ? { ...(context.doc.marks as Record<string, StoredMark>) }
          : {};
        this.collabEnabled = true;
        this.collabCanComment = Boolean(collabSession.capabilities.canComment);
        this.collabCanEdit = Boolean(collabSession.capabilities.canEdit);
        this.activeCollabSession = collabSession.session;
        this.collabConnectionStatus = 'connecting';
        this.collabIsSynced = false;
        this.collabUnsyncedChanges = 0;
        this.collabPendingLocalUpdates = 0;
        this.resetProjectionPublishState();
        if (Object.keys(initialMarks).length > 0) {
          this.lastReceivedServerMarks = initialMarks;
          this.initialMarksSynced = true;
        }
        this.updateShareEditGate();

        collabClient.onMarks((marks) => {
          const incomingMarks = (marks && typeof marks === 'object' && !Array.isArray(marks))
            ? (marks as Record<string, StoredMark>)
            : {};
          // Hocuspocus can emit a transient empty marks payload before initial sync
          // or during reconnect. Once synced, an empty map is authoritative even
          // while content updates are still in flight: it can be a remote resolution.
          if (
            Object.keys(incomingMarks).length === 0
            && Object.keys(this.lastReceivedServerMarks).length > 0
            && !this.collabIsSynced
          ) {
            return;
          }

          this.lastReceivedServerMarks = { ...incomingMarks };
          this.initialMarksSynced = true;
          if (!this.isEditorDocStructurallyEmpty()) {
            this.applyLatestCollabMarksToEditor();
          }
        });
        collabClient.onPresence((count) => {
          const otherCount = Math.max(0, count - 1);
          this.shareOtherViewerCount = otherCount;
          this.updateShareBannerTitleDisplay();
          this.updateShareBannerPresenceDisplay();
        });
        collabClient.onSyncStatus((status) => {
          this.updateCollabHealthWindow(status);
          this.collabConnectionStatus = status.connectionStatus;
          this.collabIsSynced = status.isSynced;
          this.collabUnsyncedChanges = status.unsyncedChanges;
          this.collabPendingLocalUpdates = status.pendingLocalUpdates;
          this.updateShareEditGate();
          if (collabClient.terminalCloseReason === 'reload-required') this.showCollabReloadRequired();
          if (status.connectionStatus === 'disconnected' && collabClient.terminalCloseReason === 'permission-denied') {
            void this.refreshCollabSessionAndReconnect(false);
          }
          if (status.connectionStatus === 'connected' && status.isSynced) {
            if (this.pendingCollabRebindOnSync) {
              this.pendingCollabRebindOnSync = false;
              this.connectCollabService();
            }
            this.ensureCollabCursorsInstalled();
            this.applyPendingCollabTemplate();
            this.kickCollabHydration();
            this.applyLatestCollabMarksToEditor();
            setTimeout(() => this.applyLatestCollabMarksToEditor(), 150);
            this.installShareAgentPresenceObservers();
            this.clearErrorBanner();
            this.resetShareInitRetryState();
            if (status.unsyncedChanges === 0) {
              this.flushPendingProjectionMarkdown();
            }
          }
          this.updateShareBannerSyncDisplay();
        });
        collabClient.onDocumentUpdated(() => {
          if (!this.collabEnabled) return;
          if (this.collabUnsyncedChanges > 0) return;
          if (this.collabConnectionStatus === 'connected' && this.collabIsSynced) return;
          void this.refreshCollabSessionAfterDocumentUpdated();
        });
        this.resetPendingCollabTemplateState(false);
        this.pendingCollabTemplateMarkdown = this.shouldAllowCollabTemplateSeed(collabSession.session)
          ? collabTemplateMarkdown
          : null;
        // Defer the Milkdown<->Yjs binding until the provider has completed its
        // initial room sync. Binding against a reset local editor before sync can
        // generate self-inflicted local updates that keep the client stuck syncing.
        this.pendingCollabRebindOnSync = true;
        this.updateShareEditGate();
        collabClient.connect(collabSession.session);
        this.startCollabRefreshLoop();
      } else {
        this.collabEnabled = false;
        this.collabCanComment = false;
        this.collabCanEdit = false;
        this.activeCollabSession = null;
        this.collabConnectionStatus = 'disconnected';
        this.collabIsSynced = false;
        this.collabUnsyncedChanges = 0;
        this.collabPendingLocalUpdates = 0;
        this.resetProjectionPublishState();
        this.updateShareEditGate();
        if (!preserveCurrentDocument) {
          const contentWithMarks = embedMarks(doc.markdown, doc.marks as Record<string, StoredMark>);
          this.loadDocument(contentWithMarks);
          if (doc.marks && Object.keys(doc.marks).length > 0) {
            this.applyExternalMarks(doc.marks as Record<string, StoredMark>);
          }
          const initialMarks = doc.marks
            ? { ...(doc.marks as Record<string, StoredMark>) }
            : {};
          this.lastReceivedServerMarks = initialMarks;
          this.initialMarksSynced = true;
        }
        startAgentJoinNotices(shareClient.getSlug());
        window.dispatchEvent(new Event('proof:editor-ready'));
        this.showErrorBanner('Live collaboration is currently unavailable for this shared document.');
        return;
      }

      console.log('[initFromShare] Loaded shared document:', shareClient.getSlug());
      if (attemptSeq !== this.shareInitAttemptSeq) return;
      this.clearErrorBanner();
      this.resetShareInitRetryState();
      startAgentJoinNotices(shareClient.getSlug());
      window.dispatchEvent(new Event('proof:editor-ready'));
      void this.checkTeamAccess();
      // Owner rights ride on the SOMA session, which the page may renew after this first check
      // (proof-session.js): re-read them when it does, or the Share dialog keeps hiding the
      // link setting from an Owner until a reload (Mike, 2026-09-25).
      if (!this.somaSessionListener) {
        this.somaSessionListener = () => { this.teamCanManage = null; void this.checkTeamAccess(); };
        window.addEventListener('proof:soma-session', this.somaSessionListener);
      }
    } catch (error) {
      if (attemptSeq !== this.shareInitAttemptSeq) return;
      console.error('[initFromShare] Failed:', error);
      const message = this.getErrorMessage(error);
      if (this.collabConnectionStatus === 'connected' && this.collabIsSynced) {
        this.clearErrorBanner();
        this.resetShareInitRetryState();
        return;
      }
      if (!this.shouldRetryShareInitError(error)) {
        this.resetShareInitRetryState();
        this.showErrorBanner(message, {
          retryLabel: 'Retry',
          onRetry: () => {
            this.resetShareInitRetryState();
            void this.initFromShare(options);
          },
        });
        return;
      }

      if (this.shareInitRetryCount >= this.maxShareInitRetries) {
        this.resetShareInitRetryState();
        this.showErrorBanner(`Unable to connect to live collaboration. ${message}`, {
          retryLabel: 'Retry now',
          onRetry: () => {
            this.resetShareInitRetryState();
            void this.initFromShare(options);
          },
        });
        return;
      }

      this.shareInitRetryCount += 1;
      const delayMs = Math.min(1000 * (2 ** (this.shareInitRetryCount - 1)), 8000);
      this.showErrorBanner(`Load failed. Retrying in ${Math.round(delayMs / 1000)}s...`, {
        retryLabel: 'Retry now',
        onRetry: () => {
          this.resetShareInitRetryState();
          void this.initFromShare(options);
        },
      });
      if (this.shareInitRetryTimer) {
        clearTimeout(this.shareInitRetryTimer);
      }
      this.shareInitRetryTimer = setTimeout(() => {
        this.shareInitRetryTimer = null;
        if (attemptSeq !== this.shareInitAttemptSeq) return;
        void this.initFromShare(options);
      }, delayMs);
    }
  }

  private deriveDefaultShareViewerName(): string {
    const actor = getCurrentActor();
    if (actor.startsWith('human:')) {
      const name = actor.slice('human:'.length).trim();
      if (name.length > 0) return name;
    }
    return 'Anonymous';
  }

  activateShareRuntime(options?: ShareRuntimeActivationOptions): boolean {
    if (this.shareRuntimeActivationInFlight) return false;
    const hasShareConfig = shareClient.refreshRuntimeConfig();
    this.isShareMode = hasShareConfig;
    if (!hasShareConfig) return false;
    this.collabCanComment = false;
    this.collabCanEdit = false;
    this.shareRejectedSuggestionIdsBlockedFromAcceptAll.clear();
    setShareRuntimeCapabilities({ canComment: false, canEdit: false });

    this.shareRuntimeActivationInFlight = true;
    void this.initFromShare(options)
      .finally(() => {
        this.shareRuntimeActivationInFlight = false;
      });
    return true;
  }

  deactivateShareRuntime(): void {
    this.isShareMode = false;
    this.collabEnabled = false;
    this.collabCanComment = false;
    this.collabCanEdit = false;
    this.activeCollabSession = null;
    this.collabIsSynced = false;
    this.collabConnectionStatus = 'disconnected';
    this.collabUnsyncedChanges = 0;
    this.collabPendingLocalUpdates = 0;
    this.collabUnhealthySinceMs = null;
    this.collabLastRecoveryAttemptMs = 0;
    this.collabSessionRefreshInFlight = false;
    this.shareRejectedSuggestionIdsBlockedFromAcceptAll.clear();
    this.resetPendingCollabTemplateState(true);
    this.resetShareMarksSyncState();
    this.resetProjectionPublishState();
    this.applyingCollabRemote = false;
    this.resetShareInitRetryState();
    this.clearErrorBanner();
    if (this.shareDocumentUpdatedTimer) {
      clearTimeout(this.shareDocumentUpdatedTimer);
      this.shareDocumentUpdatedTimer = null;
    }
    if (this.shareMarksRefreshTimer) {
      clearTimeout(this.shareMarksRefreshTimer);
      this.shareMarksRefreshTimer = null;
    }
    this.pendingShareMarksRefresh = false;
    this.clearPendingCommentDraftRestore();
    if (this.shareWsUnsubscribe) {
      this.shareWsUnsubscribe();
      this.shareWsUnsubscribe = null;
    }
    this.stopShareEventPoll();
    shareClient.disconnect();
    resetShareRuntimeCapabilities();
	    if (this.collabRefreshTimer) {
	      clearInterval(this.collabRefreshTimer);
	      this.collabRefreshTimer = null;
	    }
	    this.uninstallShareAgentPresenceObservers();
	    this.disconnectCollabService();
	    collabClient.disconnect();
	    this.uninstallShareContentFilter();
	    this.clearShareBanner();
	  }

  debugCollabYDocSummary(): {
    connected: boolean;
    synced: boolean;
    shareSlug: string | null;
    wsBase: string | null;
    prosemirrorLen: number | null;
    prosemirrorPreview: string | null;
    markdownLen: number | null;
    markdownPreview: string | null;
  } {
    const shareSlug = shareClient.getSlug();
    const connected = collabClient.isConnected();
    const synced = this.collabIsSynced;
    const ydoc = collabClient.getYDoc();

    const wsBase = (() => {
      const active = (this.activeCollabSession && typeof this.activeCollabSession.collabWsUrl === 'string')
        ? this.activeCollabSession.collabWsUrl
        : null;
      if (!active) return null;
      try {
        const url = new URL(active);
        url.searchParams.delete('slug');
        return url.toString().replace(/\?$/, '');
      } catch {
        return active.replace(/\?slug=.*$/, '');
      }
    })();

    if (!ydoc) {
      return {
        connected,
        synced,
        shareSlug,
        wsBase,
        prosemirrorLen: null,
        prosemirrorPreview: null,
        markdownLen: null,
        markdownPreview: null,
      };
    }

    let prosemirrorLen: number | null = null;
    let prosemirrorPreview: string | null = null;
    try {
      const frag = (ydoc as any).getXmlFragment?.('prosemirror');
      if (frag && typeof frag.length === 'number') {
        prosemirrorLen = frag.length;
        prosemirrorPreview = String(frag).slice(0, 300);
      }
    } catch {
      // ignore
    }

    let markdownLen: number | null = null;
    let markdownPreview: string | null = null;
    try {
      const raw = ydoc.getText('markdown').toString();
      markdownLen = raw.length;
      markdownPreview = raw.slice(0, 200);
    } catch {
      // ignore
    }

    return {
      connected,
      synced,
      shareSlug,
      wsBase,
      prosemirrorLen,
      prosemirrorPreview,
      markdownLen,
      markdownPreview,
    };
  }

  private resetPendingCollabTemplateState(clearPendingTemplate: boolean): void {
    if (clearPendingTemplate) {
      this.pendingCollabTemplateMarkdown = null;
    }
    this.collabTemplateSeedClaimId = null;
    if (this.collabTemplateClaimCheckTimer) {
      clearTimeout(this.collabTemplateClaimCheckTimer);
      this.collabTemplateClaimCheckTimer = null;
    }
    if (this.collabTemplateRetryTimer) {
      clearTimeout(this.collabTemplateRetryTimer);
      this.collabTemplateRetryTimer = null;
    }
    this.updateShareEditGate();
  }

  private shareMarksAnchored = false;

  private resetShareMarksSyncState(): void {
    this.shareMarksAnchored = false;
    this.initialMarksSynced = false;
    this.lastReceivedServerMarks = {};
  }

  private parseCollabTemplateClaim(value: unknown): { id: string; ts: number } | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as { id?: unknown; ts?: unknown };
    if (typeof record.id !== 'string' || record.id.length === 0) return null;
    if (typeof record.ts !== 'number' || !Number.isFinite(record.ts)) return null;
    return { id: record.id, ts: record.ts };
  }

  private isEditorDocStructurallyEmpty(): boolean {
    if (!this.editor) return true;
    let isEmpty = true;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;
      if (doc.childCount !== 1) {
        isEmpty = false;
        return;
      }
      const firstChild = doc.firstChild;
      if (!firstChild) {
        isEmpty = true;
        return;
      }
      isEmpty = firstChild.type.name === 'paragraph'
        && firstChild.content.size === 0
        && firstChild.textContent.length === 0;
    });
    return isEmpty;
  }

  private isYjsFragmentStructurallyEmpty(fragment: unknown): boolean {
    if (!fragment) return true;
    const anyFragment = fragment as any;
    const len = anyFragment.length;
    if (typeof len !== 'number') return false;
    if (len === 0) return true;
    if (len !== 1) return false;

    let first: any = null;
    if (typeof anyFragment.get === 'function') {
      first = anyFragment.get(0);
    } else if (typeof anyFragment.toArray === 'function') {
      first = anyFragment.toArray()[0];
    }
    if (!first) return true;
    if (first.nodeName !== 'paragraph') return false;
    try {
      if (String(first) === '<paragraph></paragraph>') return true;
    } catch {
      // ignore
    }
    if (typeof first.length === 'number') {
      return first.length === 0;
    }
    return false;
  }

  private isCollabHydratedForEditing(): boolean {
    if (!this.editor) return false;
    const ydoc = collabClient.getYDoc() as any;
    if (!ydoc || typeof ydoc.getXmlFragment !== 'function') return true;
    let fragment: unknown;
    try {
      fragment = ydoc.getXmlFragment('prosemirror');
    } catch {
      return true;
    }
    let bindingReady = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      try {
        const ystate = (ySyncPluginKey.getState(view.state) as any) ?? null;
        const binding = ystate?.binding;
        const mapping = binding?.mapping;
        bindingReady = ystate?.type === fragment
          && binding?.prosemirrorView === view
          && mapping instanceof Map
          && (this.isYjsFragmentStructurallyEmpty(fragment) || mapping.size > 0);
      } catch {
        bindingReady = false;
      }
    });
    return bindingReady;
  }

  private kickCollabHydration(): void {
    if (!this.isShareMode || !this.collabEnabled) return;
    if (!this.editor) return;
    if (this.collabHydrationRunning) return;

    this.collabHydrationRunning = true;
    const attemptSeq = ++this.collabHydrationAttemptSeq;
    const maxAttempts = 120;

    const finish = () => {
      if (attemptSeq === this.collabHydrationAttemptSeq) {
        this.collabHydrationRunning = false;
      }
    };

    const attempt = (count: number) => {
      if (attemptSeq !== this.collabHydrationAttemptSeq) return;
      if (!this.editor || !this.collabEnabled) {
        finish();
        return;
      }

      const isCollabHydratedForEditing = this.isCollabHydratedForEditing();
      if (this.hasCompletedInitialCollabHydration || isCollabHydratedForEditing) {
        finish();
        if (!this.hasCompletedInitialCollabHydration && isCollabHydratedForEditing) {
          this.markInitialCollabHydrationComplete();
          this.updateShareEditGate();
          this.scheduleContentSync();
        }
        return;
      }

      if (count >= maxAttempts) {
        finish();
        return;
      }
      requestAnimationFrame(() => attempt(count + 1));
    };

    attempt(0);
  }

  private schedulePendingCollabTemplateRetry(): void {
    if (!this.pendingCollabTemplateMarkdown || this.collabTemplateRetryTimer) return;
    this.collabTemplateRetryTimer = setTimeout(() => {
      this.collabTemplateRetryTimer = null;
      this.applyPendingCollabTemplate();
    }, this.collabTemplateRetryMs);
  }

  private shouldAllowCollabTemplateSeed(session: { snapshotVersion: number } | null | undefined): boolean {
    return Boolean(
      this.collabCanEdit
      && session
      && Number.isFinite(session.snapshotVersion)
      && session.snapshotVersion === 0,
    );
  }

  private captureCollabTemplateFromCurrentDocument(): string | null {
    if (!this.editor) return null;
    let markdown: string | null = null;
    this.editor.action((ctx) => {
      try {
        const view = ctx.get(editorViewCtx);
        const serializer = ctx.get(serializerCtx);
        markdown = this.normalizeMarkdownForCollab(serializer(view.state.doc));
      } catch (error) {
        const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.warn('[share] failed to capture local collab template', details);
      }
    });
    return markdown;
  }

  private connectCollabService(): void {
    if (!this.editor) return;
    this.editor.action((ctx) => {
      const collabService = ctx.get(collabServiceCtx);
      const ydoc = collabClient.getYDoc();
      if (!ydoc) {
        collabService.disconnect();
        return;
      }
      const view = ctx.get(editorViewCtx);
      collabService.mergeOptions({
        yCursorOpts: {
          cursorBuilder: collabCursorBuilder,
          selectionBuilder: collabSelectionBuilder,
        },
      });
      collabService.disconnect();
      // Important: do not connect with awareness attached yet. The yCursor plugin can
      // evaluate awareness states before y-sync has built its mapping, which can throw
      // (nodeSize on undefined). We'll install the cursor plugin after y-sync is ready.
      try {
        (collabService as any).setAwareness(null);
      } catch {
        // ignore
      }
      collabService.bindDoc(ydoc);
      collabService.connect();
      this.installCollabCursorsWhenReady(view, ctx, collabService);
    });
  }

  private ensureCollabCursorsInstalled(): void {
    if (!this.editor || !this.collabEnabled) return;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const collabService = ctx.get(collabServiceCtx);
      this.installCollabCursorsWhenReady(view, ctx, collabService);
    });
  }

  private installCollabCursorsWhenReady(view: EditorView, ctx: any, collabService: any): void {
    const awareness = collabClient.getAwareness();
    if (!awareness) return;

    const hasCursorPlugin = () =>
      view.state.plugins.some((plugin) => (plugin as any)?.spec?.key === yCursorPluginKey);

    const maxAttempts = 120;
    const attemptInstall = (attempt: number) => {
      if (!this.editor || !this.collabEnabled) return;
      if (hasCursorPlugin()) return;

      let mappingReady = false;
      try {
        const ystate = (ySyncPluginKey.getState(view.state) as any) ?? null;
        const mapping = ystate?.binding?.mapping as Map<any, any> | null;
        // In y-prosemirror, `binding.mapping` is a Map from Yjs types to ProseMirror nodes.
        // The cursor plugin can crash if awareness is attached before this mapping is populated.
        if (mapping && typeof (mapping as any).size === 'number' && (mapping as any).size > 0) mappingReady = true;
      } catch {
        // ignore and retry
      }

      if (!mappingReady) {
        if (attempt < maxAttempts) requestAnimationFrame(() => attemptInstall(attempt + 1));
        return;
      }

      try {
        collabService.setAwareness(awareness);
      } catch {
        // ignore; cursor plugin can still work with direct awareness reference
      }

      try {
        const cursorPlugin = yCursorPlugin(
          awareness as any,
          {
            cursorBuilder: collabCursorBuilder as any,
            selectionBuilder: collabSelectionBuilder as any,
          } as any,
          undefined
        );

        const nextPlugins = view.state.plugins.concat(cursorPlugin);
        ctx.set(prosePluginsCtx, nextPlugins);
        const undoManager = yUndoPluginKey.getState(view.state)?.undoManager;
        view.updateState(view.state.reconfigure({ plugins: nextPlugins }));
        // Reconfiguration recreates every plugin view. yUndoPlugin destroys its
        // manager even though PM retains the plugin state and that same manager.
        // Reattach its Yjs subscriptions after the new selection hooks are installed.
        if (undoManager && yUndoPluginKey.getState(view.state)?.undoManager === undoManager) {
          reconnectNativeUndoManager(undoManager);
        }
      } catch (error) {
        const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.warn('[share] failed to install yCursor plugin', details);
      }
    };

    attemptInstall(0);
  }

  private applyPendingCollabTemplate(): void {
    const templateMarkdown = this.pendingCollabTemplateMarkdown;
    if (!templateMarkdown || templateMarkdown.length === 0 || !this.editor) return;
    if (!this.shouldAllowCollabTemplateSeed(this.activeCollabSession)) {
      this.resetPendingCollabTemplateState(true);
      return;
    }
    if (!this.collabCanEdit) {
      this.resetPendingCollabTemplateState(true);
      return;
    }

    const ydoc = collabClient.getYDoc();
    if (!ydoc) return;

    const fragment = ydoc.getXmlFragment('prosemirror');
    // If the server already has a non-empty Yjs prosemirror fragment, we should never
    // keep trying to "seed" a template. Doing so can deadlock edit gating and, worse,
    // cause early local edits to overwrite remote content.
    if (!this.isYjsFragmentStructurallyEmpty(fragment)) {
      this.resetPendingCollabTemplateState(true);
      return;
    }

    if (!this.isEditorDocStructurallyEmpty()) {
      this.resetPendingCollabTemplateState(true);
      return;
    }

    const seedMap = ydoc.getMap<unknown>('collabInit');
    // Sometimes we can observe the "seeded" bit before the prosemirror fragment arrives
    // (or after a refresh while the fragment is still empty). Only treat it as seeded if
    // the fragment actually contains content.
    const fragmentStructurallyEmpty = this.isYjsFragmentStructurallyEmpty(fragment);
    if (seedMap.get('pmTemplateSeeded') === true && !fragmentStructurallyEmpty) {
      this.resetPendingCollabTemplateState(true);
      return;
    }

    if (!this.collabTemplateSeedClaimId) {
      this.collabTemplateSeedClaimId = `seed-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }
    const claimId = this.collabTemplateSeedClaimId;
    const now = Date.now();
    const existingClaim = this.parseCollabTemplateClaim(seedMap.get('pmTemplateSeedClaim'));

    if (!existingClaim || (now - existingClaim.ts) > this.collabTemplateClaimStaleMs) {
      ydoc.transact(() => {
        if (seedMap.get('pmTemplateSeeded') === true) return;
        const latestClaim = this.parseCollabTemplateClaim(seedMap.get('pmTemplateSeedClaim'));
        const transactionNow = Date.now();
        if (!latestClaim || (transactionNow - latestClaim.ts) > this.collabTemplateClaimStaleMs) {
          seedMap.set('pmTemplateSeedClaim', { id: claimId, ts: transactionNow });
        }
      }, 'local-template-seed-claim');
    }

    if (this.collabTemplateClaimCheckTimer) return;
    this.collabTemplateClaimCheckTimer = setTimeout(() => {
      this.collabTemplateClaimCheckTimer = null;

      const latestTemplate = this.pendingCollabTemplateMarkdown;
      if (!latestTemplate || !this.editor) return;

      const currentDoc = collabClient.getYDoc();
      if (!currentDoc) return;
      const currentSeedMap = currentDoc.getMap<unknown>('collabInit');

      if (currentSeedMap.get('pmTemplateSeeded') === true || !this.isEditorDocStructurallyEmpty()) {
        this.resetPendingCollabTemplateState(true);
        return;
      }

      const liveClaim = this.parseCollabTemplateClaim(currentSeedMap.get('pmTemplateSeedClaim'));
      if (!liveClaim || liveClaim.id !== this.collabTemplateSeedClaimId) {
        this.schedulePendingCollabTemplateRetry();
        return;
      }

      this.editor.action((ctx) => {
        try {
          const collabService = ctx.get(collabServiceCtx);
          collabService.applyTemplate(latestTemplate, (yDocNode) => {
            if (yDocNode.childCount === 0) return true;
            if (yDocNode.childCount !== 1) return false;
            const firstChild = yDocNode.firstChild;
            if (!firstChild) return true;
            return firstChild.type.name === 'paragraph' && firstChild.textContent.length === 0;
          });
        } catch (error) {
          const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
          console.warn('[share] failed to apply pending collab template', details);
        }
      });

      if (!this.isEditorDocStructurallyEmpty()) {
        currentDoc.transact(() => {
          currentSeedMap.set('pmTemplateSeeded', true);
          currentSeedMap.set('pmTemplateSeededAt', Date.now());
          currentSeedMap.delete('pmTemplateSeedClaim');
        }, 'local-template-seeded');
        this.resetPendingCollabTemplateState(true);
        return;
      }

      this.schedulePendingCollabTemplateRetry();
    }, this.collabTemplateClaimSettleMs);
  }

  private disconnectCollabService(): void {
    if (!this.editor) return;
    this.pendingCollabRebindOnSync = false;
    this.editor.action((ctx) => {
      const collabService = ctx.get(collabServiceCtx);
      collabService.disconnect();
    });
  }

  private showCollabReloadRequired(): void {
    if (this.collabRefreshTimer) clearInterval(this.collabRefreshTimer);
    this.collabRefreshTimer = null;
    this.resetShareInitRetryState();
    this.showErrorBanner('Reload this page to resume editing. Your unsent changes stay in this tab.', {
      retryLabel: 'Reload', onRetry: () => {
        collabClient.flushPendingLocalStateForUnload();
        window.location.reload();
      },
    });
  }

  private startCollabRefreshLoop(): void {
    if (this.collabRefreshTimer) {
      clearInterval(this.collabRefreshTimer);
      this.collabRefreshTimer = null;
    }
    this.collabRefreshTimer = setInterval(async () => {
      if (!this.collabEnabled || !this.activeCollabSession) return;
      await this.maybeRecoverStalledCollab();
      const expiresAt = this.activeCollabSession.expiresAt;
      if (!expiresAt) return;
      const expiresAtMs = Date.parse(expiresAt);
      if (!Number.isFinite(expiresAtMs)) return;
      const now = Date.now();
      if ((expiresAtMs - now) > 60_000) return;
      if (this.collabConnectionStatus === 'connected' && this.collabIsSynced) return;
      if (this.shouldDeferExpiringCollabRefresh(now)) return;
      await this.refreshCollabSessionAndReconnect(this.shouldPreservePendingLocalCollabState());
    }, 2_000);
  }

  private shouldPreservePendingLocalCollabState(): boolean {
    return this.collabCanEdit
      && (this.collabUnsyncedChanges > 0 || this.collabPendingLocalUpdates > 0);
  }

  private shouldDeferExpiringCollabRefresh(now: number): boolean {
    if (!this.collabCanEdit) return false;
    if (this.shouldPreservePendingLocalCollabState()) return true;
    if (this.pendingProjectionPublish) return true;
    if (this.contentSyncTimeout !== null) return true;
    return (now - this.lastLocalTypingAt) < this.collabTypingRecoveryGraceMs;
  }

  private updateCollabHealthWindow(status: CollabSyncStatus): void {
    const healthy = status.connectionStatus === 'connected'
      && status.isSynced
      && (this.collabCanEdit || status.unsyncedChanges === 0);
    if (healthy) {
      this.collabUnhealthySinceMs = null;
      this.collabLastRecoveryAttemptMs = 0;
      return;
    }
    if (this.collabUnhealthySinceMs === null) {
      this.collabUnhealthySinceMs = Date.now();
    }
  }

  private async maybeRecoverStalledCollab(): Promise<void> {
    if (!this.collabEnabled || !this.activeCollabSession) return;
    if (this.collabUnhealthySinceMs === null) return;
    const now = Date.now();
    if (
      this.collabUnsyncedChanges > 0
      && (now - this.lastLocalTypingAt) < this.collabTypingRecoveryGraceMs
    ) {
      return;
    }
    if ((now - this.collabUnhealthySinceMs) < this.collabRecoveryDelayMs) return;
    if ((now - this.collabLastRecoveryAttemptMs) < this.collabRecoveryBackoffMs) return;
    this.collabLastRecoveryAttemptMs = now;
    this.collabUnhealthySinceMs = now;
    await this.refreshCollabSessionAndReconnect(false);
  }

  private teardownCollabRuntimeAfterTerminalRefreshFailure(): void {
    this.clearPendingCommentDraftRestore();
    if (this.collabRefreshTimer) {
      clearInterval(this.collabRefreshTimer);
      this.collabRefreshTimer = null;
    }
    this.collabUnhealthySinceMs = null;
    this.collabLastRecoveryAttemptMs = 0;
    this.disconnectCollabService();
    collabClient.disconnect();
  }

  private captureCommentPopoverDraftSnapshot(): CommentPopoverDraftSnapshot | null {
    if (!this.editor) return null;
    let snapshot: CommentPopoverDraftSnapshot | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      snapshot = captureCommentPopoverDraft(view);
    });
    return snapshot;
  }

  private clearPendingCommentDraftRestore(): void {
    if (this.pendingCommentDraftRestoreTimer) {
      clearTimeout(this.pendingCommentDraftRestoreTimer);
      this.pendingCommentDraftRestoreTimer = null;
    }
    this.pendingCommentDraftSnapshot = null;
  }

  private restoreCommentPopoverDraftWithRetry(snapshot: CommentPopoverDraftSnapshot): void {
    this.clearPendingCommentDraftRestore();
    this.pendingCommentDraftSnapshot = snapshot;
    let attempts = 0;
    const tryRestore = () => {
      const pendingSnapshot = this.pendingCommentDraftSnapshot;
      if (!pendingSnapshot) return;
      if (!this.editor || !this.isShareMode || !this.collabEnabled) {
        this.clearPendingCommentDraftRestore();
        return;
      }
      let restored = false;
      this.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        restored = restoreCommentPopoverDraft(view, pendingSnapshot);
      });
      if (restored) {
        this.clearPendingCommentDraftRestore();
        return;
      }
      attempts += 1;
      if (attempts >= this.commentPopoverDraftRestoreMaxAttempts) {
        this.clearPendingCommentDraftRestore();
        return;
      }
      this.pendingCommentDraftRestoreTimer = setTimeout(tryRestore, this.commentPopoverDraftRestoreDelayMs);
    };
    tryRestore();
  }

  private async refreshCollabSessionAfterDocumentUpdated(): Promise<void> {
    const draftSnapshot = this.captureCommentPopoverDraftSnapshot();
    await this.refreshCollabSessionAndReconnect(false);
    if (draftSnapshot) {
      this.restoreCommentPopoverDraftWithRetry(draftSnapshot);
    }
  }

  private async refreshCollabSessionAndReconnect(preserveLocalState: boolean): Promise<void> {
    if (collabClient.terminalCloseReason === 'reload-required') return;
    if (!this.collabEnabled || !this.activeCollabSession) return;
    if (this.collabSessionRefreshInFlight) return;
    this.collabSessionRefreshInFlight = true;
    this.pendingCollabRebindOnSync = false;
    try {
      const refreshed = await shareClient.refreshCollabSession();
      if (this.isShareRequestError(refreshed)) {
        if (refreshed.error.status === 426) {
          collabClient.requireReload();
          this.showCollabReloadRequired();
          return;
        }
        console.warn('[share] collab session refresh failed', refreshed.error);
        if (refreshed.error.status === 401 || refreshed.error.status === 403 || refreshed.error.status === 404 || refreshed.error.status === 410) {
          this.teardownCollabRuntimeAfterTerminalRefreshFailure();
          this.collabEnabled = false;
          this.collabCanComment = false;
          this.collabCanEdit = false;
          this.collabConnectionStatus = 'disconnected';
          this.collabIsSynced = false;
          this.collabUnsyncedChanges = 0;
          this.collabPendingLocalUpdates = 0;
          this.activeCollabSession = null;
          this.resetProjectionPublishState();
          this.updateShareEditGate();
          if (refreshed.error.status === 404 || refreshed.error.status === 410) {
            this.showErrorBanner('Document not found or has been unshared.');
          } else {
            this.showReadOnlyBanner();
          }
        }
        return;
      }
      if (refreshed && 'collabAvailable' in refreshed && refreshed.collabAvailable === false) {
        this.collabEnabled = false;
        this.collabCanComment = false;
        this.collabCanEdit = false;
        this.collabConnectionStatus = 'disconnected';
        this.collabIsSynced = false;
        this.collabUnsyncedChanges = 0;
        this.collabPendingLocalUpdates = 0;
        this.activeCollabSession = null;
        this.resetProjectionPublishState();
        this.updateShareEditGate();
        this.showReadOnlyBanner();
        return;
      }
      if (!refreshed || !('session' in refreshed) || !refreshed.session) return;
      const canEditBefore = this.collabCanEdit;
      this.activeCollabSession = refreshed.session;
      this.collabCanComment = Boolean(refreshed.capabilities.canComment);
      this.collabCanEdit = Boolean(refreshed.capabilities.canEdit);
      this.resetShareMarksSyncState();
      const shouldPreserveLocalState = preserveLocalState && this.shouldPreservePendingLocalCollabState();
      let reconnectTemplate: string | null = null;
      if (shouldPreserveLocalState) {
        if (this.lastMarkdown.trim().length > 0) {
          reconnectTemplate = this.normalizeMarkdownForCollab(this.lastMarkdown);
        }
      } else {
        try {
          const latest = await shareClient.fetchDocument();
          if (!this.isShareRequestError(latest) && latest && typeof latest.markdown === 'string' && latest.markdown.trim().length > 0) {
            reconnectTemplate = this.normalizeMarkdownForCollab(latest.markdown);
          }
        } catch {
          // best-effort; reconnect against the live room without replaying stale local projection.
        }
      }
      if (!this.shouldAllowCollabTemplateSeed(refreshed.session)) {
        reconnectTemplate = null;
      }
      this.pendingCollabRebindOnSync = true;
      this.resetProjectionPublishState();
      collabClient.reconnectWithSession(refreshed.session, { preserveLocalState: shouldPreserveLocalState });
      this.resetPendingCollabTemplateState(false);
      this.pendingCollabTemplateMarkdown = this.shouldAllowCollabTemplateSeed(refreshed.session)
        ? reconnectTemplate
        : null;
      this.updateShareEditGate();
      if (canEditBefore !== this.collabCanEdit) {
        this.updateShareEditGate();
      }
    } catch (error) {
      this.pendingCollabRebindOnSync = false;
      console.warn('[share] failed to refresh collab session', error);
    } finally {
      this.collabSessionRefreshInFlight = false;
    }
  }

  /**
   * In share mode, allow text selection (for commenting) but block content edits.
   * Uses a ProseMirror filterTransaction plugin to reject doc-modifying transactions.
   */
  private installShareContentFilter(): void {
    if (!this.editor) return;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      enableShareContentFilter(view);
    });
  }

  private uninstallShareContentFilter(): void {
    if (!this.editor) return;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      disableShareContentFilter(view);
    });
  }

  private setShareContentFilterEnabled(enabled: boolean): void {
    if (!this.editor) return;
    if (enabled === this.shareContentFilterEnabled) return;
    this.shareContentFilterEnabled = enabled;
    if (enabled) {
      this.installShareContentFilter();
      return;
    }
    this.uninstallShareContentFilter();
  }

  private updateShareEditGate(): void {
    if (!this.isShareMode) return;
    const awaitingTemplateSeed = Boolean(this.pendingCollabTemplateMarkdown && this.pendingCollabTemplateMarkdown.length > 0);
    const baseAllowLocalEdits = this.collabEnabled
      && this.collabCanEdit
      && this.collabConnectionStatus === 'connected'
      && this.collabIsSynced
      && !awaitingTemplateSeed;
    const hydrationGate = evaluateShareEditHydrationGate({
      baseAllowLocalEdits,
      hasCompletedInitialCollabHydration: this.hasCompletedInitialCollabHydration,
      isCollabHydratedForEditing: !baseAllowLocalEdits
        || this.hasCompletedInitialCollabHydration
        || this.isCollabHydratedForEditing(),
    });
    if (hydrationGate.shouldKickCollabHydration) {
      // Prevent "type into blank doc" races that can overwrite remote Yjs state.
      this.kickCollabHydration();
    }
    this.shareAllowLocalEdits = hydrationGate.allowLocalEdits;
    if (hydrationGate.allowLocalEdits && !this.suggestDefaultApplied) {
      this.suggestDefaultApplied = true;
      if (EDIT_SESSION_POLICY.liveProposals) this.enableSuggestions();
      else this.disableSuggestions();
      setDirectEditing(false);
    }
    if (!this.collabCanEdit) setDirectEditing(false);
    this.updateSuggestToggleDisplay();
    this.updateShareSuggestionReviewDisplay();
    // Only block content mutations for true view-only sessions.
    // Avoid using filterTransaction as a temporary "sync lock", since it can deadlock hydration.
    this.setShareContentFilterEnabled(this.collabEnabled && !this.collabCanEdit);
    setShareRuntimeCapabilities({
      canComment: this.collabCanComment,
      canEdit: this.collabCanEdit,
    });
    this.updateEditableState();
    this.updateShareBannerTitleDisplay();
  }

  private ensureShareWebSocketConnection(): void {
    if (!this.isShareMode) return;
    if (!this.shareWsUnsubscribe) {
      this.shareWsUnsubscribe = shareClient.onMessage((message) => {
        this.handleShareWebSocketMessage(message);
      });
    }
    shareClient.connectWebSocket();
    this.startShareEventPoll();
  }

  private handleShareWebSocketMessage(message: Record<string, unknown>): void {
    const type = typeof message.type === 'string' ? message.type : '';
    if (type === 'viewers.updated') {
      const count = typeof message.count === 'number'
        ? message.count
        : (Array.isArray(message.viewers) ? message.viewers.length : 0);
      if (Number.isFinite(count)) {
        this.shareOtherViewerCount = Math.max(0, Math.floor(count) - 1);
        this.updateShareBannerTitleDisplay();
      }
      return;
    }
    if (type === 'line-marks.updated') {
      this.lineMarks?.notifyRemoteChange();
      return;
    }
    if (type === 'chat.updated') {
      this.chat?.notifyRemoteChange();
      return;
    }
    if (type === 'document.title.updated') {
      if (typeof message.title === 'string') {
        this.applyShareTitle(message.title);
      }
      return;
    }
    if (type === 'document.updated') {
      if (typeof message.title === 'string') {
        this.applyShareTitle(message.title);
      }
      if (!this.collabEnabled) {
        this.scheduleShareDocumentUpdatedRefresh();
      }
      return;
    }
    if (type === 'agent.presence') {
      const id = typeof message.id === 'string' ? message.id.trim() : '';
      if (!id || !isAgentScopedId(id)) return;
      const status = typeof message.status === 'string' && message.status.trim() ? message.status.trim() : 'idle';
      if (status === 'disconnected' || status === 'left') {
        this.shareAgentPresenceFallback.delete(id);
      } else {
        this.shareAgentPresenceFallback.set(id, {
          id,
          name: typeof message.name === 'string' && message.name.trim() ? message.name.trim() : id,
          status,
          expiresAt: typeof message.expiresAt === 'string' ? message.expiresAt : undefined,
          color: typeof message.color === 'string' && /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(message.color)
            ? message.color
            : '#6366f1',
          avatar: typeof message.avatar === 'string' && message.avatar.trim() ? message.avatar.trim() : undefined,
          at: typeof message.timestamp === 'string' && message.timestamp.trim()
            ? message.timestamp.trim()
            : new Date().toISOString(),
        });
      }
      this.updateShareBannerAgentControlDisplay();
      this.updateShareBannerPresenceDisplay();
    }
  }

  private shouldForceCollabRefreshFromPendingEvent(event: SharePendingEvent): boolean {
    return event.type === 'document.updated'
      || event.type === 'agent.edit'
      || event.type === 'agent.edit.v2'
      || event.type === 'document.rewritten';
  }

  private shouldSkipForcedCollabRefreshFromPendingEvent(): boolean {
    // When the live room is already healthy, agent/document updates should arrive
    // through Yjs. Rebinding from canonical state here can erase a fresh local edit
    // that has propagated live but has not durably persisted yet.
    return this.collabEnabled
      && this.collabConnectionStatus === 'connected'
      && this.collabIsSynced;
  }

  private isMarksPendingShareEvent(event: SharePendingEvent): boolean {
    return event.type.startsWith('comment.')
      || event.type.startsWith('suggestion.');
  }

  private handlePendingShareEvent(event: SharePendingEvent): void {
    if (event.type === 'line_mark.updated') {
      this.lineMarks?.notifyRemoteChange();
      return;
    }
    if (event.type === 'chat.message') {
      this.chat?.notifyRemoteChange();
      return;
    }
    if (this.isMarksPendingShareEvent(event)) {
      this.scheduleShareMarksRefresh();
      return;
    }
    if (!this.shouldForceCollabRefreshFromPendingEvent(event)) return;
    if (event.id <= this.shareLastForcedCollabEventId) return;
    this.shareLastForcedCollabEventId = event.id;
    if (this.shouldSkipForcedCollabRefreshFromPendingEvent()) return;
    this.scheduleShareDocumentUpdatedRefresh(true);
  }

  private startShareEventPoll(): void {
    if (!this.isShareMode || !shareClient.hasShareCredential()) return;
    this.shareEventPoller ??= new ShareEventPoller(
      () => this.isShareMode && shareClient.hasShareCredential(),
      async () => {
        const payload = await shareClient.fetchPendingEvents(this.shareEventCursor, { limit: 100 });
        if (this.isShareRequestError(payload)) return payload.error.status;
        if (!payload) return 0;
        if (!this.isShareMode) return 200;
        for (const event of payload.events) this.handlePendingShareEvent(event);
        this.shareEventCursor = Math.max(this.shareEventCursor, Math.trunc(payload.cursor));
        return 200;
      },
      this.shareEventPollMs,
    );
    this.shareEventPoller.start();
  }

  private stopShareEventPoll(): void {
    this.shareEventPoller?.stop();
    this.shareEventPoller = null;
    this.shareEventCursor = 0;
    this.shareLastForcedCollabEventId = 0;
  }

  private scheduleShareDocumentUpdatedRefresh(forceCollabRefresh: boolean = false): void {
    if (this.shareDocumentUpdatedTimer) return;
    this.shareDocumentUpdatedTimer = setTimeout(() => {
      this.shareDocumentUpdatedTimer = null;
      if (!this.isShareMode) return;
      if (this.collabEnabled) {
        if (this.collabUnsyncedChanges > 0) return;
        if (!forceCollabRefresh && this.collabConnectionStatus === 'connected' && this.collabIsSynced) return;
        void this.refreshCollabSessionAfterDocumentUpdated();
        return;
      }
      void shareClient.fetchDocument()
        .then((doc) => {
          if (!doc) return;
          this.applyShareTitle(doc.title);
          if (typeof doc.viewers === 'number') {
            this.shareOtherViewerCount = Math.max(0, Math.floor(doc.viewers) - 1);
            this.updateShareBannerTitleDisplay();
          }
        })
        .catch(() => {
          // best-effort refresh
        });
    }, this.shareDocumentUpdatedDebounceMs);
  }

  private scheduleShareMarksRefresh(): void {
    this.pendingShareMarksRefresh = true;
    if (this.shareMarksRefreshTimer) {
      clearTimeout(this.shareMarksRefreshTimer);
      this.shareMarksRefreshTimer = null;
    }
    this.shareMarksRefreshTimer = setTimeout(() => {
      this.shareMarksRefreshTimer = null;
      if (!this.pendingShareMarksRefresh) return;
      if (!this.isShareMode || !this.collabEnabled) {
        this.pendingShareMarksRefresh = false;
        return;
      }
      if (shouldDeferShareMarksRefresh({
        collabCanEdit: this.collabCanEdit,
        collabUnsyncedChanges: this.collabUnsyncedChanges,
        collabPendingLocalUpdates: this.collabPendingLocalUpdates,
      })) {
        this.scheduleShareMarksRefresh();
        return;
      }
      this.pendingShareMarksRefresh = false;
      void shareClient.fetchOpenContext()
        .then((context) => {
          if (!context || this.isShareRequestError(context) || !('doc' in context)) return;
          const serverMarks = (context.doc?.marks && typeof context.doc.marks === 'object' && !Array.isArray(context.doc.marks))
            ? context.doc.marks as Record<string, StoredMark>
            : null;
          if (!serverMarks) return;
          this.applyAuthoritativeShareMarks(serverMarks);
        })
        .catch(() => {
          // best-effort refresh for server-originated mark updates
        });
    }, this.shareDocumentUpdatedDebounceMs);
  }

  private applyAuthoritativeShareMarks(serverMarks: Record<string, StoredMark>): void {
    this.lastReceivedServerMarks = { ...serverMarks };
    this.initialMarksSynced = true;
    this.applyExternalMarks(serverMarks);
  }

  private applyAuthoritativeShareDocument(doc: ShareOpenContext['doc']): void {
    const serverMarks = (doc.marks && typeof doc.marks === 'object' && !Array.isArray(doc.marks))
      ? doc.marks as Record<string, StoredMark>
      : {};
    this.lastReceivedServerMarks = { ...serverMarks };
    this.initialMarksSynced = true;
    reconcileAuthoritativeShareDocument({
      collabConnected: this.collabEnabled && this.collabConnectionStatus === 'connected',
      markdown: doc.markdown,
      serverMarks,
      loadDocument: (markdown) => this.loadDocument(markdown, { allowShareContentMutation: true }),
      applyServerMarks: (marks) => this.applyExternalMarks(marks),
    });
  }

  private async recoverAuthoritativeShareMarks(
    failure: unknown,
    fallbackMessage: string,
    optimisticMarkIds: string[] = [],
    finalStatus?: ShareSuggestionFinalStatus,
  ): Promise<void> {
    const recovery = await recoverShareMarksAfterMutationFailure({
      failure,
      fallbackMessage,
      fetchOpenContext: () => shareClient.fetchOpenContext(),
      showErrorBanner: (message) => this.showErrorBanner(message),
      applyServerMarks: (marks) => {
        this.applyAuthoritativeShareMarks(marks);
      },
      applyServerDocument: (doc) => {
        const marks = doc.marks as Record<string, StoredMark>;
        const pendingIds = optimisticMarkIds.filter((id) => {
          const mark = marks[id];
          return Boolean(mark && mark.status !== 'accepted' && mark.status !== 'rejected');
        });
        clearResolvedMarkTombstones(pendingIds);
        this.applyAuthoritativeShareDocument(doc);
      },
      expectedResolutions: finalStatus
        ? Object.fromEntries(optimisticMarkIds.map((id) => [id, finalStatus]))
        : undefined,
    });
    if (finalStatus === 'rejected') {
      const unresolvedIds = new Set(recovery.unresolvedIds);
      for (const id of optimisticMarkIds) {
        if (unresolvedIds.has(id)) {
          this.shareRejectedSuggestionIdsBlockedFromAcceptAll.add(id);
        } else {
          this.shareRejectedSuggestionIdsBlockedFromAcceptAll.delete(id);
        }
      }
    }
  }

  private getViewerText(otherViewerCount: number): string {
    if (otherViewerCount === 1) return '1 viewer';
    return `${otherViewerCount} viewers`;
  }

  private getShareSyncStatus(): { label: string; color: string } {
    if (!this.collabEnabled) {
      return { label: 'Live sync unavailable', color: '#ef4444' };
    }
    if (this.collabConnectionStatus === 'connected') {
      if (!this.collabIsSynced) {
        return { label: 'Syncing...', color: '#f59e0b' };
      }
      if (this.collabUnsyncedChanges > 0) {
        return { label: 'Saving...', color: '#f59e0b' };
      }
      return { label: 'Saved', color: '#34d399' };
    }
    if (this.collabConnectionStatus === 'connecting') {
      return { label: 'Connecting...', color: '#f59e0b' };
    }
    if (collabClient.terminalCloseReason === 'reload-required') return { label: 'Reload to resume editing', color: '#ef4444' };
    if (collabClient.terminalCloseReason === 'unshared') {
      return { label: 'Document is no longer shared', color: '#ef4444' };
    }
    if (collabClient.terminalCloseReason === 'permission-denied') {
      return { label: 'Access revoked', color: '#ef4444' };
    }
    if (this.collabUnsyncedChanges > 0) {
      return { label: 'Offline - unsaved changes', color: '#ef4444' };
    }
    return { label: 'Offline - reconnecting', color: '#ef4444' };
  }

  private ensureShareStatusPulseStyle(): void {
    const styleId = 'share-status-pulse-style';
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      @keyframes shareStatusPulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.35; }
      }
    `;
    document.head.appendChild(style);
  }

  private getSyncStatusTextLabel(label: string): string {
    const map: Record<string, string> = {
      'Saved': 'Saved',
      'Saving...': 'Saving',
      'Syncing...': 'Syncing',
      'Connecting...': 'Connecting',
      'Offline - reconnecting': 'Offline',
      'Offline - unsaved changes': 'Unsaved',
      'Access revoked': 'Revoked',
      'Document is no longer shared': 'Unshared',
      'Live sync unavailable': 'No sync',
    };
    return map[label] ?? 'Saved';
  }

  private shouldShowStatusText(statusLabel: string): boolean {
    const normalized = statusLabel.trim() || 'Saved';
    const now = Date.now();

    if (normalized !== this.shareLastStatusLabel) {
      this.shareLastStatusLabel = normalized;
      this.shareStatusTextVisibleUntilMs = now + 3_500;
      if (this.shareStatusHideTimer) {
        clearTimeout(this.shareStatusHideTimer);
        this.shareStatusHideTimer = null;
      }
      this.shareStatusHideTimer = setTimeout(() => {
        this.shareStatusHideTimer = null;
        const label = document.querySelector('#share-banner .share-pill-status-inline .status-label') as HTMLElement | null;
        if (label) label.style.display = 'none';
      }, 3_550);
      return true;
    }

    return now < this.shareStatusTextVisibleUntilMs;
  }

  private getHumanCollaboratorAvatars(): Array<{ name: string; color: string; initial: string; state: string }> {
    const avatars: Array<{ name: string; color: string; initial: string; state: string }> = [];
    const awareness = collabClient.getAwareness();
    if (!awareness) return avatars;
    const states = awareness.getStates?.();
    if (!states) return avatars;
    const myClientId = awareness.clientID;
    const seen = new Set<string>();
    states.forEach((state: any, clientId: number) => {
      if (clientId === myClientId) return;
      const user = state?.user;
      if (!user || typeof user.name !== 'string') return;
      if (typeof user.avatar === 'string' && user.avatar.trim().length > 0) return;
      const name = user.name.trim() || 'Anonymous';
      const dedupe = name.toLowerCase();
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      const color = (typeof user.color === 'string' && /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(user.color))
        ? user.color
        : '#6b7280';
      avatars.push({
        name,
        color,
        initial: name.charAt(0).toUpperCase(),
        state: state?.cursor ? 'editing' : 'viewing',
      });
    });
    return avatars;
  }

  private ensureShareAgentPresenceIcons(agentIds: Iterable<string>): void {
    const activeIds = Array.from(new Set(
      Array.from(agentIds)
        .map((agentId) => agentId.trim())
        .filter(Boolean),
    ));
    if (activeIds.length === 0) return;

    const nextAssignments = assignDistinctAgentFamilies(activeIds);
    for (const agentId of activeIds) {
      const family = nextAssignments.get(agentId);
      if (family) this.shareAgentPresenceIcons.set(agentId, family);
    }
  }

  private syncShareAgentPresenceIcons(agentIds: Iterable<string>): void {
    const activeIds = new Set(Array.from(agentIds));
    for (const agentId of Array.from(this.shareAgentPresenceIcons.keys())) {
      if (!activeIds.has(agentId)) this.shareAgentPresenceIcons.delete(agentId);
    }
    this.ensureShareAgentPresenceIcons(activeIds);
  }

  private getAgentPresenceVariant(agentId: string): AgentFamily {
    const existing = this.shareAgentPresenceIcons.get(agentId);
    if (existing) return existing;
    this.ensureShareAgentPresenceIcons([agentId]);
    return this.shareAgentPresenceIcons.get(agentId) ?? 'purple';
  }

  private getAgentPresenceColor(agentId: string): string {
    return getAgentFacePalette(this.getAgentPresenceVariant(agentId)).accent;
  }

  private getAgentPresenceAvatar(agentId: string): string {
    return getAgentFaceAssetUrl(this.getAgentPresenceVariant(agentId));
  }

  private getConnectedAgentEntries(): Array<{
    id: string;
    name: string;
    status: string;
    color: string;
    avatar?: string;
    at: string;
    expiresAt?: string;
  }> {
    return this.collectConnectedAgentEntries().entries;
  }

  private collectConnectedAgentEntries(): {
    entries: Array<{
      id: string;
      name: string;
      status: string;
      color: string;
      avatar?: string;
      at: string;
      expiresAt?: string;
    }>;
    nextExpiryAtMs: number | null;
  } {
    const ydoc: any = collabClient.getYDoc();
    if (!ydoc || typeof ydoc.getMap !== 'function') {
      return { entries: [], nextExpiryAtMs: null };
    }

    const nowMs = Date.now();
    let nextExpiryAtMs: number | null = null;
    const entries: Array<{
      id: string;
      name: string;
      status: string;
      color: string;
      avatar?: string;
      at: string;
      expiresAt?: string;
    }> = [];

    const pushEntry = (
      id: string,
      name: string,
      status: string,
      avatar: string | undefined,
      atRaw: string,
      expiresAt?: string,
    ) => {
      const at = atRaw.trim();
      if (!at) return;
      const display = getAgentPresenceDisplay({ at, status, expiresAt }, nowMs);
      if (!display.visible) return;
      const expiryAtMs = display.nextUpdateAtMs!;
      if (nextExpiryAtMs === null || expiryAtMs < nextExpiryAtMs) {
        nextExpiryAtMs = expiryAtMs;
      }
      entries.push({
        id,
        name,
        status: display.idle ? 'idle' : 'active',
        color: this.getAgentPresenceColor(id),
        avatar,
        at: at,
        expiresAt,
      });
    };

    try {
      const presenceMap = ydoc.getMap('agentPresence');
      presenceMap.forEach((value: any) => {
        if (!value || typeof value !== 'object') return;
        const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : '';
        if (!id || !isAgentScopedId(id)) return;
        const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id;
        const status = typeof value.status === 'string' && value.status.trim() ? value.status.trim() : 'idle';
        const avatar = typeof value.avatar === 'string' && value.avatar.trim() ? value.avatar.trim() : undefined;
        const at = typeof value.at === 'string' ? value.at : '';
        pushEntry(id, name, status, avatar, at, value.expiresAt);
      });
    } catch {
      return { entries: [], nextExpiryAtMs: null };
    }

    for (const fallback of this.shareAgentPresenceFallback.values()) {
      if (!isAgentScopedId(fallback.id)) continue;
      if (entries.some((entry) => entry.id === fallback.id)) continue;
      pushEntry(fallback.id, fallback.name, fallback.status, fallback.avatar, fallback.at, fallback.expiresAt);
    }

    entries.sort((a, b) => {
      const aActive = a.status !== 'idle';
      const bActive = b.status !== 'idle';
      if (aActive !== bActive) return aActive ? -1 : 1;
      return Date.parse(b.at) - Date.parse(a.at);
    });

    this.syncShareAgentPresenceIcons(entries.map((entry) => entry.id));
    for (const entry of entries) {
      entry.color = this.getAgentPresenceColor(entry.id);
      entry.avatar = this.getAgentPresenceAvatar(entry.id);
    }

    return { entries, nextExpiryAtMs };
  }

  private clearShareAgentPresenceExpiryTimer(): void {
    if (!this.shareAgentPresenceExpiryTimer) return;
    clearTimeout(this.shareAgentPresenceExpiryTimer);
    this.shareAgentPresenceExpiryTimer = null;
  }

  private scheduleShareAgentPresenceExpiryRefresh(nextExpiryAtMs: number | null): void {
    this.clearShareAgentPresenceExpiryTimer();
    if (nextExpiryAtMs === null) return;
    const delayMs = Math.max(50, Math.ceil(nextExpiryAtMs - Date.now()) + 25);
    this.shareAgentPresenceExpiryTimer = setTimeout(() => {
      this.shareAgentPresenceExpiryTimer = null;
      if (!this.isShareMode) return;
      this.updateShareBannerAgentControlDisplay();
    }, delayMs);
  }

  private ensureShareBannerResponsiveCSS(): void {
    if (document.getElementById('proof-share-banner-responsive-css')) return;
    const style = document.createElement('style');
    style.id = 'proof-share-banner-responsive-css';
    style.textContent = `
      @keyframes proof-agent-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(139, 92, 246, 0.40), 0 0 0 0.5px rgba(0,0,0,0.08); }
        50% { box-shadow: 0 0 0 3px rgba(139, 92, 246, 0.00), 0 0 0 0.5px rgba(0,0,0,0.08); }
      }
      #share-banner {
        padding: 16px 16px 16px 24px !important;
        border-radius: 36px !important;
        gap: 14px !important;
        font-size: 15px !important;
      }
      #share-banner > a,
      #share-banner > .share-pill-title,
      #share-banner > button,
      #share-banner .share-pill-agent-trigger,
      #share-banner .share-pill-share-btn > button {
        min-height: 48px !important;
        min-width: 44px;
        font-size: 15px !important;
      }
      #share-banner .share-pill-title {
        line-height: 48px;
      }
      #share-banner .share-pill-agent-trigger:not(.has-agents) > span:first-child {
        font-size: 20px !important;
      }
      #share-banner .share-pill-share-btn > button > span + span {
        font-size: 14px !important;
      }
      #share-banner .share-pill-human-count { display: none; }
      #share-banner .share-pill-title {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #share-banner .share-pill-human-avatars {
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
      }
      #share-banner .share-pill-agent-trigger .agent-btn-label {
        white-space: nowrap;
      }
      #share-banner .share-pill-agent-trigger.has-agents {
        padding: 0 4px;
      }
      #share-banner .share-pill-status-inline {
        display:inline-flex;
        align-items:center;
        gap:6px;
        flex-shrink:0;
      }
      #share-banner .share-pill-status-inline .status-label {
        color:#6b7280;
        font-size:15px;
        font-weight:500;
        line-height:1;
      }
      #share-banner .share-pill-status-sep {
        width:1px;
        height:14px;
        background:rgba(0,0,0,0.10);
        flex-shrink:0;
      }
      #share-banner .proof-avatar-tooltip {
        position:absolute;
        top:calc(100% + 6px);
        left:50%;
        transform:translateX(-50%);
        background:#1a1a1a;
        color:#fff;
        font-size:13px;
        font-weight:500;
        padding:4px 8px;
        border-radius:6px;
        width:max-content;
        max-width:340px;
        white-space:normal;
        pointer-events:none;
        opacity:0;
        transition:opacity 0.12s ease;
        z-index:1000;
        line-height:1.3;
      }
      #share-banner .proof-avatar-tooltip::before {
        content:'';
        position:absolute;
        bottom:100%;
        left:50%;
        transform:translateX(-50%);
        border:4px solid transparent;
        border-bottom-color:#1a1a1a;
      }
      #share-banner .proof-avatar-wrap:hover .proof-avatar-tooltip,
      #share-banner .proof-avatar-wrap:focus .proof-avatar-tooltip,
      #share-banner .share-pill-agent-trigger:focus-visible .proof-avatar-tooltip {
        opacity:1;
      }
      #share-banner .share-pill-agent-btn.menu-open .proof-avatar-tooltip {
        display:none !important;
      }
      @media (max-width: 900px) {
        #share-banner { gap: 8px !important; }
        #share-banner .share-pill-human-avatars > .proof-avatar-wrap,
        #share-banner .share-pill-human-avatars > span:not(.share-pill-human-count):not([role]) { display: none !important; }
        #share-banner .share-pill-human-count { display: inline; font-size: 15px; white-space: nowrap; }
      }
      @media (max-width: 600px) {
        #share-banner {
          left: 12px !important;
          right: 12px !important;
          transform: none !important;
          min-width: unset !important;
          max-width: unset !important;
          padding: 8px 12px !important;
          gap: 6px !important;
          top: 16px !important;
          display: grid !important;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          border-radius: 28px !important;
        }
        #share-banner > a { grid-column: 1; }
        #share-banner .share-pill-title { grid-column: 2 / 4; }
        #share-banner .share-pill-status-inline { grid-column: 4; justify-self: end; }
        #share-banner .share-pill-sep,
        #share-banner .share-pill-status-sep { display: none !important; }
        #share-banner .share-pill-human-avatars { grid-column: 1; justify-content: center; }
        #share-banner .share-pill-suggest-toggle { grid-column: 2; padding: 0 4px !important; gap: 3px !important; font-size: 12px !important; }
        #share-banner .share-pill-agent-slot { grid-column: 3; justify-content: center; min-width: 0; }
        #share-banner .share-pill-share-btn { grid-column: 4; }
        #share-banner .share-pill-share-btn > button { padding: 0 8px !important; width: 100%; }
        #share-banner .share-pill-suggestion-review { grid-column: 1 / -1; grid-row: 3; }
        #share-banner .share-pill-agent-btn { max-width: 100%; min-width: 0; }
        #share-banner .share-pill-agent-trigger { padding: 0 4px !important; max-width: 100%; }
        #share-banner .share-pill-agent-trigger:not(.has-agents) { width: 100%; }
        #share-banner .share-pill-agent-trigger .agent-btn-label { min-width: 0; }
        #share-banner .share-pill-agent-trigger .agent-btn-label { font-size: 15px !important; white-space: normal; }
        #share-banner .share-pill-status-inline .status-label { display: none !important; }
        #share-banner .share-pill-agent-overflow { display: none !important; }
        #share-banner .share-pill-agent-trigger .proof-avatar-wrap > span:first-child { width: auto !important; }
        #share-banner .proof-avatar-tooltip { display: none !important; }
      }
      #share-banner .share-pill-overflow { display: none; }
      /* Phones: one compact, full-width row pinned to the top edge (not floating over the text).
         Add agent, Review style and Marks move into the overflow menu. */
      @media (max-width: 700px) {
        #share-banner {
          display: flex !important;
          flex-wrap: nowrap !important;
          top: 0 !important;
          left: 0 !important;
          right: 0 !important;
          transform: none !important;
          width: 100% !important;
          min-width: 0 !important;
          max-width: none !important;
          border-radius: 0 !important;
          border: none !important;
          border-bottom: 1px solid rgba(0,0,0,0.08) !important;
          box-shadow: none !important;
          background: #fff !important;
          backdrop-filter: none !important;
          -webkit-backdrop-filter: none !important;
          padding: env(safe-area-inset-top, 0px) max(8px, env(safe-area-inset-right, 0px)) 0 max(12px, env(safe-area-inset-left, 0px)) !important;
          height: calc(52px + env(safe-area-inset-top, 0px));
          gap: 6px !important;
          font-size: 15px !important;
        }
        #share-banner > a,
        #share-banner .share-pill-sep,
        #share-banner .share-pill-status-sep,
        #share-banner .share-pill-agent-slot,
        #share-banner .review-style-control,
        #share-banner .share-pill-suggestion-review { display: none !important; }
        #share-banner .share-pill-title {
          flex: 1 1 auto !important;
          min-width: 0 !important;
          min-height: 44px !important;
          line-height: 44px !important;
          font-size: 15px !important;
          font-weight: 600 !important;
        }
        #share-banner .share-pill-status-inline { order: 0; }
        #share-banner .share-pill-human-count { font-size: 13px !important; }
        #share-banner .share-pill-title { min-width: 36px !important; }
        /* An AI that is present stays visible in the bar; only the empty Add agent button moves to the menu. */
        #share-banner .share-pill-agent-slot:has(.share-pill-agent-trigger.has-agents) { display: inline-flex !important; flex-shrink: 0; }
        #share-banner .share-pill-suggest-toggle {
          min-height: 44px !important;
          padding: 0 10px !important;
          font-size: 12px !important;
          gap: 5px !important;
        }
        #share-banner .share-pill-share-btn > button {
          min-height: 44px !important;
          padding: 0 12px !important;
          font-size: 14px !important;
          width: auto !important;
        }
        #share-banner .share-pill-share-btn > button > span + span { display: none; }
      }
      /* Narrow phones: Suggesting/Editing becomes a pencil pill (green dot = suggesting); its aria-label and title keep the words. */
      @media (max-width: 700px) {
        #share-banner .share-pill-group { display: contents; }
        #share-banner .share-pill-overflow {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 44px;
          min-height: 44px;
          padding: 0;
          border: none;
          background: transparent;
          color: #111827;
          font-size: 22px;
          line-height: 1;
          cursor: pointer;
          flex-shrink: 0;
          font-family: inherit;
        }
        #editor { padding-bottom: 96px !important; }
        .proof-share-overflow-menu {
          position: fixed;
          right: 8px;
          min-width: 220px;
          background: #fff;
          border: 1px solid rgba(0,0,0,0.12);
          border-radius: 12px;
          box-shadow: 0 12px 32px rgba(0,0,0,0.18);
          padding: 6px;
          z-index: 10003;
          font: 15px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        .proof-share-overflow-menu button {
          display: flex;
          width: 100%;
          min-height: 48px;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 0 12px;
          border: none;
          border-radius: 8px;
          background: transparent;
          color: #111827;
          font: inherit;
          text-align: left;
          cursor: pointer;
        }
        .proof-share-overflow-menu button:active { background: #f3f4f6; }
        .proof-share-overflow-menu button span:last-child { color: #6b7280; font-size: 13px; }
      }
      /* Top bar (2026-09-21): tight around its buttons. A mouse gets 36 px targets on desktop; touch
         screens (and phones, below) keep 44 px. */
      @media (min-width: 701px) {
        #share-banner { padding: ${TOP_BAR_LAYOUT.desktopPadY}px 6px ${TOP_BAR_LAYOUT.desktopPadY}px 16px !important; gap: 10px !important; }
      }
      @media (min-width: 701px) and (pointer: fine) {
        #share-banner > a,
        #share-banner > .share-pill-title,
        #share-banner > button,
        #share-banner .share-pill-agent-trigger,
        #share-banner .share-pill-share-btn > button,
        #share-banner .share-pill-suggest-toggle,
        #share-banner .pm-review-toggle,
        #share-banner .share-pill-human-avatars > .proof-avatar-wrap {
          min-height: ${TOP_BAR_LAYOUT.desktopTargetPx}px !important;
        }
        #share-banner .share-pill-human-avatars > .proof-avatar-wrap { height: ${TOP_BAR_LAYOUT.desktopTargetPx}px !important; }
        #share-banner .share-pill-title { line-height: ${TOP_BAR_LAYOUT.desktopTargetPx}px; }
      }
      @media (max-width: 700px) {
        #share-banner { height: calc(${TOP_BAR_LAYOUT.phoneBarPx}px + env(safe-area-inset-top, 0px)) !important; }
        #share-banner .share-pill-overflow { min-height: 44px !important; height: 44px; }
      }
      .proof-share-welcome-toast .proof-toast-content { display: flex !important; flex-direction: row !important; align-items: flex-start; gap: 8px; }
      .proof-share-welcome-toast .proof-toast-dismiss {
        flex-shrink: 0; min-width: 32px; min-height: 32px; margin: -6px -6px -6px 0; border: none;
        background: transparent; color: inherit; font-size: 18px; line-height: 1; cursor: pointer;
      }
    `;
    document.head.appendChild(style);
  }

  private updateShareBannerPresenceDisplay(): void {
    const container = this.shareBannerAvatarsEl;
    if (!container) return;
    const avatars = this.getHumanCollaboratorAvatars();
    container.className = 'share-pill-human-avatars';
    container.style.cssText = 'display:none;align-items:center;flex-shrink:0;min-height:44px;min-width:44px;position:relative;';
    container.replaceChildren();

    if (avatars.length === 0) {
      container.removeAttribute('role');
      container.removeAttribute('tabindex');
      container.removeAttribute('aria-label');
      container.onclick = null;
      container.onkeydown = null;
      return;
    }
    container.style.display = 'inline-flex';
    container.style.cursor = 'pointer';
    container.setAttribute('role', 'button');
    container.setAttribute('tabindex', '0');
    container.setAttribute('aria-haspopup', 'menu');
    container.setAttribute('aria-label', `${avatars.length} collaborator${avatars.length === 1 ? '' : 's'}`);

    const count = document.createElement('span');
    count.className = 'share-pill-human-count';
    count.textContent = `${avatars.length} here`;
    container.appendChild(count);

    for (let i = 0; i < Math.min(avatars.length, 5); i++) {
      const avatar = avatars[i];
      const wrap = document.createElement('span');
      wrap.className = 'proof-avatar-wrap';
      wrap.tabIndex = 0;
      wrap.setAttribute('aria-label', `${avatar.name} — ${avatar.state}`);
      wrap.style.cssText = `display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;z-index:${5 - i};position:relative;`;
      const circle = document.createElement('span');
      circle.textContent = avatar.initial;
      circle.style.cssText = `
        width:32px;height:32px;border-radius:50%;
        background:${avatar.color};color:#fff;
        font-size:14px;font-weight:600;
        display:inline-flex;align-items:center;justify-content:center;
        border:2px solid #fff;
        box-shadow:0 0 0 0.5px rgba(0,0,0,0.08);
      `;
      const tooltip = document.createElement('span');
      tooltip.className = 'proof-avatar-tooltip';
      const tooltipName = document.createElement('span');
      tooltipName.style.cssText = 'display:block;font-weight:600';
      tooltipName.textContent = `${avatar.name} — ${avatar.state}`;
      const tooltipType = document.createElement('span');
      tooltipType.style.cssText = 'display:block;font-size:10px;opacity:0.7;margin-top:1px';
      tooltipType.textContent = 'Open people list';
      tooltip.append(tooltipName, tooltipType);
      wrap.appendChild(circle);
      wrap.appendChild(tooltip);
      container.appendChild(wrap);
    }
    if (avatars.length > 5) {
      const overflow = document.createElement('span');
      overflow.textContent = `+${avatars.length - 5}`;
      overflow.style.cssText = `
        width:32px;height:32px;border-radius:50%;
        background:#e5e7eb;color:#4b5563;
        font-size:10px;font-weight:600;
        display:inline-flex;align-items:center;justify-content:center;
        border:2px solid #fff;margin-left:-6px;
      `;
      container.appendChild(overflow);
    }

    const openPresenceMenu = () => {
      this.closeShareMenu();
      this.closeAgentMenu();
      this.closeSuggestionReviewMenu();
      if (this.presenceMenuCleanup) {
        this.closePresenceMenu();
        return;
      }

      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.style.cssText = `
        position:absolute;top:calc(100% + 8px);right:0;min-width:190px;
        background:rgba(17,24,39,0.96);border:1px solid rgba(255,255,255,0.12);
        border-radius:12px;padding:8px;z-index:1002;
        box-shadow:0 16px 40px rgba(0,0,0,0.35);
        backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      `;

      const header = document.createElement('div');
      header.textContent = 'Collaborators';
      header.style.cssText = 'padding:4px 8px 8px 8px;color:rgba(255,255,255,0.70);font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;';
      menu.appendChild(header);

      for (const avatar of avatars) {
        const row = document.createElement('div');
        row.setAttribute('role', 'menuitem');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;border-radius:8px;';
        const dot = document.createElement('span');
        dot.style.cssText = `width:18px;height:18px;border-radius:50%;background:${avatar.color};color:#fff;font-size:10px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;`;
        dot.textContent = avatar.initial;
        const name = document.createElement('span');
        name.textContent = `${avatar.name} — ${avatar.state}`;
        name.style.cssText = 'color:rgba(255,255,255,0.92);font-size:12px;font-weight:500;';
        row.append(dot, name);
        menu.appendChild(row);
      }

      container.setAttribute('aria-expanded', 'true');
      container.appendChild(menu);
      this.clampMenuToViewport(menu);

      const onDocMouseDown = (ev: MouseEvent) => {
        if (!(ev.target instanceof Node)) return;
        if (container.contains(ev.target)) return;
        cleanup();
      };
      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') cleanup();
      };
      const cleanup = () => {
        document.removeEventListener('mousedown', onDocMouseDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        container.setAttribute('aria-expanded', 'false');
        if (menu.isConnected) menu.remove();
        if (this.presenceMenuCleanup === cleanup) this.presenceMenuCleanup = null;
      };
      this.presenceMenuCleanup = cleanup;
      document.addEventListener('mousedown', onDocMouseDown, true);
      document.addEventListener('keydown', onKeyDown, true);
    };

    container.onclick = openPresenceMenu;
    container.onkeydown = (ev: KeyboardEvent) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      openPresenceMenu();
    };
  }

  private setupTitleEditing(titleEl: HTMLElement): void {
    if (!this.collabCanEdit) {
      titleEl.style.cursor = '';
      titleEl.removeAttribute('role');
      titleEl.removeAttribute('tabindex');
      if (titleEl.contentEditable === 'true') {
        this.shareBannerTitleEditing = false;
        titleEl.contentEditable = 'false';
      }
      return;
    }
    titleEl.style.cursor = 'text';
    titleEl.setAttribute('role', 'button');
    titleEl.setAttribute('tabindex', '0');
    if (titleEl.dataset.titleEditBound === 'true') return;
    titleEl.dataset.titleEditBound = 'true';

    const startEdit = () => {
      if (!this.collabCanEdit) return;
      if (titleEl.contentEditable === 'true') return;
      this.shareBannerTitleEditing = true;
      titleEl.contentEditable = 'true';
      titleEl.style.outline = 'none';
      titleEl.style.borderBottom = '1px solid rgba(0,0,0,0.15)';
      titleEl.style.color = '#111827';
      const range = document.createRange();
      range.selectNodeContents(titleEl);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    };

    titleEl.addEventListener('click', startEdit);
    titleEl.addEventListener('keydown', (event) => {
      if (titleEl.contentEditable !== 'true' && event.key !== 'Enter' && event.key !== ' ') return;
      if (titleEl.contentEditable !== 'true') {
        event.preventDefault();
        startEdit();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        titleEl.blur();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        this.shareBannerTitleEditing = false;
        titleEl.contentEditable = 'false';
        titleEl.style.borderBottom = '';
        titleEl.style.color = '#374151';
        titleEl.textContent = this.shareDocTitle || 'Untitled';
      }
    });

    titleEl.addEventListener('blur', () => {
      void this.commitShareBannerTitleEdit(titleEl);
    });
  }

  private async commitShareBannerTitleEdit(titleEl: HTMLElement): Promise<void> {
    if (!this.shareBannerTitleEditing) return;
    this.shareBannerTitleEditing = false;
    titleEl.contentEditable = 'false';
    titleEl.style.borderBottom = '';
    titleEl.style.color = '#374151';

    const previousTitle = this.shareDocTitle || 'Untitled';
    const nextTitle = titleEl.textContent?.trim() || '';
    if (!nextTitle) {
      titleEl.textContent = previousTitle;
      return;
    }
    if (nextTitle === previousTitle) return;

    const persistSeq = ++this.shareTitlePersistSeq;
    const persistSlug = shareClient.getSlug();
    this.applyShareTitle(nextTitle);
    const result = await shareClient.updateTitle(nextTitle);
    if (persistSeq !== this.shareTitlePersistSeq || persistSlug !== shareClient.getSlug()) return;
    if (result === true) return;
    console.warn('[share] failed to persist header title edit', result);
    this.applyShareTitle(previousTitle);
  }

  private applyShareTitle(title: string | null | undefined): void {
    if (this.shareBannerTitleEditing) return;
    const normalized = typeof title === 'string' ? title.trim() : '';
    const nextTitle = normalized.length > 0 ? normalized : 'Untitled';
    this.shareDocTitle = nextTitle;
    document.title = pageTitle(nextTitle, ' - ');
    this.updateShareBannerTitleDisplay();
  }

  private updateShareBannerTitleDisplay(): void {
    if (!this.shareBannerTitleEl || this.shareBannerTitleEditing) return;
    this.setupTitleEditing(this.shareBannerTitleEl);
    const label = this.shareDocTitle || 'Untitled';
    this.shareBannerTitleEl.textContent = label;
    this.shareBannerTitleEl.title = `${label} — ${this.getViewerText(this.shareOtherViewerCount)}`;
  }

  private updateShareBannerAgentControlDisplay(): void {
    if (!this.shareBannerAgentSlotEl) {
      this.clearShareAgentPresenceExpiryTimer();
      return;
    }
    const { entries: agents, nextExpiryAtMs } = this.collectConnectedAgentEntries();
    this.scheduleShareAgentPresenceExpiryRefresh(nextExpiryAtMs);
    const nextState = agents.length > 0 ? 'connected' : 'empty';
    const signature = agents.map((agent) => `${agent.id}:${agent.name}:${agent.status}:${agent.at}:${getAgentPresenceDisplay(agent).label}`).join('|');
    if (
      this.shareBannerAgentSlotEl.dataset.agentState === nextState
      && this.shareBannerAgentSlotEl.dataset.agentSignature === signature
      && this.shareBannerAgentSlotEl.firstElementChild
    ) return;
    const focused = this.shareBannerAgentSlotEl.contains(document.activeElement);
    this.closeAgentMenu();
    this.shareBannerAgentSlotEl.dataset.agentState = nextState;
    this.shareBannerAgentSlotEl.dataset.agentSignature = signature;
    this.shareBannerAgentSlotEl.replaceChildren(this.createAgentMenuButton(agents));
    if (focused) this.shareBannerAgentSlotEl.querySelector<HTMLButtonElement>('button')?.focus();
    this.scheduleBannerLayoutUpdate();
  }

  private updateShareBannerSyncDisplay(): void {
    if (!this.shareBannerSyncDotEl || !this.shareBannerSyncLabelEl) return;
    const syncStatus = this.getShareSyncStatus();
    const shouldPulse = this.collabConnectionStatus === 'connecting'
      || (this.collabConnectionStatus === 'connected' && (!this.collabIsSynced || this.collabUnsyncedChanges > 0));

    this.shareBannerSyncDotEl.style.background = syncStatus.color;
    if (shouldPulse) {
      this.ensureShareStatusPulseStyle();
      this.shareBannerSyncDotEl.style.animation = 'shareStatusPulse 1.2s ease-in-out infinite';
    } else {
      this.shareBannerSyncDotEl.style.animation = '';
    }

    const statusText = this.getSyncStatusTextLabel(syncStatus.label);
    // Phones hide the dot while "Saved" (TOOLBAR_POLICY.phoneSyncDotOnlyWhenNotSaved; CSS in chrome.css).
    const inline = this.shareBannerSyncDotEl.parentElement;
    if (inline) inline.dataset.sync = TOOLBAR_POLICY.phoneSyncDotOnlyWhenNotSaved && statusText === 'Saved' ? 'saved' : 'other';
    this.shareBannerSyncLabelEl.textContent = statusText;
    this.shareBannerSyncLabelEl.style.display = this.shouldShowStatusText(statusText) ? '' : 'none';
  }

  private renderShareBannerContent(banner: HTMLElement, otherViewerCount: number): void {
    this.ensureShareBannerResponsiveCSS();
    this.shareOtherViewerCount = otherViewerCount;
    if (
      this.shareBannerTitleEl
      && this.shareBannerAvatarsEl
      && this.shareBannerAgentSlotEl
      && this.shareBannerSyncDotEl
      && this.shareBannerSyncLabelEl
      && this.shareBannerSuggestBtnEl
      && this.shareBannerSuggestionReviewBtnEl
      && banner.contains(this.shareBannerTitleEl)
    ) {
      this.updateShareBannerTitleDisplay();
      this.updateShareBannerPresenceDisplay();
      this.updateShareBannerAgentControlDisplay();
      this.updateShareBannerSyncDisplay();
      this.updateSuggestToggleDisplay();
      this.updateShareSuggestionReviewDisplay();
      this.scheduleBannerLayoutUpdate();
      return;
    }

    this.closeShareMenu();
    this.closePresenceMenu();
    this.closeAgentMenu();

    const title = document.createElement('span');
    title.className = 'share-pill-title';
    title.style.cssText = 'font-weight:500;color:#374151;font-size:13px;flex:1 1 auto;min-width:0;';
    this.shareBannerTitleEl = title;
    this.updateShareBannerTitleDisplay();
    this.setupTitleEditing(title);

    const avatars = document.createElement('span');
    this.shareBannerAvatarsEl = avatars;
    this.updateShareBannerPresenceDisplay();

    const agentSlot = document.createElement('span');
    agentSlot.className = 'share-pill-agent-slot';
    agentSlot.style.cssText = 'display:inline-flex;align-items:center;flex-shrink:0;';
    this.shareBannerAgentSlotEl = agentSlot;
    this.updateShareBannerAgentControlDisplay();

    const syncStatusSep = document.createElement('span');
    syncStatusSep.className = 'share-pill-status-sep';
    const syncStatusInline = document.createElement('span');
    syncStatusInline.className = 'share-pill-status-inline';
    const syncDot = document.createElement('span');
    syncDot.style.cssText = 'width:7px;height:7px;border-radius:50%;display:inline-block;flex-shrink:0;';
    const syncLabel = document.createElement('span');
    syncLabel.className = 'status-label';
    this.shareBannerSyncDotEl = syncDot;
    this.shareBannerSyncLabelEl = syncLabel;
    syncStatusInline.append(syncDot, syncLabel);
    this.updateShareBannerSyncDisplay();

    const shareBtn = this.createShareMenuButton();
    const peopleBtn = document.createElement('button');
    peopleBtn.type = 'button';
    peopleBtn.className = 'anv-people';
    peopleBtn.textContent = 'People';
    peopleBtn.setAttribute('aria-haspopup', 'menu');
    peopleBtn.setAttribute('aria-expanded', 'false');
    peopleBtn.onclick = () => this.menuBar?.open('people', true, peopleBtn);

    const suggestToggle = this.createSuggestToggleButton();
    const suggestionReview = this.createShareSuggestionReviewButton();
    // Title, Review, People, Share. Mike, 2026-09-23 (usability brief).
    // ensureLineMarks creates the reading walk. Read its Review button after that call.
    // ?? does not re-read its left side, so a call inside ?? left the old Issues pill in the toolbar.
    const lineMarksUi = this.ensureLineMarks();
    const reviewControl = this.readingWalk?.navigator.reviewButton ?? lineMarksUi.bannerEl;
    const group = (name: string, ...children: HTMLElement[]) => {
      const node = document.createElement('span');
      node.className = `share-pill-group share-pill-${name}`;
      node.append(...children);
      return node;
    };
    const hidden = group('hidden', syncStatusSep, this.createReviewStyleControl(), suggestionReview);
    hidden.setAttribute('aria-hidden', 'true');
    banner.replaceChildren(
      ...(this.readingWalk ? [this.readingWalk.documentsToggle] : []),
      group('center', title, syncStatusInline),
      group('right', reviewControl, suggestToggle, lineMarksUi.alignedEl, peopleBtn, shareBtn),
      hidden,
      this.createShareOverflowButton(),
    );
    this.placeMenuBarPresence(avatars, agentSlot);
    this.updateSuggestToggleDisplay();
    this.updateShareSuggestionReviewDisplay();
    this.mountOpenView();
    this.scheduleBannerLayoutUpdate();
  }



  // --------------------------------------------------------------------------
  // Accord layout stage 2: the menu bar (File · Edit · View · People · Help)
  // --------------------------------------------------------------------------

  private mountMenuBar(): void {
    if (this.menuBar) {
      if (!this.menuBar.el.isConnected) document.body.append(this.menuBar.el);
      document.body.classList.add('amb-on');
      return;
    }
    const brand = document.createElement('a');
    brand.textContent = productName();
    brand.href = productIdentity().homeUrl;
    brand.target = '_blank';
    brand.rel = 'noopener';
    this.menuBar = new MenuBar({
      menus: () => this.menus(),
      writing: () => isWriting(),
      beforeOpen: () => {
        this.closeShareMenu();
        this.closeAgentMenu();
        this.closePresenceMenu();
        this.closeSuggestionReviewMenu();
      },
    }, brand);
    document.body.append(this.menuBar.el);
    document.body.classList.add('amb-on');
    this.menuBar.install();
    (window as unknown as { __proofMenuBar?: MenuBar }).__proofMenuBar = this.menuBar;
  }

  /**
   * Accord round 2 stage C: the honest header sits at the top of the page column, above the text,
   * so it reads as part of the document and not as another piece of chrome. The toggle is mounted
   * by the toolbar (mountShareBanner); this only has to place the header and keep it there.
   */
  private mountOpenView(): void {
    const ui = this.openViewUI;
    if (!ui) return;
    // Inside #editor, not #editor-container: #editor carries the top padding that clears the fixed
    // menu bar and toolbar, so a header prepended to the container would sit underneath them.
    const host = document.getElementById('editor') ?? document.getElementById('editor-container');
    if (host && (ui.headerEl.parentElement !== host || host.firstElementChild !== ui.headerEl)) {
      host.prepend(ui.headerEl);
    }
    const pill = document.querySelector('#share-banner .plm-issues');
    const review = this.readingWalk?.navigator.reviewButton;
    if (pill && review && pill !== review) pill.replaceWith(review);

  }

  private unmountMenuBar(): void {
    this.menuBar?.destroy();
    this.menuBar = null;
    this.findBar?.remove();
    this.findBar = null;
    document.body.classList.remove('amb-on');
  }

  /** The people here and the AI faces sit at the menu bar's right (the mockup's avatars). */
  private placeMenuBarPresence(...nodes: HTMLElement[]): void {
    const slot = this.menuBar?.rightSlot;
    if (!slot) return;
    for (const node of nodes) if (node.parentElement !== slot) slot.append(node);
  }

  /** Undo stays in the existing tool host and Edit menu, including its result notice. */
  private placeUndo(): void {
    if (!this.undoUI || !this.readingWalk) return;
    this.undoUI.setCompact(false);
    this.readingWalk.mountTool(this.undoUI.controlsEl, { first: true });
  }

  /**
   * Edit › Undo and Redo take the path Cmd/Ctrl+Z takes (PlayMakerReview.handleHistoryInput): the
   * one Undo when its entry is newest, else the review-decision history. The raw Yjs undo manager
   * would remove a pending proposal's text without recording its withdrawal, which the server's
   * marks guard then restores.
   */
  private undoFromMenu(redo: boolean): void {
    if (this.undoUI?.handleKey(redo)) return;
    try { this.restoreReviewDecision(redo); }
    catch (error) { this.showErrorBanner(error instanceof Error ? error.message : 'Could not undo that.'); }
    this.playmakerReview?.update();
  }

  private undoLabel(redo: boolean): { label: string; enabled: boolean } {
    const state = (this.undoUI?.debugState() ?? {}) as { next?: { description: string } | null; nextRedo?: { description: string } | null };
    const entry = redo ? state.nextRedo : state.next;
    if (entry) return { label: `${redo ? 'Redo' : 'Undo'} ${entry.description}`, enabled: true };
    // Typing lives in the text history (the Yjs undo manager the review-decision history extends).
    let text = false;
    this.editor?.action(ctx => {
      const manager = yUndoPluginKey.getState(ctx.get(editorViewCtx).state)?.undoManager as { undoStack?: unknown[]; redoStack?: unknown[] } | undefined;
      text = ((redo ? manager?.redoStack : manager?.undoStack)?.length ?? 0) > 0;
    });
    return { label: redo ? 'Redo' : 'Undo', enabled: text };
  }

  /** File › New: a blank document in the library, then open it. */
  private async newDocument(markdown?: string, title?: string): Promise<void> {
    try {
      const response = await fetch('/library/api/documents', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ title: title || 'Untitled document', ...(markdown === undefined ? {} : { markdown }) }),
      });
      const body = await response.json().catch(() => ({})) as { url?: string; error?: string };
      if (response.ok && body.url) { window.location.href = body.url; return; }
      this.showErrorBanner(response.status === 401 || response.status === 403
        ? `Sign in to make a new ${documentNoun()}.`
        : (body.error || `Could not make a new ${documentNoun()}.`));
    } catch {
      this.showErrorBanner(`Could not make a new ${documentNoun()}.`);
    }
  }

  /**
   * File › Import: a .md file becomes a new document. An Accord dialect file keeps its marks, as
   * `<title>.accord.md` or an older `<title>.proof.md`; so does CriticMarkup.
   */
  private importMarkdown(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,.txt,text/markdown,text/plain';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!/\.(md|markdown|txt)$/i.test(file.name)) { this.showErrorBanner('Choose a .md, .markdown or .txt file.'); return; }
      const markdown = await file.text();
      const heading = markdown.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim();
      await this.newDocument(markdown, heading || file.name.replace(/(\.(accord|proof))?\.(md|markdown|txt)$/i, ''));
    };
    input.click();
  }

  private async openDocumentsDialog(): Promise<void> {
    const walk = this.readingWalk;
    if (!walk) return;
    await walk.reloadDocuments();
    const identity = productIdentity();
    showOpenDialog(walk.documentsList(), `Open ${identity.documentNounArticle} ${identity.documentNoun}`, identity.documentNounPlural);
  }

  private openFindBar(): void {
    const lineMarks = this.lineMarks;
    const walk = this.readingWalk;
    if (!lineMarks || !walk) return;
    if (!this.findBar) {
      this.findBar = new FindBar({
        lines: () => lineMarks.lineList().map(line => line.text),
        focusLine: index => { lineMarks.revealLine(index); return walk.focusLine(index); },
        from: () => walk.focusIndex(),
      });
    }
    this.findBar.open();
  }

  private openWhoDialog(): void {
    const summary = this.lineMarks?.issueSummary();
    showWhoDialog({
      people: this.getHumanCollaboratorAvatars(),
      ais: this.getConnectedAgentEntries().map(agent => ({ name: agent.name, state: getAgentPresenceDisplay(agent).label })),
      status: this.lineMarks?.participantStatus(),
      name: actor => this.lineMarks?.displayName(actor) ?? actor,
      viewerIssues: this.lineMarks?.needsYouLines().length ?? 0,
      teamIssues: summary?.counts.total ?? 0,
      team: (summary?.team ?? []).map(actor => actor.replace(/^(human|ai|guest):/i, '')),
    });
  }

  /** The menus, built when one opens so every label and state is current. */
  private menus(): MenuSpec[] {
    const noun = documentNoun();
    const canEdit = this.isShareMode && this.collabCanEdit;
    const lm = this.lineMarks;
    const walk = this.readingWalk;
    const folding = this.folding;
    const pending = getReviewStyle() === 'proof' && canEdit ? this.getAnchoredPendingSuggestions().length : 0;
    const style = getReviewStyle();
    const find = (id: string) => MENU_BAR_POLICY.menus.find(menu => menu.id === id)!;
    const menu = (id: MenuSpec['id'], items: () => MenuItemSpec[]): MenuSpec => ({ ...find(id), items });
    return [
      menu('file', () => [
        { id: 'file-new', label: `New ${noun}`, keywords: 'create blank document', run: () => { void this.newDocument(); } },
        { id: 'file-open', label: 'Open…', keywords: 'documents list library', detail: 'documents', run: () => { void this.openDocumentsDialog(); } },
        { id: 'file-import', label: 'Import .md…', keywords: 'upload markdown file criticmarkup accord dialect', run: () => this.importMarkdown() },
        { id: 'file-rename', label: 'Rename…', keywords: 'title', enabled: canEdit, separatorBefore: true, run: () => { this.shareBannerTitleEl?.click(); } },
        { id: 'file-copy-link', label: 'Copy link', keywords: 'share url', run: () => { void this.copyLinkWithFallback(this.getCanonicalShareUrl()); } },
        { id: 'file-download', label: `Download as ${noun} (.accord.md)`, keywords: 'export markdown save dialect', run: () => { void this.downloadProofDocument(); } },
        { id: 'file-activity', label: 'View activity', keywords: 'history log', run: () => this.openShareActivityModal() },
      ]),
      menu('edit', () => {
        const undo = this.undoLabel(false);
        const redo = this.undoLabel(true);
        const items: MenuItemSpec[] = [
          { id: 'edit-undo', label: undo.label, detail: '⌘Z', keywords: 'undo', enabled: undo.enabled, run: () => this.undoFromMenu(false) },
          { id: 'edit-redo', label: redo.label, detail: '⇧⌘Z', keywords: 'redo', enabled: redo.enabled, run: () => this.undoFromMenu(true) },
          { id: 'edit-find', label: 'Find…', keywords: 'search text', separatorBefore: true, run: () => this.openFindBar() },
          { id: 'edit-editing', label: isWriting() ? 'Leave text' : 'Edit text', enabled: canEdit, separatorBefore: true, keywords: 'mode direct', run: () => this.setSuggestingFromChrome(isWriting()) },
        ];
        if (style === 'proof' && canEdit) {
          items.push(
            { id: 'edit-next-suggestion', label: 'Next suggestion', enabled: pending > 0, separatorBefore: true, run: () => { const id = this.navigateToNextSuggestion(); if (id) this.openSuggestionPopover(id); } },
            { id: 'edit-accept-all', label: `Accept all suggestions${pending ? ` (${pending})` : ''}…`, enabled: pending > 0, run: () => {
              if (window.confirm(`Accept all ${pending} suggestion${pending === 1 ? '' : 's'}?`)) withHumanReviewWrite(() => this.markAcceptAll());
            } },
            { id: 'edit-reject-all', label: `Reject all suggestions${pending ? ` (${pending})` : ''}…`, enabled: pending > 0, run: () => {
              if (window.confirm(`Reject all ${pending} suggestion${pending === 1 ? '' : 's'}?`)) withHumanReviewWrite(() => this.markRejectAll());
            } },
          );
        }
        return items;
      }),
      menu('view', () => {
        const items: MenuItemSpec[] = [];
        if (this.openViewUI) {
          const returning = this.openViewUI.current() === 'accord';
          const offer = lm?.agreedCopyOffer();
          items.push({ id: 'view-agreed-copy', label: returning ? 'Return to document' : 'View agreed copy',
            detail: returning ? undefined : offer?.detail, enabled: returning || offer?.enabled === true,
            run: () => this.openViewUI?.setView(returning ? 'open' : 'accord') });
        }
        if (walk) {
          items.push(
            { id: 'view-navigator', label: `${productIdentity().documentNounPlural} list`, kind: 'checkbox', checked: walk.railShown('left'), keywords: 'left rail documents', run: () => walk.toggleRailFromMenu('left') },
            { id: 'view-margin', label: 'Review panel', kind: 'checkbox', checked: walk.railShown('right'), keywords: 'right rail open items', run: () => walk.toggleRailFromMenu('right') },
          );
        }
        if (folding && this.openViewUI?.current() !== 'accord') {
          items.push({ id: 'view-folded-toggle', label: folding.toggleLabel(), keywords: 'whole open items fold', separatorBefore: true, run: () => folding.toggleWhole() });
        }
        if (walk) {
          items.push({ id: 'view-letter-shortcuts', label: 'Letter shortcuts', kind: 'checkbox', checked: walk.letterShortcutsEnabled(), run: () => walk.toggleLetterShortcuts() });
          items.push({ id: 'view-reading-settings', label: 'Reading settings…', keywords: 'sitting budget', separatorBefore: !lm, run: () => walk.openReadingSettings() });
          // Mike, 2026-09-24, yfbqrau4: the retired Line tab no longer hosts a Familiar brief.

        }
        if (style === 'playmaker' && this.playmakerReview) {
          const review = this.playmakerReview;
          items.push({ id: 'view-marks', label: 'Marks panel', kind: 'checkbox', checked: review.panelOpen(), keywords: 'review comments suggestions', run: () => {
            if (review.panelOpen()) { review.closePanel(); return; }
            // Accord layout stage 3: the panel docks under the Navigator's Issues list.
            walk?.showMarksPanel();
            review.openPanel();
          } });
        }
        if (!REVIEW_STYLE_POLICY.locked) {
          items.push({ id: 'view-review-style', label: 'Review style', detail: style === 'playmaker' ? 'PlayMaker' : productName(), run: () => setReviewStyle(style === 'playmaker' ? 'proof' : 'playmaker') });
        }
        items.push({ id: 'view-keys', label: 'Keyboard shortcuts', keywords: 'keys help', separatorBefore: true, run: () => showKeysDialog() });
        return items;
      }),
      menu('people', () => [
        { id: 'people-identity', label: this.readingWalk?.identityLabel() ?? 'Your identity',
          run: () => this.openWhoDialog() },
        ...(this.lineMarks?.viewerIdentity().signInUrl ? [{ id: 'people-signin', label: 'Sign in',
          run: () => { window.location.href = this.lineMarks!.viewerIdentity().signInUrl!; } }] : []),
        { id: 'people-share', label: 'Share…', keywords: 'link access', run: () => { this.openShareDialog('link'); } },
        { id: 'people-invite', label: 'Invite person…', keywords: 'email team member', enabled: this.teamCanManage === true, run: () => { this.openShareDialog('people'); } },
        { id: 'people-agent', label: 'Add agent…', keywords: 'ai key runtime sponsor', run: () => { this.openShareDialog('ais'); } },
        { id: 'people-who', label: 'Who is here', keywords: 'presence collaborators team issues', separatorBefore: true, run: () => this.openWhoDialog() },
      ]),
      menu('help', () => [
        { id: 'help-search', label: 'Search the menus', detail: 'Alt+/', run: () => this.menuBar?.openSearch() },
        { id: 'help-keys', label: 'Keyboard shortcuts', keywords: 'keys', run: () => showKeysDialog() },
        { id: 'help-marks', label: 'What the marks mean', keywords: 'legend colours dots amber blue', run: () => showMarksLegend() },
        { id: 'help-agent-docs', label: 'Agent docs', keywords: 'api ai', separatorBefore: true, run: () => { window.open('/agent-docs', '_blank', 'noopener'); } },
        { id: 'help-about', label: `About ${productName()}`, run: () => { const id = productIdentity(); showAboutDialog(id.name, id.tagline, id.engineName); } },
      ]),
    ];
  }

  private shareOverflowMenuCleanup: (() => void) | null = null;

  /** Proof Documents Step 1: per-line marks, the Issue count and Next issue. */
  private ensureLineMarks(): LineMarksUI {
    if (!this.lineMarks) {
      this.lineMarks = new LineMarksUI({
        slug: () => shareClient.getSlug(),
        apiBase: () => shareClient.getApiBaseUrl(),
        authHeaders: () => shareClient.getShareAuthHeaders(),
        actor: () => getCurrentActor(),
        canComment: () => this.collabCanComment,
        reviewTeamActors: view => Object.values(getMarkMetadataWithQuotes(view.state))
          .filter(mark => ['insert', 'delete', 'replace', 'comment'].includes(mark.kind ?? ''))
          .flatMap(mark => [mark.by, mark.resolvedBy, ...(mark.replies ?? []).map(reply => reply.by)])
          .filter((actor): actor is string => typeof actor === 'string' && Boolean(actor)),
        reviewMarks: (view) => getMarks(view.state)
          .filter(mark => mark.kind === 'comment' || mark.kind === 'insert' || mark.kind === 'delete' || mark.kind === 'replace')
          .map(mark => {
            const data = (mark.data ?? {}) as { resolved?: boolean; resolvedBy?: string; status?: string; text?: string; content?: string; replies?: Array<{ by?: string; text?: string; at?: string }> };
            const open = mark.kind === 'comment' ? data.resolved !== true : (data.status ?? 'pending') === 'pending';
            // Accord stage D: a comment and a suggestion are both threads, so the thread's own
            // fields (its opening text, the proposed wording, when it was made) come along too.
            return { id: mark.id, kind: mark.kind, by: mark.by, at: mark.at, quote: mark.quote, pos: mark.range?.from ?? null, range: mark.range ?? null, open, resolvedBy: data.resolvedBy ?? null, text: data.text ?? null, content: data.content ?? null, resolved: data.resolved === true, replies: data.replies, status: mark.kind === 'comment' ? null : (data.status ?? 'pending') };
          }),
        isSuggesting: () => this.isSuggestionsEnabled(),
        authorsOfRange: (from, to) => {
          let authors: string[] = [];
          this.editor?.action(ctx => {
            authors = getMarks(ctx.get(editorViewCtx).state)
              .filter(mark => mark.kind === 'authored' && mark.range && mark.range.from < to && mark.range.to > from)
              .map(mark => mark.by)
              .filter((by): by is string => typeof by === 'string' && by.length > 0);
          });
          return authors;
        },
        onDotActivate: (lineIndex) => this.readingWalk?.activateDot(lineIndex) ?? false,
        openReviewItem: index => this.readingWalk?.openReviewItem(index),
        nextReview: () => { this.readingWalk?.navigator.next(); },
        focusLine: (lineIndex) => this.readingWalk?.focusLine(lineIndex) ?? false,
        viewUpdated: () => { this.readingWalk?.notifyViewUpdate(); this.folding?.queueRender(); },
        sectionScope: (lineIndex) => this.folding?.sectionScope(lineIndex) ?? null,
        sectionAgreement: (lineIndex) => this.folding?.sectionAgreement(lineIndex) ?? null,
        showSectionLines: (lineIndex) => { this.folding?.showSectionLines(lineIndex); },
        revealLine: (lineIndex) => this.folding?.reveal(lineIndex) ?? false,
        // Step B4d: shift-click ranges start at the reading walk's focus line.
        anchorLine: () => this.readingWalk?.focusIndex() ?? 0,
        // Step B4c: the sitting budget was used (the rail shows it; phones get the sheet).
        onBudgetReached: () => this.readingWalk?.budgetReached(),
        // Step B7: chat messages that point at a line show as a speech bubble in the margin.
        chatCounts: () => this.chat?.lineCounts() ?? new Map<number, number>(),
        onChatBubble: (lineIndex) => { this.readingWalk?.focusLine(lineIndex); this.chat?.showLine(lineIndex); },
        // Step B4f: Explain posts a comment thread on the whole line (its first text block).
        commentOnLine: (line, text) => {
          let id: string | null = null;
          this.editor?.action(ctx => {
            const view = markApiView(ctx.get(editorViewCtx));
            let from = -1;
            let to = -1;
            const node = view.state.doc.nodeAt(line.pos);
            if (node?.isTextblock) { from = line.pos + 1; to = line.pos + node.nodeSize - 1; }
            else node?.descendants((child, childPos) => {
              if (from >= 0 || !child.isTextblock || child.textContent.trim() === '') return from < 0;
              from = line.pos + 1 + childPos + 1;
              to = from + child.content.size;
              return false;
            });
            if (from < 0 || to <= from) return;
            const quote = normalizeQuote(view.state.doc.textBetween(from, to, '\n', '\n'));
            const mark = markComment(view, quote, getCurrentActor(), text, { from, to });
            id = mark?.id ?? null;
          });
          return id;
        },
      });
      // Accord stage D: a thread's replies and its resolution act on the mark the thread is, so
      // the Margin's Changes and the Discussion use exactly one path into the document.
      this.lineMarks.decideOnMark = (ids, action, text) => {
        this.performReviewDecision(ids, action, text);
        this.playmakerReview?.update();
      };
      this.lineMarks.canTurnThreadBack = id => this.canTurnTypedThreadBack(id);
      this.lineMarks.turnThreadBack = id => this.turnTypedThreadBack(id);
      (window as unknown as { __proofLineMarks?: LineMarksUI }).__proofLineMarks = this.lineMarks;
      // Proof Documents Step 1b: the three-column reading layout and the reading walk.
      const lineMarks = this.lineMarks;
      // Proof Documents Step B2: folding. Subscribes to line marks before the reading walk does,
      // so the walk always reads the current hidden lines.
      this.folding = new FoldingUI({
        documentLoaded: () => this.initialMarksSynced && (!this.collabEnabled || this.collabIsSynced),
        slug: () => shareClient.getSlug(),
        lineMarks: () => lineMarks,
      });
      (window as unknown as { __proofFolding?: FoldingUI }).__proofFolding = this.folding;
      this.readingWalk = new ReadingWalkUI({
        newDocument: () => { void this.newDocument(); },
        slug: () => shareClient.getSlug(),
        suggestChange: (line) => {
          if (EDIT_SESSION_POLICY.privateDrafts) return this.editGesture?.open(line) ?? false;
          this.readingWalk?.focusDocument(line);
          return Boolean(this.readingWalk);
        },
        canSuggest: () => this.shareAllowLocalEdits,
        // Step B6: the reading walk acts as the same identity the line marks write with.
        actor: () => lineMarks.me(),
        lineMarks: () => lineMarks,
        marks: () => {
          let marks: Mark[] = [];
          this.editor?.action(ctx => { marks = getMarks(ctx.get(editorViewCtx).state); });
          return marks;
        },
        decide: (ids, action, text) => {
          this.performReviewDecision(ids, action, text);
          this.playmakerReview?.update();
        },
        playmaker: () => this.playmakerReview,
        reviewStyle: () => getReviewStyle(),
        directEditing: () => isWriting(), // S3's explicit Editing mode, not "suggestions off" (merge fix, Codex diagnosis)
        folding: () => this.folding,
        // Step B2 folded sections, plus line tiers' "Show only decisions" (folded context lines).
        hiddenLines: () => {
          const hidden = new Set<number>(this.folding?.hiddenLines() ?? []);
          for (const index of this.lineMarks?.tierFoldedLines() ?? []) hidden.add(index);
          return hidden;
        },
        focusChanged: (lineIndex) => {
          // Explicit selection updates the chat context without scrolling it.
          this.chat?.onFocusLine(lineIndex);
        },
        visibleLineFor: (lineIndex) => {
          let visible = this.folding?.visibleLineFor(lineIndex) ?? lineIndex;
          const tierFolded = this.lineMarks?.tierFoldedLines() ?? new Set<number>();
          while (visible > 0 && tierFolded.has(visible)) visible -= 1;
          return visible;
        },
      });
      (window as unknown as { __proofReadingWalk?: ReadingWalkUI }).__proofReadingWalk = this.readingWalk;
      // Accord round 2 stage B: the scroll camera is pure, so the check unit-tests the offset rule
      // in the page without a DOM (scripts/scroll-camera-check.mjs).
      (window as unknown as { __proofScrollCamera?: unknown }).__proofScrollCamera = { cameraScroll, deadZone, policy: SCROLL_CAMERA_POLICY };
      const walkUi = this.readingWalk;
      this.folding.subscribe(() => walkUi.onFoldChange());
      // Accord round 2 stage C: Open and Accord, two views of one document. It drives the folding
      // filter, so the Open view uses the SAME folding machinery the outline does — and the reading
      // walk already steps over hidden lines, which is why J / K run the Open list for free.
      this.openViewUI = new OpenViewUI({
        lineMarks: () => lineMarks,
        folding: () => this.folding,
        changed: () => { this.mountOpenView(); walkUi.onFoldChange(); this.scheduleBannerLayoutUpdate(); },
      });
      (window as unknown as { __proofOpenView?: OpenViewUI }).__proofOpenView = this.openViewUI;
      this.openViewUI.start();
      this.mountOpenView();
      // The one Undo: at the top of the right rail, above the outline controls.
      this.undoUI = new UndoUI({ stack: () => lineMarks.undoStack() });
      (window as unknown as { __proofUndo?: UndoUI }).__proofUndo = this.undoUI;
      this.placeUndo();
      if (!this.undoPlacementQuery) {
        try {
          this.undoPlacementQuery = window.matchMedia('(max-width: 700px)');
          this.undoPlacementQuery.addEventListener('change', () => this.placeUndo());
        } catch { /* old browsers: it stays where it was placed */ }
      }
      // Mike, 2026-09-23 (usability brief): draft locally, then submit one suggestion.
      this.editGesture = new EditGestureUI({
        view: () => { let v: EditorView | null = null; this.editor?.action(ctx => { v = ctx.get(editorViewCtx); }); return v; },
        slug: () => shareClient.getSlug(),
        actor: () => lineMarks.me(),
        canPropose: () => this.shareAllowLocalEdits && !this.isReadOnly && this.reviewLockCount === 0,
        suggestReplace: (view, quote, by, content, range) => {
          let parser: Parameters<typeof suggestReplace>[6];
          this.editor?.action(ctx => { parser = ctx.get(parserCtx); });
          return suggestReplace(markApiView(view), quote, by, content, range, undefined, parser)?.id ?? null;
        },
        pending: (id, content) => this.getAllMarks().some(mark => mark.id === id
          && (mark.kind === 'replace' || mark.kind === 'insert' || mark.kind === 'delete')
          && ((mark.data as { status?: string } | undefined)?.status ?? 'pending') === 'pending'
          && (content === undefined || (mark.data as { content?: string } | undefined)?.content === content)),
        decide: (ids) => {
          if (!this.shareAllowLocalEdits || this.isReadOnly || this.reviewLockCount > 0) throw new Error('Connect with editing permission to undo this proposal.');
          // The draft has its own Undo entry. The inverse uses the existing mark route without
          // capturing a second native/Accord history entry for the rejection itself.
          for (const id of ids) if (!this.markReject(id)) throw new Error('This proposal could not be undone.');
        },
        undoStack: () => lineMarks.undoStack(),
        proposed: (lineIndex) => this.readingWalk?.showEditProposed(lineIndex),
        notice: (text) => this.readingWalk?.showEditNotice(text),
      });
      (window as unknown as { __proofEditGesture?: EditGestureUI }).__proofEditGesture = this.editGesture;
      // Item 3: a lone "?" typed at the end of a line becomes a clarify request to the AIs.
      this.clarifyUI = new ClarifyUI({
        view: () => { let v: EditorView | null = null; this.editor?.action(ctx => { v = ctx.get(editorViewCtx); }); return v; },
        explain: (lineIndex, question) => lineMarks.explainLine(lineIndex, question),
        lineAtPos: pos => lineMarks.lineAtPos(pos),
        directEditMeta: () => proofMarkActionMeta,
        suggesting: () => this.isSuggestionsEnabled(),
        toast: message => this.showErrorBanner(message),
      });
      (window as unknown as { __proofClarify?: ClarifyUI }).__proofClarify = this.clarifyUI;
      // Proof Documents Step B7: chat beside the document (its own table; never the text or Yjs).
      this.chat = new ChatUI({
        slug: () => shareClient.getSlug(),
        apiBase: () => shareClient.getApiBaseUrl(),
        authHeaders: () => shareClient.getShareAuthHeaders(),
        lineMarks: () => lineMarks,
        focusIndex: () => walkUi.focusIndex(),
        focusLine: (lineIndex) => walkUi.focusLine(lineIndex),
        marks: () => {
          let marks: Mark[] = [];
          this.editor?.action(ctx => { marks = getMarks(ctx.get(editorViewCtx).state); });
          return marks;
        },
        // Accord layout stage 3 (decision 6): the chat is the Margin's Room tab.
        inMargin: () => true,
        railOpen: () => walkUi.isRoomVisible(),
        openRail: () => walkUi.openRoom(),
        closeRail: () => walkUi.closeRoom(),
        onUnread: (count) => {
          this.chatUnread = count;
          walkUi.setChatUnread(count);
          this.updateShareOverflowBadge();
        },
        closeOtherSheets: () => { walkUi.closeSheets(); this.playmakerReview?.closePanel(); },
      });
      this.chat.mountIn(walkUi.chatSlot);
      const chatUi = this.chat;
      walkUi.onRoomShown(() => chatUi.roomShown());
      (window as unknown as { __proofChat?: ChatUI }).__proofChat = this.chat;
    }
    this.lineMarks.start();
    this.folding?.start();
    this.undoUI?.start();
    this.clarifyUI?.start();
    if (EDIT_SESSION_POLICY.privateDrafts) this.editGesture?.start();
    this.readingWalk?.start();
    this.chat?.start();
    return this.lineMarks;
  }

  /** Phones only (hidden by CSS above 700px): holds Add agent, Review style and Marks. */
  private createShareOverflowButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'share-pill-overflow';
    btn.textContent = '⋯';
    btn.setAttribute('aria-label', 'More options');
    this.renderShareOverflowBadge(btn);
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.onclick = () => {
      if (this.shareOverflowMenuCleanup) { this.shareOverflowMenuCleanup(); return; }
      this.closeShareMenu();
      this.closeAgentMenu();
      const menu = document.createElement('div');
      menu.className = 'proof-share-overflow-menu';
      menu.setAttribute('role', 'menu');
      menu.style.top = `${Math.round(btn.closest('#share-banner')?.getBoundingClientRect().bottom ?? 52) + 6}px`;
      const close = () => {
        menu.remove();
        document.removeEventListener('pointerdown', outside, true);
        document.removeEventListener('keydown', onKey, true);
        btn.setAttribute('aria-expanded', 'false');
        this.shareOverflowMenuCleanup = null;
      };
      const outside = (event: Event) => {
        if (menu.contains(event.target as Node) || btn.contains(event.target as Node)) return;
        close();
      };
      const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { close(); btn.focus(); } };
      // Accord layout stage 2: on phones the menu bar folds into this menu. First the phone's own
      // sheets (this line, the chat, the documents), then File, Edit, View, People and Help.
      const heading = (text: string) => {
        const h = document.createElement('div');
        h.className = 'amb-group';
        h.setAttribute('role', 'presentation');
        h.textContent = text;
        menu.append(h);
      };
      const run = (spec: MenuItemSpec) => { close(); spec.run(); };
      // Polish pass (COS, 2026-09-21: "Phone toolbar matches the mockup"): the phone toolbar is
      // the title, the Issues pill and this ⋯ (TOOLBAR_POLICY.phoneKeeps). The Suggesting | Editing
      // switch and Share lead this menu instead (TOOLBAR_POLICY.phoneMenuTop), in that order.
      const moved = new Set<string>();
      for (const part of TOOLBAR_POLICY.phoneMenuTop) {
        if (part === 'mode' && this.isShareMode && this.collabCanEdit) {
          const on = isWriting();
          const seg = document.createElement('div');
          seg.className = 'apm-mode';
          seg.setAttribute('role', 'group');
          seg.setAttribute('aria-label', 'Editing mode');
          seg.append(...buildMenuItems([
            { id: 'phone-mode-edit', label: on ? 'Leave Editing' : 'Enter Editing', run: () => this.setSuggestingFromChrome(on) },
          ], run));
          menu.append(seg);
          moved.add('edit-suggesting').add('edit-editing');
        } else if (part === 'share') {
          menu.append(...buildMenuItems([{ id: 'phone-share', label: 'Share…', keywords: 'link access invite', run: () => { this.openShareDialog('link'); } }], run));
          moved.add('people-share');
        }
      }
      const phoneItems: MenuItemSpec[] = [];
      if (this.readingWalk) {
        // Accord layout stage 3 (decision 11): the Margin sheet on its Line tab, or its Room tab.
        phoneItems.push({ id: 'phone-line', label: 'Review panel', detail: 'Review · Outline · Since you', run: () => this.readingWalk?.openSheet('right') });
      }
      if (this.chat) {
        phoneItems.push({ id: 'phone-chat', label: 'Room', detail: this.chatUnread > 0 ? `chat · ${this.chatUnread} @you` : 'chat', run: () => this.chat?.open(true) });
      }
      if (this.readingWalk) {
        phoneItems.push({ id: 'phone-docs', label: `${productIdentity().documentNounPlural} list`, run: () => this.readingWalk?.openSheet('left') });
      }
      if (phoneItems.length && moved.size > 0) {
        const sep = document.createElement('div');
        sep.className = 'amb-sep';
        sep.setAttribute('role', 'separator');
        menu.append(sep);
      }
      if (phoneItems.length) menu.append(...buildMenuItems(phoneItems, run));
      for (const spec of this.menus()) {
        const items = spec.items().filter(entry => !entry.id.startsWith('view-navigator') && !entry.id.startsWith('view-margin') && entry.id !== 'help-search' && !moved.has(entry.id));
        if (items.length === 0) continue;
        heading(spec.label);
        // The phone list is plain items: a checkbox or radio says "on" at its right.
        menu.append(...buildMenuItems(items.map((entry, index) => ({
          ...entry,
          kind: 'item' as const,
          detail: entry.kind === 'checkbox' || entry.kind === 'radio' ? (entry.checked ? 'on' : '') : entry.detail,
          separatorBefore: index > 0 && entry.separatorBefore,
        })), run));
      }
      document.body.append(menu);
      btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', onKey, true);
      this.shareOverflowMenuCleanup = close;
      (menu.querySelector('button') as HTMLButtonElement | null)?.focus();
    };
    return btn;
  }

  /** Step B7: the unread chat @mention count on the phone's ⋯ button. */
  private updateShareOverflowBadge(): void {
    const btn = document.querySelector('#share-banner .share-pill-overflow') as HTMLButtonElement | null;
    if (btn) this.renderShareOverflowBadge(btn);
  }

  private renderShareOverflowBadge(btn: HTMLButtonElement): void {
    btn.querySelector('.pch-overflow-badge')?.remove();
    const n = this.chatUnread;
    btn.setAttribute('aria-label', n > 0 ? `More options (${n} unread chat ${n === 1 ? 'mention' : 'mentions'})` : 'More options');
    if (n <= 0) return;
    const badge = document.createElement('span');
    badge.className = 'pch-overflow-badge';
    badge.textContent = String(n);
    badge.setAttribute('aria-hidden', 'true');
    btn.append(badge);
  }

  private createReviewStyleControl(): HTMLElement {
    if (!this.playmakerReview) {
      this.playmakerReview = new PlayMakerReview({
        marks: () => {
          let marks: Mark[] = [];
          this.editor?.action(ctx => { marks = getMarks(ctx.get(editorViewCtx).state); });
          return marks;
        },
        decide: (ids, action, text) => this.performReviewDecision(ids, action, text),
        history: redo => this.restoreReviewDecision(redo),
        jump: id => {
          // Editing first (2026-09-19): a Marks row moves the reading walk's focus line to the
          // mark's line; the rail shows its comments and changes. No dialog opens.
          let from: number | null = null;
          this.editor?.action(ctx => {
            const mark = getMarks(ctx.get(editorViewCtx).state).find(item => item.id === id);
            from = typeof mark?.range?.from === 'number' ? mark.range.from : null;
          });
          const line = from !== null && this.lineMarks ? this.lineMarks.lineAtPos(from) : -1;
          if (line >= 0 && this.readingWalk?.focusLine(line)) return;
          const element = document.querySelector<HTMLElement>(`.ProseMirror [data-mark-id="${CSS.escape(id)}"]`);
          element?.scrollIntoView({ block: 'center', behavior: 'instant' });
        },
        changed: () => {
          this.closeSuggestionReviewMenu();
          this.shareSuggestionReviewSignature = '';
          this.updateShareSuggestionReviewDisplay();
        },
        // The one Undo (Mike, 2026-09-19): Cmd/Ctrl+Z reverses whichever came last, a typed edit
        // or a Proof action. Returning false leaves the keystroke to the text history.
        proofUndo: redo => this.undoUI?.handleKey(redo) ?? false,
        // Item 2: undo the viewer's own earlier decision on one mark (what the "Reject did
        // nothing, you already accepted it" notice offers).
        undoDecision: id => this.undoDecisionForMark(id),
      });
    }
    return this.playmakerReview.control;
  }

  private getReviewDecisionHistory(): ReviewDecisionHistory {
    const doc = collabClient.getYDoc();
    if (!doc || !this.collabCanEdit || this.getShareSuggestionResolutionTransport() !== 'collab') {
      throw new Error('Connect to the document before deciding. Your mark is still open.');
    }
    const view = this.editor?.ctx.get(editorViewCtx);
    const manager = view && yUndoPluginKey.getState(view.state)?.undoManager;
    if (!manager) throw new Error('The editor is still loading.');
    if (this.reviewDecisionHistory?.doc !== doc || this.reviewDecisionHistory.manager !== manager) {
      this.reviewDecisionHistory?.destroy();
      this.reviewDecisionHistory = new ReviewDecisionHistory(doc, manager, view);
      this.reviewDecisionIds.clear();
    }
    return this.reviewDecisionHistory;
  }

  /** One native transaction for the withdrawal and its comment, and one Proof Undo for the row. */
  private typedDiscussionDecision(action: (view: EditorView) => void, record = true): ReturnType<ReviewDecisionHistory['checkpoint']> {
    const history = this.getReviewDecisionHistory();
    const view = this.editor!.ctx.get(editorViewCtx);
    const previous = this.suppressMarksSync;
    this.suppressMarksSync = true;
    this.capturingReviewDecision = true;
    const scrollers: Array<{ node: HTMLElement; top: number; left: number }> = [];
    for (let node: HTMLElement | null = view.dom; node; node = node.parentElement) {
      scrollers.push({ node, top: node.scrollTop, left: node.scrollLeft });
    }
    const x = window.scrollX, y = window.scrollY;
    try {
      const apply = () => {
        action(view);
        const metadata = getMarkMetadataWithQuotes(view.state);
        this.lastReceivedServerMarks = { ...metadata };
        this.initialMarksSynced = true;
        collabClient.setMarksMetadata(metadata);
      };
      if (record) history.decide(apply); else history.withoutRecording(apply);
    } finally {
      this.capturingReviewDecision = false;
      this.suppressMarksSync = previous;
      for (const { node, top, left } of scrollers) { node.scrollTop = top; node.scrollLeft = left; }
      if (window.scrollX !== x || window.scrollY !== y) window.scrollTo(x, y);
      this.scheduleShareSuggestionReviewDisplay(view);
    }
    return history.checkpoint();
  }

  private async convertTypedDiscussion(run: TypedDiscussionRun): Promise<void> {
    const lm = this.lineMarks;
    if (!lm || !this.shareAllowLocalEdits || !this.collabCanEdit) return;
    const currentView = this.editor!.ctx.get(editorViewCtx);
    const item = typedItemAt(currentView.state.doc, run.from);
    if (!item || !(currentView.state.doc.textBetween(item.from + 1, run.from, '', '')
      + currentView.state.doc.textBetween(run.to, item.end, '', '')).trim()) {
      this.readingWalk?.showEditNotice('This item has no other text to discuss. Your question stays a proposal.');
      return;
    }
    if (run.text.trim().length > TYPED_DISCUSSION_POLICY.maxThreadCharacters) {
      this.readingWalk?.showEditNotice('This is longer than a discussion can hold. Your words stay a proposal.');
      return;
    }
    const id = typedDiscussionId(run.id);
    let started: Promise<string | null> = Promise.resolve(null);
    let commentId: string | undefined;
    const line = lm.lineAtPos(run.from);
    const checkpoint = this.typedDiscussionDecision(view => {
      const batch = prepareSuggestionBatch(view, [run.id], 'reject', this.editor!.ctx.get(parserCtx));
      if (batch.failedIds.length) throw new Error('The proposal changed. Its words are still text.');
      batch.apply();
      this.reviewDecisionIds.add(run.id);
    });
    // Step 4 review, 2026-09-25: the discussion's comment is written outside the recorded step.
    // Inside it, Undo let Yjs delete a comment the server still stored; the server put it back and
    // the page re-synced for 6 to 10 seconds. Turning the discussion back resolves the comment.
    this.typedDiscussionDecision(() => {
      started = lm.startThread({ lines: [line], text: run.text.trim(), asks: 'answer', waitingOn: run.waitingOn },
        { id, recordUndo: false, announce: false, onComment: id => { commentId = id; } });
    }, false);
    const record = { checkpoint, entryId: undefined as string | undefined };
    this.typedDiscussionHistory.set(id, record);
    // Publish Undo immediately, even if the row request is still in flight.
    const entry = lm.undoStack().pushSimple('thread', `asked a discussion on line ${line + 1}`, async () => {
      if (!await started) return { ok: false, reason: 'The discussion was not saved; its text has been restored.' };
      return await this.turnTypedThreadBack(id) ? { ok: true } : { ok: false, reason: 'Could not turn this discussion back into text. It may have a reply now.' };
    });
    record.entryId = entry?.id;
    if (!await started) {
      // A lost HTTP response may have saved the row. Keep a resolved comment
      // record even in that case, so it cannot reappear as an orphan discussion.
      await this.restoreTypedDiscussionText(id, run.text, line, commentId);
      this.getReviewDecisionHistory().forgetCheckpoint(checkpoint);
      if (entry) lm.undoStack().forget(entry.id);
      this.typedDiscussionHistory.delete(id);
      throw new Error('Could not save the discussion. Its words were kept as a proposal.');
    }
    this.readingWalk?.showEditNotice(TYPED_DISCUSSION_POLICY.sent.replace('{line}', String(line + 1)));
  }

  private canTurnTypedThreadBack(id: string): boolean {
    const thread = this.lineMarks?.threadById(id)?.thread;
    return Boolean(typedDiscussionInsertId(id) && thread && thread.status === 'open' && thread.replies.length === 0
      && (TYPED_DISCUSSION_POLICY.turnBackAfterReload || this.typedDiscussionHistory.has(id))
      && this.lineMarks?.canCommentHere() && this.shareAllowLocalEdits && this.collabCanEdit
      && actorKey(thread.by) === actorKey(this.lineMarks.me()));
  }

  /** Also works after reload: the row ID points at the existing withdrawal record. */
  private async turnTypedThreadBack(id: string): Promise<boolean> {
    if (!this.canTurnTypedThreadBack(id) || this.returningTypedThreads.has(id)) return false;
    const lm = this.lineMarks!;
    const thread = lm.threadById(id)!;
    const line = thread.lineIndex;
    if (line === null || thread.detached) { this.readingWalk?.showEditNotice('The item is gone. Keep the discussion until it has a new home.'); return false; }
    this.returningTypedThreads.add(id);
    let removed = false;
    try {
      const record = this.typedDiscussionHistory.get(id);
      const history = this.getReviewDecisionHistory();
      if (!await lm.takeBackTypedThread(id)) return false;
      removed = true;
      if (record && history.canRestoreCheckpoint(record.checkpoint)) {
        // The comment was never in the recorded step, so close it as a decision first; then the
        // conversion's own step (the withdrawal) is on top again, and undoing it reopens the words.
        this.resolveTypedDiscussionComment(thread.thread.markId);
        if (!history.canRestoreCheckpoint(record.checkpoint)) throw new Error('Could not turn the discussion back into text.');
        this.restoreReviewDecision(false);
        // The thread row was removed; native Redo must not recreate only its comment.
        if (!TYPED_DISCUSSION_POLICY.redoConversion) history.manager.redoStack.length = 0;
      } else {
        const view = this.editor!.ctx.get(editorViewCtx);
        const original = getMarkMetadataWithQuotes(view.state)[typedDiscussionInsertId(id)!];
        const text = typeof original?.content === 'string' ? original.content : TYPED_DISCUSSION_POLICY.missingOriginalPrefix + thread.thread.text;
        await this.restoreTypedDiscussionText(id, text, line, thread.thread.markId);
        history.forgetCheckpoint(record?.checkpoint);
      }
      if (record?.entryId) lm.undoStack().forget(record.entryId);
      this.typedDiscussionHistory.delete(id);
      return true;
    } catch (error) {
      console.warn('[typed-discussion] turning a discussion back into text failed', error);
      if (removed) await lm.restoreTypedThreadRow(thread.thread);
      this.readingWalk?.showEditNotice(error instanceof Error ? error.message : 'Could not turn the discussion back into text.');
      return false;
    } finally { this.returningTypedThreads.delete(id); }
  }

  /** Resolve a typed discussion's comment by the one path every decision takes, then drop that
   * history step: the take-back owns it, and a later Undo must not reopen an orphan comment. */
  private resolveTypedDiscussionComment(commentId: string | null | undefined): void {
    if (!commentId || !this.editor) return;
    const view = this.editor.ctx.get(editorViewCtx);
    if (!getMarks(view.state).some(mark => mark.id === commentId)) return;
    const history = this.getReviewDecisionHistory();
    const top = history.checkpoint();
    this.performReviewDecision([commentId], 'resolve');
    const added = history.checkpoint();
    if (added && added !== top) history.forgetCheckpoint(added);
  }

  private async restoreTypedDiscussionText(id: string, text: string, lineIndex: number, commentId?: string | null): Promise<void> {
    const view = this.editor!.ctx.get(editorViewCtx);
    // The server's take-back removes the thread's comment, and its marks update can arrive before
    // this runs (after a reload there is no local record to restore from). A missing comment then
    // means it is already gone, not that the anchor moved: the thread's own line is the anchor.
    const comment = commentId ? getMarks(view.state).find(mark => mark.id === commentId && mark.range) : null;
    const currentLine = comment?.range ? this.lineMarks!.lineAtPos(comment.range.from) : lineIndex;
    const line = this.lineMarks?.lineList()[currentLine];
    if (!line) throw new Error('The item is gone; the discussion was kept.');
    const item = typedItemAt(view.state.doc, line.pos + 1);
    if (!item) throw new Error('The item cannot be edited here.');
    // Removing the row already took the discussion back. Undo of the restored
    // typing must not reopen an orphan comment without its thread row.
    // Resolve the comment by the one path every decision takes (as a thread's own Undo does), then
    // drop that history step: the take-back owns it, and Undo must not reopen an orphan comment.
    // A resolve written outside that path (review, 2026-09-25) looped the marks sync after a reload.
    if (comment && commentId) this.resolveTypedDiscussionComment(commentId);
    // Put the words back the way typing puts them in: a plain local insertion, which the editor's
    // dispatch wraps into the person's own pending insert, with typing's history (one Undo takes
    // it back) and typing's marks sync. Step 4 review, 2026-09-25: a separately built insert inside
    // a decision transaction made the marks sync loop after a reload (Yjs cleanup recursed until
    // the stack ran out). The words stay text: the typed-discussion rule must not send them again.
    const me = actorKey(getCurrentActor());
    const before = new Set(getMarks(view.state).map(mark => mark.id));
    view.dispatch(view.state.tr.insertText(text, item.end));
    const restored = getMarks(view.state).find(mark => mark.kind === 'insert' && !before.has(mark.id) && actorKey(mark.by) === me);
    if (!restored) throw new Error('Could not restore the text.');
    this.typedDiscussions?.keepAsText(restored.id);
    this.typedDiscussionHistory.delete(id);
  }

  private performReviewDecision(ids: string[], action: ReviewAction, text?: string): void {
    const history = this.getReviewDecisionHistory();
    if (!this.editor) throw new Error('The editor is still loading.');
    this.editor.action(ctx => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      const batch = action === 'accept' || action === 'reject' ? prepareSuggestionBatch(view, ids, action, parser) : null;
      if (batch?.failedIds.length) {
        const verb = action === 'accept' ? 'accepted' : 'rejected';
        throw Object.assign(new Error(`${batch.failedIds.length} of ${ids.length} suggestions changed and can't be ${verb}. Nothing was changed.`), { failedIds: batch.failedIds });
      }
      const previousSuppress = this.suppressMarksSync;
      this.suppressMarksSync = true;
      this.capturingReviewDecision = true;
      let failed = 0;
      try {
        history.decide(() => {
          failed = 0;
          if (batch) {
            batch.apply(); ids.forEach(id => this.reviewDecisionIds.add(id));
          } else for (const id of [...ids].reverse()) {
            const ok = action === 'resolve' ? markResolve(view, id)
              : markReply(view, id, getCurrentActor(), text || '');
            if (!ok) { failed += 1; continue; }
            this.reviewDecisionIds.add(id);
          }
          const metadata = getMarkMetadataWithQuotes(view.state);
          this.lastReceivedServerMarks = { ...metadata };
          this.initialMarksSynced = true;
          collabClient.setMarksMetadata(metadata);
        });
        if (failed) throw new Error(`${failed} mark${failed === 1 ? ' has' : 's have'} changed. Please review the remaining marks again.`);
      } finally {
        this.capturingReviewDecision = false;
        this.suppressMarksSync = previousSuppress;
        this.scheduleShareSuggestionReviewDisplay(view);
      }
    });
    this.recordDecisionUndo(ids, action);
  }

  /**
   * The one Undo: a suggestion decision (accept / reject / resolve) goes on the person's stack.
   * Its inverse is the editor's own decision history, which refuses when the text moved under it,
   * so an undo never rewrites what someone typed after the decision.
   */
  private recordDecisionUndo(ids: string[], action: ReviewAction): void {
    if (action === 'reply' || ids.length === 0) return;
    const stack = this.lineMarks?.undoStack();
    if (!stack) return;
    const verb = action === 'accept' ? 'accepted' : action === 'reject' ? 'rejected' : 'resolved';
    const what = ids.length === 1 ? (action === 'resolve' ? 'a comment' : 'a change') : `${ids.length} ${action === 'resolve' ? 'comments' : 'changes'}`;
    const entry = stack.pushSimple(action === 'resolve' ? 'comment' : 'suggestion', `${verb} ${what}`, () => {
      try {
        const changed = this.restoreReviewDecision(false);
        return changed ? { ok: true } : { ok: false, reason: 'Not undone: that decision is no longer the newest change to the text.' };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'Could not undo that decision.' };
      }
    }, () => {
      try {
        const changed = this.restoreReviewDecision(true);
        return changed ? { ok: true } : { ok: false, reason: 'Could not redo that decision.' };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : 'Could not redo that decision.' };
      }
    });
    if (entry) for (const id of ids) this.decisionUndoEntries.set(id, entry.id);
  }

  /** markId -> the undo entry that reverses the viewer's decision on it (item 2's Undo button). */
  private readonly decisionUndoEntries = new Map<string, string>();

  /**
   * Item 2: undo the viewer's own earlier decision on one mark. Only the newest decision can be
   * reversed on its own: anything else would step over decisions and edits made since, which is
   * exactly what the one Undo refuses to do.
   */
  private async undoDecisionForMark(id: string): Promise<{ ok: boolean; reason?: string }> {
    const stack = this.lineMarks?.undoStack();
    if (!stack) return { ok: false, reason: 'Undo is not available on this document.' };
    const entryId = this.decisionUndoEntries.get(id);
    const next = stack.next();
    if (!entryId || !next) return { ok: false, reason: 'That decision was made in an earlier session and cannot be undone here.' };
    if (next.id !== entryId) return { ok: false, reason: `Not undone: you have done other things since (the newest is “${next.description}”). Use Undo in the rail, step by step.` };
    const result = await stack.undo();
    this.decisionUndoEntries.delete(id);
    return result.ok ? { ok: true } : { ok: false, reason: result.message };
  }

  private restoreReviewDecision(redo: boolean): boolean {
    const history = this.getReviewDecisionHistory();
    clearResolvedMarkTombstones([...this.reviewDecisionIds]);
    const previousSuppress = this.suppressMarksSync;
    this.suppressMarksSync = true;
    this.restoringReviewDecision = true;
    try {
      const changed = redo ? history.redo() : history.undo();
      const metadata = history.doc.getMap('marks').toJSON() as Record<string, StoredMark>;
      this.lastReceivedServerMarks = { ...metadata };
      this.editor?.action(ctx => {
        const view = ctx.get(editorViewCtx);
        view.dispatch(view.state.tr.setMeta(marksPluginKey, { type: 'SET_METADATA', metadata }).setMeta('addToHistory', false));
        this.scheduleShareSuggestionReviewDisplay(view);
      });
      return changed;
    } finally {
      this.restoringReviewDecision = false;
      this.suppressMarksSync = previousSuppress;
    }
  }

  private createSuggestToggleButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'share-pill-suggest-toggle';
    btn.style.cssText = `
      display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;min-width:44px;padding:0 12px;
      background:rgba(255,255,255,0.7);border:1px solid rgba(17,24,39,0.10);border-radius:22px;color:#111827;
      font-size:12px;font-weight:600;cursor:pointer;transition:background 0.15s,border-color 0.15s;flex-shrink:0;font-family:inherit;
    `;
    btn.onmouseenter = () => { btn.style.background = '#fff'; btn.style.borderColor = 'rgba(17,24,39,0.20)'; };
    btn.onmouseleave = () => { btn.style.background = 'rgba(255,255,255,0.7)'; btn.style.borderColor = 'rgba(17,24,39,0.10)'; };
    btn.classList.add('amb-seg');
    btn.onclick = () => this.setSuggestingFromChrome(isWriting());
    this.shareBannerSuggestBtnEl = btn;
    // Writing also ends without this button (Escape, a click outside the text), so the label
    // follows the caret rather than the last press.
    this.suggestToggleWritingUnsub ??= onWritingChange(() => this.updateSuggestToggleDisplay());
    return btn;
  }

  /** Retain the labelled control as another way to enter or leave the text. */
  private setSuggestingFromChrome(review: boolean): void {
    if (!this.collabCanEdit) return;
    if (EDIT_SESSION_POLICY.liveProposals) {
      this.enableSuggestions();
      if (review) (document.activeElement as HTMLElement | null)?.blur();
      else this.editor?.ctx.get(editorViewCtx).focus();
    } else this.disableSuggestions();
    setDirectEditing(!review);
    this.updateEditableState();
    this.updateSuggestToggleDisplay();
  }

  private updateSuggestToggleDisplay(): void {
    const btn = this.shareBannerSuggestBtnEl;
    if (!btn) return;
    const phone = window.matchMedia?.('(max-width: 700px)').matches ?? window.innerWidth <= 700;
    const visible = this.isShareMode && this.collabCanEdit && !phone;
    btn.textContent = isWriting() ? 'Leave text' : 'Edit text';
    btn.setAttribute('aria-pressed', String(isWriting()));
    btn.setAttribute('aria-label', btn.textContent);
    btn.title = 'Click text to propose changes as you type. Escape returns to Review.';
    btn.style.display = visible ? 'inline-flex' : 'none';
  }

  private getAnchoredPendingSuggestions(viewOverride?: EditorView): Mark[] {
    const collect = (view: EditorView): Mark[] => getPendingSuggestions(getMarks(view.state))
      .filter((mark) => {
        const range = mark.range;
        return Boolean(range && Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > range.from);
      })
      .sort((a, b) => (a.range?.from ?? 0) - (b.range?.from ?? 0));

    if (viewOverride) return collect(viewOverride);
    if (!this.editor) return [];

    let pending: Mark[] = [];
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      pending = collect(view);
    });
    return pending;
  }

  private openSuggestionPopover(markId: string): void {
    if (!this.editor) return;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      openMarkPopover(view, markId);
    });
  }

  private createShareSuggestionReviewButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'share-pill-suggestion-review';
    btn.style.cssText = `
      display:none;align-items:center;justify-content:center;gap:6px;min-height:44px;min-width:44px;padding:0 12px;
      background:rgba(255,255,255,0.7);border:1px solid rgba(17,24,39,0.10);border-radius:22px;color:#111827;
      font-size:12px;font-weight:600;cursor:pointer;transition:background 0.15s,border-color 0.15s;flex-shrink:0;font-family:inherit;
      font-variant-numeric: tabular-nums;
    `;
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.onmouseenter = () => { btn.style.background = '#fff'; btn.style.borderColor = 'rgba(17,24,39,0.20)'; };
    btn.onmouseleave = () => { btn.style.background = 'rgba(255,255,255,0.7)'; btn.style.borderColor = 'rgba(17,24,39,0.10)'; };
    btn.onclick = () => {
      this.triggerHaptic('selection');
      this.closeShareMenu();
      this.closePresenceMenu();
      this.closeAgentMenu();
      if (this.suggestionReviewMenuCleanup) {
        this.closeSuggestionReviewMenu();
        return;
      }
      const pending = this.getAnchoredPendingSuggestions();
      if (pending.length === 0) {
        this.updateShareSuggestionReviewDisplay();
        return;
      }

      const parent = btn.parentElement;
      if (!parent) return;

      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.style.cssText = `
        position:absolute;top:calc(100% + 8px);right:0;min-width:220px;
        background:rgba(17,24,39,0.96);border:1px solid rgba(255,255,255,0.12);
        border-radius:12px;padding:6px;z-index:1002;
        box-shadow:0 16px 40px rgba(0,0,0,0.35);
        backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      `;

      const addActionItem = (title: string, onSelect: () => boolean) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        item.style.cssText = `
          width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;
          padding:10px 12px;min-height:44px;border-radius:10px;border:0;background:transparent;
          color:rgba(255,255,255,0.92);font-size:12px;font-weight:600;cursor:pointer;text-align:left;
        `;
        item.onmouseenter = () => { item.style.background = 'rgba(255,255,255,0.08)'; };
        item.onmouseleave = () => { item.style.background = 'transparent'; };
        const left = document.createElement('span');
        left.textContent = title;
        const right = document.createElement('span');
        right.textContent = '›';
        right.style.cssText = 'font-weight:700;opacity:0.8';
        item.append(left, right);
        item.onclick = () => {
          const ok = onSelect();
          if (ok) cleanup();
        };
        menu.appendChild(item);
      };

      addActionItem('Next suggestion', () => {
        const markId = this.navigateToNextSuggestion();
        if (!markId) return false;
        this.openSuggestionPopover(markId);
        return true;
      });
      addActionItem('Accept all', () => {
        const count = this.getAnchoredPendingSuggestions().length;
        if (count <= 0) return false;
        const confirmed = window.confirm(`Accept all ${count} suggestion${count === 1 ? '' : 's'}?`);
        if (!confirmed) return false;
        withHumanReviewWrite(() => this.markAcceptAll());
        return true;
      });
      addActionItem('Reject all', () => {
        const count = this.getAnchoredPendingSuggestions().length;
        if (count <= 0) return false;
        const confirmed = window.confirm(`Reject all ${count} suggestion${count === 1 ? '' : 's'}?`);
        if (!confirmed) return false;
        withHumanReviewWrite(() => this.markRejectAll());
        return true;
      });

      const container = document.createElement('div');
      container.style.cssText = 'position:relative;display:inline-flex;align-items:center;';
      btn.replaceWith(container);
      container.appendChild(btn);
      container.appendChild(menu);
      this.clampMenuToViewport(menu);
      btn.setAttribute('aria-expanded', 'true');

      const onDocMouseDown = (ev: MouseEvent) => {
        if (!(ev.target instanceof Node)) return;
        if (container.contains(ev.target)) return;
        cleanup();
      };
      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') cleanup();
      };
      const cleanup = () => {
        document.removeEventListener('mousedown', onDocMouseDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        if (menu.isConnected) menu.remove();
        if (container.isConnected) {
          container.replaceWith(btn);
        }
        btn.setAttribute('aria-expanded', 'false');
        if (this.suggestionReviewMenuCleanup === cleanup) this.suggestionReviewMenuCleanup = null;
      };

      this.suggestionReviewMenuCleanup = cleanup;
      document.addEventListener('mousedown', onDocMouseDown, true);
      document.addEventListener('keydown', onKeyDown, true);
    };
    this.shareBannerSuggestionReviewBtnEl = btn;
    return btn;
  }

  private updateShareSuggestionReviewDisplay(viewOverride?: EditorView): void {
    this.playmakerReview?.update();
    const btn = this.shareBannerSuggestionReviewBtnEl;
    if (!btn) return;
    const canShow = this.isShareMode && this.collabCanEdit && getReviewStyle() === 'proof';
    if (!canShow) {
      if (this.shareSuggestionReviewSignature !== 'hidden') {
        btn.style.display = 'none';
        this.shareSuggestionReviewSignature = 'hidden';
        this.closeSuggestionReviewMenu();
        this.scheduleBannerLayoutUpdate();
      }
      return;
    }

    const pending = this.getAnchoredPendingSuggestions(viewOverride);
    if (pending.length === 0) {
      if (this.shareSuggestionReviewSignature !== 'hidden') {
        btn.style.display = 'none';
        this.shareSuggestionReviewSignature = 'hidden';
        this.closeSuggestionReviewMenu();
        this.scheduleBannerLayoutUpdate();
      }
      return;
    }

    const label = `${pending.length} suggestion${pending.length === 1 ? '' : 's'}`;
    const signature = `${label}:${pending.map((mark) => mark.id).join(',')}`;
    if (this.shareSuggestionReviewSignature === signature) return;

    this.shareSuggestionReviewSignature = signature;
    btn.style.display = 'inline-flex';
    btn.replaceChildren();
    const countLabel = document.createElement('span');
    countLabel.textContent = label;
    btn.appendChild(countLabel);
    btn.title = 'Review pending suggestions';
    btn.setAttribute('aria-label', `${label}. Open suggestion review actions.`);
    this.scheduleBannerLayoutUpdate();
  }

  private scheduleShareSuggestionReviewDisplay(viewOverride?: EditorView): void {
    if (viewOverride) {
      this.pendingShareSuggestionReviewView = viewOverride;
    }
    this.shareSuggestionReviewUpdateScheduler.schedule(() => {
      const scheduledView = this.pendingShareSuggestionReviewView ?? undefined;
      this.pendingShareSuggestionReviewView = null;
      this.updateShareSuggestionReviewDisplay(scheduledView);
    });
  }

  private cancelShareSuggestionReviewDisplayUpdate(): void {
    this.pendingShareSuggestionReviewView = null;
    this.shareSuggestionReviewUpdateScheduler.cancel();
  }

  private uninstallShareAgentPresenceObservers(): void {
    this.clearShareAgentPresenceExpiryTimer();
    if (this.shareAgentPresenceCleanup) {
      this.shareAgentPresenceCleanup();
      this.shareAgentPresenceCleanup = null;
    }
    try {
      const awareness: any = collabClient.getAwareness();
      if (awareness) {
        const clientIds = Array.from(this.shareAgentAwarenessClientIds.values());
        if (clientIds.length) removeAwarenessStates(awareness, clientIds as any, 'agent-cursor-cleanup');
      }
    } catch {
      // ignore
    }
    this.shareAgentAwarenessClientIds.clear();
    this.shareAgentAwarenessClocks.clear();
    this.shareAgentPresenceFallback.clear();
    this.shareAgentPresenceIcons.clear();
    this.shareAgentPresenceSummary = '';
    this.shareAgentActivitySignature = '';
    this.shareAgentActivityItems = [];
  }

  private installShareAgentPresenceObservers(): void {
    if (!this.isShareMode || !this.collabEnabled) return;
    if (this.shareAgentPresenceCleanup) return;

    const ydoc: any = collabClient.getYDoc();
    if (!ydoc || typeof ydoc.getMap !== 'function' || typeof ydoc.getArray !== 'function') return;

    const presenceMap: any = ydoc.getMap('agentPresence');
    const activityArr: any = ydoc.getArray('agentActivity');
    const cursorMap: any = ydoc.getMap('agentCursors');

    const refreshCursors = () => {
      if (!this.editor) return;
      const awareness: any = collabClient.getAwareness();
      if (!awareness) return;

      const hints: any[] = [];
      try {
        cursorMap.forEach((value: any) => hints.push(value));
      } catch {
        // ignore
      }

      const activeAgentIds = new Set<string>();
      for (const hint of hints) {
        const agentId = typeof hint?.id === 'string' ? hint.id.trim() : '';
        if (agentId && isAgentScopedId(agentId)) activeAgentIds.add(agentId);
      }
      this.ensureShareAgentPresenceIcons(activeAgentIds);

      const existingAgentIds = new Set<string>(this.shareAgentAwarenessClientIds.keys());
      for (const agentId of existingAgentIds) {
        if (activeAgentIds.has(agentId)) continue;
        const clientId = this.shareAgentAwarenessClientIds.get(agentId);
        if (typeof clientId === 'number') {
          try { removeAwarenessStates(awareness, [clientId] as any, 'agent-cursor-expired'); } catch { /* ignore */ }
        }
        this.shareAgentAwarenessClientIds.delete(agentId);
        this.shareAgentAwarenessClocks.delete(agentId);
      }

      if (hints.length === 0) return;

      this.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const ystate = (ySyncPluginKey.getState(view.state) as any) ?? null;
        const binding = ystate?.binding ?? null;
        const type = binding?.type ?? null;
        const mapping = binding?.mapping ?? null;
        if (!type || !mapping) return;

        const states = awareness.getStates?.() as Map<number, any> | undefined;
        const usedClientIds = new Set<number>();
        if (states && typeof states.keys === 'function') {
          for (const id of states.keys()) usedClientIds.add(id);
        }
        if (typeof awareness.clientID === 'number') usedClientIds.add(awareness.clientID);

        const allocateClientId = (agentId: string): number => {
          const existing = this.shareAgentAwarenessClientIds.get(agentId);
          if (typeof existing === 'number') return existing;

          // Deterministic-ish client id in a high range; bump if it collides.
          let hash = 0;
          for (let i = 0; i < agentId.length; i++) {
            hash = ((hash << 5) - hash + agentId.charCodeAt(i)) | 0;
          }
          let candidate = 1_000_000_000 + (Math.abs(hash) % 1_000_000_000);
          while (usedClientIds.has(candidate)) {
            candidate = (candidate + 1) % 2_147_483_647;
            if (candidate < 1_000_000_000) candidate = 1_000_000_000;
          }

          usedClientIds.add(candidate);
          this.shareAgentAwarenessClientIds.set(agentId, candidate);
          return candidate;
        };

        for (const hint of hints) {
          const agentId = typeof hint?.id === 'string' ? hint.id.trim() : '';
          if (!agentId || !isAgentScopedId(agentId)) continue;

          const quote = typeof hint?.quote === 'string' && hint.quote.trim() ? hint.quote.trim() : null;
          const name = typeof hint?.name === 'string' && hint.name.trim() ? hint.name.trim() : agentId;
          const color = this.getAgentPresenceColor(agentId);
          const avatar = this.getAgentPresenceAvatar(agentId);

          let from = view.state.doc.content.size;
          let to = from;
          if (quote) {
            const resolved = resolveQuoteRange(view.state.doc, quote);
            if (resolved) {
              from = resolved.from;
              to = resolved.to;
            }
          }

          let anchorRel: any;
          let headRel: any;
          try {
            anchorRel = absolutePositionToRelativePosition(from, type, mapping);
            headRel = absolutePositionToRelativePosition(to, type, mapping);
          } catch {
            continue;
          }

          const clientId = allocateClientId(agentId);
          const clock = (this.shareAgentAwarenessClocks.get(agentId) ?? 0) + 1;
          this.shareAgentAwarenessClocks.set(agentId, clock);

          const state = {
            user: { name, color, avatar },
            cursor: { anchor: anchorRel, head: headRel },
          };

          const enc = encoding.createEncoder();
          encoding.writeVarUint(enc, 1);
          encoding.writeVarUint(enc, clientId);
          encoding.writeVarUint(enc, clock);
          encoding.writeVarString(enc, JSON.stringify(state));
          const update = encoding.toUint8Array(enc);

          try {
            applyAwarenessUpdate(awareness, update, 'agent-cursor');
          } catch {
            // ignore
          }
        }
      });
    };

    const refresh = (event?: any) => {
      event?.changes?.keys?.forEach((change: { action: string }, id: string) => {
        if (change.action === 'delete') this.shareAgentPresenceFallback.delete(id);
      });
      const entries: any[] = [];
      try {
        presenceMap.forEach((value: any) => entries.push(value));
      } catch {
        // ignore
      }
      const fresh = entries.filter((entry) => entry && getAgentPresenceDisplay(entry).visible);

      const active = fresh.filter((e) => e && typeof e === 'object' && typeof e.status === 'string' && e.status !== 'idle');
      const chosen = (active.length > 0 ? active : fresh).slice(0, 3);
      const summary = chosen.length > 0
        ? `Agents: ${chosen.map((e) => {
          const name = (typeof e.name === 'string' && e.name.trim()) ? e.name.trim() : (typeof e.id === 'string' ? e.id : 'agent');
          const status = (typeof e.status === 'string' && e.status.trim()) ? e.status.trim() : 'idle';
          return `${name} (${status})`;
        }).join(', ')}`
        : '';

      let activity: any[] = [];
      try {
        activity = typeof activityArr.toArray === 'function' ? activityArr.toArray() : [];
      } catch {
        activity = [];
      }
      const items = activity
        .filter((v) => v && typeof v === 'object' && !Array.isArray(v))
        .slice(-50) as Array<Record<string, any>>;

      const activitySignature = items
        .map((item) => `${String(item.type ?? '')}:${String(item.id ?? '')}:${String(item.status ?? '')}:${String(item.at ?? '')}`)
        .join('|');
      const summaryChanged = summary !== this.shareAgentPresenceSummary;
      const activityChanged = activitySignature !== this.shareAgentActivitySignature;

      this.shareAgentPresenceSummary = summary;
      this.shareAgentActivitySignature = activitySignature;
      this.shareAgentActivityItems = items;

      if (summaryChanged || activityChanged) this.updateShareBannerPresenceDisplay();
      this.updateShareBannerAgentControlDisplay();
    };

    try {
      presenceMap.observe(refresh);
      activityArr.observe(refresh);
      cursorMap.observe(refreshCursors);
    } catch {
      // ignore observer install failures
    }
    this.shareAgentPresenceCleanup = () => {
      try { presenceMap.unobserve(refresh); } catch { /* ignore */ }
      try { activityArr.unobserve(refresh); } catch { /* ignore */ }
      try { cursorMap.unobserve(refreshCursors); } catch { /* ignore */ }
    };

    refresh();
    refreshCursors();
  }

  private openShareActivityModal(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:1100;
      background:rgba(0,0,0,0.55);
      display:flex;align-items:flex-start;justify-content:center;
      padding:48px 16px;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
      width:min(720px, 100%);
      background:rgba(17,24,39,0.98);
      border:1px solid rgba(255,255,255,0.12);
      border-radius:16px;
      box-shadow:0 24px 60px rgba(0,0,0,0.45);
      color:rgba(255,255,255,0.92);
      overflow:hidden;
    `;

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.10)';
    const title = document.createElement('div');
    title.textContent = 'Activity';
    title.style.cssText = 'font-size:13px;font-weight:700;letter-spacing:0.02em';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.style.cssText = 'border:0;background:rgba(255,255,255,0.10);color:white;padding:6px 10px;border-radius:999px;font-size:12px;cursor:pointer';
    header.append(title, close);

    const body = document.createElement('div');
    body.style.cssText = 'max-height:60vh;overflow:auto;padding:10px 16px 16px 16px';

    const items = this.shareAgentActivityItems.slice(-50).reverse();
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No activity yet.';
      empty.style.cssText = 'padding:14px 0;color:rgba(255,255,255,0.70);font-size:12px;line-height:1.35';
      body.appendChild(empty);
    } else {
      for (const item of items) {
        const row = document.createElement('div');
        row.style.cssText = 'padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);font-size:12px;line-height:1.35';
        const when = typeof item.at === 'string' ? item.at : '';
        const who = typeof item.name === 'string' ? item.name : (typeof item.id === 'string' ? item.id : 'agent');
        const status = typeof item.status === 'string' ? item.status : (typeof item.type === 'string' ? item.type : '');
        const details = typeof item.details === 'string' ? item.details : '';
        row.textContent = `${when}  ${who}  ${status}${details ? ` — ${details}` : ''}`;
        body.appendChild(row);
      }
    }

    panel.append(header, body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const cleanup = () => {
      if (!overlay.isConnected) return;
      overlay.remove();
      document.removeEventListener('keydown', onKeyDown, true);
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') cleanup();
    };
    document.addEventListener('keydown', onKeyDown, true);
    overlay.addEventListener('mousedown', (ev) => {
      if (ev.target === overlay) cleanup();
    });
    close.onclick = cleanup;
  }

  private openAgentHelpModal(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:1100;
      background:rgba(0,0,0,0.55);
      display:flex;align-items:flex-start;justify-content:center;
      padding:48px 16px;
    `;

    const panel = document.createElement('div');
    panel.style.cssText = `
      width:min(560px, 100%);
      background:rgba(17,24,39,0.98);
      border:1px solid rgba(255,255,255,0.12);
      border-radius:16px;
      box-shadow:0 24px 60px rgba(0,0,0,0.45);
      color:rgba(255,255,255,0.92);
      overflow:hidden;
    `;

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,0.10)';
    const title = document.createElement('div');
    title.textContent = 'Use an agent collaborator in this doc';
    title.style.cssText = 'font-size:13px;font-weight:700;letter-spacing:0.02em';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    close.style.cssText = 'border:0;background:rgba(255,255,255,0.10);color:white;padding:6px 10px;border-radius:999px;font-size:12px;cursor:pointer';
    header.append(title, close);

    const body = document.createElement('div');
    body.style.cssText = 'padding:14px 16px 16px 16px;color:rgba(255,255,255,0.86);font-size:12px;line-height:1.5;';
    body.innerHTML = `
      <p style="margin:0 0 10px 0;">Agent collaborators can suggest and edit with the same permissions as the link you share.</p>
      <p style="margin:0 0 8px 0;"><strong>How to connect:</strong></p>
      <ol style="margin:0 0 10px 18px;padding:0;">
        <li>Copy the agent invite link.</li>
        <li>Paste it into your AI tool (for example, ChatGPT or Claude).</li>
        <li>The agent appears here when connected.</li>
      </ol>
      <p style="margin:0;color:rgba(255,255,255,0.72);">Disconnect removes live presence from this doc, but does not revoke the link.</p>
    `;

    panel.append(header, body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const cleanup = () => {
      if (!overlay.isConnected) return;
      overlay.remove();
      document.removeEventListener('keydown', onKeyDown, true);
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') cleanup();
    };
    document.addEventListener('keydown', onKeyDown, true);
    overlay.addEventListener('mousedown', (ev) => {
      if (ev.target === overlay) cleanup();
    });
    close.onclick = cleanup;
  }

  private closeShareMenu(): void {
    if (!this.shareMenuCleanup) return;
    const cleanup = this.shareMenuCleanup;
    this.shareMenuCleanup = null;
    cleanup();
  }

  private closePresenceMenu(): void {
    if (!this.presenceMenuCleanup) return;
    const cleanup = this.presenceMenuCleanup;
    this.presenceMenuCleanup = null;
    cleanup();
  }

  private closeAgentMenu(): void {
    if (!this.agentMenuCleanup) return;
    const cleanup = this.agentMenuCleanup;
    this.agentMenuCleanup = null;
    cleanup();
  }

  private closeSuggestionReviewMenu(): void {
    if (!this.suggestionReviewMenuCleanup) return;
    const cleanup = this.suggestionReviewMenuCleanup;
    this.suggestionReviewMenuCleanup = null;
    cleanup();
  }

  private clampMenuToViewport(menu: HTMLElement): void {
    const margin = 12;
    const rect = menu.getBoundingClientRect();
    let shift = 0;
    if (rect.left < margin) {
      shift = margin - rect.left;
    } else if (rect.right > (window.innerWidth - margin)) {
      shift = (window.innerWidth - margin) - rect.right;
    }
    if (shift !== 0) {
      menu.style.transform = `translateX(${Math.round(shift)}px)`;
    }
  }

  private getCanonicalShareUrl(): string {
    try {
      const url = new URL(window.location.href);
      // Keep tokenized URLs intact. Share links are designed to be copy-pastable.
      url.pathname = url.pathname.replace(/\/+$/, '');
      return url.toString();
    } catch {
      return window.location.href;
    }
  }

  /**
   * The Accord dialect (2026-09-19; named 2026-09-21): "Download as Accord (.accord.md)" — the
   * document with every mark stored beside it (GET /api/documents/<slug>/export?format=proof-dialect,
   * the canonical machine value), saved as `<title>.accord.md`.
   */
  async downloadProofDocument(format: 'proof-dialect' | 'criticmarkup' | 'plain' = 'proof-dialect'): Promise<boolean> {
    const slug = shareClient.getSlug();
    if (!slug) return false;
    try {
      const response = await fetch(`${shareClient.getApiBaseUrl()}/documents/${encodeURIComponent(slug)}/export?format=${format}`, {
        credentials: 'same-origin',
        headers: shareClient.getShareAuthHeaders(),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const disposition = response.headers.get('content-disposition') ?? '';
      const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? `${slug}.accord.md`;
      const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.style.display = 'none';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      return true;
    } catch (error) {
      console.warn('[proof] export failed', error);
      const toast = document.createElement('div');
      toast.className = 'proof-external-change-toast proof-export-failed-toast';
      toast.setAttribute('role', 'alert');
      toast.textContent = `Could not download the ${documentNoun()}. Try again.`;
      document.body.append(toast);
      setTimeout(() => toast.remove(), 4000);
      return false;
    }
  }

  private copyWithPromptFallback(text: string, promptLabel = 'Copy link:'): boolean {
    try {
      window.prompt(promptLabel, text);
      return true;
    } catch {
      return false;
    }
  }

  private triggerHaptic(pattern: 'light' | 'medium' | 'success' | 'selection' = 'light'): void {
    void this.webHaptics.trigger(pattern);
  }

  private async copyLinkWithFallback(url: string): Promise<boolean> {
    const copied = await this.copyTextToClipboard(url);
    if (copied) {
      this.triggerHaptic('success');
      return true;
    }
    const prompted = this.copyWithPromptFallback(url);
    if (prompted) this.triggerHaptic('medium');
    return prompted;
  }

  private extractShareSlugFromUrl(shareUrl: string): string | null {
    try {
      const url = new URL(shareUrl);
      const match = url.pathname.match(/\/d\/([^/?#]+)/);
      if (!match?.[1]) return null;
      return decodeURIComponent(match[1]);
    } catch {
      return null;
    }
  }

  private getAgentInviteMessage(token: string): string {
    const shareUrl = new URL(this.getCanonicalShareUrl());
    shareUrl.search = '';
    shareUrl.hash = '';
    const slug = shareClient.getSlug() || this.extractShareSlugFromUrl(shareUrl.toString());
    const origin = shareUrl.origin;

    if (!slug) {
      return [
        `Collaborate with me on this ${productName()} doc.`,
        '',
        `Doc: ${shareUrl}`,
      ].join('\n');
    }

    const encodedSlug = encodeURIComponent(slug);
    const presenceUrl = `${origin}/api/agent/${encodedSlug}/presence`;
    const stateUrl = `${origin}/api/agent/${encodedSlug}/state`;
    const opsUrl = `${origin}/api/agent/${encodedSlug}/ops`;
    const editUrl = `${origin}/api/agent/${encodedSlug}/edit`;

    return [
      `Collaborate with me on this ${productName()} doc.`,
      '',
      `Doc: ${shareUrl}`,
      '',
      'Auth for each API request:',
      `- x-share-token: ${token}`,
      '- X-Agent-Id: <your-agent-id>',
      '- Keep this key private; send it only in the request header, never in a URL.',
      '',
      'Start here:',
      '1) Read current document state with your identity header:',
      `   GET ${stateUrl}`,
      '   header: X-Agent-Id: <your-agent-id>',
      '2) Optionally set your friendly name in presence:',
      `   POST ${presenceUrl}`,
      '   body: {"agentId":"<your-agent-id>","name":"<your-name>","status":"active"}',
      '3) If edits/comments are useful based on state, apply them with:',
      `   POST ${opsUrl}`,
      `   or POST ${editUrl}`,
      '4) Then reply briefly with what you changed or suggest next steps.',
    ].join('\n');
  }

  /** Invite person: the team routes (server/document-team-routes.ts), same origin, JSON. */
  private async teamRequest<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
    const slug = shareClient.getSlug();
    if (!slug) throw new Error('No document');
    const response = await fetch(`/api/documents/${encodeURIComponent(slug)}/team${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(typeof json.error === 'string' ? json.error : 'Something went wrong. Try again.');
    return json as T;
  }

  /** Invite person: only an Owner (signed in) sees "Invite person"; guests never ask. */
  private async checkTeamAccess(): Promise<void> {
    if (this.teamCanManage !== null || !window.__PROOF_LIBRARY_MEMBER__) return;
    try {
      const team = await this.teamRequest<{ canManage?: boolean }>('GET', '');
      this.teamCanManage = team.canManage === true;
    } catch {
      this.teamCanManage = false;
    }
  }

  /** Add agent is the Share dialog's AIs tab (decision 12). */
  private openAgentKeyDialog(): boolean {
    return this.openShareDialog('ais');
  }

  private showShareWelcomeToastOnce(capabilities?: { canComment: boolean; canEdit: boolean } | null): void {
    const slug = shareClient.getSlug();
    if (!slug) return;

    try {
      const key = `proof_share_welcome_${slug}`;
      if (sessionStorage.getItem(key) === '1') return;
      sessionStorage.setItem(key, '1');
    } catch {
      // sessionStorage best-effort
    }

    if (this.shareWelcomeToast) {
      this.shareWelcomeToast.remove();
      this.shareWelcomeToast = null;
    }

    const message = capabilities?.canEdit
      ? 'This document was shared with you. You can edit it, and your changes are saved automatically.'
      : capabilities?.canComment
        ? 'This document was shared with you. You can leave comments.'
        : 'This document was shared with you for viewing.';

    const toast = document.createElement('div');
    toast.className = 'proof-external-change-toast proof-share-welcome-toast';
    toast.innerHTML = `
      <div class="proof-toast-content">
        <span class="proof-toast-message">${message}</span>
        <button type="button" class="proof-toast-dismiss" aria-label="Dismiss">×</button>
      </div>
    `;
    toast.querySelector('.proof-toast-dismiss')?.addEventListener('click', () => {
      toast.remove();
      if (this.shareWelcomeToast === toast) this.shareWelcomeToast = null;
    });

    document.body.appendChild(toast);
    this.shareWelcomeToast = toast;
    this.positionShareWelcomeToast(toast);
    requestAnimationFrame(() => {
      if (this.shareWelcomeToast !== toast) return;
      this.positionShareWelcomeToast(toast);
    });

    setTimeout(() => {
      if (this.shareWelcomeToast !== toast) return;
      toast.remove();
      this.shareWelcomeToast = null;
    }, 5000);
  }

  private positionShareWelcomeToast(toast: HTMLElement): void {
    const banner = document.getElementById('share-banner');
    const isMobile = window.innerWidth <= 700;
    const pageMargin = isMobile ? 12 : 12;
    let top = 12;
    if (banner) {
      const rect = banner.getBoundingClientRect();
      top = Math.max(12, Math.round(rect.bottom + 10));
    }

    if (isMobile) {
      // Under the compact bar, not at the bottom where it would sit on the feedback chip and the last lines.
      toast.style.top = `${top - 4}px`;
      toast.style.bottom = 'auto';
      toast.style.left = `${pageMargin}px`;
      toast.style.right = `${pageMargin}px`;
      toast.style.maxWidth = 'none';
    } else {
      toast.style.top = `${top}px`;
      toast.style.bottom = '';
      toast.style.left = '';
      toast.style.right = `${pageMargin}px`;
      toast.style.maxWidth = '340px';
    }
  }

  /** Accord layout stage 2: one Share button; it opens the Share dialog (decision 12). */
  private createShareMenuButton(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'share-pill-share-btn';
    container.style.cssText = 'position:relative;display:inline-flex;align-items:center';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'Share');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.style.cssText = `
      display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;min-width:44px;padding:0 16px;background:#111;
      border:none;border-radius:22px;color:#fff;font-size:13px;font-weight:600;
      cursor:pointer;transition:background 0.15s;flex-shrink:0;font-family:inherit;
    `;
    const label = document.createElement('span');
    label.textContent = 'Share';
    btn.append(label);
    btn.onmouseenter = () => { btn.style.background = '#333'; };
    btn.onmouseleave = () => { btn.style.background = '#111'; };
    btn.onclick = () => {
      this.triggerHaptic('selection');
      this.openShareDialog('link');
    };
    container.appendChild(btn);
    return container;
  }

  /** The Share dialog: Link (and the guest setting), People (Invite person), AIs (Add agent). */
  private openShareDialog(tab: ShareTab): boolean {
    this.closeShareMenu();
    this.closeAgentMenu();
    this.closePresenceMenu();
    this.shareOverflowMenuCleanup?.();
    const owner = this.teamCanManage === true;
    showShareDialog({
      title: this.shareDocTitle || 'Untitled',
      shareUrl: this.getCanonicalShareUrl(),
      documentNoun: documentNoun(),
      copyLink: () => this.copyLinkWithFallback(this.getCanonicalShareUrl()),
      download: () => { void this.downloadProofDocument(); },
      activity: () => this.openShareActivityModal(),
      // The Accord rules retire blind marking controls; stored records remain intact.
      linkExtras: [],
      invite: owner ? {
        load: () => this.teamRequest<TeamState>('GET', ''),
        invite: (email, name) => this.teamRequest<InviteResult>('POST', '/invites', { email, name }),
        resend: id => this.teamRequest<InviteResult>('POST', `/invites/${encodeURIComponent(id)}/resend`, {}),
        remove: id => this.teamRequest<TeamState>('POST', `/invites/${encodeURIComponent(id)}/remove`, {}),
        setGuestAccess: mode => this.teamRequest<TeamState>('PUT', '/guest-access', { mode }),
        copy: text => this.copyTextToClipboard(text),
        // Cross invitation (2026-09-19): the Owner answers what an AI proposed.
        confirmNomination: async id => {
          const body = await this.teamRequest<{ team: TeamState; emailed?: boolean }>('POST', `/nominations/${encodeURIComponent(id)}/confirm`, {});
          return { team: body.team, emailed: body.emailed };
        },
        declineNomination: id => this.teamRequest<TeamState>('POST', `/nominations/${encodeURIComponent(id)}/decline`, {}),
        revokeAttestation: id => this.teamRequest<TeamState>('POST', `/attestations/${encodeURIComponent(id)}/revoke`, {}),
        setDirectInvite: (tokenId, allow) => this.teamRequest<TeamState>('PUT', `/agents/${encodeURIComponent(tokenId)}/direct-invite`, { allow }),
      } : null,
      agents: {
        // A2 will add team-only documents; today this notice depends on member sign-in.
        isSignedInMember: Boolean(window.__PROOF_LIBRARY_MEMBER__),
        create: (label, runtime) => shareClient.createAgentKey(label, runtime),
        list: () => shareClient.listAgentKeys(),
        revoke: id => shareClient.revokeAgentKey(id),
        invite: token => this.getAgentInviteMessage(token),
        copy: text => this.copyTextToClipboard(text),
      },
    }, tab);
    return true;
  }

  private createAgentMenuButton(
    seedAgents?: Array<{
      id: string;
      name: string;
      status: string;
      color: string;
      avatar?: string;
      at: string;
      expiresAt?: string;
    }>,
  ): HTMLElement {
    const container = document.createElement('div');
    container.className = 'share-pill-agent-btn';
    container.style.cssText = 'position:relative;display:inline-flex;align-items:center';
    const agents = seedAgents ?? this.getConnectedAgentEntries();
    const hasAgents = agents.length > 0;

    const buildAgentFace = (
      agent: {
        id: string;
        name: string;
        avatar?: string;
        at: string;
        expiresAt?: string;
        status: string;
      },
      options: {
        size: number;
        title: string;
        zIndex?: number;
        marginLeft?: number;
      },
    ): HTMLSpanElement => {
      const family = this.getAgentPresenceVariant(agent.id);
      const palette = getAgentFacePalette(family);
      const face = createAgentFaceElement({
        family,
        size: options.size,
        title: options.title,
        wrapperClassName: 'share-pill-agent-face',
        className: 'share-pill-agent-face__svg',
      });
      face.dataset.agentFamily = family;
      face.dataset.agentId = agent.id;
      const display = getAgentPresenceDisplay(agent);
      face.dataset.presenceState = display.idle ? 'idle' : 'active';
      face.style.opacity = display.idle ? '0.45' : '1';
      face.style.animation = display.idle ? 'none' : 'proof-agent-pulse 2s ease-in-out infinite';
      face.title = `${agent.name} — ${display.label}`;
      face.style.filter = 'drop-shadow(0 1px 1px rgba(15,23,42,0.10))';
      face.style.borderRadius = '999px';
      face.style.boxShadow = `0 0 0 1px ${palette.accent}22`;
      face.style.position = 'relative';
      face.style.zIndex = String(options.zIndex ?? 1);
      if (typeof options.marginLeft === 'number') {
        face.style.marginLeft = `${options.marginLeft}px`;
      }
      return face;
    };

    const buildAgentStack = (
      items: Array<{
        id: string;
        name: string;
        avatar?: string;
        at: string;
        expiresAt?: string;
        status: string;
      }>,
    ): { element: HTMLSpanElement; tooltipLabel: string; tooltipSubtext: string } => {
      const stack = document.createElement('span');
      stack.style.cssText = 'display:inline-flex;align-items:center;justify-content:flex-start;position:relative;height:32px;';

      if (items.length === 1) {
        stack.style.width = '32px';
        stack.appendChild(buildAgentFace(items[0], {
          size: 32,
          title: `${items[0].name} icon`,
          zIndex: 2,
        }));
        return {
          element: stack,
          tooltipLabel: `${items[0].name} — ${getAgentPresenceDisplay(items[0]).label}`,
          tooltipSubtext: 'Open agent actions',
        };
      }

      const visible = items.slice(0, 2);
      const faceSize = 32;
      const overlap = -7;
      const chipGap = 5;
      const overflowCount = Math.max(0, items.length - 2);
      const stackWidth = faceSize + (visible.length - 1) * (faceSize + overlap) + (overflowCount > 0 ? 24 + chipGap : 0);
      stack.style.width = `${stackWidth}px`;

      visible.forEach((agent, index) => {
        stack.appendChild(buildAgentFace(agent, {
          size: faceSize,
          title: `${agent.name} icon`,
          zIndex: visible.length - index + 1,
          marginLeft: index === 0 ? 0 : overlap,
        }));
      });

      if (overflowCount > 0) {
        const chip = document.createElement('span');
        chip.textContent = `+${overflowCount}`;
        chip.className = 'share-pill-agent-overflow';
        chip.style.cssText = `
          margin-left:${chipGap}px;
          min-width:24px;height:18px;padding:0 6px;border-radius:999px;
          background:rgba(17,24,39,0.92);color:#fff;font-size:10px;font-weight:700;line-height:1;
          display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;
          box-shadow:0 1px 4px rgba(0,0,0,0.22);
          font-variant-numeric: tabular-nums;
        `;
        stack.appendChild(chip);
      }

      return {
        element: stack,
        tooltipLabel: items.map((agent) => `${agent.name} — ${getAgentPresenceDisplay(agent).label}`).join('\n'),
        tooltipSubtext: 'Click to manage',
      };
    };

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'share-pill-agent-trigger';
    if (hasAgents) {
      btn.classList.add('has-agents');
      btn.setAttribute('aria-label', `${agents.map((agent) => `${agent.name} — ${getAgentPresenceDisplay(agent).label}`).join('; ')}. Open agent actions`);
      btn.setAttribute('aria-haspopup', 'menu');
      btn.setAttribute('aria-expanded', 'false');
      btn.style.cssText = `
        display:inline-flex;align-items:center;justify-content:center;gap:0;min-height:44px;min-width:44px;padding:0 4px;
        background:transparent;border:0;border-radius:18px;color:#111827;cursor:pointer;
        transition:background 0.15s;flex-shrink:0;font-family:inherit;
      `;

      const wrap = document.createElement('span');
      wrap.className = 'proof-avatar-wrap';
      wrap.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;position:relative;';
      const stack = buildAgentStack(agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        avatar: agent.avatar,
        at: agent.at,
        expiresAt: agent.expiresAt,
        status: agent.status,
      })));
      wrap.appendChild(stack.element);
      const tooltip = document.createElement('span');
      tooltip.className = 'proof-avatar-tooltip';
      const tooltipName = document.createElement('span');
      tooltipName.style.cssText = 'display:block;font-weight:600;white-space:pre-line';
      tooltipName.textContent = stack.tooltipLabel;
      const tooltipType = document.createElement('span');
      tooltipType.style.cssText = 'display:block;font-size:10px;opacity:0.7;margin-top:1px';
      tooltipType.textContent = stack.tooltipSubtext;
      tooltip.append(tooltipName, tooltipType);
      wrap.appendChild(tooltip);
      wrap.dataset.agentCount = String(agents.length);

      btn.appendChild(wrap);
      btn.onmouseenter = () => {
        btn.style.background = 'rgba(17,24,39,0.06)';
      };
      btn.onmouseleave = () => {
        btn.style.background = 'transparent';
      };
    } else {
      btn.setAttribute('aria-label', 'Add agent');
      btn.style.cssText = `
        display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;min-width:44px;padding:0 12px;
        background:rgba(255,255,255,0.7);border:1px solid rgba(17,24,39,0.10);border-radius:22px;color:#111827;
        font-size:12px;font-weight:500;cursor:pointer;transition:background 0.15s,border-color 0.15s;flex-shrink:0;font-family:inherit;
      `;

      const icon = document.createElement('span');
      icon.textContent = '+';
      icon.style.cssText = 'font-size:12px;line-height:1;color:#6b7280;';
      btn.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'agent-btn-label';
      label.textContent = 'Add agent';
      label.style.cssText = 'font-size:12px;font-weight:600;line-height:1;';
      btn.appendChild(label);

      btn.onmouseenter = () => {
        btn.style.background = '#fff';
        btn.style.borderColor = 'rgba(17,24,39,0.20)';
      };
      btn.onmouseleave = () => {
        btn.style.background = 'rgba(255,255,255,0.7)';
        btn.style.borderColor = 'rgba(17,24,39,0.10)';
      };
    }

    const openMenu = () => {
      if (this.getConnectedAgentEntries().length === 0) {
        this.closeShareMenu();
        this.closeAgentMenu();
        this.openAgentKeyDialog();
        return;
      }
      this.closeShareMenu();
      this.closePresenceMenu();
      this.closeSuggestionReviewMenu();
      if (this.agentMenuCleanup) {
        this.closeAgentMenu();
        return;
      }
      container.classList.add('menu-open');
      btn.setAttribute('aria-expanded', 'true');

      const menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.style.cssText = `
        position:absolute;top:calc(100% + 8px);right:0;min-width:280px;max-width:min(360px, calc(100vw - 24px));
        background:rgba(17,24,39,0.96);border:1px solid rgba(255,255,255,0.12);
        border-radius:12px;padding:8px;z-index:1002;
        box-shadow:0 16px 40px rgba(0,0,0,0.35);
        backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      `;

      const addDivider = () => {
        const hr = document.createElement('div');
        hr.style.cssText = 'height:1px;background:rgba(255,255,255,0.10);margin:8px 6px';
        menu.appendChild(hr);
      };

      const addMenuButton = (
        title: string,
        onSelect: () => Promise<boolean> | boolean,
        options?: {
          subtle?: boolean;
          destructive?: boolean;
          disabled?: boolean;
          successText?: string;
          failureText?: string;
        },
      ) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.setAttribute('role', 'menuitem');
        item.style.cssText = `
          width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;
          padding:10px 12px;min-height:44px;border-radius:10px;border:0;background:transparent;
          color:${options?.destructive ? '#fca5a5' : (options?.subtle ? 'rgba(255,255,255,0.82)' : 'rgba(255,255,255,0.92)')};
          font-size:12px;font-weight:${options?.subtle ? '500' : '600'};cursor:pointer;text-align:left;
        `;
        item.onmouseenter = () => { if (!options?.disabled) item.style.background = 'rgba(255,255,255,0.08)'; };
        item.onmouseleave = () => { item.style.background = 'transparent'; };
        if (options?.disabled) {
          item.disabled = true;
          item.style.opacity = '0.55';
          item.style.cursor = 'default';
        }

        const left = document.createElement('span');
        left.textContent = title;
        const right = document.createElement('span');
        right.style.cssText = 'font-weight:600;opacity:0.85';
        item.append(left, right);
        item.onclick = async () => {
          if (options?.disabled) return;
          const ok = await onSelect();
          right.textContent = ok ? (options?.successText ?? 'Done') : (options?.failureText ?? 'Failed');
          if (ok) {
            setTimeout(() => cleanup(), 400);
          } else {
            setTimeout(() => { right.textContent = ''; }, 1200);
          }
        };
        menu.appendChild(item);
      };

      const agentsNow = this.getConnectedAgentEntries();
      if (agentsNow.length === 0) {
        const header = document.createElement('div');
        header.textContent = 'Add an agent';
        header.style.cssText = 'padding:8px 12px 4px;color:#fff;font-size:13px;font-weight:700;';
        const body = document.createElement('div');
        body.textContent = 'Invite an agent collaborator to edit, suggest, and review this doc.';
        body.style.cssText = 'padding:0 12px 8px;color:rgba(255,255,255,0.78);font-size:12px;line-height:1.35;';
        menu.append(header, body);
        addMenuButton('Add agent / manage keys', () => this.openAgentKeyDialog(), {
          successText: 'Opened',
        });
        addDivider();
        addMenuButton('How agent access works', async () => {
          this.openAgentHelpModal();
          return true;
        }, { subtle: true, successText: 'Done' });
      } else {
        const header = document.createElement('div');
        header.textContent = `Agent collaborators (${agentsNow.length})`;
        header.style.cssText = 'padding:8px 12px 6px;color:rgba(255,255,255,0.85);font-size:11px;font-weight:700;letter-spacing:0.03em;text-transform:uppercase;';
        menu.appendChild(header);
        for (const agent of agentsNow.slice(0, 6)) {
          const row = document.createElement('div');
          row.dataset.agentRow = agent.id;
          row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;min-height:44px;border-radius:10px;background:rgba(255,255,255,0.04);margin-bottom:4px;';
          const left = document.createElement('div');
          left.style.cssText = 'display:flex;align-items:center;gap:8px;min-width:0;';
          const family = this.getAgentPresenceVariant(agent.id);
          const face = createAgentFaceElement({
            family,
            size: 18,
            title: `${agent.name} icon`,
            wrapperClassName: 'share-menu-agent-face',
            className: 'share-menu-agent-face__svg',
          });
          face.style.filter = 'drop-shadow(0 1px 1px rgba(0,0,0,0.16))';
          const dot = document.createElement('span');
          dot.style.cssText = `width:8px;height:8px;border-radius:50%;background:${agent.status === 'idle' ? '#6b7280' : '#10b981'};display:inline-block;flex-shrink:0`;
          const name = document.createElement('span');
          name.textContent = agent.name;
          name.style.cssText = 'color:#fff;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
          left.append(face, dot, name);

          const right = document.createElement('div');
          right.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0;';

          if (this.collabCanEdit) {
            const disconnect = document.createElement('button');
            disconnect.type = 'button';
            disconnect.setAttribute('aria-label', `Disconnect ${agent.name}`);
            disconnect.textContent = 'Disconnect';
            disconnect.style.cssText = `
              border:0;background:transparent;color:#fca5a5;font-size:11px;font-weight:600;
              padding:3px 0;cursor:pointer;border-radius:6px;
            `;
            disconnect.onmouseenter = () => { disconnect.style.color = '#fecaca'; };
            disconnect.onmouseleave = () => { disconnect.style.color = '#fca5a5'; };
            disconnect.onclick = async (event) => {
              event.stopPropagation();
              disconnect.disabled = true;
              disconnect.textContent = '...';
              const result = await shareClient.disconnectAgentPresence(agent.id);
              if (result && typeof result === 'object' && 'error' in result) {
                disconnect.disabled = false;
                disconnect.textContent = 'Retry';
                return;
              }
              const ok = result === true;
              if (!ok) {
                disconnect.disabled = false;
                disconnect.textContent = 'Retry';
                return;
              }
              row.remove();
              this.updateShareBannerPresenceDisplay();
              this.updateShareBannerAgentControlDisplay();
              if (!menu.querySelector('[data-agent-row]')) cleanup();
            };
            right.appendChild(disconnect);
          }

          row.append(left, right);
          menu.appendChild(row);
        }
        addDivider();
        addMenuButton('Add agent / manage keys', () => this.openAgentKeyDialog(), {
          successText: 'Opened',
        });
      }

      container.appendChild(menu);
      this.clampMenuToViewport(menu);
      const onDocMouseDown = (ev: MouseEvent) => {
        if (!(ev.target instanceof Node)) return;
        if (container.contains(ev.target)) return;
        cleanup();
      };
      const onKeyDown = (ev: KeyboardEvent) => {
        if (ev.key === 'Escape') cleanup();
      };
      const cleanup = () => {
        container.classList.remove('menu-open');
        btn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('mousedown', onDocMouseDown, true);
        document.removeEventListener('keydown', onKeyDown, true);
        if (menu.isConnected) menu.remove();
        if (this.agentMenuCleanup === cleanup) this.agentMenuCleanup = null;
      };
      this.agentMenuCleanup = cleanup;
      document.addEventListener('mousedown', onDocMouseDown, true);
      document.addEventListener('keydown', onKeyDown, true);
    };

    btn.onclick = () => {
      this.triggerHaptic('selection');
      openMenu();
    };
    container.appendChild(btn);
    return container;
  }

  private async copyTextToClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for environments where Clipboard API is unavailable.
      try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        return copied;
      } catch {
        return false;
      }
    }
  }

  private showShareBanner(viewers: number): void {
    this.clearShareBanner();
    const banner = document.createElement('div');
    banner.id = 'share-banner';
    banner.style.cssText = `
      position: fixed;
      top: 0;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(255,255,255,0.94);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      color: #374151;
      border: 1px solid rgba(0,0,0,0.06);
      border-radius: 28px;
      padding: 10px 12px 10px 22px;
      font-size: 13px;
      font-weight: 400;
      z-index: 1000;
      display: flex;
      align-items: center;
      gap: 12px;
      max-width: calc(100vw - 24px);
      box-sizing: border-box;
      box-shadow: 0 6px 24px rgba(0,0,0,0.06), 0 0 0 0.5px rgba(0,0,0,0.03);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-width: min(480px, calc(100vw - 24px));
    `;
    this.shareOtherViewerCount = Math.max(0, viewers);
    this.mountMenuBar();
    this.renderShareBannerContent(banner, this.shareOtherViewerCount);
    document.body.appendChild(banner);
    this.shareBannerResizeObserver = new ResizeObserver(() => this.scheduleBannerLayoutUpdate());
    this.shareBannerResizeObserver.observe(banner);
    this.scheduleBannerLayoutUpdate();
  }

  private clearShareBanner(): void {
    this.shareOverflowMenuCleanup?.();
    this.shareBannerResizeObserver?.disconnect();
    this.shareBannerResizeObserver = null;
    this.clearShareAgentPresenceExpiryTimer();
    this.closeShareMenu();
    this.closePresenceMenu();
    this.closeAgentMenu();
    this.closeSuggestionReviewMenu();
    this.shareBannerTitleEditing = false;
    this.shareBannerTitleEl = null;
    this.shareBannerAvatarsEl = null;
    this.shareBannerAgentSlotEl = null;
    this.shareBannerSyncDotEl = null;
    this.shareBannerSyncLabelEl = null;
    this.shareBannerSuggestBtnEl = null;
    this.shareBannerSuggestionReviewBtnEl = null;
    this.shareSuggestionReviewSignature = '';
    this.cancelShareSuggestionReviewDisplayUpdate();
    if (this.shareStatusHideTimer) {
      clearTimeout(this.shareStatusHideTimer);
      this.shareStatusHideTimer = null;
    }
    if (this.shareDocumentUpdatedTimer) {
      clearTimeout(this.shareDocumentUpdatedTimer);
      this.shareDocumentUpdatedTimer = null;
    }
    if (this.shareMarksRefreshTimer) {
      clearTimeout(this.shareMarksRefreshTimer);
      this.shareMarksRefreshTimer = null;
    }
    this.pendingShareMarksRefresh = false;
    this.unmountMenuBar();
    const existing = document.getElementById('share-banner');
    if (!existing) return;
    existing.remove();
    this.scheduleBannerLayoutUpdate();
  }

  applyExternalMarks(
    marks: Record<string, StoredMark>,
    options?: { authoritativeSnapshot?: boolean },
  ): void {
    if (!this.editor) return;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      // Use applyRemoteMarks to create ProseMirror anchors for new marks
      // (using the `quote` field) and merge metadata for existing marks.
      applyRemoteMarks(view, marks, {
        hydrateAnchors: this.collabCanEdit,
        authoritativeSnapshot: options?.authoritativeSnapshot,
      });
      this.scheduleShareSuggestionReviewDisplay(view);
    });
  }

  private applyLatestCollabMarksToEditor(): void {
    if (!this.isShareMode || !this.collabEnabled || !this.editor) return;
    if (!this.initialMarksSynced) return;
    if (this.collabCanEdit && (!this.collabIsSynced || !this.isCollabHydratedForEditing())) return;
    if (this.isEditorDocStructurallyEmpty()) return;

    this.applyingCollabRemote = true;
    this.suppressMarksSync = true;
    try {
      this.applyExternalMarks(this.lastReceivedServerMarks, { authoritativeSnapshot: true });
      this.shareMarksAnchored = this.collabCanEdit;
    } finally {
      this.suppressMarksSync = false;
      this.applyingCollabRemote = false;
    }
  }

  private resetProjectionPublishState(): void {
    this.hasCompletedInitialCollabHydration = !this.isShareMode || !this.collabEnabled;
    this.hasLocalContentEditSinceHydration = false;
    this.lastContentChangeSource = null;
    this.pendingProjectionPublish = false;
  }

  private recordContentChangeSource(source: 'local' | 'remote' | 'system'): void {
    if (!this.isShareMode || !this.collabEnabled) return;
    this.lastContentChangeSource = source;
    if (!this.hasCompletedInitialCollabHydration) return;
    if (source === 'remote') {
      this.hasLocalContentEditSinceHydration = false;
      this.pendingProjectionPublish = false;
      return;
    }
    if (source !== 'local') return;
    this.hasLocalContentEditSinceHydration = true;
  }

  private markInitialCollabHydrationComplete(): void {
    this.hasCompletedInitialCollabHydration = true;
    // onMarks can arrive before the PM fragment. Hydration completion must retry anchors.
    this.applyLatestCollabMarksToEditor();
  }

  private shouldPublishProjectionMarkdown(
    source: 'content-sync' | 'direct-content' | 'marks-change' | 'marks-flush',
  ): boolean {
    if (!this.collabEnabled || !this.collabCanEdit) return false;
    if (this.isShareMode) return false;
    if (!this.hasCompletedInitialCollabHydration) return false;
    if (source === 'marks-change' || source === 'marks-flush') return false;
    if (source === 'content-sync' && this.lastContentChangeSource !== 'local') return false;
    return this.hasLocalContentEditSinceHydration;
  }

  private canPublishProjectionMarkdownNow(): boolean {
    if (!this.collabEnabled || !this.collabCanEdit) return false;
    if (!this.isShareMode) return true;
    return this.collabConnectionStatus === 'connected'
      && this.collabIsSynced
      && this.collabUnsyncedChanges === 0;
  }

  private publishProjectionMarkdown(
    view: import('@milkdown/kit/prose/view').EditorView,
    markdown: string,
    source: 'content-sync' | 'direct-content' | 'marks-change' | 'marks-flush',
  ): void {
    if (!this.shouldPublishProjectionMarkdown(source)) return;
    if (!this.canPublishProjectionMarkdownNow()) {
      this.pendingProjectionPublish = true;
      return;
    }
    collabClient.setProjectionMarkdown(this.normalizeMarkdownForCollab(markdown));
    this.pendingProjectionPublish = false;
  }

  private flushPendingProjectionMarkdown(): void {
    if (!this.pendingProjectionPublish || !this.editor || !this.canPublishProjectionMarkdownNow()) return;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const serializer = ctx.get(serializerCtx);
      const markdown = this.normalizeMarkdownForRuntime(serializer(view.state.doc));
      if (!markdown) return;
      this.lastMarkdown = markdown;
      collabClient.setProjectionMarkdown(this.normalizeMarkdownForCollab(markdown));
      this.pendingProjectionPublish = false;
    });
  }

  private flushShareMarks(_options?: { keepalive?: boolean; persistContent?: boolean }): void {
    if (!this.isShareMode || !this.editor || this.suppressMarksSync) return;
    if (!this.initialMarksSynced) return;
    if (this.collabEnabled && !this.shareMarksAnchored) {
      this.applyLatestCollabMarksToEditor();
      if (!this.shareMarksAnchored) return;
    }
    this.editor.action((ctx) => {
      try {
        const view = ctx.get(editorViewCtx);
        const localMetadata = getMarkMetadataWithQuotes(view.state);
        const metadata = mergePendingServerMarks(localMetadata, this.lastReceivedServerMarks);
        this.lastReceivedServerMarks = { ...metadata };
        this.initialMarksSynced = true;
        const serializer = ctx.get(serializerCtx);
        const markdown = this.normalizeMarkdownForRuntime(serializer(view.state.doc));
        const shouldPersistContent = shouldKeepalivePersistShareContent({
          keepalive: Boolean(_options?.keepalive),
          persistContent: _options?.persistContent,
          collabEnabled: this.collabEnabled,
          collabCanEdit: this.collabCanEdit,
          hasCompletedInitialCollabHydration: this.hasCompletedInitialCollabHydration,
          hasLocalContentEditSinceHydration: this.hasLocalContentEditSinceHydration,
          collabConnectionStatus: this.collabConnectionStatus,
          collabIsSynced: this.collabIsSynced,
          collabUnsyncedChanges: this.collabUnsyncedChanges,
          collabPendingLocalUpdates: this.collabPendingLocalUpdates,
          markdown,
        });
        const shouldPersistMarks = shouldKeepalivePersistShareMarks({
          keepalive: Boolean(_options?.keepalive),
          collabEnabled: this.collabEnabled,
          collabCanEdit: this.collabCanEdit,
          hasCompletedInitialCollabHydration: this.hasCompletedInitialCollabHydration,
          hasLocalContentEditSinceHydration: this.hasLocalContentEditSinceHydration,
          collabUnsyncedChanges: this.collabUnsyncedChanges,
          collabPendingLocalUpdates: this.collabPendingLocalUpdates,
        });
        if (this.collabEnabled && this.collabCanEdit) {
          this.publishProjectionMarkdown(view, markdown, 'marks-flush');
          collabClient.setMarksMetadata(metadata);
        }
        if (shouldPersistContent) {
          const allowLocalKeepaliveBaseToken = shouldUseLocalKeepaliveBaseToken({
            keepalive: Boolean(_options?.keepalive),
            collabEnabled: this.collabEnabled,
            collabCanEdit: this.collabCanEdit,
            hasCompletedInitialCollabHydration: this.hasCompletedInitialCollabHydration,
            collabIsSynced: this.collabIsSynced,
            collabUnsyncedChanges: this.collabUnsyncedChanges,
            collabPendingLocalUpdates: this.collabPendingLocalUpdates,
          });
          void shareClient.pushUpdate(markdown, metadata, getCurrentActor(), {
            keepalive: Boolean(_options?.keepalive),
            allowLocalKeepaliveBaseToken,
          });
          return;
        }
        if (!shouldPersistMarks) {
          return;
        }
        if (!this.collabEnabled || !this.collabCanEdit || LEGACY_REST_FALLBACK) {
          void shareClient.pushMarks(metadata, getCurrentActor(), { keepalive: Boolean(_options?.keepalive) });
        }
      } catch (error) {
        console.error('[flushShareMarks] Failed to push marks via collab runtime:', error);
      }
    });
  }

  private showReadOnlyBanner(): void {
    if (this.readOnlyBanner) return;

    const banner = document.createElement('div');
    banner.id = 'readonly-banner';
    banner.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      background: #f59e0b;
      color: white;
      padding: 8px 16px;
      text-align: center;
      font-size: 14px;
      font-weight: 500;
      z-index: 1000;
    `;
    banner.textContent = 'Read-only mode — changes will not be saved';
    document.body.appendChild(banner);

    this.readOnlyBanner = banner;
    this.updateEditableState();
    this.scheduleBannerLayoutUpdate();
  }

  private scheduleBannerLayoutUpdate(): void {
    requestAnimationFrame(() => this.updateBannerLayout());
  }

  private applyTopChromeForMode(): void {
    const toolbar = document.getElementById('toolbar');
    if (toolbar) {
      if (this.isShareMode) {
        toolbar.style.display = 'none';
        toolbar.setAttribute('aria-hidden', 'true');
      } else {
        toolbar.style.display = '';
        toolbar.removeAttribute('aria-hidden');
      }
    }

    if (this.isShareMode) {
      document.documentElement.style.background = '#fff';
      document.body.style.background = '#fff';
    }
  }

  private updateBannerLayout(): void {
    const editor = document.getElementById('editor');
    if (!editor) return;
    // Direct Editing: toolbar label changes must not reflow the document mid-keystroke. Mike, 2026-09-19.
    if (isWriting()) return;

    const banners: HTMLElement[] = [];
    const shareBanner = document.getElementById('share-banner');
    if (shareBanner) banners.push(shareBanner);
    if (this.readOnlyBanner) banners.push(this.readOnlyBanner);
    if (this.reviewLockBanner) banners.push(this.reviewLockBanner);

    if (banners.length === 0) {
      editor.style.paddingTop = '';
      return;
    }

    // Top bar (Mike, 2026-09-21: "excess whitespace above and below the buttons"): the bar sits
    // close to the top edge, and the text starts just below it. On phones the bar is pinned to the
    // top edge by CSS (top: 0), so the space it takes is counted from 0.
    const phone = window.matchMedia?.('(max-width: 700px)').matches ?? window.innerWidth <= 700;
    // Accord layout stage 2: on desktop the toolbar sits right under the 28 px menu bar.
    const menuBarShown = Boolean(this.menuBar?.el.isConnected) && !phone;
    let offset = shareBanner ? (phone ? 0 : (menuBarShown ? MENU_BAR_POLICY.heightPx : TOP_BAR_LAYOUT.desktopTopPx)) : 0;
    for (const banner of banners) {
      banner.style.top = `${offset}px`;
      const height = banner.offsetHeight || banner.getBoundingClientRect().height;
      offset += height;
    }

    const extraSpacing = phone ? TOP_BAR_LAYOUT.textGapPhonePx : TOP_BAR_LAYOUT.textGapDesktopPx;
    editor.style.paddingTop = `${Math.ceil(offset + extraSpacing)}px`;
  }

  private updateEditableState(viewOverride?: EditorView): void {
    const isEditable = !this.isReadOnly
      && this.reviewLockCount === 0
      && (!this.isShareMode || (this.shareAllowLocalEdits && (EDIT_SESSION_POLICY.liveProposals || isWriting())));

    const applyEditableState = (view: EditorView) => {
      view.setProps({
        editable: () => isEditable,
      });
    };

    if (viewOverride) {
      applyEditableState(viewOverride);
      return;
    }

    if (!this.editor) return;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      applyEditableState(view);
    });
  }

  private ensureReviewLockBanner(): void {
    if (!this.reviewLockBanner) {
      const banner = document.createElement('div');
      banner.id = 'review-lock-banner';
      banner.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        background: #2563eb;
        color: white;
        padding: 8px 16px;
        text-align: center;
        font-size: 14px;
        font-weight: 600;
        z-index: 1000;
      `;
      document.body.appendChild(banner);
      this.reviewLockBanner = banner;
    }

    this.updateReviewLockBannerText();
    this.scheduleBannerLayoutUpdate();
  }

  private updateReviewLockBannerText(): void {
    if (!this.reviewLockBanner) return;
    const suffix = this.reviewLockReason ? ` — ${this.reviewLockReason}` : '';
    this.reviewLockBanner.textContent = `Review running — editing is temporarily locked${suffix}`;
  }

  private removeReviewLockBanner(): void {
    if (!this.reviewLockBanner) return;
    this.reviewLockBanner.remove();
    this.reviewLockBanner = null;
    this.scheduleBannerLayoutUpdate();
  }

  private getReviewLockState(): { locked: boolean; lockCount: number; reason?: string } {
    return {
      locked: this.reviewLockCount > 0,
      lockCount: this.reviewLockCount,
      reason: this.reviewLockReason ?? undefined,
    };
  }

  private showErrorBanner(
    message: string,
    options?: { retryLabel?: string; onRetry?: () => void },
  ): void {
    this.clearErrorBanner();
    const banner = document.createElement('div');
    banner.id = 'error-banner';
    banner.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      background: #ef4444;
      color: white;
      padding: 8px 16px;
      text-align: center;
      font-size: 14px;
      font-weight: 500;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      flex-wrap: wrap;
    `;
    const text = document.createElement('span');
    text.textContent = `Error: ${message}`;
    banner.appendChild(text);

    if (options?.onRetry) {
      const retryButton = document.createElement('button');
      retryButton.type = 'button';
      retryButton.textContent = options.retryLabel ?? 'Retry';
      retryButton.style.cssText = `
        border: 1px solid rgba(255,255,255,0.45);
        background: rgba(255,255,255,0.12);
        color: white;
        border-radius: 999px;
        padding: 3px 10px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      `;
      retryButton.onclick = () => options.onRetry?.();
      banner.appendChild(retryButton);
    }

    document.body.prepend(banner);
    this.scheduleBannerLayoutUpdate();
  }

  private clearErrorBanner(): void {
    const banner = document.getElementById('error-banner');
    if (!banner) return;
    banner.remove();
    this.scheduleBannerLayoutUpdate();
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
    if (error && typeof error === 'object') {
      const maybeMessage = (error as { message?: unknown }).message;
      if (typeof maybeMessage === 'string' && maybeMessage.trim().length > 0) {
        return maybeMessage.trim();
      }
    }
    return 'Load failed';
  }

  private isShareRequestError(value: unknown): value is {
    error: { status: number; code: string; message: string };
  } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const payload = value as { error?: unknown };
    if (!payload.error || typeof payload.error !== 'object' || Array.isArray(payload.error)) return false;
    const err = payload.error as { status?: unknown; code?: unknown; message?: unknown };
    return typeof err.status === 'number'
      && typeof err.code === 'string'
      && typeof err.message === 'string';
  }

  private shouldRetryShareInitError(error: unknown): boolean {
    const message = this.getErrorMessage(error).toLowerCase();
    if (message.includes('not found') || message.includes('unshared')) return false;
    if (message.includes('upgrade required')) return false;
    return (
      message.includes('load failed')
      || message.includes('failed to fetch')
      || message.includes('network')
      || message.includes('timed out')
      || message.includes('live collaboration is currently unavailable')
    );
  }

  private resetShareInitRetryState(): void {
    this.shareInitRetryCount = 0;
    if (this.shareInitRetryTimer) {
      clearTimeout(this.shareInitRetryTimer);
      this.shareInitRetryTimer = null;
    }
  }

  private setupCursorTracking(): void {
    if (!this.editor) return;

    let cursorTimeout: ReturnType<typeof setTimeout> | null = null;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const dom = view.dom;

      const reportCursor = () => {
        if (cursorTimeout) clearTimeout(cursorTimeout);
        cursorTimeout = setTimeout(() => {
          void view.state.selection.from;
        }, 50);
      };

      const reportKeyboardActivity = (event: KeyboardEvent) => {
        // Ignore modifier-only key events; they aren't meaningful typing activity.
        if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') {
          reportCursor();
          return;
        }
        this.reportEditorInputActivity('keyboard');
        reportCursor();
      };

      const reportInputActivity = () => {
        this.reportEditorInputActivity('input');
      };

      dom.addEventListener('keyup', reportKeyboardActivity);
      dom.addEventListener('beforeinput', reportInputActivity);
      dom.addEventListener('paste', reportInputActivity);
      dom.addEventListener('drop', reportInputActivity);
      dom.addEventListener('compositionend', reportInputActivity);
      dom.addEventListener('mouseup', reportCursor);
    });
  }

  private reportEditorInputActivity(source: 'keyboard' | 'input'): void {
    const now = Date.now();
    this.lastLocalTypingAt = now;
    if (now - this.lastEditorInputActivitySentAt < 500) return;
    this.lastEditorInputActivitySentAt = now;
    void source;
  }

  private noteLocalContentMutation(): void {
    this.lastLocalTypingAt = Date.now();
  }

  private isYjsChangeOriginTransaction(transaction: any): boolean {
    const ySyncMeta = transaction?.getMeta?.(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
    if (ySyncMeta?.isChangeOrigin === true) return true;

    const rawMeta = (transaction as { meta?: Record<string, unknown> } | null)?.meta;
    if (!rawMeta || typeof rawMeta !== 'object') return false;

    for (const [key, value] of Object.entries(rawMeta)) {
      if (!key.startsWith('y-sync')) continue;
      if (value === true) return true;
      if (value && typeof value === 'object' && (value as { isChangeOrigin?: boolean }).isChangeOrigin === true) {
        return true;
      }
    }
    return false;
  }

  /**
   * Set up the suggestions interceptor to convert edits to tracked changes
   * when suggestion mode is enabled.
   */
  private refuseHiddenInput(event: Event, inputType: string): boolean {
    if (!this.folding?.inputTouchesHidden({ inputType, target: event.target } as InputEvent)) return false;
    event.preventDefault();
    this.readingWalk?.showEditNotice('That would change hidden text. Show it first.');
    return true;
  }

  private setupSuggestionsInterceptor(): void {
    if (!this.editor) return;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);

      // Direct props run before Milkdown's native history/collab keymaps.
      // The document listener also covers Edit-menu events outside the editor.
      view.setProps({
        handleKeyDown: (_view, event) => {
          if (this.playmakerReview?.handleHistoryInput(event)) return true;
          if (['Backspace', 'Delete'].includes(event.key) && this.folding?.inputTouchesHidden({
            inputType: event.key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward', target: event.target,
          } as InputEvent)) {
            event.preventDefault(); this.readingWalk?.showEditNotice('That would change hidden text. Show it first.'); return true;
          }
          return this.folding?.arrow(event) ?? false;
        },
        handleDOMEvents: {
          ...view.props.handleDOMEvents,
          // A click puts the caret in the DOM at once, but ProseMirror reads it only when the
          // selectionchange event arrives, a task later. An update in that window (a remote cursor,
          // a decoration refresh) or ProseMirror's own focus check 20 ms after focus writes the old
          // selection back, and the typing lands where the caret was before (the caret check typed
          // into the title; 2026-09-24). Read the click's selection as soon as the click ends.
          mouseup: (upView) => { readPointerSelectionSoon(upView); return false; },
          click: (clickView) => { readPointerSelectionSoon(clickView); return false; },
          paste: (_view, event) => this.refuseHiddenInput(event, 'insertFromPaste'),
          cut: (_view, event) => this.refuseHiddenInput(event, 'deleteByCut'),
          drop: (inputView, event) => {
            const at = inputView.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY });
            if (at && this.folding?.positionHidden(at.pos)) {
              event.preventDefault(); this.readingWalk?.showEditNotice('That would change hidden text. Show it first.'); return true;
            }
            return this.refuseHiddenInput(event, 'insertFromDrop');
          },
          beforeinput: (inputView, event) => {
            if (this.playmakerReview?.handleHistoryInput(event as InputEvent)) return true;
            if (this.folding?.inputTouchesHidden(event as InputEvent)) {
              event.preventDefault();
              this.readingWalk?.showEditNotice('That would change hidden text. Show it first.');
              return true;
            }
            return commitLiveTextInput(inputView, event as InputEvent, this.isSuggestionsEnabled());
          },
        },
      });

      view.dom.addEventListener(liveSuggestionInputEvent, ((event: CustomEvent<LiveSuggestionInput>) => {
        const detail = event.detail;
        if (!view.editable || !this.shareAllowLocalEdits || !this.isSuggestionsEnabled()) return;
        const mark = getMarks(view.state).find(m => m.id === detail.id);
        const stored = getMarkMetadataWithQuotes(view.state)[detail.id];
        if (!mark?.range || !stored || (stored.status ?? 'pending') !== 'pending' || stored.content !== detail.before) {
          this.readingWalk?.showEditNotice('This proposal changed. Read its current words before editing.');
          return;
        }
        try {
          if (!detail.content && EDIT_SESSION_POLICY.deleteProposalRejects) {
            this.performReviewDecision([detail.id], 'reject');
            detail.handled = true;
          } else if (mark.by === getCurrentActor()) {
            this.noteLocalContentMutation();
            this.getReviewDecisionHistory().edit(() => {
              detail.handled = modifySuggestionContent(markApiView(view), detail.id, detail.content);
            });
          } else if (!EDIT_SESSION_POLICY.editOtherProposalsInPlace) {
            // P2 transfer is off: preserve the author's proposal and create the editor's
            // competing replacement, just as typing a replacement on the old anchor does.
            this.noteLocalContentMutation();
            this.getReviewDecisionHistory().edit(() => {
              const proposal = suggestReplace(markApiView(view), mark.quote, getCurrentActor(), detail.content, mark.range);
              detail.handled = Boolean(proposal);
              detail.nextId = proposal?.id;
            });
          }
        } catch (error) {
          this.readingWalk?.showEditNotice(error instanceof Error ? error.message : 'Could not edit this proposal.');
        }
      }) as EventListener);

      this.typedDiscussions?.stop();
      this.typedDiscussions = new TypedDiscussionController(view, {
        enabled: () => view.editable && this.shareAllowLocalEdits && this.collabCanEdit && this.isSuggestionsEnabled(),
        candidates: () => this.chat?.allCandidates(true) ?? [],
        convert: run => this.convertTypedDiscussion(run),
        notice: message => this.readingWalk?.showEditNotice(message),
      });

      // Store the original dispatchTransaction
      const dispatchOriginal = view.dispatch.bind(view);
      const originalDispatch = (transaction: Transaction) => {
        this.folding?.mapTransaction(transaction);
        dispatchOriginal(transaction);
      };

      // Override dispatchTransaction to intercept edits
      (view as any).dispatch = (tr: any) => {
        keepUndoGroupOpen(tr);
        // Yjs restores text and records atomically. Supply the restored records
        // on that same PM update, before normalization can invent mark metadata.
        if (this.restoringReviewDecision || (tr.docChanged && tr.getMeta(ySyncPluginKey)?.isChangeOrigin && !tr.getMeta(marksPluginKey))) {
          tr.setMeta(marksPluginKey, {
            type: 'SET_METADATA',
            metadata: collabClient.getYDoc()?.getMap('marks').toJSON() ?? this.lastReceivedServerMarks,
          });
        }
        const dispatchWithRevision = (transaction: any) => {
          if (userEdit) transaction.setMeta(FOLD_USER_EDIT, true);
          // Group local text and derived records in the native history transaction.
          // All derived mark writes from this dispatch stay in that same edit.
          const humanMark = isOwnHumanMarkChange(transaction,
            marksPluginKey.getState(view.state)?.metadata ?? {},
            transaction.getMeta(marksPluginKey)?.metadata ?? {}, getCurrentActor());
          if (transaction.getMeta('proofLocalMarkChange') && !humanMark) transaction.setMeta('addToHistory', false);
          const clickDecisions = transaction.getMeta(clickEditDecisionsMeta) as string[] | undefined;
          if (clickDecisions?.length && !this.capturingReviewDecision && !this.restoringReviewDecision
            && this.collabCanEdit && this.getShareSuggestionResolutionTransport() === 'collab') {
            this.getReviewDecisionHistory().decide(() => {
              originalDispatch(transaction);
              const metadata = getMarkMetadataWithQuotes(view.state);
              this.lastReceivedServerMarks = { ...metadata };
              this.initialMarksSynced = true;
              collabClient.setMarksMetadata(metadata);
            });
            clickDecisions.forEach(id => this.reviewDecisionIds.add(id));
            this.recordDecisionUndo(clickDecisions, 'reject');
          } else if (humanMark && !this.capturingReviewDecision
            && !this.restoringReviewDecision && !this.isYjsChangeOriginTransaction(transaction)
            && this.collabCanEdit && collabClient.getYDoc()
            && this.getShareSuggestionResolutionTransport() === 'collab') {
            // Proof's popover uses the same mark functions as the review dialog.
            // Capture its text and records atomically, with the same refusal guards.
            const history = this.getReviewDecisionHistory();
            Object.keys(getMarkMetadataWithQuotes(view.state)).forEach(id => this.reviewDecisionIds.add(id));
            history.decide(() => {
              originalDispatch(transaction);
              const metadata = getMarkMetadataWithQuotes(view.state);
              this.lastReceivedServerMarks = { ...metadata };
              this.initialMarksSynced = true;
              collabClient.setMarksMetadata(metadata);
            });
          } else if (isLocalContentChange && !this.capturingReviewDecision && !tr.getMeta('history$') && tr.getMeta('addToHistory') !== false
            && this.collabCanEdit && collabClient.getYDoc()
            && this.getShareSuggestionResolutionTransport() === 'collab') {
            this.getReviewDecisionHistory().edit(() => originalDispatch(transaction));
          } else originalDispatch(transaction);
          if (transaction?.docChanged) {
            this.revision += 1;
          }
        };
        const isRemoteContentChange = Boolean(tr?.docChanged) && this.isYjsChangeOriginTransaction(tr);
        const marksMeta = tr?.getMeta?.(marksPluginKey);
        const markActionMeta = tr?.getMeta?.(proofMarkActionMeta);
        const isMarksOnlyChange = marksMeta !== undefined;
        const isDocumentLoad = tr?.getMeta?.('document-load') !== undefined;
        const isLocalContentChange = Boolean(tr?.docChanged)
          && !isRemoteContentChange
          && !isMarksOnlyChange
          && markActionMeta === undefined
          && !isDocumentLoad;

        const userEdit = isLocalContentChange && tr.getMeta('history$') === undefined
          && tr.getMeta('addToHistory') !== false && !this.capturingReviewDecision && !this.restoringReviewDecision;
        if (userEdit && this.folding?.refuses(tr)) {
          this.readingWalk?.showEditNotice('That would change hidden text. Show it first.');
          return;
        }

        // Check if suggestions are enabled
        const pluginState = suggestionsPluginKey.getState(view.state);
        const suggestionsEnabled = pluginState?.enabled ?? false;

        if (isRemoteContentChange) {
          this.recordContentChangeSource('remote');
        } else if (isLocalContentChange) {
          this.noteLocalContentMutation();
          this.recordContentChangeSource('local');
        } else if (tr?.docChanged) {
          this.recordContentChangeSource('system');
        }

        if (suggestionsEnabled && tr.docChanged) {
          // Don't intercept meta transactions (like enabling/disabling suggestions)
          if (tr.getMeta(suggestionsPluginKey) !== undefined) {
            dispatchWithRevision(tr);
          } else if (marksMeta !== undefined || markActionMeta !== undefined) {
            // Don't intercept marks operations (accept/reject suggestions)
            // These are internal operations that should not be converted to suggestions
            dispatchWithRevision(tr);
          } else if (tr.getMeta('document-load') !== undefined) {
            // Don't intercept document load transactions
            dispatchWithRevision(tr);
          } else if (this.isYjsChangeOriginTransaction(tr)) {
            // Don't intercept Yjs-origin collaborative transactions.
            originalDispatch(tr);
          } else if (tr.getMeta('history$') !== undefined || tr.getMeta('addToHistory') === false) {
            // Don't intercept undo/redo transactions (from history plugin)
            dispatchWithRevision(tr);
          } else {
            // Wrap the transaction to convert edits to suggestions
            const wrappedTr = wrapTransactionForSuggestions(tr, view.state, true);
            // Follow only a replacement this keystroke created: compare the document's marks
            // before and after (one source), and require the typist as its author. A replacement
            // restored by someone else's Undo is in the text before its record reaches this page,
            // and it must not take the caret.
            const beforeIds = new Set(getMarks(view.state).map(m => m.id));
            dispatchWithRevision(wrappedTr);
            const me = getCurrentActor();
            const replacement = getMarks(view.state).find(m => m.kind === 'replace' && !beforeIds.has(m.id) && m.by === me);
            if (replacement) focusLiveSuggestion(view, replacement.id);

          }
        } else {
          dispatchWithRevision(tr);
        }

        if (shouldUpdateShareSuggestionReviewDisplay({
          docChanged: Boolean(tr?.docChanged),
          marksMeta,
        })) {
          this.scheduleShareSuggestionReviewDisplay(view);
        }
        this.typedDiscussions?.update(userEdit);
      };

      // Caret stability (2026-09-19): a change the person did not make keeps their line in place.
      const interceptedDispatch = (view as any).dispatch as (tr: any) => void;
      (view as any).dispatch = (tr: any) => anchorCaretAround(view, tr, next => {
        interceptedDispatch(next);
      });

      console.log('[setupSuggestionsInterceptor] Suggestions interceptor installed');
    });
  }

  private posToLineCol(doc: import('@milkdown/kit/prose/model').Node, pos: number): { line: number; col: number } {
    let line = 0;
    let col = pos;

    doc.nodesBetween(0, pos, (node, nodePos) => {
      if (node.isBlock && nodePos < pos) {
        line++;
        col = pos - nodePos - 1;
      }
      return true;
    });

    return { line: Math.max(0, line - 1), col };
  }

  private scheduleContentSync(): void {
    if (!this.editor) return;
    if (this.contentSyncTimeout) {
      clearTimeout(this.contentSyncTimeout);
    }

    this.contentSyncTimeout = setTimeout(() => {
      this.editor?.action((innerCtx) => {
        const view = innerCtx.get(editorViewCtx);
        let markdown: string | null = null;

        try {
          const serializer = innerCtx.get(serializerCtx);
          markdown = this.normalizeMarkdownForRuntime(serializer(view.state.doc));
        } catch (error) {
          const details = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
          console.error('[scheduleContentSync] Failed to serialize document', details);
        }

        if (!markdown || markdown === this.lastMarkdown) return;

        try {
          this.lastMarkdown = markdown;
          this.sendDocumentSnapshot(view, markdown);
          if (this.collabEnabled && this.collabCanEdit && this.shouldPublishProjectionMarkdown('content-sync')) {
            this.publishProjectionMarkdown(view, markdown, 'content-sync');
            const metadata = getMarkMetadataWithQuotes(view.state);
            collabClient.setMarksMetadata(metadata);
          }
          getTriggerService().updateDocumentContent(
            view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
          );
        } catch (error) {
          const details = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
          console.error('[scheduleContentSync] Failed to send document snapshot', details);
        }
      });
    }, 150);
  }

  /**
   * Initialize the agent integration for @proof mentions.
   * This sets up the agent with the API key and wires it to the editor.
   */
  private initAgentIntegration(): void {
    if (!this.editor) return;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);

      // Initialize agent with the editor view
      initAgentIntegration(view);

      // Set up the keybindings callback to show the input dialog
      setShowAgentInputCallback((context, callbacks) => {
        showAgentInputDialog(context, callbacks);
      });

      // Initialize context menu with right-click support
      const cleanupContextMenu = initContextMenu(view);

      // Listen for agent invocation events from keybindings and context menu
      const handleAgentInvocation = (event: CustomEvent<{
        prompt: string;
        context: AgentInputContext;
        showDialog?: boolean;
      }>) => {
        const { prompt, context, showDialog } = event.detail;
        captureEvent('agent_ui_invoked', {
          show_dialog: Boolean(showDialog),
          prompt_chars: prompt?.length ?? 0,
          has_selection: Boolean(context.selection?.trim()),
        });

        if (showDialog) {
          // Show dialog first
          showAgentInputDialog(context, {
            onSubmit: async (userPrompt: string) => {
              this.invokeAgentOnSelection(view, userPrompt, context);
            },
            onCancel: () => {},
          });
        } else if (prompt) {
          // Direct invocation with prompt
          this.invokeAgentOnSelection(view, prompt, context);
        }
      };

      window.addEventListener('proof:invoke-agent', handleAgentInvocation as EventListener);

      console.log('[Editor] Agent integration initialized with keybindings and context menu');
    });
  }

  /**
   * Invoke the agent on a selection with the given prompt
   */
  private invokeAgentOnSelection(
    view: import('@milkdown/kit/prose/view').EditorView,
    prompt: string,
    context: AgentInputContext
  ): void {
    console.log('[Editor] Invoking agent on selection:', { prompt, context });

    // Import and use the agent session manager (will be created in Phase 1)
    // For now, create a comment with the request for @proof to handle
    const selectedText = context.selection;
    const actor = getCurrentActor();
    captureEvent('agent_manual_request', {
      prompt_chars: prompt.length,
      has_selection: Boolean(selectedText.trim()),
    });

    if (selectedText.trim()) {
      // Create a comment with @proof mention to trigger the agent
      markComment(view, selectedText, actor, `@proof ${prompt}`, context.range);
      captureEvent('agent_manual_request_queued', {
        trigger_type: 'comment',
      });
    } else {
      // No selection - just log for now
      console.log('[Editor] No selection for agent invocation');
      captureEvent('agent_manual_request_dropped', { reason: 'empty_selection' });
    }
  }

  private handleContentChange(markdown: string): void {
    if (!this.editor) return;

    const canonicalMarkdown = this.normalizeMarkdownForRuntime(markdown);
    this.lastMarkdown = canonicalMarkdown;
    this.recordContentChangeSource('local');
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      this.sendDocumentSnapshot(view, canonicalMarkdown);
      if (this.shouldPublishProjectionMarkdown('direct-content')) {
        this.publishProjectionMarkdown(view, canonicalMarkdown, 'direct-content');
        const metadata = getMarkMetadataWithQuotes(view.state);
        collabClient.setMarksMetadata(metadata);
      }
      getTriggerService().updateDocumentContent(
        view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
      );
    });
  }

  private handleMarksChange(
    actionMarks: Mark[],
    view: import('@milkdown/kit/prose/view').EditorView,
    actionMetadata?: Record<string, StoredMark>
  ): void {
    if (this.suppressMarksSync) return;
    // Authored-only edits can trigger marks callbacks with no actionable marks.
    // Skipping avoids pushing stale markdown snapshots during fast typing.
    // Resolving the final live suggestion is also an empty actionable-marks
    // snapshot, and that deletion must reach the collaborative Yjs marks map.
    if (actionMarks.length === 0 && this.liveCollabSuggestionResolutionDepth === 0) return;

    let markdown = this.serializeMarkdown(view);
    if (!markdown) {
      markdown = this.lastMarkdown;
    }
    if (!markdown) return;

    this.lastMarkdown = markdown;
    this.sendDocumentSnapshot(view, markdown, actionMarks);

    const metadata = mergePendingServerMarks(
      actionMetadata ?? getMarkMetadataWithQuotes(view.state),
      this.lastReceivedServerMarks,
    );
    this.lastReceivedServerMarks = { ...metadata };
    this.initialMarksSynced = true;

    if (this.collabEnabled && this.collabCanEdit) {
      collabClient.setMarksMetadata(metadata);
    }

    // In share mode, push marks-only updates immediately for reliability.
    if (this.isShareMode) {
      this.flushShareMarks();
    }

    // Pass marks changes to agent integration for @proof detection
    agentHandleMarksChange(actionMarks, view);
  }

  private serializeMarkdown(view: import('@milkdown/kit/prose/view').EditorView): string | null {
    if (!this.editor) return null;
    try {
      const serializer = this.editor.ctx.get(serializerCtx);
      return this.normalizeMarkdownForRuntime(serializer(view.state.doc));
    } catch (error) {
      const details = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
      console.error('[serializeMarkdown] Failed to serialize document', details);
      return null;
    }
  }

  private normalizeMarkdownForRuntime(markdown: string): string {
    // Shared/collab runtime treats authored highlights as derived UI state.
    // Keep suggestion/comment proof spans intact while removing authored wrappers.
    if (this.isShareMode || this.collabEnabled) {
      return stripAuthoredSpanTags(markdown);
    }
    return markdown;
  }

  private normalizeMarkdownForCollab(markdown: string): string {
    // Collab transport stays span-free to prevent span reparse drift/duplication.
    // Marks are carried separately in metadata.
    return stripProofSpanTags(this.normalizeMarkdownForRuntime(markdown));
  }

  private sendDocumentSnapshot(
    view: import('@milkdown/kit/prose/view').EditorView,
    markdown: string,
    actionMarksOverride?: Mark[]
  ): void {
    const metadata = getMarkMetadataForDisk(view.state);
    const contentWithMarks = embedMarks(markdown, metadata);
    if (this.isCliMode) {
      fileClient.debouncedSave(contentWithMarks);
    }
    void actionMarksOverride;
  }

  private emitDocumentSnapshotNow(): void {
    if (!this.editor) return;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      let markdown: string | null = null;
      try {
        const serializer = ctx.get(serializerCtx);
        markdown = serializer(view.state.doc);
      } catch (error) {
        const details = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ''}` : String(error);
        console.error('[emitDocumentSnapshotNow] Failed to serialize document', details);
        return;
      }

      if (!markdown) return;
      const canonicalMarkdown = this.normalizeMarkdownForRuntime(markdown);
      this.lastMarkdown = canonicalMarkdown;
      this.sendDocumentSnapshot(view, canonicalMarkdown);
    });
  }

  /**
   * Load a document and apply embedded marks metadata.
   */
  loadDocument(content: string, options?: { allowShareContentMutation?: boolean }): void {
    if (!this.editor) {
      console.error('[loadDocument] Editor not initialized');
      return;
    }

    const { content: provenanceStripped, provenance } = extractEmbeddedProvenance(content);
    const { content: cleanContent, marks: embeddedMetadata, legacyMarks = [] } = extractMarks(provenanceStripped);

    if (!this.hasTrackedDocumentOpened) {
      this.hasTrackedDocumentOpened = true;
      captureEvent('document_opened', {
        content_chars: cleanContent.length,
        embedded_marks_count: Object.keys(embeddedMetadata).length,
        legacy_marks_count: legacyMarks.length,
        has_provenance: Boolean(provenance),
      });
    }

    this.lastMarkdown = cleanContent;
    this.suppressMarksSync = true;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);

      const buildLegacyMetadata = (mark: Mark): StoredMark => {
        const base: StoredMark = {
          kind: mark.kind,
          by: mark.by,
          createdAt: mark.at,
        };
        if (mark.range) {
          base.range = { from: mark.range.from, to: mark.range.to };
        }

        if (mark.kind === 'comment') {
          const data = mark.data as CommentData | undefined;
          base.text = data?.text ?? '';
          base.threadId = data?.thread ?? mark.id;
          base.thread = data?.replies ?? [];
          base.resolved = Boolean(data?.resolved);
        } else if (mark.kind === 'insert') {
          const data = mark.data as { content?: string; status?: 'pending' | 'accepted' | 'rejected' } | undefined;
          base.content = data?.content ?? '';
          base.status = data?.status ?? 'pending';
        } else if (mark.kind === 'delete') {
          const data = mark.data as { status?: 'pending' | 'accepted' | 'rejected' } | undefined;
          base.status = data?.status ?? 'pending';
        } else if (mark.kind === 'replace') {
          const data = mark.data as { content?: string; status?: 'pending' | 'accepted' | 'rejected' } | undefined;
          base.content = data?.content ?? '';
          base.status = data?.status ?? 'pending';
        } else if (mark.kind === 'flagged') {
          base.note = (mark.data as { note?: string } | undefined)?.note;
        }

        return base;
      };

      const applyLegacyMarks = (
        legacy: Mark[],
        baseMetadata: Record<string, StoredMark>
      ): Record<string, StoredMark> => {
        if (!legacy.length) return baseMetadata;

        const metadata = { ...baseMetadata };
        const commentThreads = new Map<string, Mark[]>();
        const suggestionMarkType = view.state.schema.marks.proofSuggestion;
        const commentMarkType = view.state.schema.marks.proofComment;
        const flaggedMarkType = view.state.schema.marks.proofFlagged;
        const approvedMarkType = view.state.schema.marks.proofApproved;
        const authoredMarkType = view.state.schema.marks.proofAuthored;

        let markTr = view.state.tr;

        for (const mark of legacy) {
          if (mark.kind === 'comment') {
            const data = mark.data as CommentData | undefined;
            const threadId = data?.thread ?? mark.id;
            const thread = commentThreads.get(threadId) ?? [];
            thread.push(mark);
            commentThreads.set(threadId, thread);
            continue;
          }

          if (!mark.range) continue;

          if (mark.kind === 'authored' && authoredMarkType) {
            markTr = markTr.addMark(mark.range.from, mark.range.to, authoredMarkType.create({ by: mark.by }));
            continue;
          }

          if (mark.kind === 'insert' || mark.kind === 'delete' || mark.kind === 'replace') {
            if (!suggestionMarkType) continue;
            markTr = markTr.addMark(mark.range.from, mark.range.to, suggestionMarkType.create({
              id: mark.id,
              kind: mark.kind,
              by: mark.by,
            }));
            metadata[mark.id] = buildLegacyMetadata(mark);
            continue;
          }

          if (mark.kind === 'flagged' && flaggedMarkType) {
            markTr = markTr.addMark(mark.range.from, mark.range.to, flaggedMarkType.create({ id: mark.id, by: mark.by }));
            metadata[mark.id] = buildLegacyMetadata(mark);
            continue;
          }

          if (mark.kind === 'approved' && approvedMarkType) {
            markTr = markTr.addMark(mark.range.from, mark.range.to, approvedMarkType.create({ id: mark.id, by: mark.by }));
            metadata[mark.id] = buildLegacyMetadata(mark);
            continue;
          }
        }

        for (const [threadId, threadMarks] of commentThreads.entries()) {
          const sorted = [...threadMarks].sort((a, b) => a.at.localeCompare(b.at));
          const anchor = sorted.find(entry => entry.range) ?? sorted[0];
          if (!anchor || !anchor.range || !commentMarkType) continue;

          markTr = markTr.addMark(anchor.range.from, anchor.range.to, commentMarkType.create({ id: anchor.id, by: anchor.by }));

          const replies = sorted.filter(entry => entry.id !== anchor.id).map(entry => ({
            by: entry.by,
            text: (entry.data as CommentData | undefined)?.text ?? '',
            at: entry.at,
          }));

          metadata[anchor.id] = {
            ...buildLegacyMetadata(anchor),
            threadId,
            thread: replies,
            resolved: Boolean((anchor.data as CommentData | undefined)?.resolved),
          };
        }

        if (markTr.steps.length > 0) {
          view.dispatch(markTr);
        }

        return metadata;
      };

      // Parse the markdown content into a ProseMirror document
      const newDoc = parser(cleanContent);

      // Replace the entire document (mark as document-load to skip human authorship tracking)
      let tr = view.state.tr
        .replaceWith(0, view.state.doc.content.size, newDoc.content)
        .setMeta('document-load', true);
      if (options?.allowShareContentMutation) {
        tr = tr.setMeta(SHARE_CONTENT_FILTER_ALLOW_META, true);
      }
      view.dispatch(tr);

      const authoredMarkType = view.state.schema.marks.proofAuthored;
      let hasAuthoredMarks = false;
      if (authoredMarkType) {
        newDoc.descendants((node) => {
          if (!node.isText) return true;
          if (node.marks.some(mark => mark.type === authoredMarkType)) {
            hasAuthoredMarks = true;
            return false;
          }
          return true;
        });
      }

      let markMetadata = embeddedMetadata;
      let combinedLegacyMarks = legacyMarks ?? [];
      if (provenance?.spans?.length && !hasAuthoredMarks) {
        combinedLegacyMarks = combinedLegacyMarks.concat(
          migrateProvenanceToMarks({ spans: provenance.spans }, cleanContent)
        );
      }

      if (combinedLegacyMarks.length > 0) {
        markMetadata = applyLegacyMarks(combinedLegacyMarks, markMetadata);
      }
      setMarkMetadata(view, markMetadata);

      // Trigger heatmap refresh
      const heatmapTr = view.state.tr.setMeta('heatmapUpdate', true);
      view.dispatch(heatmapTr);

    });
    this.suppressMarksSync = false;
  }

  getContent(): string {
    const root = document.getElementById('editor');
    return root?.textContent || '';
  }

  looksLikeMarkdown(content: string): boolean {
    return looksLikeMarkdownSyntax(content);
  }

  getMarkdownSnapshot(): { content: string } | null {
    if (!this.editor) return null;

    let snapshot: { content: string } | null = null;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      let markdown: string | null = null;

      try {
        const serializer = ctx.get(serializerCtx);
        markdown = serializer(view.state.doc);
      } catch (error) {
        const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.error('[getMarkdownSnapshot] Failed to serialize document', details);
        return;
      }

      if (!markdown) return;

      const metadata = getMarkMetadataForDisk(view.state);
      const contentWithMarks = embedMarks(markdown, metadata);

      this.lastMarkdown = markdown;
      snapshot = {
        content: contentWithMarks,
      };
    });

    return snapshot;
  }

  /**
   * Get the full editor state including cursor, selection, scroll position, and structure.
   * This is the main method for AI agents to understand the current document state.
   */
  getFullState(): EditorFullState | null {
    if (!this.editor) return null;

    let result: EditorFullState | null = null;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;
      const { from, to } = view.state.selection;

      // Plain-text projection for stable offsets and mapping logic.
      const plainText = doc.textBetween(0, doc.content.size, '\n', '\n');

      // Also capture markdown for safe round-tripping in tooling workflows.
      let markdownContent: string | undefined;
      try {
        const serializer = ctx.get(serializerCtx);
        const markdown = serializer(doc);
        if (markdown) {
          const metadata = getMarkMetadata(view.state);
          markdownContent = embedMarks(markdown, metadata);
          markdownContent = stripAuthoredSpanTags(markdownContent);
          this.lastMarkdown = markdown;
        }
      } catch (error) {
        const details = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        console.error('[getFullState] Failed to serialize markdown snapshot', details);
      }

      // Calculate cursor position
      const cursorOffset = from;
      const { line: cursorLine, col: cursorCol } = this.offsetToLineCol(doc, from);

      // Get selection info
      let selection: EditorFullState['selection'] = null;
      if (from !== to) {
        const selectedText = getTextForRange(doc, { from, to });
        const { line: fromLine } = this.offsetToLineCol(doc, from);
        const { line: toLine } = this.offsetToLineCol(doc, to);
        selection = {
          hasSelection: true,
          from,
          to,
          text: selectedText,
          fromLine,
          toLine,
        };
      }

      // Get scroll/visibility info
      const scroll = this.getVisibleRange(view);

      // Get document structure
      const structure = this.extractStructure(doc);

      const authorshipStats = getAuthorshipStats(view);

      const safeMarkdown = markdownContent ?? plainText;
      result = {
        content: safeMarkdown,
        plainText,
        markdownContent: safeMarkdown,
        revision: this.revision,
        cursor: {
          line: cursorLine,
          column: cursorCol,
          offset: cursorOffset,
        },
        selection,
        focusHeading: null,
        scroll,
        activeMark: null,
        structure,
        authorshipStats,
      };

      if (structure.sections.length > 0) {
        const focusSection = structure.sections
          .filter(section => section.line <= cursorLine)
          .sort((a, b) => a.line - b.line)
          .pop();
        result.focusHeading = focusSection?.heading ?? null;
      }

      const activeMarkId = getActiveMarkId(view.state);
      if (activeMarkId) {
        const marks = getMarks(view.state);
        const active = marks.find(mark => mark.id === activeMarkId);
        if (active) {
          const [resolved] = resolveMarks(doc, [active]);
          const activeMark: EditorFullState['activeMark'] = {
            id: active.id,
            kind: active.kind,
            by: active.by,
            at: active.at,
            quote: active.quote,
            range: active.range ?? null,
            resolvedRange: resolved?.resolvedRange ?? null,
            data: (active.data as Record<string, unknown> | undefined) ?? null,
          };

          if (active.kind === 'comment') {
            const commentData = active.data as CommentData | undefined;
            const threadId = commentData?.thread;
            if (threadId) {
              const thread = getThread(marks, threadId).map(entry => {
                const entryData = entry.data as CommentData | undefined;
                return {
                  id: entry.id,
                  by: entry.by,
                  at: entry.at,
                  text: entryData?.text,
                  resolved: entryData?.resolved,
                };
              });
              activeMark.thread = thread;
            }
          }

          result.activeMark = activeMark;
        }
      }
    });

    return result;
  }

  /**
   * Convert document offset to line and column
   */
  private offsetToLineCol(doc: import('@milkdown/kit/prose/model').Node, offset: number): { line: number; col: number } {
    let line = 0;
    let lastBlockStart = 0;

    doc.nodesBetween(0, Math.min(offset, doc.content.size), (node, pos) => {
      if (node.isBlock && pos < offset) {
        line++;
        lastBlockStart = pos + 1;
      }
      return true;
    });

    return {
      line: Math.max(0, line),
      col: offset - lastBlockStart,
    };
  }

  /**
   * Get the visible range of the document based on scroll position
   */
  private getVisibleRange(view: import('@milkdown/kit/prose/view').EditorView): EditorFullState['scroll'] {
    const editorRect = view.dom.getBoundingClientRect();
    const doc = view.state.doc;

    // Find first visible line
    let visibleFromLine = 0;
    let visibleToLine = 0;
    const visibleHeadings: string[] = [];

    let currentLine = 0;
    doc.descendants((node, pos) => {
      if (node.isBlock) {
        try {
          const coords = view.coordsAtPos(pos);
          if (coords) {
            // Check if this block is in the visible viewport
            if (coords.top >= editorRect.top && coords.top <= editorRect.bottom) {
              if (visibleFromLine === 0) {
                visibleFromLine = currentLine;
              }
              visibleToLine = currentLine;

              // Check if it's a heading
              if (node.type.name.startsWith('heading') || node.type.name === 'heading') {
                visibleHeadings.push(node.textContent);
              }
            }
          }
        } catch {
          // Ignore coordinate errors
        }
        currentLine++;
      }
      return true;
    });

    return {
      visibleFromLine,
      visibleToLine,
      visibleHeadings,
    };
  }

  /**
   * Extract document structure (headings and sections)
   */
  private extractStructure(doc: import('@milkdown/kit/prose/model').Node): EditorFullState['structure'] {
    const sections: EditorFullState['structure']['sections'] = [];
    let currentLine = 0;
    let totalWords = 0;

    doc.descendants((node, _pos) => {
      if (node.isBlock) {
        const text = node.textContent;
        const words = text.split(/\s+/).filter(w => w.length > 0).length;
        totalWords += words;

        // Check if heading
        if (node.type.name === 'heading') {
          const level = node.attrs.level || 1;
          sections.push({
            heading: text,
            level,
            line: currentLine,
            wordCount: words,
          });
        }
        currentLine++;
      }
      return true;
    });

    return { sections, totalWords };
  }

  // =====================
  // Editor Operations
  // =====================

  /**
   * Insert text at a specific offset position
   * @param offset - Position to insert at
   * @param text - Text to insert
   * @param author - Optional author (e.g., 'ai:claude' or 'human:dan'). If provided, creates an authored mark.
   */
  insertAt(offset: number, text: string, author?: string): void {
    if (!this.editor) {
      console.warn('[insertAt] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      const docSizeBefore = view.state.doc.content.size;
      const clampedOffset = Math.max(0, Math.min(offset, docSizeBefore));

      // Parse the text as markdown and insert
      const newContent = parser(text);
      let tr = view.state.tr.insert(clampedOffset, newContent.content);

      // Mark as AI-authored if author is specified (prevents double-marking by human tracker)
      if (author) {
        tr = tr.setMeta('ai-authored', true);
      }
      view.dispatch(tr);

      // Calculate actual inserted length by comparing doc sizes
      const docSizeAfter = view.state.doc.content.size;
      const actualInsertedLength = docSizeAfter - docSizeBefore;

      // Create authored mark for the inserted content if author is specified
      if (author && actualInsertedLength > 0) {
        const range: MarkRange = { from: clampedOffset, to: clampedOffset + actualInsertedLength };
        addAuthoredMark(view, author, range, text);
        console.log('[insertAt] Created authored mark for', author, 'at range', range, 'actualLength:', actualInsertedLength);

      }

      console.log('[insertAt] Inserted text at offset:', clampedOffset, 'actualLength:', actualInsertedLength);
    });
  }

  /**
   * Insert text at the current cursor position
   * @param text - Text to insert
   * @param author - Optional author (e.g., 'ai:claude' or 'human:dan'). If provided, creates an authored mark.
   */
  insertAtCursor(text: string, author?: string): void {
    if (!this.editor) {
      console.warn('[insertAtCursor] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      const { from } = view.state.selection;
      const docSizeBefore = view.state.doc.content.size;

      // Parse the text as markdown and insert
      const newContent = parser(text);
      let tr = view.state.tr.insert(from, newContent.content);

      // Mark as AI-authored if author is specified (prevents double-marking by human tracker)
      if (author) {
        tr = tr.setMeta('ai-authored', true);
      }
      view.dispatch(tr);

      // Calculate actual inserted length by comparing doc sizes
      const docSizeAfter = view.state.doc.content.size;
      const actualInsertedLength = docSizeAfter - docSizeBefore;

      // Create authored mark for the inserted content if author is specified
      if (author && actualInsertedLength > 0) {
        const range: MarkRange = { from, to: from + actualInsertedLength };
        addAuthoredMark(view, author, range, text);
        console.log('[insertAtCursor] Created authored mark for', author, 'at range', range, 'actualLength:', actualInsertedLength);

      }

      console.log('[insertAtCursor] Inserted text at cursor:', from, 'actualLength:', actualInsertedLength);
    });
  }

  /**
   * Replace the current selection with new text
   * @param text - Replacement text
   * @param author - Optional author (e.g., 'ai:claude' or 'human:dan'). If provided, creates an authored mark.
   */
  replaceSelection(text: string, author?: string): void {
    if (!this.editor) {
      console.warn('[replaceSelection] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      const { from, to } = view.state.selection;
      const docSizeBefore = view.state.doc.content.size;
      const selectionLength = to - from;

      // Parse the text as markdown and replace
      const newContent = parser(text);
      let tr = view.state.tr.replaceWith(from, to, newContent.content);

      // Mark as AI-authored if author is specified (prevents double-marking by human tracker)
      if (author) {
        tr = tr.setMeta('ai-authored', true);
      }
      view.dispatch(tr);

      // Calculate actual inserted length by comparing doc sizes
      // Net change = newLength - selectionLength, so newLength = netChange + selectionLength
      const docSizeAfter = view.state.doc.content.size;
      const actualInsertedLength = (docSizeAfter - docSizeBefore) + selectionLength;

      // Create authored mark for the replacement content if author is specified
      if (author && actualInsertedLength > 0) {
        const range: MarkRange = { from, to: from + actualInsertedLength };
        addAuthoredMark(view, author, range, text);
        console.log('[replaceSelection] Created authored mark for', author, 'at range', range, 'actualLength:', actualInsertedLength);

      }

      console.log('[replaceSelection] Replaced selection from', from, 'to', to, 'actualLength:', actualInsertedLength);
    });
  }

  /**
   * Replace text in a specific range
   * @param from - Start position
   * @param to - End position
   * @param text - Replacement text
   * @param author - Optional author (e.g., 'ai:claude' or 'human:dan'). If provided, creates an authored mark.
   */
  replaceRange(from: number, to: number, text: string, author?: string): void {
    if (!this.editor) {
      console.warn('[replaceRange] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      const docSizeBefore = view.state.doc.content.size;
      const clampedFrom = Math.max(0, Math.min(from, docSizeBefore));
      const clampedTo = Math.max(0, Math.min(to, docSizeBefore));
      const rangeLength = clampedTo - clampedFrom;

      // Parse the text as markdown and replace
      const newContent = parser(text);
      let tr = view.state.tr.replaceWith(clampedFrom, clampedTo, newContent.content);

      // Mark as AI-authored if author is specified (prevents double-marking by human tracker)
      if (author) {
        tr = tr.setMeta('ai-authored', true);
      }
      view.dispatch(tr);

      // Calculate actual inserted length by comparing doc sizes
      // Net change = newLength - rangeLength, so newLength = netChange + rangeLength
      const docSizeAfter = view.state.doc.content.size;
      const actualInsertedLength = (docSizeAfter - docSizeBefore) + rangeLength;

      // Create authored mark for the replacement content if author is specified
      if (author && actualInsertedLength > 0) {
        const range: MarkRange = { from: clampedFrom, to: clampedFrom + actualInsertedLength };
        addAuthoredMark(view, author, range, text);
        console.log('[replaceRange] Created authored mark for', author, 'at range', range, 'actualLength:', actualInsertedLength);

      }

      console.log('[replaceRange] Replaced range from', clampedFrom, 'to', clampedTo, 'actualLength:', actualInsertedLength);
    });
  }

  setHeatMapMode(mode: string): void {
    const validModes = ['hidden', 'subtle', 'background', 'full'] as const;
    if (!validModes.includes(mode as typeof validModes[number])) return;

    this.heatMapMode = mode as typeof validModes[number];

    if (this.editor) {
      this.editor.action((ctx) => {
        ctx.set(heatmapCtx.key, { mode: this.heatMapMode });

        const view = ctx.get(editorViewCtx);
        const tr = view.state.tr.setMeta('heatmapUpdate', true);
        view.dispatch(tr);
      });
    }
  }

  setTheme(theme: string): void {
    const themePicker = getThemePicker();
    if (themePicker) {
      themePicker.setTheme(theme as 'default' | 'whitey');
    }

    if (this.editor) {
      this.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        const tr = view.state.tr.setMeta('heatmapUpdate', true);
        view.dispatch(tr);
      });
    }

    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'));
    });
  }

  setCurrentActor(actor: string): void {
    const normalized = setCurrentActorValue(actor);
    console.log('[setCurrentActor] Current actor set to', normalized);
  }

  scrollToLine(line: number): void {
    console.log('[scrollToLine] Called with line:', line);
    if (!this.editor) {
      console.log('[scrollToLine] No editor');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      let currentLine = 0;
      let targetPos = 0;
      let found = false;

      // Find the position at the start of the target line
      view.state.doc.descendants((node, pos) => {
        if (node.isBlock) {
          if (currentLine === line) {
            targetPos = pos;
            found = true;
            return false; // Stop traversal
          }
          currentLine++;
        }
        return true;
      });

      console.log('[scrollToLine] Found:', found, 'targetPos:', targetPos, 'totalBlocks:', currentLine);

      if (!found) {
        console.log('[scrollToLine] Line not found');
        return;
      }

      // Get DOM element at position and scroll into view
      try {
        const domResult = view.domAtPos(targetPos);
        let el = domResult.node;

        // Find block element
        while (el && !(el instanceof HTMLElement && el.tagName.match(/^(P|H[1-6]|LI|PRE|BLOCKQUOTE)$/i))) {
          el = el.parentNode as Node;
        }

        if (el instanceof HTMLElement && !isEditing()) {
          console.log('[scrollToLine] Scrolling to element:', el.tagName);
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } catch (e) {
        console.error('[scrollToLine] Error:', e);
      }
    });
  }

  scrollToOffset(offset: number): void {
    console.log('[scrollToOffset] Called with offset:', offset);
    if (!this.editor) {
      console.log('[scrollToOffset] No editor');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);

      // Clamp offset to valid range
      const clampedOffset = Math.max(0, Math.min(offset, view.state.doc.content.size));

      try {
        const domResult = view.domAtPos(clampedOffset);
        let el = domResult.node;

        // Find block element
        while (el && !(el instanceof HTMLElement && el.tagName.match(/^(P|H[1-6]|LI|PRE|BLOCKQUOTE|DIV)$/i))) {
          el = el.parentNode as Node;
        }

        if (el instanceof HTMLElement && !isEditing()) {
          console.log('[scrollToOffset] Scrolling to element:', el.tagName);
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } catch (e) {
        console.error('[scrollToOffset] Error:', e);
      }
    });
  }

  navigateToAgent(sessionId: string): void {
    navigateToAgentInEditor(sessionId);
  }

  followAgent(sessionId: string): void {
    followAgentInEditor(sessionId);
  }

  unfollowAgent(showToast: boolean = false): void {
    unfollowAgentInEditor(showToast);
  }

  getFollowedAgent(): string | null {
    return getFollowedAgentInEditor();
  }

  isFollowingAgent(sessionId?: string): boolean {
    const followed = getFollowedAgentInEditor();
    if (!followed) return false;
    if (!sessionId) return true;
    return followed === sessionId;
  }

  // =====================
  // Agent Cursor Methods
  // =====================

  /**
   * Set the agent cursor to a specific position in the document.
   * The cursor is visible to the user and animates when it moves.
   */
  setAgentCursor(position: number, animateOrActor?: boolean | string, actor?: string): void {
    if (!this.editor) {
      console.warn('[setAgentCursor] Editor not initialized');
      return;
    }

    const resolvedActor = typeof animateOrActor === 'string' ? animateOrActor : actor;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      setAgentCursor(view, position, resolvedActor);
      console.log('[setAgentCursor] Set agent cursor to position:', position);
    });
  }

  /**
   * Set the agent selection range.
   * The selection is visible to the user as a highlighted region.
   */
  setAgentSelection(from: number, to: number, animateOrActor?: boolean | string, actor?: string): void {
    if (!this.editor) {
      console.warn('[setAgentSelection] Editor not initialized');
      return;
    }

    const resolvedActor = typeof animateOrActor === 'string' ? animateOrActor : actor;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      setAgentSelection(view, from, to, resolvedActor);
      console.log('[setAgentSelection] Set agent selection from', from, 'to', to);
    });
  }

  /**
   * Clear the agent cursor and selection.
   */
  clearAgentCursor(): void {
    if (!this.editor) {
      console.warn('[clearAgentCursor] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      clearAgentCursor(view);
      console.log('[clearAgentCursor] Cleared agent cursor');
    });
  }

  /**
   * Get the current agent cursor state.
   */
  getAgentCursorState(): { cursorPos: number | null; selectionFrom: number | null; selectionTo: number | null } | null {
    if (!this.editor) {
      console.warn('[getAgentCursorState] Editor not initialized');
      return null;
    }

    let result: { cursorPos: number | null; selectionFrom: number | null; selectionTo: number | null } | null = null;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const state = getAgentCursorState(view);
      if (state) {
        result = {
          cursorPos: state.cursorPos,
          selectionFrom: state.selectionFrom,
          selectionTo: state.selectionTo,
        };
      }
    });

    return result;
  }

  // =====================
  // Batch Operations
  // =====================

  /**
   * Execute multiple operations atomically in a single transaction.
   *
   * Operations are executed sequentially and share context:
   * - 'select' stores a selection that subsequent operations can use
   * - 'goto' moves the agent cursor (visible to user)
   * - 'replace' uses the stored selection or resolves its own selector
   *
   * If any operation fails, the entire batch is rolled back.
   */
  executeBatch(operations: BatchOperation[]): BatchResult {
    if (!this.editor) {
      console.warn('[executeBatch] Editor not initialized');
      return { success: false, error: 'Editor not initialized', results: [] };
    }

    let result: BatchResult = { success: false, error: 'Unknown error', results: [] };

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      result = executeBatchImpl(view, parser, operations);

      // Trigger heatmap refresh if document changed
      if (result.success) {
        const heatmapTr = view.state.tr.setMeta('heatmapUpdate', true);
        view.dispatch(heatmapTr);
      }
    });

    console.log('[executeBatch] Result:', result);
    return result;
  }

  // =====================
  // Suggestions (Track Changes)
  // =====================

  /**
   * Enable suggestion mode (track changes)
   */
  enableSuggestions(): void {
    if (!this.editor) {
      console.warn('[enableSuggestions] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      enableSuggestions(view);
      console.log('[enableSuggestions] Suggestions enabled');
    });
  }

  /**
   * Disable suggestion mode
   */
  disableSuggestions(): void {
    if (!this.editor) {
      console.warn('[disableSuggestions] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      disableSuggestions(view);
      console.log('[disableSuggestions] Suggestions disabled');
    });
  }

  /**
   * Toggle suggestion mode
   */
  toggleSuggestions(): boolean {
    if (!this.editor) {
      console.warn('[toggleSuggestions] Editor not initialized');
      return false;
    }

    let enabled = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      enabled = toggleSuggestions(view);
      console.log('[toggleSuggestions] Suggestions:', enabled ? 'enabled' : 'disabled');
    });
    return enabled;
  }

  /**
   * Check if suggestions are enabled
   */
  isSuggestionsEnabled(): boolean {
    if (!this.editor) return false;

    let enabled = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      enabled = isSuggestionsEnabled(view.state);
    });
    return enabled;
  }

  /**
   * Get all pending suggestions
   */
  getSuggestions(): Mark[] {
    if (!this.editor) return [];

    let suggestions: Mark[] = [];
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      suggestions = getPendingSuggestions(getMarks(view.state));
    });
    return suggestions;
  }

  /**
   * Accept a suggestion by ID
   */
  acceptSuggestion(id: string): boolean {
    return this.markAccept(String(id));
  }

  /**
   * Reject a suggestion by ID
   */
  rejectSuggestion(id: string): boolean {
    return this.markReject(String(id));
  }

  /**
   * Accept all pending suggestions
   */
  acceptAllSuggestions(): number {
    return this.markAcceptAll();
  }

  /**
   * Reject all pending suggestions
   */
  rejectAllSuggestions(): number {
    return this.markRejectAll();
  }

  /**
   * Open the inline comment composer for the current selection.
   */
  beginAddComment(by: string): boolean {
    if (!this.editor) {
      console.warn('[beginAddComment] Editor not initialized');
      return false;
    }

    let opened = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const range = this.getSelectionRangeOrBlock(view);
      if (!range) return;
      openCommentComposer(view, range, normalizeActor(by));
      opened = true;
    });

    return opened;
  }

  // =====================
  // Unified Marks API (new system)
  // =====================

  /**
   * Get all marks in the document
   */
  getAllMarks(): Mark[] {
    if (!this.editor) return [];

    let marks: Mark[] = [];
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      marks = getMarks(view.state);
    });
    return marks;
  }

  /**
   * Debug helper: validate that stored mark ranges still match their quotes.
   */
  validateMarkAnchors(): {
    totalMarks: number;
    checkedMarks: number;
    mismatches: Array<{
      id: string;
      kind: string;
      by: string;
      range: MarkRange;
      quoteSnippet: string;
      actualSnippet: string;
    }>;
  } {
    if (!this.editor) {
      return { totalMarks: 0, checkedMarks: 0, mismatches: [] };
    }

    let result: {
      totalMarks: number;
      checkedMarks: number;
      mismatches: Array<{
        id: string;
        kind: string;
        by: string;
        range: MarkRange;
        quoteSnippet: string;
        actualSnippet: string;
      }>;
    } = { totalMarks: 0, checkedMarks: 0, mismatches: [] };

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const marks = getMarks(view.state);
      const mismatches: Array<{
        id: string;
        kind: string;
        by: string;
        range: MarkRange;
        quoteSnippet: string;
        actualSnippet: string;
      }> = [];

      let checkedMarks = 0;
      for (const mark of marks) {
        if (!mark.range) continue;
        checkedMarks += 1;
        const actual = getTextForRange(view.state.doc, mark.range);
        const expectedNormalized = normalizeQuote(mark.quote ?? '');
        const actualNormalized = normalizeQuote(actual);
        if (expectedNormalized && actualNormalized !== expectedNormalized) {
          mismatches.push({
            id: mark.id,
            kind: mark.kind,
            by: mark.by,
            range: mark.range,
            quoteSnippet: expectedNormalized.slice(0, 120),
            actualSnippet: actualNormalized.slice(0, 120),
          });
        }
      }

      result = {
        totalMarks: marks.length,
        checkedMarks,
        mismatches,
      };
    });

    return result;
  }

  /**
   * Get marks filtered by kind
   */
  getMarksByKind(kind: MarkKind): Mark[] {
    if (!this.editor) return [];

    let marks: Mark[] = [];
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const allMarks = getMarks(view.state);
      marks = getMarksByKind(allMarks, kind);
    });
    return marks;
  }

  /**
   * Get pending suggestions (insert, delete, replace with status=pending)
   */
  getPendingMarkSuggestions(): Mark[] {
    if (!this.editor) return [];

    let marks: Mark[] = [];
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const allMarks = getMarks(view.state);
      marks = getPendingSuggestions(allMarks);
    });
    return marks;
  }

  /**
   * Get IDs of pending suggestions (for state snapshots)
   */
  getPendingMarkIds(): string[] {
    return this.getPendingMarkSuggestions().map(m => m.id);
  }

  /**
   * Get unresolved comments (marks-based)
   */
  getUnresolvedMarkComments(): Mark[] {
    if (!this.editor) return [];

    let marks: Mark[] = [];
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const allMarks = getMarks(view.state);
      marks = getUnresolvedMarkComments(allMarks);
    });
    return marks;
  }

  /**
   * Find a mark by ID
   */
  findMarkById(id: string): Mark | undefined {
    if (!this.editor) return undefined;

    let mark: Mark | undefined;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const allMarks = getMarks(view.state);
      mark = findMark(allMarks, id);
    });
    return mark;
  }

  /**
   * Get visual layout information for agent-native testing.
   * Returns pixel positions of marks, popovers, and detects overlaps.
   */
  getVisualLayout(): VisualLayoutInfo {
    const result: VisualLayoutInfo = {
      viewport: { width: 0, height: 0, scrollTop: 0, scrollLeft: 0 },
      marks: [],
      popovers: [],
      overlaps: [],
      gutterAlignments: []
    };

    if (!this.editor) return result;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const editorDom = view.dom;

      // Viewport info
      result.viewport = {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollTop: window.scrollY || document.documentElement.scrollTop,
        scrollLeft: window.scrollX || document.documentElement.scrollLeft
      };

      // Get all marks with their positions
      const allMarks = getMarks(view.state);

      for (const mark of allMarks) {
        const markInfo: VisualLayoutInfo['marks'][0] = {
          id: mark.id,
          kind: mark.kind,
          textBounds: null,
          gutterBounds: null
        };

        // Get text bounds from the mark's range
        if (mark.range && mark.range.from !== undefined && mark.range.to !== undefined) {
          try {
            const startCoords = view.coordsAtPos(mark.range.from);
            const endCoords = view.coordsAtPos(mark.range.to);
            if (startCoords && endCoords) {
              markInfo.textBounds = {
                top: Math.min(startCoords.top, endCoords.top),
                left: startCoords.left,
                width: Math.abs(endCoords.right - startCoords.left),
                height: Math.abs(endCoords.bottom - startCoords.top)
              };
            }
          } catch {
            // Position may be invalid
          }
        }

        // Find gutter element for this mark
        const gutterEl = document.querySelector(`[data-mark-id="${mark.id}"]`);
        if (gutterEl) {
          const rect = gutterEl.getBoundingClientRect();
          markInfo.gutterBounds = {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height
          };
        }

        result.marks.push(markInfo);

        // Check gutter alignment
        if (markInfo.textBounds && markInfo.gutterBounds) {
          const textMidY = markInfo.textBounds.top + markInfo.textBounds.height / 2;
          const gutterMidY = markInfo.gutterBounds.top + markInfo.gutterBounds.height / 2;
          const delta = Math.abs(textMidY - gutterMidY);
          result.gutterAlignments.push({
            markId: mark.id,
            textMidY,
            gutterMidY,
            delta,
            aligned: delta < 20 // Within 20px is considered aligned
          });
        }
      }

      // Find popovers
      const popovers = document.querySelectorAll('[data-popover-mark-id]');
      popovers.forEach((popover) => {
        const markId = popover.getAttribute('data-popover-mark-id');
        if (markId) {
          const rect = popover.getBoundingClientRect();
          result.popovers.push({
            markId,
            bounds: {
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height
            }
          });
        }
      });

      // Also check for any visible popovers by class
      const visiblePopovers = document.querySelectorAll('.mark-popover, .suggestion-popover, .comment-popover');
      visiblePopovers.forEach((popover) => {
        const markId = popover.getAttribute('data-mark-id') || popover.getAttribute('data-popover-mark-id');
        // Only add if not already added
        if (markId && !result.popovers.find(p => p.markId === markId)) {
          const rect = popover.getBoundingClientRect();
          result.popovers.push({
            markId,
            bounds: {
              top: rect.top,
              left: rect.left,
              width: rect.width,
              height: rect.height
            }
          });
        }
      });

      // Detect overlaps between popovers and other elements
      const headings = document.querySelectorAll('h1, h2, h3, h4, h5, h6');

      for (const popover of result.popovers) {
        // Check overlap with headings
        headings.forEach((heading) => {
          const rect = heading.getBoundingClientRect();
          const overlap = this.calculateOverlap(popover.bounds, {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height
          });
          if (overlap > 0) {
            result.overlaps.push({
              element1: { type: 'popover', id: popover.markId },
              element2: { type: 'heading' },
              overlapArea: overlap
            });
          }
        });

        // Check overlap with other popovers
        for (const other of result.popovers) {
          if (other.markId !== popover.markId) {
            const overlap = this.calculateOverlap(popover.bounds, other.bounds);
            if (overlap > 0) {
              // Avoid duplicate entries
              const exists = result.overlaps.find(o =>
                (o.element1.id === popover.markId && o.element2.id === other.markId) ||
                (o.element1.id === other.markId && o.element2.id === popover.markId)
              );
              if (!exists) {
                result.overlaps.push({
                  element1: { type: 'popover', id: popover.markId },
                  element2: { type: 'popover', id: other.markId },
                  overlapArea: overlap
                });
              }
            }
          }
        }
      }
    });

    return result;
  }

  /**
   * Calculate overlap area between two rectangles
   */
  private calculateOverlap(
    r1: { top: number; left: number; width: number; height: number },
    r2: { top: number; left: number; width: number; height: number }
  ): number {
    const xOverlap = Math.max(0, Math.min(r1.left + r1.width, r2.left + r2.width) - Math.max(r1.left, r2.left));
    const yOverlap = Math.max(0, Math.min(r1.top + r1.height, r2.top + r2.height) - Math.max(r1.top, r2.top));
    return xOverlap * yOverlap;
  }

  private getSelectionRangeOrBlock(view: EditorView): MarkRange | null {
    let { from, to } = view.state.selection;
    const doc = view.state.doc;

    if (from === to) {
      const $pos = doc.resolve(from);
      from = $pos.start($pos.depth);
      to = $pos.end($pos.depth);
    }

    if (from >= to) return null;
    return { from, to };
  }

  private filterMatchesByScope(
    view: EditorView,
    matches: Array<{ from: number; to: number; match: string }>,
    scope?: FindOptions['scope']
  ): Array<{ from: number; to: number; match: string }> {
    if (!scope || scope === 'all') return matches;

    if (scope === 'selection') {
      const { from, to } = view.state.selection;
      if (from === to) return [];
      return matches.filter(match => match.from >= from && match.to <= to);
    }

    if (scope === 'visible') {
      const visible = this.getVisibleRange(view);
      return matches.filter(match => {
        const { line } = this.offsetToLineCol(view.state.doc, match.from);
        return line >= visible.visibleFromLine && line <= visible.visibleToLine;
      });
    }

    return matches;
  }

  private quoteForRange(view: EditorView, range: MarkRange): string {
    return view.state.doc.textBetween(range.from, range.to, '\n', '\n');
  }

  /**
   * Mark content as approved
   */
  markApprove(quote: string, by: string): Mark | null {
    if (!this.editor) {
      throw new Error('Editor not initialized');
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      mark = approve(view, quote, by);
      if (mark) {
        console.log('[markApprove] Created approval:', mark.id);
      } else {
        console.log('[markApprove] Removed approval for selection');
      }
    });
    return mark;
  }

  /**
   * Mark content as approved using a selector.
   */
  markApproveSelector(selector: CommentSelector, by: string): Mark | null {
    if (!this.editor) {
      console.warn('[markApproveSelector] Editor not initialized');
      return null;
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      const range = resolveSelectorRange(view.state.doc, selector);
      if (!range) {
        throw new Error('Selector did not resolve');
      }
      const quote = this.quoteForRange(view, range);
      mark = approve(view, quote, by, range);
      if (mark) {
        console.log('[markApproveSelector] Created approval:', mark.id);
      } else {
        console.log('[markApproveSelector] Removed approval for selection');
      }
    });
    return mark;
  }

  /**
   * Mark current selection (or block) as approved
   */
  markApproveSelection(by: string): Mark | null {
    if (!this.editor) {
      console.warn('[markApproveSelection] Editor not initialized');
      return null;
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      const range = this.getSelectionRangeOrBlock(view);
      if (!range) return;
      const quote = this.quoteForRange(view, range);
      mark = approve(view, quote, by, range);
      if (mark) {
        console.log('[markApproveSelection] Created approval:', mark.id);
      } else {
        console.log('[markApproveSelection] Removed approval for selection');
      }
    });
    return mark;
  }

  /**
   * Remove an approval mark
   */
  markUnapprove(quote: string, by: string): boolean {
    if (!this.editor) {
      console.warn('[markUnapprove] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      success = unapprove(view, quote, by);
      console.log('[markUnapprove] Removed approval:', success);
    });
    return success;
  }

  /**
   * Flag content for attention
   */
  markFlag(quote: string, by: string, note?: string): Mark | null {
    if (!this.editor) {
      throw new Error('Editor not initialized');
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      mark = flag(view, quote, by, note);
      if (mark) {
        console.log('[markFlag] Created flag:', mark.id);
      } else {
        console.log('[markFlag] Removed flag for selection');
      }
    });
    return mark;
  }

  /**
   * Flag content using a selector.
   */
  markFlagSelector(selector: CommentSelector, by: string, note?: string): Mark | null {
    if (!this.editor) {
      console.warn('[markFlagSelector] Editor not initialized');
      return null;
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      const range = resolveSelectorRange(view.state.doc, selector);
      if (!range) {
        throw new Error('Selector did not resolve');
      }
      const quote = this.quoteForRange(view, range);
      mark = flag(view, quote, by, note, range);
      if (mark) {
        console.log('[markFlagSelector] Created flag:', mark.id);
      } else {
        console.log('[markFlagSelector] Removed flag for selection');
      }
    });
    return mark;
  }

  /**
   * Flag current selection (or block) for attention
   */
  markFlagSelection(by: string, note?: string): Mark | null {
    if (!this.editor) {
      console.warn('[markFlagSelection] Editor not initialized');
      return null;
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      const range = this.getSelectionRangeOrBlock(view);
      if (!range) return;
      const quote = this.quoteForRange(view, range);
      mark = flag(view, quote, by, note, range);
      if (mark) {
        console.log('[markFlagSelection] Created flag:', mark.id);
      } else {
        console.log('[markFlagSelection] Removed flag for selection');
      }
    });
    return mark;
  }

  /**
   * Remove a flag mark
   */
  markUnflag(quote: string, by: string): boolean {
    if (!this.editor) {
      console.warn('[markUnflag] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      success = unflag(view, quote, by);
      console.log('[markUnflag] Removed flag:', success);
    });
    return success;
  }

  /**
   * Add a comment mark
   */
  markComment(quote: string, by: string, text: string, meta?: OrchestratedMarkMeta): Mark {
    if (!this.editor) {
      throw new Error('Editor not initialized');
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      const matches = findMatchesInDoc(view.state.doc, quote, {
        regex: false,
        caseSensitive: true,
        maxMatches: 1,
        normalizeWhitespace: true,
      });
      const range = matches[0] ? { from: matches[0].from, to: matches[0].to } : undefined;
      mark = markComment(view, quote, by, text, range, meta);
      console.log('[markComment] Created comment:', mark.id);
      captureEvent('mark_created', { mark_kind: 'comment', source: 'quote' });
    });
    return mark!;
  }

  /**
   * Add a comment mark on the current selection (or block).
   */
  markCommentSelection(by: string, text: string): Mark | null {
    if (!this.editor) {
      console.warn('[markCommentSelection] Editor not initialized');
      return null;
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      const range = this.getSelectionRangeOrBlock(view);
      if (!range) return;
      const quote = this.quoteForRange(view, range);
      mark = markComment(view, quote, by, text, range);
      console.log('[markCommentSelection] Created comment:', mark.id);
      captureEvent('mark_created', { mark_kind: 'comment', source: 'selection' });
    });
    return mark;
  }

  /**
   * Add a comment mark using a selector (range/quote/pattern/anchor).
   */
  markCommentSelector(selector: CommentSelector, by: string, text: string, meta?: OrchestratedMarkMeta): Mark | null {
    if (!this.editor) {
      console.warn('[markCommentSelector] Editor not initialized');
      return null;
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      const range = resolveSelectorRange(view.state.doc, selector);
      const quoteSource = selector.quote || (range ? view.state.doc.textBetween(range.from, range.to, '\n', '\n') : '');
      const quote = normalizeQuote(quoteSource);
      if (!quote && !range) return;
      mark = markComment(view, quote, by, text, range ?? undefined, meta);
      console.log('[markCommentSelector] Created comment:', mark.id);
      captureEvent('mark_created', { mark_kind: 'comment', source: 'selector' });
    });
    return mark;
  }

  /**
   * Reply to a comment
   */
  markReply(markId: string, by: string, text: string): Mark | null {
    if (!this.editor) {
      console.warn('[markReply] Editor not initialized');
      return null;
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      mark = markReply(view, markId, by, text);
      if (mark) {
        console.log('[markReply] Created reply:', mark.id);
      }
    });
    return mark;
  }

  /**
   * Resolve a comment thread
   */
  markResolve(markId: string): boolean {
    if (!this.editor) {
      console.warn('[markResolve] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      if (this.isShareMode) this.suppressMarksSync = true;
      try {
        success = markResolve(view, markId);
      } finally {
        if (this.isShareMode) this.suppressMarksSync = false;
      }
      console.log('[markResolve] Resolved:', success);
      if (success) {
        if (this.isShareMode) {
          const actor = getCurrentActor();
          const metadata = getMarkMetadataWithQuotes(view.state);
          this.lastReceivedServerMarks = { ...metadata };
          this.initialMarksSynced = true;

          if (this.getShareSuggestionResolutionTransport() !== 'collab') void shareClient.resolveComment(markId, actor).then((result) => {
            if (!result || 'error' in result || result.success !== true) return;
            const serverMarks = (result.marks && typeof result.marks === 'object' && !Array.isArray(result.marks))
              ? result.marks as Record<string, StoredMark>
              : null;
            if (!serverMarks) return;
            this.lastReceivedServerMarks = mergePendingServerMarks(this.lastReceivedServerMarks, serverMarks);
            this.initialMarksSynced = true;
            if (this.editor) {
              this.editor.action((innerCtx) => {
                const innerView = innerCtx.get(editorViewCtx);
                const mergedMetadata = mergePendingServerMarks(getMarkMetadataWithQuotes(innerView.state), serverMarks);
                setMarkMetadata(innerView, mergedMetadata);
              });
            }
          }).catch((error) => {
            console.error('[markResolve] Failed to resolve comment via share mutation:', error);
          });
        }
        captureEvent('mark_resolved', { mark_kind: 'comment' });
      }
    });
    return success;
  }

  /**
   * Unresolve a comment thread
   */
  markUnresolve(markId: string): boolean {
    if (!this.editor) {
      console.warn('[markUnresolve] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      if (this.isShareMode) this.suppressMarksSync = true;
      try {
        success = markUnresolve(view, markId);
      } finally {
        if (this.isShareMode) this.suppressMarksSync = false;
      }
      console.log('[markUnresolve] Unresolved:', success);
      if (success && this.isShareMode) {
        const metadata = getMarkMetadataWithQuotes(view.state);
        this.lastReceivedServerMarks = { ...metadata };
        this.initialMarksSynced = true;

        const actor = getCurrentActor();
        void shareClient.unresolveComment(markId, actor).then((result) => {
          if (!result || 'error' in result || result.success !== true) return;
          const serverMarks = (result.marks && typeof result.marks === 'object' && !Array.isArray(result.marks))
            ? result.marks as Record<string, StoredMark>
            : null;
          if (!serverMarks) return;
          this.lastReceivedServerMarks = mergePendingServerMarks(this.lastReceivedServerMarks, serverMarks);
          this.initialMarksSynced = true;
          if (this.editor) {
            this.editor.action((innerCtx) => {
              const innerView = innerCtx.get(editorViewCtx);
              const mergedMetadata = mergePendingServerMarks(getMarkMetadataWithQuotes(innerView.state), serverMarks);
              setMarkMetadata(innerView, mergedMetadata);
            });
          }
        }).catch((error) => {
          console.error('[markUnresolve] Failed to unresolve comment via share mutation:', error);
        });
      }
    });
    return success;
  }

  /**
   * Delete a comment thread by mark ID
   */
  markDeleteThread(markId: string): boolean {
    if (!this.editor) {
      console.warn('[markDeleteThread] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      success = deleteMark(view, markId);
    });
    return success;
  }

  /**
   * Suggest an insertion
   * Returns null if the quote cannot be found in the document
   */
  markSuggestInsert(quote: string, by: string, content: string, range?: MarkRange, meta?: OrchestratedMarkMeta): Mark | null {
    if (!this.editor) {
      throw new Error('Editor not initialized');
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));

      // Validate quote exists in document
      if (!range) {
        const resolved = resolveQuoteRange(view.state.doc, quote);
        if (!resolved) {
          console.warn('[markSuggestInsert] Quote not found in document:', quote);
          return;
        }
      }

      mark = suggestInsert(view, quote, by, content, range, meta);
      if (mark) {
        console.log('[markSuggestInsert] Created suggestion:', mark.id);
        captureEvent('mark_created', { mark_kind: 'insert' });
      } else {
        console.warn('[markSuggestInsert] Suggestion was rejected by safety checks.');
      }
    });
    return mark;
  }

  /**
   * Suggest a deletion
   * Returns null if the quote cannot be found in the document
   */
  markSuggestDelete(quote: string, by: string, range?: MarkRange, meta?: OrchestratedMarkMeta): Mark | null {
    if (!this.editor) {
      throw new Error('Editor not initialized');
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));

      // Validate quote exists in document
      if (!range) {
        const resolved = resolveQuoteRange(view.state.doc, quote);
        if (!resolved) {
          console.warn('[markSuggestDelete] Quote not found in document:', quote);
          return;
        }
      }

      mark = suggestDelete(view, quote, by, range, meta);
      if (mark) {
        console.log('[markSuggestDelete] Created suggestion:', mark.id);
        captureEvent('mark_created', { mark_kind: 'delete' });
      } else {
        console.warn('[markSuggestDelete] Suggestion was rejected by safety checks.');
      }
    });
    return mark;
  }

  /**
   * Suggest a replacement
   * Returns null if the quote cannot be found in the document
   */
  markSuggestReplace(quote: string, by: string, content: string, range?: MarkRange, meta?: OrchestratedMarkMeta): Mark | null {
    if (!this.editor) {
      throw new Error('Editor not initialized');
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      const parser = ctx.get(parserCtx);

      // Validate quote exists in document
      if (!range) {
        const resolved = resolveQuoteRange(view.state.doc, quote);
        if (!resolved) {
          console.warn('[markSuggestReplace] Quote not found in document:', quote);
          return;
        }
      }

      mark = suggestReplace(view, quote, by, content, range, meta, parser);
      if (mark) {
        console.log('[markSuggestReplace] Created suggestion:', mark.id);
        captureEvent('mark_created', { mark_kind: 'replace' });
      } else {
        console.warn('[markSuggestReplace] Suggestion was rejected by safety checks.');
      }
    });
    return mark;
  }

  /**
   * Find and suggest replacements across the document.
   */
  markSuggestEdit(
    find: string,
    replace: string,
    by: string,
    options?: FindOptions
  ): { success: boolean; count: number; marks?: Mark[]; error?: string } {
    if (!this.editor) {
      return { success: false, count: 0, error: 'Editor not initialized' };
    }

    let result: { success: boolean; count: number; marks?: Mark[]; error?: string } = {
      success: false,
      count: 0,
    };

    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      const parser = ctx.get(parserCtx);
      const scope = options?.scope ?? 'all';
      if (scope === 'selection' && view.state.selection.from === view.state.selection.to) {
        result = { success: false, count: 0, error: 'No selection' };
        return;
      }

      const matches = findMatchesInDoc(view.state.doc, find, options);
      const scopedMatches = this.filterMatchesByScope(view, matches, scope);
      if (scopedMatches.length === 0) {
        result = { success: false, count: 0, error: 'No matches' };
        return;
      }

      const marks: Mark[] = [];
      for (const match of scopedMatches) {
        const mark = suggestReplace(
          view,
          match.match,
          by,
          replace,
          { from: match.from, to: match.to },
          undefined,
          parser
        );
        if (mark) {
          marks.push(mark);
        } else {
          console.warn('[markSuggestEdit] Skipped unsafe replacement for match:', match.match);
        }
      }

      if (marks.length === 0) {
        result = { success: false, count: 0, error: 'No safe matches' };
        return;
      }

      captureEvent('mark_created', {
        mark_kind: 'replace',
        source: 'bulk_edit',
        count: marks.length,
      });
      result = { success: true, count: marks.length, marks };
    });

    return result;
  }

  /**
   * Rewrite the document: diff new content against current, create suggestions for each change.
   * Returns the list of created marks.
   */
  rewriteDocument(
    newContent: string,
    by: string,
    options?: { allowShareContentMutation?: boolean }
  ): {
    success: boolean;
    marks: Mark[];
    mode?: 'highlights' | 'refresh';
    stats?: ChangeStats;
    attemptedChanges?: number;
    createdSuggestions?: number;
    error?: string;
    reason?: string;
  } {
    if (!this.editor) {
      return { success: false, marks: [], error: 'Editor not initialized' };
    }

    const allowShareContentMutation = Boolean(options?.allowShareContentMutation);
    const rewriteMeta = allowShareContentMutation
      ? ({ allowShareContentMutation: true } as OrchestratedMarkMeta)
      : undefined;

    let result: {
      success: boolean;
      marks: Mark[];
      mode?: 'highlights' | 'refresh';
      stats?: ChangeStats;
      attemptedChanges?: number;
      createdSuggestions?: number;
      error?: string;
      reason?: string;
    } = {
      success: false,
      marks: [],
    };
    let deferredRefresh: { content: string; stats: ChangeStats; reason: string } | null = null;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      const { content: provenanceStripped } = extractEmbeddedProvenance(newContent);
      const { content: canonicalizedContent } = extractMarks(provenanceStripped);
      const incomingMarkdownForCompare = normalizeMarkdownForComparison(stripProofSpanTags(canonicalizedContent));

      // Get plain text content with block boundaries preserved (same as getFullState)
      const doc = view.state.doc;
      const oldContent = doc.textBetween(0, doc.content.size, '\n', '\n');
      const currentStructure = structureSignature(doc);
      let currentMarkdownForCompare: string | null = null;
      try {
        const serializer = ctx.get(serializerCtx);
        const serialized = serializer(doc);
        if (serialized) {
          currentMarkdownForCompare = normalizeMarkdownForComparison(stripProofSpanTags(serialized));
        }
      } catch (error) {
        console.warn('[rewriteDocument] Failed to serialize current markdown for comparison:', error);
      }

      if (!oldContent) {
        result = { success: false, marks: [], error: 'Empty document' };
        return;
      }

      // Build text index for mapping character offsets to ProseMirror positions
      const textIndex = buildTextIndex(doc);
      if (!textIndex) {
        result = { success: false, marks: [], error: 'Failed to build text index' };
        return;
      }

      // Normalize incoming markdown to the same textBetween representation.
      let newText = canonicalizedContent;
      let incomingStructure: string | null = null;
      try {
        const newDoc = parser(canonicalizedContent);
        if (newDoc) {
          newText = newDoc.textBetween(0, newDoc.content.size, '\n', '\n');
          incomingStructure = structureSignature(newDoc);
        }
      } catch (parseErr) {
        console.warn('[rewriteDocument] Parser failed, using raw content:', parseErr);
      }

      // Line-based diff on plain text
      const oldLines = oldContent.split('\n');
      const newLines = newText.split('\n');
      const changes = computeLineDiff(oldLines, newLines);

      if (changes.length === 0) {
        const markdownStructureChanged = currentMarkdownForCompare !== null
          && incomingMarkdownForCompare !== currentMarkdownForCompare;
        const parsedStructureChanged = incomingStructure !== null
          && incomingStructure !== currentStructure;
        if (markdownStructureChanged || parsedStructureChanged) {
          deferredRefresh = {
            content: canonicalizedContent,
            stats: computeChangeStats(changes, oldLines, newLines),
            reason: 'structural_markdown_change',
          };
          result = {
            success: true,
            mode: 'refresh',
            marks: [],
            attemptedChanges: 0,
            createdSuggestions: 0,
            reason: deferredRefresh.reason,
          };
          return;
        }

        result = {
          success: true,
          mode: 'highlights',
          marks: [],
          attemptedChanges: 0,
          createdSuggestions: 0,
        };
        return;
      }

      const stats = computeChangeStats(changes, oldLines, newLines);
      let mode = classifyRewriteMode(stats);

      // Dry-run validation before any mark creation.
      if (mode === 'highlights') {
        const validation = validateDiffPositions(textIndex, changes, oldLines);
        if (!validation.valid) {
          mode = 'refresh';
          deferredRefresh = {
            content: canonicalizedContent,
            stats,
            reason: `position_validation_failed:${validation.failedCount}`,
          };
          result = {
            success: true,
            mode,
            marks: [],
            stats,
            attemptedChanges: changes.length,
            createdSuggestions: 0,
            reason: deferredRefresh.reason,
          };
          return;
        }
      }

      if (mode === 'refresh') {
        deferredRefresh = {
          content: canonicalizedContent,
          stats,
          reason: 'rewrite_mode_refresh',
        };
        result = {
          success: true,
          mode,
          marks: [],
          stats,
          attemptedChanges: changes.length,
          createdSuggestions: 0,
          reason: deferredRefresh.reason,
        };
        return;
      }

      // Apply changes as suggestions (reverse order so positions don't shift)
      // Use explicit ProseMirror ranges (via textIndex) instead of quote-based
      // text search so that structural changes (headings, paragraph breaks)
      // land on proper block boundaries.
      const marks: Mark[] = [];
      for (let i = changes.length - 1; i >= 0; i--) {
        const change = changes[i];
        let mark: Mark | null = null;

        try {
          if (change.type === 'replace' || change.type === 'delete') {
            const offsets = linesToCharOffsets(oldLines, change.oldLineStart!, change.oldLineEnd!);
            const range = mapTextOffsetsToRange(textIndex, offsets.from, offsets.to);
            if (!range) continue;

            const quote = oldContent.slice(offsets.from, offsets.to);

            if (change.type === 'replace') {
              mark = suggestReplace(view, quote, by, change.newText!, range, undefined, parser);
            } else {
              mark = suggestDelete(view, quote, by, range);
            }
          } else if (change.type === 'insert') {
            if (change.oldLineStart !== undefined && change.oldLineStart > 0) {
              // Anchor after the preceding line
              let anchorIdx = change.oldLineStart - 1;
              let anchorOffsets = linesToCharOffsets(oldLines, anchorIdx, anchorIdx + 1);
              let anchorRange = mapTextOffsetsToRange(textIndex, anchorOffsets.from, anchorOffsets.to);

              // If anchor line is empty (from==to), walk backward to find a non-empty line
              if (!anchorRange) {
                let found = false;
                for (let k = anchorIdx - 1; k >= 0; k--) {
                  const fallbackOffsets = linesToCharOffsets(oldLines, k, k + 1);
                  const fallbackRange = mapTextOffsetsToRange(textIndex, fallbackOffsets.from, fallbackOffsets.to);
                  if (fallbackRange) {
                    anchorIdx = k;
                    anchorOffsets = fallbackOffsets;
                    anchorRange = fallbackRange;
                    found = true;
                    break;
                  }
                }
                if (!found) {
                  mark = suggestInsert(view, '', by, change.newText! + '\n', { from: 0, to: 0 }, rewriteMeta);
                }
              }

              if (!mark && anchorRange) {
                const anchorQuote = oldContent.slice(anchorOffsets.from, anchorOffsets.to);
                mark = suggestInsert(view, anchorQuote, by, '\n' + change.newText!, anchorRange, rewriteMeta);
              }
            } else {
              // Insert at document start
              mark = suggestInsert(view, '', by, change.newText! + '\n', { from: 0, to: 0 }, rewriteMeta);
            }
          }
        } catch (e) {
          console.warn('[rewriteDocument] Failed to create suggestion for change:', change.type, e);
        }

        if (mark) {
          marks.push(mark);
        }
      }

      // Guard against partial application for large rewrites.
      const attemptedChanges = changes.length;
      const createdSuggestions = marks.length;
      const coverageRatio = attemptedChanges > 0 ? (createdSuggestions / attemptedChanges) : 1;
      const lowCoverage = attemptedChanges >= 6 && coverageRatio < 0.7;

      if (lowCoverage) {
        const reason = `low_coverage:${createdSuggestions}/${attemptedChanges}`;
        console.warn('[rewriteDocument] Escalating to refresh due to low suggestion coverage:', {
          attemptedChanges,
          createdSuggestions,
          coverageRatio,
        });
        deferredRefresh = {
          content: canonicalizedContent,
          stats,
          reason,
        };
        result = {
          success: true,
          mode: 'refresh',
          marks: [],
          stats,
          attemptedChanges,
          createdSuggestions,
          reason,
        };
        return;
      }

      result = {
        success: true,
        mode: 'highlights',
        marks,
        stats,
        attemptedChanges,
        createdSuggestions,
      };
    });

    if (deferredRefresh) {
      this.loadDocument(deferredRefresh.content, { allowShareContentMutation });
      this.markAllAsAuthored(by);
      // Refresh-mode rewrites bypass listener-based sync; emit a snapshot explicitly
      // so native state/share sync receive the new content.
      this.emitDocumentSnapshotNow();
    }

    return result;
  }

  /**
   * Handle an external file change detected by the file watcher.
   * Canonicalizes disk content, diffs against editor state, and either
   * applies highlights (scattered edits) or refreshes (full rewrite).
   * Applies an external file change from a non-web editor integration.
   */
  handleExternalChange(diskContent: string, providedBy?: string | null): void {
    if (!this.editor) {
      console.error('[handleExternalChange] Editor not initialized');
      return;
    }

    // 1. Canonicalize disk content (strip provenance spans and marks metadata)
    const { content: provenanceStripped } = extractEmbeddedProvenance(diskContent);
    const { content: canonicalized } = extractMarks(provenanceStripped);

    // Use provided by (from provenance queue), fall back to regex scan, then generic
    let by: string;
    if (providedBy) {
      by = providedBy;
    } else {
      const agentMatch = diskContent.match(/data-by="ai:([^"]+)"/);
      by = agentMatch ? `ai:${agentMatch[1]}` : 'ai:external-agent';
    }

    // When providedBy is set, the change came from the provenance queue
    // (known agent edit) — skip the toast since presence + highlights are enough.
    const isProvenanceTracked = !!providedBy;
    this.applyExternalHighlights(canonicalized, by, isProvenanceTracked);
  }

  /**
   * Mark the entire document as authored by the given agent.
   * Used for offline provenance: Write entries (kind: "full").
   */
  markAllAsAuthored(by: string): void {
    if (!this.editor) return;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      const authoredMarkType = view.state.schema.marks.proofAuthored;
      if (!authoredMarkType) return;
      const tr = view.state.tr.addMark(
        0, view.state.doc.content.size,
        authoredMarkType.create({ by })
      );
      view.dispatch(tr);
    });
  }

  /**
   * Mark specific line ranges as authored by the given agent.
   * Used for offline provenance: Edit entries (kind: "partial") with hash-verified hunks.
   */
  markHunksAsAuthored(by: string, hunks: Array<{start_line: number, end_line: number, lines: string[]}>): void {
    if (!this.editor) return;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      const authoredMarkType = view.state.schema.marks.proofAuthored;
      if (!authoredMarkType) return;

      // Build line-number → ProseMirror position index
      const doc = view.state.doc;
      const linePositions: Array<{from: number, to: number}> = [];
      doc.descendants((node, pos) => {
        if (node.isBlock && node.isTextblock) {
          linePositions.push({ from: pos, to: pos + node.nodeSize });
        }
      });

      let tr = view.state.tr;
      for (const hunk of hunks) {
        const startIdx = hunk.start_line - 1;
        const endIdx = hunk.end_line - 1;
        if (startIdx < 0 || endIdx >= linePositions.length) continue;

        const from = linePositions[startIdx].from;
        const to = linePositions[endIdx].to;
        tr = tr.addMark(from, to, authoredMarkType.create({ by }));
      }

      if (tr.docChanged) {
        view.dispatch(tr);
      }
    });
  }

  /**
   * Try to apply external changes as individual suggestion marks (highlights mode).
   * Falls back to refresh mode if changes are too extensive or positions fail validation.
   *
   * Lock lifecycle: this method locks the editor and is responsible for unlocking.
   * In highlights mode, unlock happens synchronously before return.
   * In refresh mode, unlock is deferred to applyRefresh's animation completion.
   *
   * Lock lifecycle ends within each path after work completes.
   */
  private applyExternalHighlights(
    canonicalizedContent: string,
    by: string,
    skipToast: boolean = false
  ): void {
    if (!this.editor) {
      return;
    }

    this.reviewLock('Applying external changes...');

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);

      // 1. Snapshot current doc
      const doc = view.state.doc;
      const oldText = doc.textBetween(0, doc.content.size, '\n', '\n');
      const textIndex = buildTextIndex(doc);

      if (!textIndex) {
        console.warn('[applyExternalHighlights] buildTextIndex failed, falling back to refresh');
        // applyRefresh owns lock from here and sends its own callback
        this.applyRefresh(canonicalizedContent, by);
        return;
      }

      // 2. Normalize disk content to match doc.textBetween() format.
      // Markdown uses \n\n between paragraphs, but textBetween uses single \n
      // between block nodes. Parse through ProseMirror to get the same representation.
      let newText = canonicalizedContent;
      try {
        const newDoc = parser(canonicalizedContent);
        if (newDoc) {
          newText = newDoc.textBetween(0, newDoc.content.size, '\n', '\n');
        }
      } catch (parseErr) {
        console.warn('[applyExternalHighlights] Parser failed, using raw content:', parseErr);
      }

      // 3. Diff
      const oldLines = oldText.split('\n');
      const newLines = newText.split('\n');
      const changes = computeLineDiff(oldLines, newLines);

      if (changes.length === 0) {
        this.reviewUnlock();
        return;
      }

      // 4. Classify mode
      const stats = computeChangeStats(changes, oldLines, newLines);
      let mode = classifyChangeMode(stats);

      // 5. Dry-run validation (only for highlights mode)
      if (mode === 'highlights') {
        const validation = validateDiffPositions(textIndex, changes, oldLines);
        if (!validation.valid) {
          console.warn(`[applyExternalHighlights] ${validation.failedCount} positions failed validation, escalating to refresh`);
          mode = 'refresh';
        }
      }

      if (mode === 'refresh') {
        // applyRefresh owns lock from here and sends its own callback
        this.applyRefresh(canonicalizedContent, by, stats);
        return;
      }

      // 6. Apply suggestions in reverse order (positions don't shift)
      const marks: Mark[] = [];
      for (let i = changes.length - 1; i >= 0; i--) {
        const change = changes[i];
        let mark: Mark | null = null;

        try {
          if (change.type === 'replace' || change.type === 'delete') {
            const offsets = linesToCharOffsets(oldLines, change.oldLineStart!, change.oldLineEnd!);
            const range = mapTextOffsetsToRange(textIndex, offsets.from, offsets.to);
            if (!range) continue;

            // Use actual text at the range as quote (cross-check in resolveRangeWithValidation)
            const quote = oldText.slice(offsets.from, offsets.to);

            if (change.type === 'replace') {
              mark = suggestReplace(view, quote, by, change.newText!, range, undefined, parser);
            } else {
              mark = suggestDelete(view, quote, by, range);
            }
          } else if (change.type === 'insert') {
            if (change.oldLineStart !== undefined && change.oldLineStart > 0) {
              // Anchor after the preceding line
              let anchorIdx = change.oldLineStart - 1;
              let anchorOffsets = linesToCharOffsets(oldLines, anchorIdx, anchorIdx + 1);
              let anchorRange = mapTextOffsetsToRange(textIndex, anchorOffsets.from, anchorOffsets.to);

              // If anchor line is empty (from==to), walk backward to find a non-empty line
              if (!anchorRange) {
                let found = false;
                for (let k = anchorIdx - 1; k >= 0; k--) {
                  const fallbackOffsets = linesToCharOffsets(oldLines, k, k + 1);
                  const fallbackRange = mapTextOffsetsToRange(textIndex, fallbackOffsets.from, fallbackOffsets.to);
                  if (fallbackRange) {
                    anchorIdx = k;
                    anchorOffsets = fallbackOffsets;
                    anchorRange = fallbackRange;
                    found = true;
                    break;
                  }
                }
                if (!found) {
                  // No non-empty line before this — insert at document start
                  mark = suggestInsert(view, '', by, change.newText! + '\n', { from: 0, to: 0 });
                }
              }

              if (!mark && anchorRange) {
                const anchorQuote = oldText.slice(anchorOffsets.from, anchorOffsets.to);
                mark = suggestInsert(view, anchorQuote, by, '\n' + change.newText!, anchorRange);
              }
            } else {
              // Insert at document start
              mark = suggestInsert(view, '', by, change.newText! + '\n', { from: 0, to: 0 });
            }
          }
        } catch (e) {
          console.warn('[applyExternalHighlights] Failed to create suggestion:', change.type, e);
        }

        if (mark) marks.push(mark);
      }

      // 7. Show toast notification (skip for provenance-tracked changes —
      //    presence indicator + green highlights + sidebar count are enough)
      if (!skipToast) {
        this.showExternalChangeToast(by, marks.length);
      }

      // 8. Force glow decoration rebuild after glow expires
      setTimeout(() => {
        if (this.editor) {
          this.editor.action((ctx) => {
            const v = ctx.get(editorViewCtx);
            v.dispatch(v.state.tr);
          });
        }
      }, 2100);

      // 9. Unlock after highlights are applied.
      this.reviewUnlock();
    });
  }

  /**
   * Apply a full refresh: load new content with fade animation and provenance carry-forward.
   *
   * This method takes ownership of the review lock (caller must have locked).
   * Unlock happens after the async animation completes (~500ms).
   */
  private applyRefresh(
    canonicalizedContent: string,
    by: string,
    stats?: ChangeStats
  ): void {
    if (!this.isReviewLocked()) this.reviewLock('Refreshing document...');

    // 1. Snapshot provenance before reload
    let provenanceSnapshot: Array<{ text: string; by: string }> = [];
    if (this.editor) {
      this.editor.action((ctx) => {
        const view = ctx.get(editorViewCtx);
        provenanceSnapshot = this.snapshotProvenance(view);
      });
    }

    // 2. Store content for revert
    this.preRefreshRevertContent = this.lastMarkdown;
    this.preRefreshRevertTimestamp = Date.now();

    // 3. Fade out animation
    this.triggerRefreshFadeOut();

    // 4. After fade out, load new content
    setTimeout(() => {
      this.loadDocument(canonicalizedContent);

      // 5. Re-apply provenance to unchanged ranges
      if (this.editor && provenanceSnapshot.length > 0) {
        this.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          this.restoreProvenance(view, provenanceSnapshot, by);
        });
      }

      // 6. Fade in animation
      this.triggerRefreshFadeIn();

      // 7. Unlock after fade and show the banner
      setTimeout(() => {
        this.reviewUnlock();
        this.showRefreshBanner(by, stats);
      }, 300);
    }, 200);
  }

  /**
   * Snapshot proofAuthored marks before loadDocument destroys them.
   */
  private snapshotProvenance(view: EditorView): Array<{ text: string; by: string }> {
    const snapshot: Array<{ text: string; by: string }> = [];
    const doc = view.state.doc;
    doc.descendants((node, _pos) => {
      if (!node.isText) return;
      const authoredMark = node.marks.find(m => m.type.name === 'proofAuthored');
      if (authoredMark) {
        snapshot.push({
          text: node.text || '',
          by: authoredMark.attrs.by || 'human',
        });
      }
    });
    return snapshot;
  }

  /**
   * Restore provenance marks to unchanged text ranges after loadDocument.
   * New/changed text is attributed to the external agent.
   */
  private restoreProvenance(
    view: EditorView,
    snapshot: Array<{ text: string; by: string }>,
    agentBy: string
  ): void {
    const authoredMarkType = view.state.schema.marks.proofAuthored;
    if (!authoredMarkType) return;

    let tr = view.state.tr;
    const doc = view.state.doc;

    // Use an array (not Map) to preserve per-occurrence attribution for duplicate text
    const entries = [...snapshot];

    // Walk new doc and restore provenance where text matches, consuming entries
    doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return;
      const existingAuthored = node.marks.find(m => m.type.name === 'proofAuthored');
      if (existingAuthored) return; // already has provenance

      const idx = entries.findIndex(e => e.text === node.text);
      if (idx !== -1) {
        // Unchanged text — restore original provenance, consume the entry
        const entry = entries.splice(idx, 1)[0];
        tr = tr.addMark(pos, pos + node.nodeSize, authoredMarkType.create({ by: entry.by }));
      }
      // New/changed text without provenance can be attributed to agent
      // but we leave that to the authored-tracker plugin to handle naturally
    });

    if (tr.docChanged || tr.steps.length > 0) {
      view.dispatch(tr);
    }
  }

  /**
   * Trigger fade-out CSS class for refresh transition.
   */
  private triggerRefreshFadeOut(): void {
    const editor = document.querySelector('.milkdown') as HTMLElement;
    if (editor) {
      editor.classList.add('proof-refreshing');
      editor.classList.remove('proof-refreshed');
    }
  }

  /**
   * Trigger fade-in CSS class for refresh transition.
   */
  private triggerRefreshFadeIn(): void {
    const editor = document.querySelector('.milkdown') as HTMLElement;
    if (editor) {
      editor.classList.remove('proof-refreshing');
      editor.classList.add('proof-refreshed');
      // Clean up class after animation
      setTimeout(() => editor.classList.remove('proof-refreshed'), 400);
    }
  }

  /**
   * Show a toast notification for highlights mode changes.
   */
  private showExternalChangeToast(by: string, markCount: number): void {
    // Remove existing toast
    this.removeExternalChangeToast();

    const agentName = by.startsWith('ai:') ? by.slice(3).replace(/-/g, ' ') : 'External agent';
    const displayName = agentName.charAt(0).toUpperCase() + agentName.slice(1);

    const toast = document.createElement('div');
    toast.className = 'proof-external-change-toast';
    toast.innerHTML = `
      <div class="proof-toast-content">
        <span class="proof-toast-message">${displayName} updated ${markCount} section${markCount !== 1 ? 's' : ''}</span>
        <div class="proof-toast-actions">
          <button class="proof-toast-btn proof-toast-review">Review</button>
          <button class="proof-toast-btn proof-toast-accept-all">Accept All</button>
          <button class="proof-toast-btn proof-toast-reject-all">Reject All</button>
        </div>
      </div>
    `;

    // Review button — scroll to first suggestion
    toast.querySelector('.proof-toast-review')?.addEventListener('click', () => {
      this.navigateToFirstSuggestion();
      this.removeExternalChangeToast();
    });

    // Accept All
    toast.querySelector('.proof-toast-accept-all')?.addEventListener('click', () => {
      this.markAcceptAll();
      this.removeExternalChangeToast();
    });

    // Reject All
    toast.querySelector('.proof-toast-reject-all')?.addEventListener('click', () => {
      this.markRejectAll();
      this.removeExternalChangeToast();
    });

    document.body.appendChild(toast);
    this.toastElement = toast;

    // Auto-dismiss after 10 seconds
    setTimeout(() => this.removeExternalChangeToast(), 10000);
  }

  private removeExternalChangeToast(): void {
    if (this.toastElement) {
      this.toastElement.remove();
      this.toastElement = null;
    }
  }

  /**
   * Show refresh banner with revert option.
   */
  private showRefreshBanner(by: string, stats?: ChangeStats): void {
    this.removeRefreshBanner();

    const agentName = by.startsWith('ai:') ? by.slice(3).replace(/-/g, ' ') : 'External agent';
    const displayName = agentName.charAt(0).toUpperCase() + agentName.slice(1);

    // Build a human-readable summary of what changed
    let summary = '';
    if (stats) {
      const parts: string[] = [];
      if (stats.replacedLines > 0) parts.push(`${stats.replacedLines} modified`);
      if (stats.insertedLines > 0) parts.push(`${stats.insertedLines} added`);
      if (stats.deletedLines > 0) parts.push(`${stats.deletedLines} removed`);
      if (parts.length > 0) {
        summary = parts.join(', ') + ` line${stats.changedLines !== 1 ? 's' : ''}`;
      } else {
        summary = `${stats.changedLines} line${stats.changedLines !== 1 ? 's' : ''} changed`;
      }
    }

    const banner = document.createElement('div');
    banner.className = 'proof-refresh-banner';

    const REVERT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
    const canRevert = this.preRefreshRevertContent !== null &&
      (Date.now() - this.preRefreshRevertTimestamp) < REVERT_WINDOW_MS;

    banner.innerHTML = `
      <div class="proof-refresh-banner-info">
        <span class="proof-refresh-banner-title">${displayName} rewrote this document</span>
        ${summary ? `<span class="proof-refresh-banner-summary">${summary}</span>` : ''}
      </div>
      <div class="proof-refresh-banner-actions">
        ${canRevert ? '<button class="proof-refresh-banner-btn proof-refresh-revert">Undo rewrite</button>' : ''}
        <button class="proof-refresh-banner-btn proof-refresh-dismiss">&times;</button>
      </div>
    `;

    if (canRevert) {
      banner.querySelector('.proof-refresh-revert')?.addEventListener('click', () => {
        this.revertRefresh();
        this.removeRefreshBanner();
      });
    }

    banner.querySelector('.proof-refresh-dismiss')?.addEventListener('click', () => {
      this.removeRefreshBanner();
    });

    const editorEl = document.getElementById('editor');
    if (editorEl) {
      editorEl.insertBefore(banner, editorEl.firstChild);
    } else {
      document.body.appendChild(banner);
    }
    this.refreshBanner = banner;

    // Auto-hide after 60 seconds
    setTimeout(() => this.removeRefreshBanner(), 60000);
  }

  private removeRefreshBanner(): void {
    if (this.refreshBanner) {
      this.refreshBanner.remove();
      this.refreshBanner = null;
    }
  }

  /**
   * Revert a refresh by loading the pre-refresh content.
   */
  private revertRefresh(): void {
    const REVERT_WINDOW_MS = 60 * 60 * 1000;
    if (!this.preRefreshRevertContent) return;
    if ((Date.now() - this.preRefreshRevertTimestamp) > REVERT_WINDOW_MS) {
      console.warn('[revertRefresh] Revert window expired');
      return;
    }

    this.loadDocument(this.preRefreshRevertContent);
    this.preRefreshRevertContent = null;

  }

  /**
   * Find matches in the document (no edits).
   */
  markFind(
    find: string,
    options?: FindOptions
  ): { success: boolean; count: number; matches?: Array<{ from: number; to: number; match: string; line: number; column: number; snippet: string }>; error?: string } {
    if (!this.editor) {
      return { success: false, count: 0, error: 'Editor not initialized' };
    }

    let result: { success: boolean; count: number; matches?: Array<{ from: number; to: number; match: string; line: number; column: number; snippet: string }>; error?: string } = {
      success: false,
      count: 0,
    };

    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      const scope = options?.scope ?? 'all';
      if (scope === 'selection' && view.state.selection.from === view.state.selection.to) {
        result = { success: false, count: 0, error: 'No selection' };
        return;
      }

      const matches = findMatchesInDoc(view.state.doc, find, options);
      const scopedMatches = this.filterMatchesByScope(view, matches, scope);
      if (scopedMatches.length === 0) {
        result = { success: false, count: 0, error: 'No matches' };
        return;
      }

      const summaries = scopedMatches.map(match => {
        const { line, col } = this.offsetToLineCol(view.state.doc, match.from);
        const snippetFrom = Math.max(0, match.from - 40);
        const snippetTo = Math.min(view.state.doc.content.size, match.to + 40);
        const snippet = view.state.doc.textBetween(snippetFrom, snippetTo, '\n', '\n');
        return {
          from: match.from,
          to: match.to,
          match: match.match,
          line,
          column: col,
          snippet,
        };
      });

      result = { success: true, count: summaries.length, matches: summaries };
    });

    return result;
  }

  searchDocument(
    query: string,
    options: FindOptions = {}
  ): {
    success: boolean;
    count: number;
    matches: Array<{ text: string; position: number; context: string; from: number; to: number }>;
    error?: string;
  } {
    if (!this.editor) {
      return { success: false, count: 0, matches: [], error: 'Editor not initialized' };
    }

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return { success: false, count: 0, matches: [], error: 'Empty query' };
    }

    let result: {
      success: boolean;
      count: number;
      matches: Array<{ text: string; position: number; context: string; from: number; to: number }>;
      error?: string;
    } = {
      success: false,
      count: 0,
      matches: [],
    };

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const docSize = view.state.doc.content.size;
      const matches = findMatchesInDoc(view.state.doc, trimmedQuery, options);

      if (matches.length === 0) {
        result = { success: false, count: 0, matches: [], error: 'No matches' };
        return;
      }

      const summaries = matches.map((match) => {
        const contextFrom = Math.max(0, match.from - 60);
        const contextTo = Math.min(docSize, match.to + 60);
        const context = view.state.doc.textBetween(contextFrom, contextTo, '\n', '\n');
        return {
          text: match.match,
          position: match.from,
          context,
          from: match.from,
          to: match.to,
        };
      });

      result = { success: true, count: summaries.length, matches: summaries };
    });

    return result;
  }

  /**
   * Modify a suggestion's content before accepting
   */
  markModifySuggestion(markId: string, content: string): boolean {
    if (!this.editor) {
      console.warn('[markModifySuggestion] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      success = modifySuggestionContent(view, markId, content);
      console.log('[markModifySuggestion] Modified:', success);
    });
    return success;
  }

  private notifyHostAuthorshipStatsUpdated(stats: ReturnType<typeof getAuthorshipStats>): void {
    (this as any).bridge?.authorshipStatsUpdated?.(stats);
  }

  private isSuggestionPendingOnServer(markId: string): boolean {
    const mark = this.lastReceivedServerMarks[markId];
    if (!mark) return false;
    if (mark.kind !== 'insert' && mark.kind !== 'delete' && mark.kind !== 'replace') return false;
    return mark.status !== 'accepted' && mark.status !== 'rejected';
  }

  private getShareSuggestionResolutionTransport(): ShareSuggestionResolutionTransport {
    return getShareSuggestionResolutionTransport({
      collabEnabled: this.collabEnabled,
      connectionStatus: this.collabConnectionStatus,
      isSynced: this.collabIsSynced,
    });
  }

  private applyShareSuggestionLocally<T>(
    transport: ShareSuggestionResolutionTransport,
    apply: () => T,
  ): T {
    const previousSuppressMarksSync = this.suppressMarksSync;
    if (transport === 'collab') {
      this.liveCollabSuggestionResolutionDepth += 1;
      this.suppressMarksSync = false;
    } else {
      this.suppressMarksSync = true;
    }
    try {
      return apply();
    } finally {
      if (transport === 'collab') {
        this.liveCollabSuggestionResolutionDepth = Math.max(
          0,
          this.liveCollabSuggestionResolutionDepth - 1,
        );
      }
      this.suppressMarksSync = previousSuppressMarksSync;
    }
  }

  private dropSuggestionIdsFromServerMarkCache(markIds: string[]): Record<string, StoredMark> {
    const removed: Record<string, StoredMark> = {};
    const next = { ...this.lastReceivedServerMarks };
    for (const id of markIds) {
      if (!id || !next[id]) continue;
      removed[id] = next[id];
      delete next[id];
    }
    this.lastReceivedServerMarks = next;
    return removed;
  }

  private restoreServerMarkCache(marks: Record<string, StoredMark>): void {
    if (Object.keys(marks).length === 0) return;
    this.lastReceivedServerMarks = { ...this.lastReceivedServerMarks, ...marks };
  }

  private async reconcileShareSuggestionBatch(
    markIds: string[],
    finalStatus: ShareSuggestionFinalStatus,
    actor: string,
  ): Promise<void> {
    const fallbackMessage = finalStatus === 'accepted'
      ? 'Unable to accept every suggestion.'
      : 'Unable to reject every suggestion.';
    const reconciliation = await reconcileShareMarkMutationBatch({
      markIds,
      finalStatus,
      mutate: (markId) => finalStatus === 'accepted'
        ? shareClient.acceptSuggestion(markId, actor)
        : shareClient.rejectSuggestion(markId, actor),
      fetchOpenContext: () => shareClient.fetchOpenContext(),
      fallbackMessage,
      showErrorBanner: (message) => this.showErrorBanner(message),
      applyServerMarks: (marks) => this.applyAuthoritativeShareMarks(marks),
      applyServerDocument: (doc) => {
        const marks = doc.marks as Record<string, StoredMark>;
        const pendingIds = markIds.filter((id) => {
          const mark = marks[id];
          return Boolean(mark && mark.status !== 'accepted' && mark.status !== 'rejected');
        });
        clearResolvedMarkTombstones(pendingIds);
        this.applyAuthoritativeShareDocument(doc);
      },
    });
    if (finalStatus === 'rejected') {
      const unresolvedIds = new Set(reconciliation.unresolvedIds);
      for (const id of markIds) {
        if (unresolvedIds.has(id)) {
          this.shareRejectedSuggestionIdsBlockedFromAcceptAll.add(id);
        } else {
          this.shareRejectedSuggestionIdsBlockedFromAcceptAll.delete(id);
        }
      }
    }
  }

  /**
   * Accept a suggestion and apply the change
   */
  markAccept(markId: string): boolean {
    if (!this.editor) {
      console.warn('[markAccept] Editor not initialized');
      return false;
    }

    if (this.isShareMode) {
      const transport = this.getShareSuggestionResolutionTransport();
      let accepted = false;
      this.editor.action((ctx) => {
        const view = markApiView(ctx.get(editorViewCtx));
        const parser = ctx.get(parserCtx);
        const removedServerMarks = this.dropSuggestionIdsFromServerMarkCache([markId]);
        this.applyShareSuggestionLocally(transport, () => {
          accepted = acceptMark(view, markId, parser);
        });
        if (!accepted) this.restoreServerMarkCache(removedServerMarks);
        if (!accepted) return;
        const metadata = getMarkMetadataWithQuotes(view.state);
        this.lastReceivedServerMarks = { ...metadata };
        this.initialMarksSynced = true;
        const stats = getAuthorshipStats(view);
        this.notifyHostAuthorshipStatsUpdated(stats);
        this.scheduleShareSuggestionReviewDisplay(view);
      });

      if (!accepted) {
        console.warn('[markAccept] Suggestion not pending in share mode:', markId);
        return false;
      }

      this.shareRejectedSuggestionIdsBlockedFromAcceptAll.delete(markId);
      runShareSuggestionRestFallback(transport, () => {
        const actor = getCurrentActor();
        void shareClient.acceptSuggestion(markId, actor).then(async (result) => {
          if (!result || 'error' in result || result.success !== true) {
            await this.recoverAuthoritativeShareMarks(
              result,
              'Unable to accept suggestion.',
              [markId],
              'accepted',
            );
            return;
          }
          const serverMarks = (result.marks && typeof result.marks === 'object' && !Array.isArray(result.marks))
            ? result.marks as Record<string, StoredMark>
            : null;
          if (!serverMarks) return;
          this.applyAuthoritativeShareMarks(serverMarks);
        }).catch((error) => {
          console.error('[markAccept] Failed to persist suggestion acceptance via share mutation:', error);
          void this.recoverAuthoritativeShareMarks(
            error,
            'Unable to accept suggestion.',
            [markId],
            'accepted',
          );
        });
      });
      captureEvent('suggestion_accepted', { count: 1 });
      return true;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      const parser = ctx.get(parserCtx);
      success = acceptMark(view, markId, parser);
      console.log('[markAccept] Accepted:', success);
      if (success) {
        captureEvent('suggestion_accepted', { count: 1 });
        const stats = getAuthorshipStats(view);
        this.notifyHostAuthorshipStatsUpdated(stats);
      }
    });

    return success;
  }

  /**
   * Reject a suggestion without changing the document
   */
  markReject(markId: string): boolean {
    if (!this.editor) {
      console.warn('[markReject] Editor not initialized');
      return false;
    }

    if (this.isShareMode) {
      const transport = this.getShareSuggestionResolutionTransport();
      let rejected = false;
      this.editor.action((ctx) => {
        const view = markApiView(ctx.get(editorViewCtx));
        const removedServerMarks = this.dropSuggestionIdsFromServerMarkCache([markId]);
        this.applyShareSuggestionLocally(transport, () => {
          rejected = rejectMark(view, markId);
        });
        if (!rejected) this.restoreServerMarkCache(removedServerMarks);
        if (!rejected) return;
        const metadata = getMarkMetadataWithQuotes(view.state);
        this.lastReceivedServerMarks = { ...metadata };
        this.initialMarksSynced = true;
        this.scheduleShareSuggestionReviewDisplay(view);
      });

      if (!rejected) {
        console.warn('[markReject] Suggestion not pending in share mode:', markId);
        return false;
      }

      if (transport === 'rest') {
        this.shareRejectedSuggestionIdsBlockedFromAcceptAll.add(markId);
      } else {
        this.shareRejectedSuggestionIdsBlockedFromAcceptAll.delete(markId);
      }
      runShareSuggestionRestFallback(transport, () => {
        const actor = getCurrentActor();
        void shareClient.rejectSuggestion(markId, actor).then(async (result) => {
          if (!result || 'error' in result || result.success !== true) {
            await this.recoverAuthoritativeShareMarks(
              result,
              'Unable to reject suggestion.',
              [markId],
              'rejected',
            );
            return;
          }
          this.shareRejectedSuggestionIdsBlockedFromAcceptAll.delete(markId);
          const serverMarks = (result.marks && typeof result.marks === 'object' && !Array.isArray(result.marks))
            ? result.marks as Record<string, StoredMark>
            : null;
          if (!serverMarks) return;
          this.applyAuthoritativeShareMarks(serverMarks);
        }).catch((error) => {
          console.error('[markReject] Failed to persist suggestion rejection via share mutation:', error);
          void this.recoverAuthoritativeShareMarks(
            error,
            'Unable to reject suggestion.',
            [markId],
            'rejected',
          );
        });
      });

      captureEvent('suggestion_rejected', { count: 1 });
      return true;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      success = rejectMark(view, markId);
      console.log('[markReject] Rejected:', success);
      if (success) {
        captureEvent('suggestion_rejected', { count: 1 });
      }
    });
    return success;
  }

  /**
   * Accept all pending suggestions
   */
  markAcceptAll(): number {
    if (!this.editor) {
      console.warn('[markAcceptAll] Editor not initialized');
      return 0;
    }

    if (this.isShareMode) {
      const transport = this.getShareSuggestionResolutionTransport();
      let acceptedCount = 0;
      let acceptedIds: string[] = [];
      this.editor.action((ctx) => {
        const view = markApiView(ctx.get(editorViewCtx));
        const parser = ctx.get(parserCtx);
        const pendingIds = getPendingSuggestions(getMarks(view.state))
          .map((mark) => mark.id)
          .filter((id) => (
            this.isSuggestionPendingOnServer(id)
            && !this.shareRejectedSuggestionIdsBlockedFromAcceptAll.has(id)
          ));
        if (pendingIds.length === 0) return;
        const pendingIdSet = new Set(pendingIds);
        const removedServerMarks = this.dropSuggestionIdsFromServerMarkCache(pendingIds);
        const acceptedIdSet = new Set<string>();
        try {
          this.applyShareSuggestionLocally(transport, () => {
            for (let pass = 0; pass < 4; pass += 1) {
              const remaining = getPendingSuggestions(getMarks(view.state))
                .filter((mark) => pendingIdSet.has(mark.id))
                .map((mark) => mark.id)
                .reverse();
              if (remaining.length === 0) break;
              let acceptedInPass = 0;
              for (const id of remaining) {
                if (acceptMark(view, id, parser)) {
                  acceptedIdSet.add(id);
                  acceptedInPass += 1;
                }
              }
              if (acceptedInPass === 0) break;
            }
          });
        } finally {
          const unresolvedServerMarks = Object.fromEntries(
            Object.entries(removedServerMarks).filter(([id]) => !acceptedIdSet.has(id)),
          );
          this.restoreServerMarkCache(unresolvedServerMarks);
        }
        acceptedIds = [...acceptedIdSet];
        acceptedCount = acceptedIds.length;
        if (acceptedCount <= 0) return;
        const metadata = getMarkMetadataWithQuotes(view.state);
        this.lastReceivedServerMarks = { ...metadata };
        this.initialMarksSynced = true;
        const stats = getAuthorshipStats(view);
        this.notifyHostAuthorshipStatsUpdated(stats);
        this.scheduleShareSuggestionReviewDisplay(view);
      });
      if (acceptedCount <= 0 || acceptedIds.length === 0) return 0;

      runShareSuggestionRestFallback(transport, () => {
        const actor = getCurrentActor();
        void this.reconcileShareSuggestionBatch(acceptedIds, 'accepted', actor).catch((error) => {
          console.error('[markAcceptAll] Failed to persist suggestion acceptance via share mutation:', error);
          void this.recoverAuthoritativeShareMarks(
            error,
            'Unable to accept every suggestion.',
            acceptedIds,
            'accepted',
          );
        });
      });
      captureEvent('suggestion_accepted', { count: acceptedCount });
      return acceptedCount;
    }

    let count = 0;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      const parser = ctx.get(parserCtx);
      count = acceptAll(view, parser);
      console.log('[markAcceptAll] Accepted:', count);
      if (count > 0) {
        captureEvent('suggestion_accepted', { count });
        const stats = getAuthorshipStats(view);
        this.notifyHostAuthorshipStatsUpdated(stats);
      }
    });

    return count;
  }

  /**
   * Reject all pending suggestions
   */
  markRejectAll(): number {
    if (!this.editor) {
      console.warn('[markRejectAll] Editor not initialized');
      return 0;
    }

    if (this.isShareMode) {
      const transport = this.getShareSuggestionResolutionTransport();
      let rejectedIds: string[] = [];
      let rejectedCount = 0;
      this.editor.action((ctx) => {
        const view = markApiView(ctx.get(editorViewCtx));
        rejectedIds = getPendingSuggestions(getMarks(view.state))
          .map((mark) => mark.id)
          .filter((id) => this.isSuggestionPendingOnServer(id));
        if (rejectedIds.length === 0) return;
        const removedServerMarks = this.dropSuggestionIdsFromServerMarkCache(rejectedIds);
        const rejectedIdSet = new Set<string>();
        try {
          this.applyShareSuggestionLocally(transport, () => {
            for (const id of [...rejectedIds].reverse()) {
              if (rejectMark(view, id)) rejectedIdSet.add(id);
            }
          });
        } finally {
          const unresolvedServerMarks = Object.fromEntries(
            Object.entries(removedServerMarks).filter(([id]) => !rejectedIdSet.has(id)),
          );
          this.restoreServerMarkCache(unresolvedServerMarks);
        }
        rejectedIds = rejectedIds.filter((id) => rejectedIdSet.has(id));
        rejectedCount = rejectedIds.length;
        if (rejectedCount <= 0) return;
        const metadata = getMarkMetadataWithQuotes(view.state);
        this.lastReceivedServerMarks = { ...metadata };
        this.initialMarksSynced = true;
        this.scheduleShareSuggestionReviewDisplay(view);
      });

      if (rejectedCount <= 0 || rejectedIds.length === 0) return 0;

      if (transport === 'rest') {
        for (const id of rejectedIds) {
          this.shareRejectedSuggestionIdsBlockedFromAcceptAll.add(id);
        }
      } else {
        for (const id of rejectedIds) {
          this.shareRejectedSuggestionIdsBlockedFromAcceptAll.delete(id);
        }
      }
      runShareSuggestionRestFallback(transport, () => {
        const actor = getCurrentActor();
        void this.reconcileShareSuggestionBatch(rejectedIds, 'rejected', actor).catch((error) => {
          console.error('[markRejectAll] Failed to persist suggestion rejection via share mutation:', error);
          void this.recoverAuthoritativeShareMarks(
            error,
            'Unable to reject every suggestion.',
            rejectedIds,
            'rejected',
          );
        });
      });

      captureEvent('suggestion_rejected', { count: rejectedCount });
      return rejectedCount;
    }

    let count = 0;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      count = rejectAll(view);
      console.log('[markRejectAll] Rejected:', count);
      if (count > 0) {
        captureEvent('suggestion_rejected', { count });
        const stats = getAuthorshipStats(view);
        this.notifyHostAuthorshipStatsUpdated(stats);
      }
    });
    return count;
  }

  /**
   * Delete a mark by ID
   */
  markDelete(markId: string): boolean {
    if (!this.editor) {
      console.warn('[markDelete] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      success = deleteMark(view, markId);
      console.log('[markDelete] Deleted:', success);
    });
    return success;
  }

  /**
   * Set the active mark for highlighting
   */
  markSetActive(markId: string | null): void {
    if (!this.editor) {
      console.warn('[markSetActive] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      setActiveMark(view, markId);
      console.log('[markSetActive] Set active mark:', markId);
    });
  }

  // =====================
  // Authorship (Provenance)
  // =====================

  /**
   * Get authorship statistics for the current document
   * Returns percentage and character count for human vs AI authored content
   */
  getMarkMetadata(): Record<string, unknown> {
    if (!this.editor) return {};
    let metadata: Record<string, unknown> = {};
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      metadata = getMarkMetadata(view.state) as Record<string, unknown>;
    });
    return metadata;
  }

  getMarkMetadataWithQuotes(): Record<string, unknown> {
    if (!this.editor) return {};
    let metadata: Record<string, unknown> = {};
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      metadata = getMarkMetadataWithQuotes(view.state) as Record<string, unknown>;
    });
    return metadata;
  }

  getAuthorshipStats(): { humanPercent: number; aiPercent: number; humanChars: number; aiChars: number } {
    if (!this.editor) {
      return { humanPercent: 0, aiPercent: 0, humanChars: 0, aiChars: 0 };
    }

    let stats = { humanPercent: 0, aiPercent: 0, humanChars: 0, aiChars: 0 };
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      stats = getAuthorshipStats(view);
      console.log('[getAuthorshipStats] Stats:', stats);
    });
    return stats;
  }

  /**
   * Add an authored mark for a range of content
   * Used when AI inserts content via MCP or human types
   */
  addAuthoredMark(by: string, range: MarkRange, quote?: string): Mark {
    if (!this.editor) {
      throw new Error('Editor not initialized');
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      mark = addAuthoredMark(view, by, range, quote);
      console.log('[addAuthoredMark] Created authored mark:', mark.id);
    });
    return mark!;
  }

  /**
   * Override authored marks for the current selection (or block)
   */
  markAuthoredSelection(by: string): Mark | null {
    if (!this.editor) {
      console.warn('[markAuthoredSelection] Editor not initialized');
      return null;
    }

    let mark: Mark | null = null;
    this.editor.action((ctx) => {
      const view = markApiView(ctx.get(editorViewCtx));
      const range = this.getSelectionRangeOrBlock(view);
      if (!range) return;
      mark = setAuthoredMark(view, by, range);
      if (mark) {
        console.log('[markAuthoredSelection] Created authored mark:', mark.id);
      }
    });
    return mark;
  }

  /**
   * Coalesce adjacent authored marks by the same actor
   * Call this periodically (e.g., on save) to reduce mark count
   */
  coalesceMarks(): void {
    if (!this.editor) {
      console.warn('[coalesceMarks] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      coalesceMarks(view);
      console.log('[coalesceMarks] Coalesced marks');
    });
  }

  /**
   * Update mark positions after a document edit
   * This keeps ranges in sync when the document changes
   */
  updateMarksAfterEdit(editFrom: number, editTo: number, newLength: number): void {
    if (!this.editor) {
      console.warn('[updateMarksAfterEdit] Editor not initialized');
      return;
    }

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      updateMarksAfterEdit(view, editFrom, editTo, newLength);
      console.log('[updateMarksAfterEdit] Updated marks after edit:', editFrom, editTo, newLength);
    });
  }

  // === Navigation Methods ===

  /**
   * Navigate to a specific mark by ID
   * Scrolls to the mark position and sets it as active (opens popover)
   */
  navigateToMark(markId: string): boolean {
    if (!this.editor) {
      console.warn('[navigateToMark] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const marks = getMarks(view.state);
      const mark = marks.find(m => m.id === markId);

      if (!mark || !mark.range) {
        console.warn('[navigateToMark] Mark not found:', markId);
        return;
      }

      // Set as active mark (this opens the popover)
      setActiveMark(view, markId);

      // Scroll to the mark position
      const pos = mark.range.from;
      const line = this.lineMarks?.lineAtPos(pos);
      if (line !== undefined && line >= 0) this.folding?.reveal(line);
      const coords = view.coordsAtPos(pos);
      if (coords) {
        const editorRect = view.dom.getBoundingClientRect();
        const scrollTop = view.dom.scrollTop;
        const targetY = coords.top - editorRect.top + scrollTop - (editorRect.height / 3);
        view.dom.scrollTo({ top: Math.max(0, targetY), behavior: 'smooth' });
      }

      console.log('[navigateToMark] Navigated to mark:', markId, 'at position:', pos);
      success = true;
    });

    return success;
  }

  /**
   * Navigate to the first unresolved comment
   */
  navigateToFirstComment(): string | null {
    this.currentCommentIndex = -1;
    return this.navigateToNextComment();
  }

  /**
   * Navigate to the next unresolved comment
   */
  navigateToNextComment(): string | null {
    if (!this.editor) {
      console.warn('[navigateToNextComment] Editor not initialized');
      return null;
    }

    let markId: string | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const allMarks = getMarks(view.state);
      const comments = getUnresolvedMarkComments(allMarks);

      if (comments.length === 0) {
        console.log('[navigateToNextComment] No unresolved comments');
        this.currentCommentIndex = -1;
        return;
      }

      // Sort by position
      const sortedComments = [...comments].sort((a, b) => (a.range?.from ?? 0) - (b.range?.from ?? 0));

      this.currentCommentIndex = (this.currentCommentIndex + 1) % sortedComments.length;
      const mark = sortedComments[this.currentCommentIndex];
      markId = mark.id;
    });

    if (markId) {
      this.navigateToMark(markId);
    }
    return markId;
  }

  /**
   * Navigate to the previous unresolved comment
   */
  navigateToPrevComment(): string | null {
    if (!this.editor) {
      console.warn('[navigateToPrevComment] Editor not initialized');
      return null;
    }

    let markId: string | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const allMarks = getMarks(view.state);
      const comments = getUnresolvedMarkComments(allMarks);

      if (comments.length === 0) {
        console.log('[navigateToPrevComment] No unresolved comments');
        this.currentCommentIndex = -1;
        return;
      }

      // Sort by position
      const sortedComments = [...comments].sort((a, b) => (a.range?.from ?? 0) - (b.range?.from ?? 0));

      this.currentCommentIndex = this.currentCommentIndex <= 0
        ? sortedComments.length - 1
        : this.currentCommentIndex - 1;
      const mark = sortedComments[this.currentCommentIndex];
      markId = mark.id;
    });

    if (markId) {
      this.navigateToMark(markId);
    }
    return markId;
  }

  /**
   * Navigate to the first pending suggestion
   */
  navigateToFirstSuggestion(): string | null {
    this.currentSuggestionIndex = -1;
    return this.navigateToNextSuggestion();
  }

  /**
   * Navigate to the next pending suggestion
   */
  navigateToNextSuggestion(): string | null {
    if (!this.editor) {
      console.warn('[navigateToNextSuggestion] Editor not initialized');
      return null;
    }

    let markId: string | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const suggestions = getPendingSuggestions(getMarks(view.state));

      if (suggestions.length === 0) {
        console.log('[navigateToNextSuggestion] No pending suggestions');
        this.currentSuggestionIndex = -1;
        return;
      }

      // Sort by position
      const sortedSuggestions = [...suggestions].sort((a, b) => (a.range?.from ?? 0) - (b.range?.from ?? 0));

      this.currentSuggestionIndex = (this.currentSuggestionIndex + 1) % sortedSuggestions.length;
      const mark = sortedSuggestions[this.currentSuggestionIndex];
      markId = mark.id;
    });

    if (markId) {
      this.navigateToMark(markId);
    }
    return markId;
  }

  /**
   * Navigate to the previous pending suggestion
   */
  navigateToPrevSuggestion(): string | null {
    if (!this.editor) {
      console.warn('[navigateToPrevSuggestion] Editor not initialized');
      return null;
    }

    let markId: string | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const suggestions = getPendingSuggestions(getMarks(view.state));

      if (suggestions.length === 0) {
        console.log('[navigateToPrevSuggestion] No pending suggestions');
        this.currentSuggestionIndex = -1;
        return;
      }

      // Sort by position
      const sortedSuggestions = [...suggestions].sort((a, b) => (a.range?.from ?? 0) - (b.range?.from ?? 0));

      this.currentSuggestionIndex = this.currentSuggestionIndex <= 0
        ? sortedSuggestions.length - 1
        : this.currentSuggestionIndex - 1;
      const mark = sortedSuggestions[this.currentSuggestionIndex];
      markId = mark.id;
    });

    if (markId) {
      this.navigateToMark(markId);
    }
    return markId;
  }

  /**
   * Resolve the currently active comment (if any)
   * Returns true if a comment was resolved, false if no active comment or not a comment.
   */
  resolveActiveComment(): boolean {
    if (!this.editor) {
      console.warn('[resolveActiveComment] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const activeId = getActiveMarkId(view.state);
      if (!activeId) return;

      const marks = getMarks(view.state);
      const mark = marks.find(m => m.id === activeId);
      if (!mark || mark.kind !== 'comment') return;

      success = markResolve(view, activeId);
      if (success) {
        setActiveMark(view, null);
      }
    });
    return success;
  }

  /**
   * Sweep the document for actionable items (called by always-on timer).
   * Finds unresolved comments needing agent response and triggers the agent.
   */
  sweepForActionableItems(triggerOnFirstSweep = false): void {
    captureEvent('agent_sweep_requested', { trigger_on_first_sweep: triggerOnFirstSweep });
    agentSweep(triggerOnFirstSweep);
  }

  setAlwaysOnEnabled(enabled: boolean): void {
    agentSetAlwaysOnEnabled(enabled);
  }

  // === Find Methods (Cmd+F) ===

  /**
   * Show the find UI.
   */
  showFindBar(): void {
    // The web app uses the toolbar find UI directly.
  }

  /**
   * Hide the find bar
   */
  hideFindBar(): void {
    this.clearFind();
  }

  /**
   * Find text in document, returns match info
   */
  find(query: string): { total: number; current: number } {
    if (!this.editor || !query || query.trim().length === 0) {
      this.findMatches = [];
      this.findQuery = '';
      this.currentFindIndex = -1;
      if (this.editor) {
        this.editor.action((ctx) => {
          const view = ctx.get(editorViewCtx);
          clearFindHighlights(view);
        });
      }
      return { total: 0, current: 0 };
    }

    this.findQuery = query;
    this.findMatches = [];
    this.currentFindIndex = -1;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const matches = findMatchesInDoc(view.state.doc, query, {
        regex: false,
        caseSensitive: false,
        normalizeWhitespace: false,
        maxMatches: 1000,
      });
      this.findMatches = matches.map((match) => ({ from: match.from, to: match.to }));
      if (this.findMatches.length === 0) {
        clearFindHighlights(view);
      }
    });

    // Navigate to first match if any
    if (this.findMatches.length > 0) {
      return this.findNext();
    }

    return { total: 0, current: 0 };
  }

  /**
   * Navigate to next match
   */
  findNext(): { total: number; current: number } {
    if (this.findMatches.length === 0) {
      return { total: 0, current: 0 };
    }

    this.currentFindIndex = (this.currentFindIndex + 1) % this.findMatches.length;
    this.highlightCurrentMatch();

    return { total: this.findMatches.length, current: this.currentFindIndex + 1 };
  }

  /**
   * Navigate to previous match
   */
  findPrev(): { total: number; current: number } {
    if (this.findMatches.length === 0) {
      return { total: 0, current: 0 };
    }

    this.currentFindIndex = this.currentFindIndex <= 0
      ? this.findMatches.length - 1
      : this.currentFindIndex - 1;
    this.highlightCurrentMatch();

    return { total: this.findMatches.length, current: this.currentFindIndex + 1 };
  }

  /**
   * Clear find highlighting
   */
  clearFind(): void {
    this.findQuery = '';
    this.findMatches = [];
    this.currentFindIndex = -1;
    if (!this.editor) return;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      clearFindHighlights(view);
    });
  }

  // =====================
  // Skills & Review
  // =====================

  /**
   * Set the API key for the embedded agent
   */
  setApiKey(apiKey: string): void {
    setAgentApiKey(apiKey);
    console.log('[proof] API key configured');
    captureEvent('agent_api_key_configured', { configured: Boolean(apiKey.trim()) });
  }

  /**
   * Get available review skills
   */
  getSkills(): Array<{
    id: string;
    name: string;
    description: string;
    icon?: string;
    parallelStrategy: string;
    maxAgents?: number;
    batchSize?: number;
    orchestratedVisibleMarks?: boolean;
    promptCharCount: number;
    styleGuideVersion?: string;
    styleGuideCharCount?: number;
  }> {
    const registry = getSkillsRegistry();
    return registry.getAllSkills().map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      icon: skill.icon,
      parallelStrategy: skill.parallelStrategy,
      debugLoop: skill.debugLoop,
      maxAgents: skill.maxAgents,
      batchSize: skill.batchSize,
      orchestratedVisibleMarks: skill.orchestratedVisibleMarks,
      promptCharCount: skill.prompt.length,
      styleGuideVersion: skill.styleGuideVersion,
      styleGuideCharCount: skill.styleGuideCharCount,
    }));
  }

  reviewLock(reason?: string): { locked: boolean; lockCount: number; reason?: string } {
    if (reason) {
      this.reviewLockReason = reason;
    }

    this.reviewLockCount += 1;
    this.ensureReviewLockBanner();
    this.updateEditableState();
    this.scheduleBannerLayoutUpdate();

    return this.getReviewLockState();
  }

  reviewUnlock(): { locked: boolean; lockCount: number } {
    if (this.reviewLockCount > 0) {
      this.reviewLockCount -= 1;
    }

    if (this.reviewLockCount === 0) {
      this.reviewLockReason = null;
      this.removeReviewLockBanner();
    } else {
      this.updateReviewLockBannerText();
      this.scheduleBannerLayoutUpdate();
    }

    this.updateEditableState();
    const { locked, lockCount } = this.getReviewLockState();
    return { locked, lockCount };
  }

  reviewLockStatus(): { locked: boolean; lockCount: number; reason?: string } {
    return this.getReviewLockState();
  }

  isReviewLocked(): boolean {
    return this.reviewLockCount > 0;
  }

  /**
   * Run a skill-based review
   */
  async runSkillReview(skillId: string, scope: 'selection' | 'document'): Promise<void> {
    if (!this.editor) {
      console.error('[proof] Cannot run skill review: editor not initialized');
      captureEvent('review_run_rejected', { reason: 'editor_not_initialized', skill_id: skillId, scope });
      return;
    }

    const registry = getSkillsRegistry();
    const skill = registry.getSkill(skillId);
    if (!skill) {
      console.error(`[proof] Unknown skill: ${skillId}`);
      captureEvent('review_run_rejected', { reason: 'unknown_skill', skill_id: skillId, scope });
      return;
    }

    if (this.reviewInFlight) {
      console.warn(`[proof] Review already running; ignoring request for ${skillId}`);
      captureEvent('review_run_rejected', { reason: 'review_in_flight', skill_id: skill.id, scope });
      return;
    }

    console.log(`[proof] Running skill review: ${skill.name} (${scope})`);
    const startedAt = Date.now();
    let runSucceeded = false;
    let runError: string | undefined;
    captureEvent('review_run_started', {
      skill_id: skill.id,
      scope,
    });

    const actionPromise = this.editor.action(async (ctx) => {
      const view = ctx.get(editorViewCtx);
      const { from, to } = view.state.selection;
      const hasSelection = from !== to;

      // Use selection if available and scope is 'selection', otherwise review whole doc
      const selection = scope === 'selection' && hasSelection ? { from, to } : undefined;

      const reviewPromise = runReview(view, skill, scope, selection);
      try {
        await reviewPromise;
        runSucceeded = true;
        console.log(`[proof] Skill review completed: ${skill.name}`);
      } catch (error) {
        runError = error instanceof Error ? error.name : 'unknown_error';
        console.error(`[proof] Skill review failed: ${skill.name}`, error);
      }
    });

    this.reviewInFlight = actionPromise;
    try {
      await actionPromise;
      captureEvent('review_run_completed', {
        skill_id: skill.id,
        scope,
        success: runSucceeded,
        duration_ms: Date.now() - startedAt,
        error_type: runError ?? 'none',
      });
    } finally {
      if (this.reviewInFlight === actionPromise) {
        this.reviewInFlight = null;
      }
    }
  }

  /**
   * Debug helper: run the orchestrator only and return its focus-area plan.
   * This does not create marks or lock the document.
   */
  async debugPlanOnly(
    skillId: string,
    options?: {
      forceFresh?: boolean;
      cancelActive?: boolean;
      timeoutMs?: number;
      focusAreaIds?: string[];
      maxFocusAreas?: number;
      singleWriter?: boolean;
      visibleProvisionalMarks?: boolean;
      markStrategy?: 'propose' | 'visible-provisional';
      useGlobalConfig?: boolean;
    }
  ): Promise<unknown> {
    if (!this.editor) {
      console.error('[proof] Cannot run plan-only debug: editor not initialized');
      return null;
    }

    const registry = getSkillsRegistry();
    const skill = registry.getSkill(skillId);
    if (!skill) {
      console.error(`[proof] Unknown skill for plan-only debug: ${skillId}`);
      return null;
    }

    if (this.reviewInFlight) {
      console.warn(`[proof] Review already running; ignoring plan-only request for ${skillId}`);
      return null;
    }

    const actionPromise = this.editor.action(async (ctx) => {
      const view = ctx.get(editorViewCtx);
      return debugPlanOnlyReview(view, skill, options);
    });

    this.reviewInFlight = actionPromise;
    try {
      const result = await actionPromise;
      console.log('[proof] Plan-only debug result:', result);
      return result;
    } finally {
      if (this.reviewInFlight === actionPromise) {
        this.reviewInFlight = null;
      }
    }
  }

  /**
   * Debug helper: run exactly one focus area via a single sub-agent.
   * This returns proposals and rejection reasons, but does not create marks.
   */
  async debugRunSingleFocusArea(
    skillId: string,
    options?: {
      focusAreaIndex?: number;
      focusAreaId?: string;
      useCachedPlan?: boolean;
      forceFreshPlan?: boolean;
      cancelActive?: boolean;
      timeoutMs?: number;
      focusAreaIds?: string[];
      maxFocusAreas?: number;
      singleWriter?: boolean;
      visibleProvisionalMarks?: boolean;
      markStrategy?: 'propose' | 'visible-provisional';
      useGlobalConfig?: boolean;
    }
  ): Promise<unknown> {
    if (!this.editor) {
      console.error('[proof] Cannot run single focus-area debug: editor not initialized');
      return null;
    }

    const registry = getSkillsRegistry();
    const skill = registry.getSkill(skillId);
    if (!skill) {
      console.error(`[proof] Unknown skill for single focus-area debug: ${skillId}`);
      return null;
    }

    if (this.reviewInFlight) {
      console.warn(`[proof] Review already running; ignoring single focus-area request for ${skillId}`);
      return null;
    }

    const actionPromise = this.editor.action(async (ctx) => {
      const view = ctx.get(editorViewCtx);
      return debugRunSingleFocusAreaReview(view, skill, options);
    });

    this.reviewInFlight = actionPromise;
    try {
      const result = await actionPromise;
      console.log('[proof] Single focus-area debug result:', result);
      return result;
    } finally {
      if (this.reviewInFlight === actionPromise) {
        this.reviewInFlight = null;
      }
    }
  }

  debugGetCachedPlan(skillId: string): unknown {
    return debugGetCachedPlanReview(skillId);
  }

  debugClearPlanCache(skillId?: string): void {
    debugClearPlanCacheReview(skillId);
  }

  /**
   * Debug helper: run the full orchestrator path with explicit orchestration
   * options (for example, focusAreaIds) so the run matches real behavior.
   */
  async debugRunOrchestrated(
    skillId: string,
    options?: {
      scope?: ReviewScope;
      selection?: { from: number; to: number };
      orchestration?: OrchestrationRunOptions;
      cancelActive?: boolean;
    }
  ): Promise<unknown> {
    if (!this.editor) {
      console.error('[proof] Cannot run orchestrated debug: editor not initialized');
      return null;
    }

    const registry = getSkillsRegistry();
    const skill = registry.getSkill(skillId);
    if (!skill) {
      console.error(`[proof] Unknown skill for orchestrated debug: ${skillId}`);
      return null;
    }

    if (options?.cancelActive) {
      try {
        await cancelActiveReview();
      } catch (error) {
        console.warn('[proof] Failed to cancel active review before orchestrated debug:', error);
      } finally {
        this.reviewInFlight = null;
      }
    }

    if (this.reviewInFlight) {
      console.warn(`[proof] Review already running; ignoring orchestrated debug request for ${skillId}`);
      return null;
    }

    const actionPromise = this.editor.action(async (ctx) => {
      const view = ctx.get(editorViewCtx);
      const scope: ReviewScope = options?.scope ?? 'document';
      const selection = scope === 'selection' ? options?.selection : undefined;
      return runReview(view, skill, scope, selection, options?.orchestration);
    });

    this.reviewInFlight = actionPromise;
    try {
      const result = await actionPromise;
      console.log('[proof] Orchestrated debug result:', result);
      return result;
    } finally {
      if (this.reviewInFlight === actionPromise) {
        this.reviewInFlight = null;
      }
    }
  }

  /**
   * Debug helper: map plain-text offsets to a doc range + quote using the
   * same text index utilities as the orchestrator.
   */
  debugMapTextOffsets(from: number, to: number): { range: MarkRange | null; quote: string | null } | null {
    if (!this.editor) {
      console.error('[proof] Cannot map text offsets: editor not initialized');
      return null;
    }

    let result: { range: MarkRange | null; quote: string | null } | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;
      const docSize = doc.content.size;
      const safeFrom = Number.isFinite(from) ? Math.max(0, Math.floor(from)) : 0;
      const safeTo = Number.isFinite(to) ? Math.max(safeFrom, Math.floor(to)) : safeFrom;

      const index = buildTextIndex(doc);
      const mapped = mapTextOffsetsToRange(index, safeFrom, safeTo);
      if (!mapped) {
        result = { range: null, quote: null };
        return;
      }

      const clampedFrom = Math.max(0, Math.min(mapped.from, docSize));
      const clampedTo = Math.max(clampedFrom, Math.min(mapped.to, docSize));
      const clampedRange: MarkRange = { from: clampedFrom, to: clampedTo };
      const quote = getTextForRange(doc, clampedRange);
      result = { range: clampedRange, quote };
    });

    return result;
  }

  /**
   * Debug helper: describe textblock boundaries intersecting a given doc range.
   * Useful for diagnosing structural safety checks.
   */
  debugDescribeTextblocks(range: { from: number; to: number }): unknown {
    if (!this.editor) {
      console.error('[proof] Cannot describe textblocks: editor not initialized');
      return null;
    }

    let result: unknown = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;
      const docSize = doc.content.size;
      const safeFrom = Number.isFinite(range?.from) ? Math.max(0, Math.floor(range.from)) : 0;
      const safeTo = Number.isFinite(range?.to) ? Math.max(safeFrom, Math.floor(range.to)) : safeFrom;
      const clampedFrom = Math.max(0, Math.min(safeFrom, docSize));
      const clampedTo = Math.max(clampedFrom, Math.min(safeTo, docSize));

      const slices: Array<{
        from: number;
        to: number;
        text: string;
        leadingWhitespace: number;
        trailingWhitespace: number;
        fullyCovered: boolean;
      }> = [];

      doc.nodesBetween(clampedFrom, clampedTo, (node, pos) => {
        if (!node.isTextblock) return;
        const from = pos + 1;
        const to = pos + node.content.size;
        if (clampedTo <= from || clampedFrom >= to) return;
        const text = doc.textBetween(from, to, '\n', '\n');
        const leadingWhitespace = text.match(/^\s+/)?.[0].length ?? 0;
        const trailingWhitespace = text.match(/\s+$/)?.[0].length ?? 0;
        const fullyCovered = clampedFrom <= from && clampedTo >= to;
        slices.push({ from, to, text, leadingWhitespace, trailingWhitespace, fullyCovered });
      });

      result = {
        docSize,
        range: { from: clampedFrom, to: clampedTo },
        slices,
      };
    });

    return result;
  }

  debugTextForRange(range: MarkRange): { range: MarkRange; text: string } | null {
    if (!this.editor) {
      console.error('[proof] Cannot read text for range: editor not initialized');
      return null;
    }
    const safeRange: MarkRange = {
      from: Math.max(0, Math.floor(range?.from ?? 0)),
      to: Math.max(0, Math.floor(range?.to ?? 0)),
    };
    if (safeRange.to < safeRange.from) {
      safeRange.to = safeRange.from;
    }

    let result: { range: MarkRange; text: string } | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;
      const docSize = doc.content.size;
      const clamped: MarkRange = {
        from: Math.max(0, Math.min(safeRange.from, docSize)),
        to: Math.max(0, Math.min(safeRange.to, docSize)),
      };
      if (clamped.to < clamped.from) {
        clamped.to = clamped.from;
      }
      const text = doc.textBetween(clamped.from, clamped.to, '\n', '\n');
      result = { range: clamped, text };
    });
    return result;
  }

  debugGetParagraphCandidate(minWords: number = 8): { range: MarkRange; quote: string; line: number } | null {
    if (!this.editor) {
      console.error('[proof] Cannot get paragraph candidate: editor not initialized');
      return null;
    }

    let candidate: { range: MarkRange; quote: string; line: number } | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;
      const docSize = doc.content.size;
      let currentLine = 0;

      doc.descendants((node, pos) => {
        if (!node.isBlock) return true;

        if (!candidate && node.type.name === 'paragraph') {
          const words = node.textContent.split(/\s+/).filter(w => w.length > 0);
          if (words.length >= Math.max(1, Math.floor(minWords))) {
            const from = Math.max(0, Math.min(pos + 1, docSize));
            const to = Math.max(from, Math.min(pos + node.content.size + 1, docSize));
            candidate = {
              range: { from, to },
              quote: node.textContent,
              line: currentLine,
            };
            return false;
          }
        }

        currentLine += 1;
        return true;
      });
    });

    return candidate;
  }

  debugFindBlockByText(text: string): { range: MarkRange; nodeType: string; line: number } | null {
    if (!this.editor) {
      console.error('[proof] Cannot find block by text: editor not initialized');
      return null;
    }

    const target = String(text ?? '').trim();
    if (!target) return null;

    let match: { range: MarkRange; nodeType: string; line: number } | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;
      const docSize = doc.content.size;
      let currentLine = 0;

      doc.descendants((node, pos) => {
        if (!node.isBlock) return true;

        if (!match && node.textContent.trim() === target) {
          const from = Math.max(0, Math.min(pos + 1, docSize));
          const to = Math.max(from, Math.min(pos + node.content.size + 1, docSize));
          match = {
            range: { from, to },
            nodeType: node.type.name,
            line: currentLine,
          };
          return false;
        }

        currentLine += 1;
        return true;
      });
    });

    return match;
  }

  debugInspectMarksForText(target: string): {
    found: boolean;
    range?: MarkRange;
    markNames?: string[];
    hasEm?: boolean;
    hasStrong?: boolean;
  } | null {
    if (!this.editor) {
      console.error('[proof] Cannot inspect marks: editor not initialized');
      return null;
    }

    const needle = String(target ?? '').trim();
    if (!needle) return null;

    let result: {
      found: boolean;
      range?: MarkRange;
      markNames?: string[];
      hasEm?: boolean;
      hasStrong?: boolean;
    } | null = null;

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const doc = view.state.doc;
      const index = buildTextIndex(doc);
      if (!index) {
        result = { found: false };
        return;
      }

      const start = index.text.indexOf(needle);
      if (start === -1) {
        result = { found: false };
        return;
      }

      const end = start + needle.length;
      const mapped = mapTextOffsetsToRange(index, start, end);
      if (!mapped) {
        result = { found: false };
        return;
      }

      const range: MarkRange = { from: mapped.from, to: mapped.to };
      const markNames = new Set<string>();

      doc.nodesBetween(range.from, range.to, (node) => {
        if (!node.isText) return;
        for (const mark of node.marks) {
          markNames.add(mark.type.name);
        }
      });

      const names = Array.from(markNames);
      result = {
        found: true,
        range,
        markNames: names,
        hasEm: markNames.has('em') || markNames.has('italic') || markNames.has('emphasis'),
        hasStrong: markNames.has('strong'),
      };
    });

    return result;
  }

  debugResolveRangeWithValidation(quote: string, range?: MarkRange): unknown {
    if (!this.editor) {
      console.error('[proof] Cannot resolve range: editor not initialized');
      return null;
    }

    let result: unknown = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      result = debugResolveRangeWithValidationMark(view.state.doc, quote, range);
    });
    return result;
  }

  debugAnalyzeReplace(quote: string, content: string, range?: MarkRange): unknown {
    if (!this.editor) {
      console.error('[proof] Cannot analyze replace: editor not initialized');
      return null;
    }

    let result: unknown = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const parser = ctx.get(parserCtx);
      result = debugAnalyzeReplaceMark(view, quote, content, range, parser);
    });
    return result;
  }

  debugQuoteSpansMultipleTableCells(quote: string, range?: MarkRange): boolean {
    if (!this.editor) {
      console.error('[proof] Cannot check table-cell boundary: editor not initialized');
      return false;
    }

    let spansMultipleCells = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const resolvedRange = range ?? resolveQuoteRange(view.state.doc, quote);
      if (!resolvedRange) {
        spansMultipleCells = false;
        return;
      }
      spansMultipleCells = rangeCrossesTableCellBoundary(view.state.doc, resolvedRange);
    });

    return spansMultipleCells;
  }

  async cancelReview(): Promise<void> {
    captureEvent('review_cancel_requested', {});
    let cancelled = false;
    try {
      await cancelActiveReview();
      cancelled = true;
    } catch (error) {
      console.error('[proof] Failed to cancel review:', error);
    } finally {
      this.reviewInFlight = null;
      captureEvent('review_cancel_completed', { success: cancelled });
    }
  }

  async stopAllReviews(): Promise<{ cancelledSessions: number; unlocked: boolean; lockCount: number }> {
    captureEvent('review_stop_all_requested', {});
    let cancelledSessions = 0;

    try {
      await cancelActiveReview();
    } catch (error) {
      console.error('[proof] Failed to cancel active review executor:', error);
    }

    try {
      const result = await cancelAllAgentSessions();
      cancelledSessions = Number(result?.count ?? 0) || 0;
    } catch (error) {
      console.error('[proof] Failed to cancel agent sessions:', error);
    } finally {
      // Ensure the UI can launch a fresh review even if a prior promise is hung.
      this.reviewInFlight = null;
    }

    // Force-clear review locks that can get stuck during provider outages.
    let lockState = this.reviewLockStatus();
    let unlockAttempts = 0;
    const maxUnlockAttempts = 12;
    while (lockState.locked && unlockAttempts < maxUnlockAttempts) {
      this.reviewUnlock();
      unlockAttempts += 1;
      lockState = this.reviewLockStatus();
    }

    if (lockState.locked) {
      console.warn(
        `[proof] stopAllReviews: review lock still held after ${unlockAttempts} unlock attempts (lockCount=${lockState.lockCount}).`
      );
    } else {
      console.log(
        `[proof] stopAllReviews: cancelledSessions=${cancelledSessions} unlockAttempts=${unlockAttempts}.`
      );
    }

    captureEvent('review_stop_all_completed', {
      cancelled_sessions: cancelledSessions,
      unlocked: !lockState.locked,
      lock_count: lockState.lockCount,
      unlock_attempts: unlockAttempts,
    });

    return {
      cancelledSessions,
      unlocked: !lockState.locked,
      lockCount: lockState.lockCount,
    };
  }

  /**
   * Helper: Highlight and scroll to current match
   */
  private highlightCurrentMatch(): void {
    if (!this.editor || this.currentFindIndex < 0 || this.currentFindIndex >= this.findMatches.length) {
      return;
    }

    const match = this.findMatches[this.currentFindIndex];

    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const docSize = view.state.doc.content.size;
      const from = Math.max(0, Math.min(match.from, docSize));
      const to = Math.max(from, Math.min(match.to, docSize));
      const line = this.lineMarks?.lineAtPos(from);
      if (line !== undefined && line >= 0) this.folding?.reveal(line);
      const selection = TextSelection.create(view.state.doc, from, to);
      const tr = view.state.tr.setSelection(selection);
      view.dispatch(tr);
      setFindHighlights(view, this.findMatches, this.currentFindIndex);

      this.scrollFindMatchIntoView(view, from);

      console.log('[find] Highlighted match', this.currentFindIndex + 1, 'of', this.findMatches.length);
    });
  }

  private getFindScrollParent(view: EditorView): HTMLElement | null {
    const dom = view.dom as HTMLElement;
    let current: HTMLElement | null =
      (dom.closest('#editor') as HTMLElement)
      || (dom.closest('#editor-container') as HTMLElement)
      || (dom.closest('.editor') as HTMLElement)
      || (dom.closest('#app') as HTMLElement)
      || dom.parentElement;

    while (current) {
      const style = window.getComputedStyle(current);
      const overflowY = style.overflowY;
      if ((overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay')
          && current.scrollHeight > current.clientHeight) {
        return current;
      }
      current = current.parentElement;
    }

    return document.scrollingElement as HTMLElement | null;
  }

  private scrollFindMatchIntoView(view: EditorView, pos: number): void {
    const docSize = view.state.doc.content.size;
    const clampedPos = Math.max(0, Math.min(pos, docSize));
    const coords = view.coordsAtPos(clampedPos);
    if (!coords) return;

    const scrollParent = this.getFindScrollParent(view);
    if (!scrollParent) return;

    const scrollingElement = document.scrollingElement as HTMLElement | null;
    const isDocumentScroll = scrollingElement !== null && scrollParent === scrollingElement;
    const viewportHeight = isDocumentScroll ? window.innerHeight : scrollParent.clientHeight;
    const currentScrollTop = isDocumentScroll ? window.scrollY : scrollParent.scrollTop;
    const relativeTop = isDocumentScroll
      ? coords.top
      : coords.top - scrollParent.getBoundingClientRect().top;
    const targetY = currentScrollTop + relativeTop - (viewportHeight / 3);
    const maxScrollTop = isDocumentScroll
      ? Math.max(0, (scrollingElement?.scrollHeight ?? 0) - window.innerHeight)
      : Math.max(0, scrollParent.scrollHeight - scrollParent.clientHeight);
    const top = Math.max(0, Math.min(targetY, maxScrollTop));

    if (isDocumentScroll) {
      window.scrollTo({ top, behavior: 'auto' });
    } else {
      scrollParent.scrollTo({ top, behavior: 'auto' });
    }
  }

  // =====================
  // Input Simulation (Agent-Native Testing)
  // =====================

  /**
   * Set cursor to a specific document position
   * @param position - Document offset position
   * @returns true if successful
   */
  setCursor(position: number): boolean {
    if (!this.editor) {
      console.warn('[setCursor] Editor not initialized');
      return false;
    }

    let success = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const docSize = view.state.doc.content.size;
      const clampedPos = Math.max(0, Math.min(position, docSize));

      try {
        // @ts-expect-error - TextSelection is available
        const TextSelection = view.state.selection.constructor;
        const $pos = view.state.doc.resolve(clampedPos);
        const selection = TextSelection.near($pos);
        const tr = view.state.tr.setSelection(selection);
        view.dispatch(tr);
        view.focus();
        success = true;
        console.log('[setCursor] Set cursor to position:', clampedPos);
      } catch (e) {
        console.error('[setCursor] Error:', e);
      }
    });
    return success;
  }

  /**
   * Set cursor after a specific quote in the document
   * @param quote - Text to find
   * @returns Position after the quote, or null if not found
   */
  setCursorAfterQuote(quote: string): number | null {
    if (!this.editor) {
      console.warn('[setCursorAfterQuote] Editor not initialized');
      return null;
    }

    let resultPos: number | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const range = resolveQuoteRange(view.state.doc, quote);

      if (range) {
        resultPos = range.to;
        // @ts-expect-error - TextSelection is available
        const TextSelection = view.state.selection.constructor;
        const $pos = view.state.doc.resolve(range.to);
        const selection = TextSelection.near($pos);
        const tr = view.state.tr.setSelection(selection);
        view.dispatch(tr);
        view.focus();
        console.log('[setCursorAfterQuote] Set cursor after:', quote, 'at position:', range.to);
      } else {
        console.warn('[setCursorAfterQuote] Quote not found:', quote);
      }
    });
    return resultPos;
  }

  /**
   * Simulate a keypress in the editor
   * Supports: Enter, Backspace, Delete, Tab, Escape, ArrowUp/Down/Left/Right
   * @param key - Key name to simulate
   * @returns true if the key was handled
   */
  simulateKeypress(key: string): boolean {
    if (!this.editor) {
      console.warn('[simulateKeypress] Editor not initialized');
      return false;
    }

    let handled = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const { from, to } = state.selection;

      let tr = state.tr;

      switch (key.toLowerCase()) {
        case 'enter':
        case 'return': {
          // Insert a newline/paragraph break
          // Check if we're in a code block or just need a hard break
          const $from = state.doc.resolve(from);
          const parent = $from.parent;

          if (parent.type.name === 'code_block') {
            // In code block, just insert newline
            tr = tr.insertText('\n', from, to);
          } else {
            // Split the block (create new paragraph)
            const canSplit = tr.doc.resolve(from).parent.type.spec.content?.includes('block');
            if (canSplit || tr.doc.resolve(from).depth > 0) {
              tr = tr.split(from);
            } else {
              // Fallback: insert hard break
              const hardBreak = state.schema.nodes.hard_break;
              if (hardBreak) {
                tr = tr.replaceSelectionWith(hardBreak.create());
              } else {
                tr = tr.insertText('\n', from, to);
              }
            }
          }
          handled = true;
          break;
        }

        case 'backspace': {
          if (from === to && from > 0) {
            // Delete character before cursor
            tr = tr.delete(from - 1, from);
            handled = true;
          } else if (from !== to) {
            // Delete selection
            tr = tr.delete(from, to);
            handled = true;
          }
          break;
        }

        case 'delete': {
          const docSize = state.doc.content.size;
          if (from === to && to < docSize) {
            // Delete character after cursor
            tr = tr.delete(from, from + 1);
            handled = true;
          } else if (from !== to) {
            // Delete selection
            tr = tr.delete(from, to);
            handled = true;
          }
          break;
        }

        case 'tab': {
          // Insert tab character or spaces
          tr = tr.insertText('  ', from, to); // 2 spaces
          handled = true;
          break;
        }

        case 'arrowleft': {
          if (from > 0) {
            // @ts-expect-error - TextSelection is available
            const TextSelection = state.selection.constructor;
            const $pos = state.doc.resolve(from - 1);
            tr = tr.setSelection(TextSelection.near($pos));
            handled = true;
          }
          break;
        }

        case 'arrowright': {
          const docSize = state.doc.content.size;
          if (to < docSize) {
            // @ts-expect-error - TextSelection is available
            const TextSelection = state.selection.constructor;
            const $pos = state.doc.resolve(to + 1);
            tr = tr.setSelection(TextSelection.near($pos));
            handled = true;
          }
          break;
        }

        default:
          console.warn('[simulateKeypress] Unknown key:', key);
          break;
      }

      if (handled && tr.docChanged || tr.selectionSet) {
        view.dispatch(tr);
        console.log('[simulateKeypress] Handled key:', key);
      }
    });

    return handled;
  }

  /**
   * Type text at the current cursor position
   * @param text - Text to insert
   * @returns true if successful
   */
  simulateTyping(text: string): boolean {
    if (!this.editor) {
      console.warn('[simulateTyping] Editor not initialized');
      return false;
    }

    if (!text) return false;

    let success = false;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { state } = view;
      const { from, to } = state.selection;

      const tr = state.tr.insertText(text, from, to);
      view.dispatch(tr);
      success = true;
      console.log('[simulateTyping] Typed:', text);
    });

    return success;
  }

  /**
   * Get current cursor position
   * @returns Current cursor position info
   */
  getCursorPosition(): { from: number; to: number; isCollapsed: boolean } | null {
    if (!this.editor) {
      console.warn('[getCursorPosition] Editor not initialized');
      return null;
    }

    let result: { from: number; to: number; isCollapsed: boolean } | null = null;
    this.editor.action((ctx) => {
      const view = ctx.get(editorViewCtx);
      const { from, to } = view.state.selection;
      result = { from, to, isCollapsed: from === to };
    });

    return result;
  }
}

// Initialize global proof instance
window.proof = new ProofEditorImpl();
const externalAgentHooks = (window as any).__proofExternalAgentHooks;
if (externalAgentHooks && typeof externalAgentHooks === 'object') {
  Object.assign(window.proof, externalAgentHooks);
}

// Minimal browser-agent hook. Only exposed on share pages (/d/:slug).
if (window.location?.pathname?.startsWith('/d/')) {
  (window as any).__PROOF_EDITOR__ = {
    getMarkdown: () => (window.proof.getMarkdownSnapshot()?.content ?? ''),
    insertMarkdown: (markdown: string) => window.proof.insertAtCursor(markdown, 'ai:browser-agent'),
    replaceSelection: (markdown: string) => window.proof.replaceSelection(markdown, 'ai:browser-agent'),
    focus: () => {
      try {
        const el = document.querySelector('#editor .ProseMirror') as HTMLElement | null;
        el?.focus();
      } catch {
        // ignore focus failures
      }
    },
  };
}

// Expose freeform prompt for sidebar
(window as any).sendAgentPrompt = (prompt: string) => {
  // Refresh document content before triggering so the agent sees current state
  try {
    const impl = window.proof as ProofEditorImpl;
    if (impl?.editor) {
      const view = impl.editor.ctx.get(editorViewCtx);
      if (view?.state?.doc) {
        getTriggerService().updateDocumentContent(
          view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
        );
      }
    }
  } catch (e) {
    console.warn('[sendAgentPrompt] Could not refresh doc content:', e);
  }
  getTriggerService().handleFreeformPrompt(prompt);
};

// Expose agent status and debug helpers for the web runtime
(window as any).getAgentStatus = getAgentStatus;
(window as any).getAgentSessionsSummary = getAgentSessionsSummary;
(window as any).cancelAllAgentSessions = cancelAllAgentSessions;
(window as any).validateMarkAnchors = () => window.proof.validateMarkAnchors();
(window as any).debugPlanOnly = (skillId: string, options?: unknown) => window.proof.debugPlanOnly(skillId, options);
(window as any).debugRunSingleFocusArea = (skillId: string, options?: unknown) =>
  window.proof.debugRunSingleFocusArea(skillId, options);
(window as any).debugGetCachedPlan = (skillId: string) => window.proof.debugGetCachedPlan(skillId);
(window as any).debugClearPlanCache = (skillId?: string) => window.proof.debugClearPlanCache(skillId);
(window as any).debugRunOrchestrated = (skillId: string, options?: unknown) =>
  window.proof.debugRunOrchestrated(skillId, options);
(window as any).debugMapTextOffsets = (from: number, to: number) => window.proof.debugMapTextOffsets(from, to);
(window as any).debugDescribeTextblocks = (from: number, to: number) =>
  window.proof.debugDescribeTextblocks({ from, to });
(window as any).debugTextForRange = (from: number, to: number) =>
  window.proof.debugTextForRange({ from, to });
(window as any).debugGetParagraphCandidate = (minWords?: number) =>
  window.proof.debugGetParagraphCandidate(minWords);
(window as any).debugFindBlockByText = (text: string) => window.proof.debugFindBlockByText(text);
(window as any).debugInspectMarksForText = (text: string) => window.proof.debugInspectMarksForText(text);
(window as any).debugResolveRangeWithValidation = (quote: string, range?: MarkRange) =>
  window.proof.debugResolveRangeWithValidation(quote, range);
(window as any).debugAnalyzeReplace = (quote: string, content: string, range?: MarkRange) =>
  window.proof.debugAnalyzeReplace(quote, content, range);

// Comment navigation shortcuts for devtools/testing hooks
(window as any).navigateNextComment = () => window.proof.navigateToNextComment();
(window as any).navigatePrevComment = () => window.proof.navigateToPrevComment();
(window as any).resolveActiveComment = () => window.proof.resolveActiveComment();

// Auto-initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('[INIT] DOMContentLoaded - calling init()');
    window.proof.init();
  });
} else {
  console.log('[INIT] DOM ready - calling init() immediately');
  window.proof.init();
}

export default window.proof;
