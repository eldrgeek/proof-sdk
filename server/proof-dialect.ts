/**
 * Proof Documents — export and import in the Proof dialect (and CriticMarkup), server side.
 * The codec is pure (src/shared/proof-dialect.ts); this module reads every mark stored beside a
 * document and writes a Proof Document, and imports one into a new document.
 *
 * Authorship: Mike Wolf specified the dialect and ruled on its form (2026-09-19); built by Claude
 * Opus 5 (worker proof-dialect), 2026-09-19. Policies are named constants below
 * (EXPORT_POLICY, IMPORT_POLICY) so a later ruling is a one-line change.
 *
 * SECURITY (import): a file can claim anything. An import writes a mark in someone's name only
 * when the importer may act as that person (IMPORT_POLICY.mayActAs):
 *   - the operator credential (the /share/markdown API key, like the owner credential) may act as
 *     anyone named in the file's handle table;
 *   - a signed-in person (the library's New document → Import) may act only as themselves;
 *   - anyone else (no credential) acts only as "guest:importer".
 * A suggestion or comment by someone the importer may not act as is imported under a guest name
 * ("guest:<handle>", shown "(guest)"): a proposal, never an attestation. Every attestation (a
 * line mark, a tier, a flag, a time-to-live, an ask or its answer, an objection) by such a person
 * becomes a history note on its line: listed in /state as `dialectHistory`, exported as
 * {history mark="…" claimed="…"}, never counted, and never turned back into a mark by a later
 * import (a history group always imports as history). {do} lines, Familiar proxies,
 * alternatives and picks always import as history (IMPORT_POLICY.alwaysHistory): a file must not
 * be able to propose an executable action, bind a Familiar, or settle a wording by unanimity.
 */
import { randomUUID } from 'crypto';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import {
  addDocumentEvent,
  assertWritesAllowed,
  getDb,
  getDocumentBySlug,
  replaceDocumentLineMark,
} from './db.js';
import { executeDocumentOperationAsync, patchStoredMarksAsync, stripMarkdownWithMapping } from './document-engine.js';
import { stripAllProofSpanTags } from './proof-span-strip.js';
import { buildIssueReport, computeServerLines, listCanonicalLineMarks, type IssueReport } from './line-marks.js';
import { answerAsk, buildAskReport, createAskOnLine, listCanonicalAsks } from './asks.js';
import { askTeamActors } from '../src/shared/asks.js';
import { listProxyMarks } from './proxy-marks.js';
import { writeTiers } from './line-tiers.js';
import { createObjection, recordSuggestionNote, writeFlag } from './review-aids.js';
import { addToBundle, setTtl } from './proof-extras.js';
import {
  actorKey,
  anchorForLine,
  hashLine,
  isAiActor,
  isMarkVia,
  lineOfReviewMark,
  normalizeLineText,
  resolveLineAnchor,
  type DocLine,
  type LineAnchor,
  type LineMark,
} from '../src/shared/line-marks.js';
import { isGuestActor } from '../src/shared/identity.js';
import {
  CRITIC_POLICY,
  DIALECT_POLICY,
  alignLines,
  blockLinesFromMdast,
  buildHandleTable,
  countOccurrences,
  handleForActor,
  looksLikeCriticMarkup,
  parseCriticMarkup,
  parseMarkGroup,
  parseProofDocument,
  planInlineMarks,
  serializeCriticMarkup,
  serializeFrontMatter,
  serializeMarkGroup,
  serializeProofDocument,
  splitFrontMatter,
  visibleFragment,
  type BlockLine,
  type CriticMarkOut,
  type HandleTable,
  type InlineMark,
  type InlineMarkOut,
  type LineGroups,
  type MarkGroup,
  type MdNode,
  type ParsedProofDocument,
  type YamlValue,
} from '../src/shared/proof-dialect.js';

// ============================================================================
// POLICY
// ============================================================================

export const EXPORT_FORMATS = ['proof-dialect', 'criticmarkup', 'plain'] as const;
export type ExportFormat = typeof EXPORT_FORMATS[number];

export const EXPORT_POLICY = {
  formats: EXPORT_FORMATS,
  /** "authored" (who wrote which text) marks are noisy; written only with ?authored=1. */
  authoredByDefault: false,
  /** Status marks written without via= are "api" (the default). */
  defaultVia: 'api',
  /**
   * While blind marking is on, an export by anyone but the owner credential leaves out other
   * people's positions (line statuses, ask answers) — the same rule as /state, applied per document
   * rather than per line (simpler, stricter).
   */
  blindHidesOthers: true,
  /** Chat is a conversation beside the document, not a mark: it is not exported. */
  exportsChat: false,
} as const;

export const IMPORT_POLICY = {
  /** Types that never import live, whoever imports (see the header). */
  alwaysHistory: ['do', 'proxy', 'alternative', 'pick', 'history', 'authored'] as readonly string[],
  /** A suggestion or comment by someone the importer may not act as: kept under a guest name. */
  untrustedTextMarks: 'guest' as const,
  /** An attestation by someone the importer may not act as: kept as a history note. */
  untrustedAttestations: 'history' as const,
  /** The operator's own actor for unattributed marks. */
  operatorDefaultActor: 'ai:import',
  anonymousActor: 'guest:importer',
  maxBytes: 10 * 1024 * 1024,
} as const;

/** Who is importing, and so whose name the import may write marks in. */
export type ImportAuthority =
  | { kind: 'operator'; actor?: string | null }
  | { kind: 'session'; actor: string }
  | { kind: 'anonymous' };

export function mayActAs(authority: ImportAuthority, actor: string): boolean {
  if (authority.kind === 'operator') return true;
  if (authority.kind === 'session') return actorKey(actor) === actorKey(authority.actor);
  return actorKey(actor) === actorKey(IMPORT_POLICY.anonymousActor);
}

export function defaultActorFor(authority: ImportAuthority): string {
  if (authority.kind === 'operator') return authority.actor && authority.actor.trim() ? authority.actor.trim() : IMPORT_POLICY.operatorDefaultActor;
  if (authority.kind === 'session') return authority.actor;
  return IMPORT_POLICY.anonymousActor;
}

// ============================================================================
// Shared helpers
// ============================================================================

function mdastOf(markdown: string): MdNode {
  return unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml']).parse(markdown) as unknown as MdNode;
}

function blockLinesOf(markdown: string): BlockLine[] {
  return blockLinesFromMdast(mdastOf(markdown));
}

function parseStoredMarks(raw: unknown): Record<string, Record<string, unknown>> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, Record<string, unknown>>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** An ISO time from a file field, or null (never in the future: a file cannot post-date a mark). */
function validTime(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  return new Date(Math.min(ms, Date.now())).toISOString();
}

/** Line start offsets of a text. */
function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') out.push(i + 1);
  return out;
}

