/**
 * Proof Documents — Step B7: chat in the right rail (pure code, shared by the browser and the server).
 *
 * Authorship: requirement by Mike Wolf ("A Proof document has a chat sidebar. The sidebar can be
 * closed or open. It must be usable on mobile." and, 18 Sept, "room on the right for a chat
 * panel"); the COS's proposal (any team member posts; a message points at lines; an AI's reply
 * that proposes an edit lands as a suggestion; a bottom sheet on a phone); built by Claude Opus 5
 * (worker proof-chat), 2026-09-19. POLICY rules are Claude's decisions where the spec is silent.
 *
 * Chat lives BESIDE the document, in its own table. It never writes into the document's text or
 * its Yjs state (the earlier "Verso chat" was rolled back while a client-server write loop was
 * investigated). A message that proposes a change asks the server to create a normal suggestion
 * (the same route an AI would call) and links to it; the page never edits the text for chat.
 */
import type { LineAnchor } from './line-marks.js';

export const CHAT_POLICY = {
  /** Longest message text (characters). */
  maxText: 4000,
  /** Most line pointers on one message. */
  maxLines: 20,
  /** Most @-mentions recorded on one message. */
  maxMentions: 20,
  /** GET /chat returns at most this many messages per call (default 100). */
  maxPage: 200,
  defaultPage: 100,
  /** The page polls for new messages this often while visible (a room broadcast also wakes it). */
  pollMs: 4000,
  /** Writing needs comment access (as for a comment); guests may chat under their typed name. */
  whoMayPost: 'commenter' as const,
  /** Chatting does not make someone a team member (it is not reviewing). */
  chatJoinsTeam: false,
  /** Chat is never an Issue; an unread @mention shows only as a badge (rail toggle, phone ⋯). */
  chatIsIssue: false,
  /** Explain (E) and "Ask why" also post a chat message linked to their comment thread. */
  mirrorExplain: true,
  mirrorAskWhy: true,
  /** A message with a suggestion but no pointers points at the suggestion's line. */
  suggestionPointsAtItsLine: true,
  /** Message kinds. */
  kinds: ['message', 'explain', 'why'] as const,
  /**
   * Desktop: an empty chat starts folded (header only) in windows shorter than this, unless the
   * reader has opened or folded it themselves (remembered per browser).
   */
  foldEmptyChatBelowHeightPx: 860,
  /** Characters of a quoted reply shown above a reply. */
  replyExcerpt: 80,
} as const;

export type ChatKind = typeof CHAT_POLICY.kinds[number];

export interface ChatSuggestionRef {
  markId: string;
  kind: 'replace' | 'insert' | 'delete';
  quote: string;
  content: string | null;
  why: string | null;
}

export interface ProofChatMessage {
  /** Increasing integer (the cursor for GET /chat?after=). */
  id: number;
  by: string;
  text: string;
  kind: ChatKind;
  /** Line pointers, stored as line anchors (they follow their lines like marks do). */
  lines: LineAnchor[];
  mentions: string[];
  replyTo: number | null;
  /** The suggestion this message proposed (created by the server). */
  suggestion: ChatSuggestionRef | null;
  /** The comment thread this message mirrors (Explain, Ask why). */
  commentMarkId: string | null;
  createdAt: string;
}

export function isChatKind(value: unknown): value is ChatKind {
  return typeof value === 'string' && (CHAT_POLICY.kinds as readonly string[]).includes(value);
}

/** Trims and bounds a message's text; keeps its line breaks. Returns '' when nothing is left. */
export function cleanChatText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, CHAT_POLICY.maxText);
}

// ============================================================================
// Markdown-lite: links, `code`, **bold** (and line breaks). Rendered as DOM, never as HTML.
// ============================================================================

export type ChatSegment =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'bold'; text: string }
  | { type: 'link'; text: string; href: string }
  | { type: 'mention'; text: string };

const SAFE_URL = /^https?:\/\/[^\s<>"'`]+$/i;

export function safeHref(url: string): string | null {
  const trimmed = url.trim().replace(/[.,;:!?)\]]+$/, '');
  if (!SAFE_URL.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Splits a message into segments. Recognised, in this order: `code`, [text](http…), **bold**,
 * a bare http(s) URL, and @mentions of the given names (longest first). Everything else is text.
 */
export function tokenizeChat(text: string, mentionNames: readonly string[] = []): ChatSegment[] {
  const out: ChatSegment[] = [];
  const push = (seg: ChatSegment) => {
    const last = out[out.length - 1];
    if (seg.type === 'text' && last?.type === 'text') { last.text += seg.text; return; }
    if (seg.type === 'text' && !seg.text) return;
    out.push(seg);
  };
  const names = [...new Set(mentionNames.filter(n => n && n.length <= 80))].sort((a, b) => b.length - a.length);
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    // `code`
    let m = /^`([^`\n]{1,500})`/.exec(rest);
    if (m) { push({ type: 'code', text: m[1] }); i += m[0].length; continue; }
    // [label](url)
    m = /^\[([^\]\n]{1,200})\]\(([^)\s]{1,2000})\)/.exec(rest);
    if (m) {
      const href = safeHref(m[2]);
      if (href) { push({ type: 'link', text: m[1], href }); i += m[0].length; continue; }
    }
    // **bold**
    m = /^\*\*([^*\n][^*\n]{0,499}?)\*\*/.exec(rest);
    if (m) { push({ type: 'bold', text: m[1] }); i += m[0].length; continue; }
    // bare URL (only at a word start)
    if ((i === 0 || /[\s(]/.test(text[i - 1])) && /^https?:\/\//i.test(rest)) {
      m = /^https?:\/\/[^\s<>"'`]+/i.exec(rest);
      if (m) {
        const raw = m[0].replace(/[.,;:!?)\]]+$/, '');
        const href = safeHref(raw);
        if (href) { push({ type: 'link', text: raw, href }); i += raw.length; continue; }
      }
    }
    // @mention of a known name
    if (text[i] === '@' && (i === 0 || !/[\w.]/.test(text[i - 1]))) {
      const name = names.find(n => rest.slice(1, 1 + n.length).toLowerCase() === n.toLowerCase() && !/[\w-]/.test(rest.charAt(1 + n.length)));
      if (name) { push({ type: 'mention', text: rest.slice(0, 1 + name.length) }); i += 1 + name.length; continue; }
    }
    push({ type: 'text', text: text[i] });
    i += 1;
  }
  return out;
}

// ============================================================================
// Mentions
// ============================================================================

export interface MentionCandidate {
  actor: string;
  /** Names that mention this actor when typed after @ (the label first). */
  names: string[];
}

/** The names that mention an actor: its label, its bare id (ai:claude-cos → claude-cos), an email's user. */
export function mentionNamesFor(actor: string, label: string): string[] {
  const names = new Set<string>();
  const clean = (s: string) => s.replace(/\s*\(guest\)\s*$/i, '').trim();
  if (label) names.add(clean(label));
  const body = actor.replace(/^(human|ai|guest):/i, '').trim();
  if (body && !body.includes('@')) names.add(body);
  if (/^ai:/i.test(actor)) names.add(body.replace(/-/g, ' '));
  return [...names].filter(n => n.length >= 2 && n.length <= 80);
}

/** Every candidate mentioned as @name in the text (longest names win; each actor once). */
export function findMentions(text: string, candidates: readonly MentionCandidate[]): string[] {
  const pairs = candidates.flatMap(c => c.names.map(name => ({ actor: c.actor, name })))
    .sort((a, b) => b.name.length - a.name.length);
  const found: string[] = [];
  const lower = text.toLowerCase();
  let at = lower.indexOf('@');
  while (at >= 0) {
    if (at === 0 || !/[\w.]/.test(text[at - 1])) {
      const hit = pairs.find(p => lower.startsWith(p.name.toLowerCase(), at + 1) && !/[\w-]/.test(text.charAt(at + 1 + p.name.length)));
      if (hit && !found.some(a => a.toLowerCase() === hit.actor.toLowerCase())) found.push(hit.actor);
    }
    at = lower.indexOf('@', at + 1);
  }
  return found.slice(0, CHAT_POLICY.maxMentions);
}

/** The partial @name being typed at the caret (for the composer's suggestions), or null. */
export function mentionQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const m = /(^|[^\w.])@([^@\n]{0,40})$/.exec(before);
  if (!m) return null;
  const query = m[2];
  // A query stops at two spaces or when it already reads like a sentence.
  if (/\s{2}/.test(query) || query.split(/\s+/).length > 3) return null;
  return { start: caret - query.length - 1, query };
}

/** Unread @mentions of `viewer`: messages after `lastRead` by someone else that mention them. */
export function unreadMentions(messages: readonly ProofChatMessage[], viewer: string, lastRead: number, key: (actor: string) => string): number {
  const me = key(viewer);
  if (!me) return 0;
  return messages.filter(m => m.id > lastRead && key(m.by) !== me && m.mentions.some(a => key(a) === me)).length;
}