function lineAtOffset(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ============================================================================
// History notes
// ============================================================================

export interface HistoryNote {
  id: string;
  /** The mark as written, with handle references in its fields replaced by identities. */
  mark: { type: string; fields: Record<string, string> };
  claimedBy: string | null;
  reason: string;
  importedBy: string;
  anchor: LineAnchor | null;
  at: string;
  seq: number;
}

/**
 * Reasons whose notes are written back exactly as the original mark: their type never imports
 * live (IMPORT_POLICY.alwaysHistory), so the next import turns them into a history note again.
 * Every other note (an untrusted identity, a refused or unplaced mark, an unknown type) is written
 * as {history mark="…" claimed="…" reason=…}, which can never become a mark.
 */
export const VERBATIM_HISTORY_REASONS: readonly string[] = ['never-imported-live'];

/** Fields that hold handle references ("@mw" or "@mw @claude"). */
const HANDLE_REF_FIELDS = ['to', 'for'];

function parseHistoryMark(raw: string): HistoryNote['mark'] {
  try {
    const parsed = JSON.parse(raw) as { type?: unknown; fields?: unknown };
    if (parsed && typeof parsed.type === 'string') {
      const fieldsIn = parsed.fields && typeof parsed.fields === 'object' ? parsed.fields as Record<string, unknown> : {};
      return { type: parsed.type, fields: Object.fromEntries(Object.entries(fieldsIn).map(([k, v]) => [k, String(v)])) };
    }
  } catch {
    // older rows: plain text
  }
  const group = parseMarkGroup(raw);
  return group ? { type: group.type, fields: group.fields } : { type: 'history', fields: { mark: raw } };
}

export function listHistoryNotes(slug: string): HistoryNote[] {
  const rows = getDb().prepare(`SELECT * FROM document_dialect_history WHERE document_slug = ? ORDER BY seq ASC, id ASC`).all(slug) as Array<Record<string, unknown>>;
  return rows.map(row => ({
    id: String(row.id),
    mark: parseHistoryMark(String(row.mark_text)),
    claimedBy: typeof row.claimed_by === 'string' ? row.claimed_by : null,
    reason: String(row.reason),
    importedBy: String(row.imported_by),
    anchor: typeof row.line_hash === 'string' ? {
      hash: row.line_hash, occurrence: Number(row.line_occurrence ?? 0), ordinal: Number(row.line_ordinal ?? 0),
      kind: String(row.line_kind ?? 'paragraph'), excerpt: String(row.line_excerpt ?? ''), ...(typeof row.line_text === 'string' && row.line_text ? { text: row.line_text } : {}),
    } : null,
    at: String(row.at),
    seq: Number(row.seq ?? 0),
  }));
}

function insertHistoryNote(slug: string, note: Omit<HistoryNote, 'id'>): void {
  assertWritesAllowed('insertHistoryNote');
  const a = note.anchor;
  getDb().prepare(`
    INSERT INTO document_dialect_history (id, document_slug, mark_text, claimed_by, reason, imported_by, line_hash, line_occurrence,
      line_ordinal, line_kind, line_excerpt, line_text, seq, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(randomUUID(), slug, JSON.stringify(note.mark), note.claimedBy, note.reason, note.importedBy, a?.hash ?? null, a?.occurrence ?? null,
    a?.ordinal ?? null, a?.kind ?? null, a ? normalizeLineText(a.excerpt).slice(0, 80) : '', a?.text ?? null, note.seq, note.at);
}

/** A history note as a readable line (for /state). */
function describeHistoryMark(note: HistoryNote): string {
  return serializeMarkGroup({ type: note.mark.type, source: null, fields: note.mark.fields });
}

/** The group an export writes for a history note (handles mapped through the export's table). */
function historyGroup(note: HistoryNote, h: (actor: string | null | undefined) => string | null): MarkGroup {
  if (VERBATIM_HISTORY_REASONS.includes(note.reason) || note.mark.type === 'history') {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(note.mark.fields)) {
      out[key] = HANDLE_REF_FIELDS.includes(key) ? value.split(/\s+/).filter(Boolean).map(token => (token.startsWith('@') ? `@${h(token.slice(1)) ?? token.slice(1)}` : token)).join(' ') : value;
    }
    return { type: note.mark.type, source: note.mark.type === 'history' ? null : h(note.claimedBy), fields: out };
  }
  return { type: 'history', source: null, fields: fields([['mark', describeHistoryMark(note)], ['claimed', note.claimedBy], ['reason', note.reason]]) };
}

/** /state: every history note with the line it sits on now (null when the line is gone). */
export function historyNotesForState(slug: string, lines: DocLine[]): Array<Record<string, unknown>> {
  return listHistoryNotes(slug).map(note => {
    const resolved = note.anchor ? resolveLineAnchor(lines, note.anchor) : null;
    return {
      id: note.id,
      mark: describeHistoryMark(note),
      claimedBy: note.claimedBy,
      reason: note.reason,
      importedBy: note.importedBy,
      lineIndex: resolved ? resolved.lineIndex : null,
      at: note.at,
      counts: false,
    };
  });
}

// ============================================================================
// EXPORT
// ============================================================================

export interface ExportResult {
  text: string;
  filename: string;
  contentType: string;
  warnings: string[];
  counts: Record<string, number>;
}

interface ExportContext {
  handles: HandleTable;
  order: string[];
  h: (actor: string | null | undefined) => string | null;
}

function exportContext(): ExportContext {
  const order: string[] = [];
  const ctx: ExportContext = {
    handles: {},
    order,
    h: (actor) => {
      const a = typeof actor === 'string' ? actor.trim() : '';
      if (!a) return null;
      let handle = handleForActor(ctx.handles, a);
      if (!handle) {
        ctx.handles = buildHandleTable([a], ctx.handles);
        handle = handleForActor(ctx.handles, a);
      }
      return handle;
    },
  };
  return ctx;
}

function fields(entries: Array<[string, unknown]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      out[key] = value.map(String).join('|');
      continue;
    }
    out[key] = value === true ? '1' : String(value);
  }
  return out;
}

function fileNameFor(title: string | null | undefined, slug: string, format: ExportFormat): string {
  const base = String(title ?? '').normalize('NFKD').replace(/[^\w\s.-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || slug;
  return format === 'proof-dialect' ? `${base}.proof.md` : format === 'criticmarkup' ? `${base}.critic.md` : `${base}.md`;
}

/** Finds a stored mark's span in the body: every occurrence of its quote, the one nearest startRel wins. */
function locateQuote(body: string, stripped: { stripped: string; map: number[] }, quote: string, nearStripped: number | null, within?: { from: number; to: number }): { start: number; end: number } | null {
  const q = String(quote ?? '');
  if (!q.trim()) return null;
  const candidates: Array<{ start: number; end: number; strippedAt: number }> = [];
  const push = (start: number, end: number, strippedAt: number) => {
    if (within && (start < within.from || end > within.to)) return;
    candidates.push({ start, end, strippedAt });
  };
  for (let at = stripped.stripped.indexOf(q); at >= 0; at = stripped.stripped.indexOf(q, at + 1)) {
    const endIdx = at + q.length - 1;
    if (endIdx >= stripped.map.length) break;
    push(stripped.map[at], stripped.map[endIdx] + 1, at);
  }
  if (!candidates.length) {
    // Whitespace-normalized match (quotes are stored normalized).
    const pattern = new RegExp(q.trim().split(/\s+/).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'), 'g');
    for (const m of stripped.stripped.matchAll(pattern)) {
      const at = m.index ?? 0;
      const endIdx = at + m[0].length - 1;
      if (endIdx >= stripped.map.length) continue;
      push(stripped.map[at], stripped.map[endIdx] + 1, at);
    }
  }
  if (!candidates.length) return null;
  let best = candidates[0];
  if (nearStripped !== null) {
    for (const c of candidates) if (Math.abs(c.strippedAt - nearStripped) < Math.abs(best.strippedAt - nearStripped)) best = c;
  }
  // Never start inside markdown syntax that belongs outside the text (a list marker, "#").
  return { start: best.start, end: Math.max(best.end, best.start) };
}

function relOffset(value: unknown): number | null {
  const m = typeof value === 'string' ? /^char:(\d+)$/.exec(value) : null;
  return m ? Number(m[1]) : null;
}

export async function exportProofDocument(slug: string, input: {
  markdown: string;
  marks: unknown;
  format: ExportFormat;
  title?: string | null;
  /** Blind marking: the caller's actor (null = the owner credential, which reads everything). */
  viewer?: string | null;
  authored?: boolean;
}): Promise<ExportResult> {
  const warnings: string[] = [];
  const counts: Record<string, number> = {};
  const bump = (key: string, n = 1) => { counts[key] = (counts[key] ?? 0) + n; };
  const clean = stripAllProofSpanTags(input.markdown ?? '');
  const { frontMatter, body } = splitFrontMatter(clean);
  const lines = await computeServerLines(clean);
  const blocks = blockLinesOf(body);
  const lineMap = alignLines(lines, blocks);
  const stored = parseStoredMarks(input.marks);
  const ctx = exportContext();
  const stripped = stripMarkdownWithMapping(body);
  const bodyStarts = lineStarts(body);

  // --- every mark stored beside the document -------------------------------------------------
  let askReport: ReturnType<typeof buildAskReport> | null = null;
  const report: IssueReport = await buildIssueReport(slug, clean, stored, {
    asks: (ls) => { askReport = buildAskReport(slug, ls); return askReport.issueInputs; },
    teamExtra: askTeamActors(listCanonicalAsks(slug)),
  });
  const blind = report.settings.blind && EXPORT_POLICY.blindHidesOthers && input.viewer !== null && input.viewer !== undefined;
  const visibleActor = (actor: string) => !blind || actorKey(actor) === actorKey(String(input.viewer));

  // Line groups per editor line index.
  const perLine = new Map<number, MarkGroup[]>();
  const addLine = (index: number | null | undefined, group: MarkGroup) => {
    if (index === null || index === undefined || index < 0) { warnings.push(`A ${group.type} mark has no line in the current text and was left out`); bump('unplaced'); return; }
    perLine.set(index, [...(perLine.get(index) ?? []), group]);
  };

  // Text marks: pending suggestions and comments (and "authored" when asked for).
  const notesByMark = new Map<string, Record<string, unknown>>();
  for (const note of report.reviewNotes) {
    const target = note.target as { markId?: string } | undefined;
    if (target?.markId) notesByMark.set(target.markId, note);
  }
  const bundleOf = new Map<string, string>();
  const bundles: Record<string, YamlValue> = {};
  for (const bundle of report.bundles) {
    if (bundle.status !== 'open') continue;
    const id = String(bundle.id);
    bundles[id] = { title: String(bundle.title ?? ''), ...(bundle.why ? { why: String(bundle.why) } : {}) };
    for (const member of (bundle.members as Array<{ markId: string }> | undefined) ?? []) bundleOf.set(member.markId, id);
  }
  const inline: Array<InlineMarkOut & { markId: string; lineIndex: number | null; critic: CriticMarkOut | null }> = [];
  const markEntries = Object.entries(stored).sort((a, b) => String(a[1].createdAt ?? '').localeCompare(String(b[1].createdAt ?? '')) || a[0].localeCompare(b[0]));
  for (const [id, mark] of markEntries) {
    const kind = String(mark.kind ?? '');
    const pending = (mark.status ?? 'pending') === 'pending';
    const isSuggestion = kind === 'insert' || kind === 'delete' || kind === 'replace';
    if (isSuggestion && !pending) continue;
    if (kind !== 'comment' && !isSuggestion && !(kind === 'authored' && input.authored)) continue;
    const by = str(mark.by) ?? 'ai:unknown';
    const quote = String(mark.quote ?? '');
    const lineIndex = lineOfReviewMark(lines, { quote });
    const block = lineIndex !== null ? lineMap.get(lineIndex) : undefined;
    const within = block ? { from: bodyStarts[block.startLine] ?? 0, to: (bodyStarts[block.endLine + 1] ?? body.length + 1) - 1 } : undefined;
    const span = locateQuote(body, stripped, quote, relOffset(mark.startRel), within) ?? locateQuote(body, stripped, quote, relOffset(mark.startRel));
    if (span && kind === 'insert' && typeof mark.content === 'string') {
      // The stored quote is trimmed; an inserted " Really." keeps its space inside the brackets.
      const lead = /^[ \t]*/.exec(mark.content)?.[0] ?? '';
      const trail = /[ \t]*$/.exec(mark.content)?.[0] ?? '';
      if (lead && body.slice(span.start - lead.length, span.start) === lead) span.start -= lead.length;
      if (trail && trail.length < mark.content.length && body.slice(span.end, span.end + trail.length) === trail) span.end += trail.length;
    }
    let group: MarkGroup;
    const extra: MarkGroup[] = [];
    let critic: CriticMarkOut | null = null;
    if (isSuggestion) {
      const note = notesByMark.get(id);
      group = {
        type: 'changed',
        source: ctx.h(by),
        fields: fields([
          ['at', str(mark.createdAt)],
          ['why', note?.why], ['priority', note?.priority], ['priorityreason', note?.priorityReason],
          ['hints', (note?.rejectHints as string[] | undefined) ?? []],
          ['bundle', bundleOf.get(id)],
        ]),
      };
      critic = { start: 0, end: 0, kind: kind as 'insert' | 'delete' | 'replace', inserted: kind === 'replace' ? String(mark.content ?? '') : null };
      bump('suggestions');
    } else if (kind === 'comment') {
      group = { type: 'comment', source: ctx.h(by), fields: fields([['text', String(mark.text ?? '')], ['at', str(mark.createdAt)], ['resolved', mark.resolved === true]]) };
      const replies = (Array.isArray(mark.replies) ? mark.replies : (Array.isArray(mark.thread) ? mark.thread : [])) as Array<Record<string, unknown>>;
      for (const reply of replies) {
        extra.push({ type: 'reply', source: ctx.h(str(reply.by) ?? 'ai:unknown'), fields: fields([['text', String(reply.text ?? '')], ['at', str(reply.at)]]) });
      }
      critic = { start: 0, end: 0, kind: 'comment', comments: [`@${ctx.h(by)}: ${String(mark.text ?? '')}`, ...replies.map(r => `@${ctx.h(str(r.by) ?? 'ai:unknown')}: ${String(r.text ?? '')}`)] };
      bump('comments');
    } else {
      group = { type: 'authored', source: ctx.h(by), fields: {} };
      bump('authored');
    }
    if (!span || span.end <= span.start) {
      // Not placeable in the text: a line mark with quote= on the line (or the first line).
      const fallback: MarkGroup = { ...group, fields: { ...fields([['quote', quote], ['kind', isSuggestion ? kind : null], ['to', kind === 'replace' || kind === 'insert' ? String(mark.content ?? '') : null]]), ...group.fields } };
      addLine(lineIndex ?? (lines.length ? 0 : null), fallback);
      for (const g of extra) addLine(lineIndex ?? 0, g);
      bump('placedOnLine');
      continue;
    }
    const out: InlineMarkOut & { markId: string; lineIndex: number | null; critic: CriticMarkOut | null } = {
      start: span.start,
      end: span.end,
      kind: isSuggestion ? kind as 'insert' | 'delete' | 'replace' : 'comment',
      inserted: kind === 'replace' ? String(mark.content ?? '') : null,
      groups: [group, ...extra],
      markId: id,
      lineIndex,
      critic: critic ? { ...critic, start: span.start, end: span.end } : null,
    };
    inline.push(out);
  }
  const plan = planInlineMarks(inline);
  for (const mark of plan.overlapping) {
    const quote = body.slice(mark.start, mark.end);
    const [first, ...rest] = mark.groups;
    addLine(mark.lineIndex ?? 0, { ...first, fields: { ...fields([['quote', normalizeLineText(visibleFragment(quote))], ['kind', mark.kind !== 'comment' ? mark.kind : null], ['to', mark.kind === 'replace' ? mark.inserted : null]]), ...first.fields } });
    for (const g of rest) addLine(mark.lineIndex ?? 0, g);
    bump('placedOnLine');
  }

  // Line marks: statuses.
  const lineMarks: LineMark[] = listCanonicalLineMarks(slug);
  const statusGroups: Array<{ index: number; actorOrder: number; group: MarkGroup }> = [];
  for (const mark of lineMarks) {
    if (!visibleActor(mark.by)) { bump('hiddenByBlind'); continue; }
    const resolved = resolveLineAnchor(lines, mark.anchor);
    if (!resolved) { warnings.push(`A ${mark.status} mark by ${mark.by} is on a line that is gone`); bump('unplaced'); continue; }
    const line = lines[resolved.lineIndex];
    const was = line.hash !== mark.anchor.hash ? (mark.anchor.text ?? mark.anchor.excerpt) : null;
    const handle = ctx.h(mark.by);
    statusGroups.push({
      index: resolved.lineIndex,
      actorOrder: ctx.order.length,
      group: {
        type: mark.status,
        source: handle,
        fields: fields([
          ['at', mark.at],
          ['via', mark.via && mark.via !== EXPORT_POLICY.defaultVia ? mark.via : null],
          ['reason', mark.reason], ['why', mark.why], ['evidence', mark.evidence],
          ['was', was],
        ]),
      },
    });
    bump('lineMarks');
  }
  statusGroups.sort((a, b) => a.index - b.index || String(a.group.source).localeCompare(String(b.group.source)) || a.group.type.localeCompare(b.group.type));
  for (const s of statusGroups) addLine(s.index, s.group);

  // Tiers (tagged lines only; untagged lines are decision lines by default).
  for (const tier of report.tiers) {
    if (!tier.tagged) continue;
    addLine(Number(tier.lineIndex), { type: String(tier.tier), source: ctx.h(String(tier.by ?? '')), fields: fields([['reason', tier.reason], ['author', tier.byAuthor === true]]) });
    bump('tiers');
  }
  // Uncertain flags.
  for (const flag of report.flags) {
    addLine(flag.lineIndex as number | null, { type: 'uncertain', source: ctx.h(String(flag.by)), fields: fields([['note', flag.note], ['at', flag.createdAt]]) });
    bump('flags');
  }
  // Times-to-live.
  for (const ttl of report.ttls) {
    addLine(ttl.lineIndex as number | null, { type: 'ttl', source: ctx.h(String(ttl.by)), fields: fields([['for', ttl.ttl], ['since', ttl.periodStart]]) });
    bump('ttls');
  }
  // Asks and their answers.
  const asks = ((askReport as ReturnType<typeof buildAskReport> | null)?.asks ?? []) as Array<Record<string, unknown>>;
  for (const ask of asks) {
    if (ask.orphaned) { warnings.push('An ask whose line is gone was left out'); bump('unplaced'); continue; }
    const to = (ask.to as string[] | undefined) ?? [];
    addLine(ask.lineIndex as number | null, {
      type: 'ask',
      source: ctx.h(String(ask.by)),
      fields: fields([['to', to.map(t => `@${ctx.h(t)}`).join(' ') || 'anyone'], ['recommend', ask.recommend], ['ifyes', ask.ifYes]]),
    });
    for (const answer of (ask.answers as Array<Record<string, unknown>> | undefined) ?? []) {
      if (!visibleActor(String(answer.by))) continue;
      addLine(ask.lineIndex as number | null, { type: 'answer', source: ctx.h(String(answer.by)), fields: fields([['choice', answer.choice], ['words', answer.words]]) });
    }
    bump('asks');
  }
  // Objections (open ones), one group per covered line sharing a local id.
  let objectionN = 0;
  for (const objection of report.objections) {
    if (objection.status !== 'open') continue;
    objectionN += 1;
    for (const covered of (objection.lines as Array<{ lineIndex: number | null }> | undefined) ?? []) {
      addLine(covered.lineIndex, { type: 'objection', source: ctx.h(String(objection.by)), fields: fields([['id', `o${objectionN}`], ['reason', objection.reason], ['if', objection.condition]]) });
    }
    bump('objections');
  }
  // Alternatives and picks (history on import).
  let altN = 0;
  for (const set of report.alternatives) {
    const idMap = new Map<string, string>([['original', 'original']]);
    for (const option of (set.options as Array<Record<string, unknown>> | undefined) ?? []) {
      if (option.id === 'original') continue;
      altN += 1;
      idMap.set(String(option.id), `a${altN}`);
      addLine(set.lineIndex as number | null, { type: 'alternative', source: ctx.h(String(option.by ?? '')), fields: fields([['id', `a${altN}`], ['text', option.text]]) });
    }
    for (const pick of (set.picks as Array<Record<string, unknown>> | undefined) ?? []) {
      if (!visibleActor(String(pick.by))) continue;
      addLine(set.lineIndex as number | null, { type: 'pick', source: ctx.h(String(pick.by)), fields: fields([['choice', idMap.get(String(pick.choice)) ?? String(pick.choice)]]) });
    }
    bump('alternatives');
  }
  // {do} lines (history on import: a file never proposes an executable action).
  for (const d of report.dos) {
    if (d.state === 'withdrawn' || d.lineIndex === null || d.lineIndex === undefined) continue;
    addLine(d.lineIndex as number, {
      type: 'do',
      source: ctx.h(String(d.by ?? '')),
      fields: fields([['state', d.state], ['to', ((d.to as string[] | undefined) ?? []).map(t => `@${ctx.h(t)}`).join(' ')], ['action', JSON.stringify(d.action ?? null)]]),
    });
    bump('dos');
  }
  // Familiar proxies (history on import): every stored proxy, moot ones too.
  for (const proxy of listProxyMarks(slug)) {
    const resolved = resolveLineAnchor(lines, proxy.anchor);
    addLine(resolved ? resolved.lineIndex : null, { type: 'proxy', source: ctx.h(proxy.familiar), fields: fields([['for', `@${ctx.h(proxy.for)}`], ['status', proxy.status], ['confidence', proxy.confidence], ['evidence', proxy.evidence]]) });
    bump('proxies');
  }
  // History notes from earlier imports (always written back as history).
  for (const note of listHistoryNotes(slug)) {
    const resolved = note.anchor ? resolveLineAnchor(lines, note.anchor) : null;
    addLine(resolved ? resolved.lineIndex : null, historyGroup(note, ctx.h));
    bump('history');
  }

  // --- write --------------------------------------------------------------------------------
  const lineGroups: LineGroups[] = [];
  for (const [index, groups] of [...perLine.entries()].sort((a, b) => a[0] - b[0])) {
    const block = lineMap.get(index);
    if (!block) { warnings.push(`${groups.length} mark(s) on line ${index + 1} (${lines[index]?.kind ?? 'unknown'}) could not be placed in the markdown`); bump('unplaced', groups.length); continue; }
    lineGroups.push({ line: block.markLine, groups });
  }
  const proof: { [key: string]: YamlValue } = { version: String(DIALECT_POLICY.version) };
  if (input.title) proof.title = String(input.title);
  if (Object.keys(ctx.handles).length) proof.handles = ctx.handles;
  if (Object.keys(bundles).length) proof.bundles = bundles;
  const dialect = serializeProofDocument({ markdown: body, frontMatter, proof, inline: plan.inline, lines: lineGroups });
  if (input.format === 'proof-dialect') {
    return { text: dialect.endsWith('\n') ? dialect : `${dialect}\n`, filename: fileNameFor(input.title, slug, 'proof-dialect'), contentType: 'text/markdown; charset=utf-8', warnings, counts };
  }
  if (input.format === 'plain') {
    const parsed = parseProofDocument(dialect);
    const front = serializeFrontMatter({ otherLines: parsed.frontMatter.otherLines, proof: null });
    const text = `${front}${front ? '\n' : ''}${parsed.base.replace(/^\n+/, '')}`;
    return { text: text.endsWith('\n') ? text : `${text}\n`, filename: fileNameFor(input.title, slug, 'plain'), contentType: 'text/markdown; charset=utf-8', warnings, counts };
  }
  const criticMarks = plan.inline.map(m => (m as typeof inline[number]).critic).filter((c): c is CriticMarkOut => Boolean(c));
  const criticBody = serializeCriticMarkup({ markdown: body, marks: criticMarks });
  const front = serializeFrontMatter({ otherLines: frontMatter.otherLines, proof: Object.keys(ctx.handles).length ? { handles: ctx.handles } : null });
  const text = `${front}${front ? '\n' : ''}${criticBody}`;
  return { text: text.endsWith('\n') ? text : `${text}\n`, filename: fileNameFor(input.title, slug, 'criticmarkup'), contentType: 'text/markdown; charset=utf-8', warnings, counts };
}

// ============================================================================
// IMPORT
// ============================================================================

export interface ImportSummary {
  format: 'proof-dialect' | 'criticmarkup';
  importedBy: string;
  authority: ImportAuthority['kind'];
  created: Record<string, number>;
  history: number;
  guests: string[];
  warnings: string[];
}

/** Detects the format when asked for "auto". */
export function detectImportFormat(text: string): 'proof-dialect' | 'criticmarkup' {
  return looksLikeCriticMarkup(text) ? 'criticmarkup' : 'proof-dialect';
}

/** True when the text carries dialect or CriticMarkup marks (library uploads use the importer then). */
export function hasProofMarks(text: string): boolean {
  const t = String(text ?? '');
  if (looksLikeCriticMarkup(t)) return true;
  const parsed = parseProofDocument(t);
  return parsed.inline.length > 0 || parsed.lines.length > 0 || Boolean(parsed.frontMatter.proof);
}

/** Parses an import: the base markdown to create the document from, and every mark. */
export function parseImport(text: string, format: 'auto' | 'proof-dialect' | 'criticmarkup'): { parsed: ParsedProofDocument; format: 'proof-dialect' | 'criticmarkup'; markdown: string } {
  const f = format === 'auto' ? detectImportFormat(text) : format;
  const parsed = f === 'criticmarkup' ? parseCriticMarkup(text) : parseProofDocument(text);
  const front = serializeFrontMatter({ otherLines: parsed.frontMatter.otherLines, proof: null });
  const markdown = `${front}${parsed.base.replace(/^\n+/, '')}`;
  return { parsed, format: f, markdown };
}

type Op = (path: string, body: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;

/**
 * Applies every mark of a parsed Proof Document to a document just created from its base markdown.
 * Text marks go first (in reverse document order, so earlier anchors never move), then line marks
 * against the lines as they are once the pending insertions are in.
 */
export async function applyImportedMarks(slug: string, input: {
  parsed: ParsedProofDocument;
  format: 'proof-dialect' | 'criticmarkup';
  authority: ImportAuthority;
}): Promise<ImportSummary> {
  const { parsed, authority } = input;
  const importer = defaultActorFor(authority);
  const warnings = [...parsed.warnings];
  const created: Record<string, number> = {};
  const bump = (key: string) => { created[key] = (created[key] ?? 0) + 1; };
  const guests = new Set<string>();
  let historyCount = 0;
  let seq = 0;
  const now = new Date().toISOString();
  const op: Op = async (path, body) => {
    const result = await executeDocumentOperationAsync(slug, 'POST', path, body);
    return { status: result.status, body: (result.body ?? {}) as Record<string, unknown> };
  };
  const claimedActor = (group: MarkGroup): string => {
    if (!group.source) return importer;
    const mapped = parsed.handles[group.source];
    return mapped ? mapped : `guest:${group.source}`;
  };
  const textActor = (group: MarkGroup): string => {
    const claimed = claimedActor(group);
    if (mayActAs(authority, claimed)) return claimed;
    const guest = isGuestActor(claimed) ? claimed : `guest:${group.source ?? 'imported'}`;
    guests.add(guest);
    return guest;
  };
  const history = (group: MarkGroup, anchor: LineAnchor | null, reason: string) => {
    // Handle references in fields ("to", "for") become identities, so the note outlives the file's table.
    const markFields: Record<string, string> = {};
    for (const [key, value] of Object.entries(group.fields)) {
      markFields[key] = HANDLE_REF_FIELDS.includes(key) && group.type !== 'history'
        ? value.split(/\s+/).filter(Boolean).map(token => (token.startsWith('@') ? `@${parsed.handles[token.slice(1)] ?? `guest:${token.slice(1)}`}` : token)).join(' ')
        : value;
    }
    insertHistoryNote(slug, {
      mark: { type: group.type, fields: markFields },
      claimedBy: group.type === 'history' ? null : claimedActor(group),
      reason: group.type === 'history' ? 'history' : reason,
      importedBy: importer,
      anchor,
      at: now,
      seq: (seq += 1),
    });
    historyCount += 1;
  };

  // --- lines of the created document ----------------------------------------------------------
  const readDoc = () => {
    const doc = getDocumentBySlug(slug);
    return { markdown: stripAllProofSpanTags(doc?.markdown ?? ''), marks: parseStoredMarks(doc?.marks) };
  };
  let docNow = readDoc();
  const initialLines = await computeServerLines(docNow.markdown);
  const baseBody = parsed.base;
  const baseBlocks = blockLinesOf(baseBody);
  const baseMap = alignLines(initialLines, baseBlocks);
  const storedBody = splitFrontMatter(docNow.markdown).body;
  const storedBlocks = blockLinesOf(storedBody);
  const storedMap = alignLines(initialLines, storedBlocks);
  const storedStarts = lineStarts(storedBody);
  const baseStarts = lineStarts(baseBody);
  /** base line → editor line index */
  const baseLineToDoc = new Map<number, number>();
  for (const [index, block] of baseMap) for (let l = block.startLine; l <= block.endLine; l += 1) baseLineToDoc.set(l, index);

  // --- text marks -----------------------------------------------------------------------------
  const commentPatches: Array<{ markId: string; at: string | null; replies: Array<{ by: string; text: string; at: string }>; resolved: boolean; by: string }> = [];
  const suggestionPatches: Array<{ markId: string; at: string | null }> = [];
  const bundleMembers = new Map<string, { by: string; ids: string[] }>();
  const bundleMeta = (parsed.frontMatter.proof?.bundles ?? {}) as Record<string, YamlValue>;

  /** Where a base offset sits: its editor line and the raw anchor to use against the stored text. */
  const anchorFor = (start: number, end: number): { anchor: string; occurrence: number; lineIndex: number | null; visible: string } | null => {
    const raw = baseBody.slice(start, end);
    if (!raw.trim()) return null;
    const baseLine = lineAtOffset(baseStarts, start);
    const lineIndex = baseLineToDoc.get(baseLine) ?? null;
    const block = lineIndex !== null ? storedMap.get(lineIndex) : undefined;
    const baseBlock = lineIndex !== null ? baseMap.get(lineIndex) : undefined;
    // Occurrences of the raw text before this point: those in the stored text before the line's
    // block, plus those inside the line before the point (counted in base).
    const storedBefore = block ? storedBody.slice(0, storedStarts[block.startLine] ?? 0) : baseBody.slice(0, start);
    const lineStartInBase = baseBlock ? (baseStarts[baseBlock.startLine] ?? 0) : start;
    const within = baseBody.slice(lineStartInBase, start);
    const occurrence = countOccurrences(storedBefore, raw) + countOccurrences(within, raw);
    return { anchor: raw, occurrence, lineIndex, visible: normalizeLineText(visibleFragment(raw)) };
  };

  const placeText = async (path: string, payload: Record<string, unknown>, at: ReturnType<typeof anchorFor>): Promise<{ status: number; body: Record<string, unknown> }> => {
    if (!at) return { status: 409, body: { code: 'ANCHOR_NOT_FOUND' } };
    const first = await op(path, { ...payload, quote: at.visible || at.anchor, target: { anchor: at.anchor, mode: 'exact', occurrence: at.occurrence } });
    if (first.status < 300) return first;
    // Formatting may have been rewritten when the document was stored: fall back to the visible quote.
    const second = await op(path, { ...payload, quote: at.visible });
    if (second.status < 300) warnings.push(`"${at.visible.slice(0, 40)}" was anchored by its visible text (first match)`);
    return second;
  };

  const pendingLineGroups: Array<{ lineIndex: number; groups: MarkGroup[] }> = [];
  const inlineMarks = [...parsed.inline].sort((a, b) => b.start - a.start || a.end - b.end);
  for (const mark of inlineMarks) {
    const [group, ...extra] = mark.groups;
    if (!group) continue;
    await importTextMark(mark, group, extra);
  }

  async function importTextMark(mark: InlineMark, group: MarkGroup, extra: MarkGroup[]): Promise<void> {
    const baseLine = lineAtOffset(baseStarts, mark.start);
    const lineIndex = baseLineToDoc.get(baseLine) ?? null;
    const lineAnchor = lineIndex !== null ? anchorForLine(initialLines[lineIndex]) : null;
    if (IMPORT_POLICY.alwaysHistory.includes(group.type) || (group.type !== 'changed' && group.type !== 'comment')) {
      // A text mark of another type ([x]{agreed @mw}): a line mark on its line.
      if (lineIndex !== null) pendingLineGroups.push({ lineIndex, groups: [group, ...extra] });
      else { history(group, null, 'unplaced'); }
      return;
    }
    const by = textActor(group);
    if (group.type === 'comment') {
      const text = group.fields.text ?? '';
      if (!text.trim()) { warnings.push('A comment with no text was skipped'); return; }
      const at = anchorFor(mark.start, mark.end);
      const result = await placeText('/marks/comment', { by, text }, at);
      if (result.status >= 300) { warnings.push(`A comment on "${mark.raw.slice(0, 40)}" could not be placed (${String(result.body.code ?? result.status)})`); history(group, lineAnchor, 'unplaced'); return; }
      const markId = String(result.body.markId ?? '');
      const replies = extra.filter(g => g.type === 'reply').map(g => ({ by: textActor(g), text: g.fields.text ?? '', at: validTime(g.fields.at) ?? now })).filter(r => r.text.trim());
      commentPatches.push({ markId, at: validTime(group.fields.at), replies, resolved: group.fields.resolved === '1' || group.fields.resolved === 'true', by });
      bump('comments');
      return;
    }
    // changed
    const deleted = mark.deleted;
    const inserted = mark.inserted ?? '';
    let result: { status: number; body: Record<string, unknown> };
    if (deleted !== null && deleted.length > 0) {
      const at = anchorFor(mark.start, mark.end);
      result = inserted.length > 0
        ? await placeText('/marks/suggest-replace', { by, content: inserted }, at)
        : await placeText('/marks/suggest-delete', { by }, at);
    } else if (inserted.length > 0) {
      result = await importInsertion(mark.start, inserted, by);
    } else {
      warnings.push('An empty change was skipped');
      return;
    }
    if (result.status >= 300) {
      warnings.push(`A change at "${(deleted ?? inserted).slice(0, 40)}" could not be placed (${String(result.body.code ?? result.status)})`);
      history(group, lineAnchor, 'unplaced');
      return;
    }
    const markId = String(result.body.markId ?? '');
    suggestionPatches.push({ markId, at: validTime(group.fields.at) });
    const noteFields = {
      why: group.fields.why ?? null,
      rejectHints: group.fields.hints ? group.fields.hints.split('|').filter(Boolean).slice(0, 5) : [],
      priority: group.fields.priority && /^[1-5]$/.test(group.fields.priority) ? Number(group.fields.priority) : null,
      priorityReason: group.fields.priorityreason ?? null,
    };
    if (markId && (noteFields.why || noteFields.rejectHints.length || noteFields.priority !== null)) recordSuggestionNote(slug, markId, by, noteFields);
    if (markId && group.fields.bundle) {
      const entry = bundleMembers.get(group.fields.bundle) ?? { by, ids: [] };
      entry.ids.unshift(markId);
      bundleMembers.set(group.fields.bundle, entry);
    }
    bump('suggestions');
  }

  /** A pure insertion at a base offset: inline after the words before it, a new block, or a replace of the next word. */
  async function importInsertion(at: number, inserted: string, by: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const baseLine = lineAtOffset(baseStarts, at);
    const lineStart = baseStarts[baseLine] ?? 0;
    const lineEnd = (baseStarts[baseLine + 1] ?? baseBody.length + 1) - 1;
    const lineText = baseBody.slice(lineStart, lineEnd);
    const prefix = baseBody.slice(lineStart, at).replace(/^\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|>\s*|#{1,6}\s+)*/, '');
    if (!lineText.trim() || !prefix.trim()) {
      const blockLike = !lineText.trim() || /\n\s*\n/.test(inserted);
      if (blockLike) {
        // A new block: after the previous line's last words.
        let prevIndex: number | null = null;
        for (let l = baseLine - 1; l >= 0; l -= 1) { const idx = baseLineToDoc.get(l); if (idx !== undefined) { prevIndex = idx; break; } }
        if (prevIndex === null) return { status: 409, body: { code: 'NO_BLOCK_BEFORE' } };
        const prevBlock = baseMap.get(prevIndex)!;
        const prevEndLine = prevBlock.endLine;
        const prevStart = baseStarts[prevEndLine] ?? 0;
        const prevEnd = (baseStarts[prevEndLine + 1] ?? baseBody.length + 1) - 1;
        const tail = lastWords(baseBody.slice(prevStart, prevEnd));
        if (!tail) return { status: 409, body: { code: 'NO_BLOCK_BEFORE' } };
        const anchor = anchorFor(prevEnd - tail.length, prevEnd);
        return placeText('/marks/suggest-insert', { by, content: `\n\n${inserted.replace(/^\n+|\n+$/g, '')}` }, anchor);
      }
      // At the start of a line: replace its first word with the insertion plus that word.
      const rest = baseBody.slice(at, lineEnd);
      const word = /^\S+/.exec(rest)?.[0];
      if (!word) return { status: 409, body: { code: 'ANCHOR_NOT_FOUND' } };
      warnings.push(`An insertion at the start of "${word}" was imported as a replacement of that word`);
      return placeText('/marks/suggest-replace', { by, content: `${inserted}${word}` }, anchorFor(at, at + word.length));
    }
    const tail = lastWords(baseBody.slice(lineStart, at));
    return placeText('/marks/suggest-insert', { by, content: inserted }, anchorFor(at - tail.length, at));
  }

  function lastWords(text: string): string {
    // Up to 40 characters ending exactly at the point, starting on a word boundary.
    const t = text.slice(-60);
    const m = /\S.*$/s.exec(t.length > 40 ? t.slice(t.indexOf(' ', t.length - 40) + 1) : t);
    return m ? text.slice(text.length - m[0].length) : text.trimStart();
  }

  // --- line marks (after the text marks: lines as stored with the pending insertions) ----------
  docNow = readDoc();
  const lines = await computeServerLines(docNow.markdown);
  const currentBlocks = blockLinesOf(parsed.current);
  const currentMap = alignLines(lines, currentBlocks);
  const currentLineToDoc = new Map<number, number>();
  for (const [index, block] of currentMap) for (let l = block.startLine; l <= block.endLine; l += 1) currentLineToDoc.set(l, index);
  for (const entry of parsed.lines) {
    const index = currentLineToDoc.get(entry.currentLine ?? entry.line);
    if (index === undefined) {
      warnings.push(`Marks on markdown line ${(entry.currentLine ?? entry.line) + 1} match no document line`);
      for (const g of entry.groups) history(g, null, 'unplaced');
      continue;
    }
    pendingLineGroups.push({ lineIndex: index, groups: entry.groups });
  }

  // Objections are collected across lines by id.
  const objections = new Map<string, { group: MarkGroup; anchors: LineAnchor[] }>();
  const statusEntries: Array<{ line: DocLine; group: MarkGroup; by: string }> = [];
  for (const { lineIndex, groups } of pendingLineGroups) {
    const line = lines[lineIndex];
    if (!line) continue;
    const anchor = anchorForLine(line);
    let lastAsk: string | null = null;
    for (const group of groups) {
      if (IMPORT_POLICY.alwaysHistory.includes(group.type)) { history(group, anchor, group.type === 'history' ? 'history' : 'never-imported-live'); continue; }
      if ((group.type === 'comment' || group.type === 'changed') && group.fields.quote) {
        await importLineTextMark(line, group, groups.filter(g => g.type === 'reply'));
        continue;
      }
      if (group.type === 'reply') continue;
      const claimed = claimedActor(group);
      if (!mayActAs(authority, claimed)) { history(group, anchor, 'untrusted-identity'); continue; }
      const by = claimed;
      if (DIALECT_POLICY.statusTypes.includes(group.type)) {
        statusEntries.push({ line, group, by });
        continue;
      }
      if (group.type === 'decision' || group.type === 'context') {
        const r = writeTiers(slug, { by, tier: group.type, reason: group.fields.reason, lines: [line], markdown: docNow.markdown, rawMarks: docNow.marks, source: 'agent' });
        if (r.status === 200) bump('tiers'); else { warnings.push(`A ${group.type} tag was refused (${String(r.body.code)})`); history(group, anchor, 'refused'); }
        continue;
      }
      if (group.type === 'uncertain') {
        const r = writeFlag(slug, { by, anchor, note: group.fields.note, source: 'agent', line });
        if (r.status === 200) {
          // The flag keeps its original time: a deliberate mark made after it (and before the export) still settles it.
          const at = validTime(group.fields.at);
          const id = (r.body.flag as { id?: string } | undefined)?.id;
          if (at && id) getDb().prepare(`UPDATE document_line_flags SET created_at = ? WHERE document_slug = ? AND id = ?`).run(at, slug, id);
          bump('flags');
        } else { history(group, anchor, 'refused'); }
        continue;
      }
      if (group.type === 'ttl') {
        const r = await setTtl(slug, { by, anchor, ttl: group.fields.for, markdown: docNow.markdown, source: 'agent' });
        if (r.status === 200) {
          // The period keeps its original start, so a claim does not get younger by being exported.
          const since = validTime(group.fields.since);
          const id = (r.body.ttl as { id?: string } | undefined)?.id;
          if (since && id) getDb().prepare(`UPDATE document_line_ttls SET set_at = ?, period_start = ? WHERE document_slug = ? AND id = ?`).run(since, since, slug, id);
          bump('ttls');
        } else { warnings.push(`A time-to-live was refused (${String(r.body.code)})`); history(group, anchor, 'refused'); }
        continue;
      }
      if (group.type === 'ask') {
        const toRaw = (group.fields.to ?? '').trim();
        const to = !toRaw || toRaw === 'anyone' ? [] : toRaw.split(/[\s,]+/).filter(Boolean).map(t => {
          const h = t.replace(/^@/, '');
          return parsed.handles[h] ?? `guest:${h}`;
        });
        const r = createAskOnLine(slug, line, lines, { by, to, recommend: group.fields.recommend, ifYes: group.fields.ifyes, source: 'agent' });
        if (r.status === 200) { lastAsk = String((r.body.ask as { id?: string } | undefined)?.id ?? ''); bump('asks'); }
        else { warnings.push(`An ask was refused (${String(r.body.code)})`); history(group, anchor, 'refused'); lastAsk = null; }
        continue;
      }
      if (group.type === 'answer') {
        if (!lastAsk) { history(group, anchor, 'no-ask'); continue; }
        const r = answerAsk(slug, { id: lastAsk, by, choice: group.fields.choice, words: group.fields.words, line: { anchor }, source: 'agent', canMark: false });
        if (r.status === 200) bump('answers'); else { history(group, anchor, 'refused'); }
        continue;
      }
      if (group.type === 'objection') {
        const key = `${actorKey(by)}|${group.fields.id ?? randomUUID()}`;
        const entry = objections.get(key) ?? { group: { ...group, source: group.source }, anchors: [] };
        entry.anchors.push(anchor);
        objections.set(key, entry);
        continue;
      }
      if (group.type === 'unseen') continue;
      // An unknown type: kept as history so nothing in the file is lost.
      history(group, anchor, 'unknown-type');
    }
  }
  for (const { group, anchors } of objections.values()) {
    const by = claimedActor(group);
    const r = createObjection(slug, { by, anchors, reason: group.fields.reason, condition: group.fields.if, lines, source: 'agent', canMark: false });
    if (r.status === 200) bump('objections'); else { warnings.push(`An objection was refused (${String(r.body.code)})`); for (const a of anchors) history(group, a, 'refused'); }
  }
  // Status marks last: they are the file's exact record (an ask answer or objection never overrides them).
  for (const { line, group, by } of statusEntries) {
    const status = group.type;
    const reason = group.fields.reason ?? '';
    const current = anchorForLine(line);
    let anchor: LineAnchor = current;
    if (group.fields.was) {
      const was = normalizeLineText(group.fields.was);
      anchor = { hash: hashLine(line.kind, was), occurrence: 0, ordinal: line.index, kind: line.kind, excerpt: was.slice(0, 80), text: was };
    }
    if (status === 'rejected' && !reason.trim()) { history(group, current, 'rejected-without-reason'); continue; }
    if (status === 'approved' && authority.kind !== 'operator' && authority.kind !== 'session') { history(group, current, 'approve-needs-owner'); continue; }
    const via = isMarkVia(group.fields.via) ? group.fields.via : 'api';
    if (via === 'proxy' && authority.kind !== 'operator') { history(group, current, 'proxy-via-needs-operator'); continue; }
    const at = validTime(group.fields.at) ?? now;
    const why = group.fields.why && isAiActor(by) ? group.fields.why : null;
    const evidence = group.fields.evidence && isAiActor(by) ? group.fields.evidence : null;
    replaceDocumentLineMark({
      slug,
      actorKey: actorKey(by),
      replaceIds: [],
      anchor,
      next: {
        id: randomUUID(), by_actor: by, status, reason: reason || null, line_hash: anchor.hash, line_occurrence: anchor.occurrence,
        line_ordinal: anchor.ordinal, line_kind: anchor.kind, line_excerpt: normalizeLineText(anchor.excerpt).slice(0, 80), at, created_at: at,
        via, line_text: anchor.text ?? null, why, evidence, proxy_json: null,
      },
    });
    bump('lineMarks');
  }

  async function importLineTextMark(line: DocLine, group: MarkGroup, replies: MarkGroup[]): Promise<void> {
    const by = textActor(group);
    const quote = group.fields.quote ?? '';
    const base = { by };
    let result: { status: number; body: Record<string, unknown> };
    if (group.type === 'comment') {
      result = await op('/marks/comment', { ...base, quote, text: group.fields.text ?? '' });
      if (result.status < 300) {
        commentPatches.push({ markId: String(result.body.markId ?? ''), at: validTime(group.fields.at), replies: replies.map(g => ({ by: textActor(g), text: g.fields.text ?? '', at: validTime(g.fields.at) ?? now })), resolved: group.fields.resolved === '1', by });
        bump('comments');
      }
    } else {
      const kind = group.fields.kind === 'delete' ? 'delete' : group.fields.kind === 'insert' ? 'insert' : 'replace';
      result = await op(`/marks/suggest-${kind}`, { ...base, quote, ...(kind !== 'delete' ? { content: group.fields.to ?? '' } : {}) });
      if (result.status < 300) { suggestionPatches.push({ markId: String(result.body.markId ?? ''), at: validTime(group.fields.at) }); bump('suggestions'); }
    }
    if (result.status >= 300) { warnings.push(`A ${group.type} on "${quote.slice(0, 40)}" could not be placed`); history(group, anchorForLine(line), 'unplaced'); }
  }

  // --- bundles, then timestamps and replies (one write of the stored marks), then resolves -----
  for (const [id, entry] of bundleMembers) {
    const meta = bundleMeta[id];
    const title = meta && typeof meta === 'object' && typeof meta.title === 'string' ? meta.title : id;
    const why = meta && typeof meta === 'object' && typeof meta.why === 'string' ? meta.why : null;
    const state = readDoc();
    const r = await addToBundle(slug, { by: entry.by, bundle: { id, title, why }, markIds: entry.ids, markdown: state.markdown, rawMarks: state.marks, source: 'agent' });
    if (r.status === 200) bump('bundles'); else warnings.push(`Bundle "${id}" was refused (${String(r.body.code)})`);
  }
  if (commentPatches.length || suggestionPatches.length) {
    let repliesWritten = 0;
    const patched = await patchStoredMarksAsync(slug, (marks) => {
      const next = marks as unknown as Record<string, Record<string, unknown>>;
      for (const patch of suggestionPatches) {
        if (patch.at && next[patch.markId]) next[patch.markId] = { ...next[patch.markId], createdAt: patch.at };
      }
      for (const patch of commentPatches) {
        const existing = next[patch.markId];
        if (!existing) continue;
        const replies = patch.replies.map(r => ({ by: r.by, text: r.text, at: r.at }));
        next[patch.markId] = { ...existing, ...(patch.at ? { createdAt: patch.at } : {}), ...(replies.length ? { thread: replies, replies } : {}) };
        repliesWritten += replies.length;
      }
      return next as never;
    }, importer);
    if (patched.status >= 300) warnings.push(`Original timestamps and replies were not written (${patched.status})`);
    else if (repliesWritten) created.replies = repliesWritten;
    for (const patch of commentPatches) {
      if (!patch.resolved) continue;
      const r = await op('/marks/resolve', { markId: patch.markId, by: patch.by });
      if (r.status < 300) bump('resolved');
    }
  }
  try {
    addDocumentEvent(slug, 'document.imported', { format: input.format, authority: authority.kind, created, history: historyCount, guests: [...guests], warnings: warnings.slice(0, 50) }, importer);
  } catch (error) {
    console.warn('[proof-dialect] failed to record import event', { slug, error: String(error) });
  }
  return { format: input.format, importedBy: importer, authority: authority.kind, created, history: historyCount, guests: [...guests], warnings };
}

export { CRITIC_POLICY, parseMarkGroup };
