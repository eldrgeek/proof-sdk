/**
 * Proof Documents — the Proof dialect of markdown: a pure codec (parse and serialize), plus
 * CriticMarkup import and export. No I/O: the server (server/proof-dialect.ts) reads and writes
 * the stored marks; this module only turns text into structures and back.
 *
 * Authorship: Mike Wolf specified the dialect ("[...]{mark}, derived from the Markdown [...](target)
 * syntax"; the braces hold the type, then its source, then key=value fields; ruled Yes on
 * 2026-09-19). Built by Claude Opus 5 (worker proof-dialect), 2026-09-19.
 *
 * GRAMMAR (DIALECT_POLICY holds every choice below as a named constant)
 *
 *   mark group   = "{" type [ " " "@" handle ] { " " key "=" value } "}"
 *   type         = a bare lowercase word: [a-z][a-z0-9_-]*
 *   handle       = [A-Za-z0-9][A-Za-z0-9._-]*   (mapped to an identity by the front matter)
 *   value        = bare ([^\s"{}]+) or "quoted" (escapes: \" \\ \n)
 *
 *   text mark    = "[" content "]" group { group }      e.g. [This sentence]{agreed @mw at=2026-09-18}
 *   changed      = [~~deleted~~ inserted]{changed @mw}   a replacement
 *                  [new words]{changed @mw}              a pure insertion
 *                  [~~old words~~]{changed @mw}          a pure deletion
 *   line marks   = one or more groups at the END of a line, each preceded by whitespace:
 *                  Some line. {agreed @mw via=dwell} {agreed @claude} {decision}
 *                  A table row carries them inside its last cell: | a | b {agreed @mw} |
 *                  A fenced code block carries them on its opening fence: ```js {seen @mw}
 *
 * DISAMBIGUATION (why ordinary markdown is never read as a mark)
 *   - A link [t](u) has "](", a reference [t][r] has "][", a footnote reference has no braces: a
 *     text mark needs "]{" with no space between.
 *   - A task list item "- [ ] x" / "- [x] x" has "] " after the bracket, never "]{".
 *   - Pandoc attributes {.class #id key=v} and raw attributes {=html} start with ".", "#", "=" or a
 *     key=value pair; a mark's first token must be a bare word, so they are left alone.
 *   - A trailing line group must be preceded by whitespace and must be a known line type
 *     (DIALECT_POLICY.lineTypes) or carry an @source, so a line that merely ends in "{x}" (a
 *     template placeholder, LaTeX, prose) stays text.
 *   - Nothing inside code spans or fenced code blocks is parsed (except the fence line's groups).
 *   - Escape a literal "]" inside mark content as "\]" (plain markdown escapes, so renderers show "]").
 *
 * PLAIN RENDERERS: a text mark shows as "[text]{changed @mw}" and a line mark as a trailing
 * "{agreed @mw}"; nothing is hidden, nothing breaks a table (marks sit inside the last cell), and
 * a fence's info string keeps its language as the first word.
 */

// ============================================================================
// POLICY
// ============================================================================

export const DIALECT_POLICY = {
  version: 1,
  /** A mark's type: a bare lowercase word (so Pandoc {.class #id} attributes are never marks). */
  typePattern: /^[a-z][a-z0-9_-]*$/,
  handlePattern: /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
  keyPattern: /^[A-Za-z][A-Za-z0-9_-]*$/,
  /** Types accepted as trailing line groups without an @source (tiers and bare flags). */
  lineTypes: [
    'seen', 'agreed', 'approved', 'rejected', 'skimmed', 'unseen',
    'decision', 'context', 'uncertain', 'ttl', 'ask', 'answer', 'objection', 'alternative', 'pick',
    'do', 'proxy', 'comment', 'changed', 'reply', 'history',
  ] as readonly string[],
  /** Status marks a person or AI puts on a line (stored as line marks). */
  statusTypes: ['seen', 'agreed', 'approved', 'rejected', 'skimmed'] as readonly string[],
  /** Front matter key that holds the dialect's metadata (handles, bundles). */
  frontMatterKey: 'proof',
  /** Longest content inside one text mark, and most groups on one line (defensive limits). */
  maxContent: 20000,
  maxGroupsPerLine: 200,
} as const;

// ============================================================================
// Mark groups
// ============================================================================

export interface MarkGroup {
  type: string;
  /** The handle after "@", without the "@" (null when the mark names no source). */
  source: string | null;
  /** key=value fields in the order written. */
  fields: Record<string, string>;
}

const BARE_VALUE = /^[^\s"{}\\]+$/;

function isWs(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t';
}

/**
 * Parses a mark group starting at text[start] === "{". Returns the group and the index just past
 * its "}", or null when the braces are not a mark (Pandoc attributes, prose, a broken group).
 * A group never spans a line break.
 */
export function parseMarkGroupAt(text: string, start: number): { group: MarkGroup; end: number } | null {
  if (text[start] !== '{') return null;
  let i = start + 1;
  const tokens: Array<{ raw: string; value?: string; key?: string }> = [];
  let groupClosed = false;
  while (i < text.length) {
    while (isWs(text[i])) i += 1;
    const ch = text[i];
    if (ch === undefined || ch === '\n' || ch === '\r') return null;
    if (ch === '}') {
      i += 1;
      groupClosed = true;
      break;
    }
    // One token: a bare run, possibly key="quoted".
    let raw = '';
    while (i < text.length && !isWs(text[i]) && text[i] !== '}' && text[i] !== '"' && text[i] !== '\n' && text[i] !== '{') {
      raw += text[i];
      i += 1;
    }
    if (text[i] === '{') return null;
    if (text[i] === '"') {
      // Only a key=" may open a quoted value.
      if (!raw.endsWith('=') || raw.length < 2) return null;
      i += 1;
      let value = '';
      let closed = false;
      while (i < text.length) {
        const c = text[i];
        if (c === '\n' || c === '\r') return null;
        if (c === '\\' && i + 1 < text.length) {
          const next = text[i + 1];
          value += next === 'n' ? '\n' : next;
          i += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          i += 1;
          break;
        }
        value += c;
        i += 1;
      }
      if (!closed) return null;
      tokens.push({ raw: raw + '"', key: raw.slice(0, -1), value });
      if (!(isWs(text[i]) || text[i] === '}')) return null;
      continue;
    }
    if (!raw) return null;
    const eq = raw.indexOf('=');
    if (eq > 0) tokens.push({ raw, key: raw.slice(0, eq), value: raw.slice(eq + 1) });
    else tokens.push({ raw });
  }
  if (!groupClosed || tokens.length === 0) return null;
  const [first, ...rest] = tokens;
  if (first.key !== undefined || !DIALECT_POLICY.typePattern.test(first.raw)) return null;
  const group: MarkGroup = { type: first.raw, source: null, fields: {} };
  for (const token of rest) {
    if (token.key === undefined) {
      if (token.raw.startsWith('@') && group.source === null && Object.keys(group.fields).length === 0) {
        const handle = token.raw.slice(1);
        if (!DIALECT_POLICY.handlePattern.test(handle)) return null;
        group.source = handle;
        continue;
      }
      return null;
    }
    if (!DIALECT_POLICY.keyPattern.test(token.key)) return null;
    group.fields[token.key] = token.value ?? '';
  }
  return { group, end: i };
}

/** Parses exactly one group ("{agreed @mw}") or returns null. */
export function parseMarkGroup(text: string): MarkGroup | null {
  const trimmed = String(text ?? '').trim();
  const parsed = parseMarkGroupAt(trimmed, 0);
  return parsed && parsed.end === trimmed.length ? parsed.group : null;
}

export function quoteValue(value: string): string {
  const v = String(value ?? '');
  if (v && BARE_VALUE.test(v)) return v;
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

export function serializeMarkGroup(group: MarkGroup): string {
  if (!DIALECT_POLICY.typePattern.test(group.type)) throw new Error(`Invalid mark type: ${group.type}`);
  const parts = [group.type];
  if (group.source) {
    if (!DIALECT_POLICY.handlePattern.test(group.source)) throw new Error(`Invalid handle: ${group.source}`);
    parts.push(`@${group.source}`);
  }
  for (const [key, value] of Object.entries(group.fields)) {
    if (value === undefined || value === null) continue;
    if (!DIALECT_POLICY.keyPattern.test(key)) throw new Error(`Invalid field name: ${key}`);
    parts.push(`${key}=${quoteValue(String(value))}`);
  }
  return `{${parts.join(' ')}}`;
}

/** A trailing group is a line mark only when its type is a known line type or it names a source. */
export function isLineGroup(group: MarkGroup): boolean {
  return group.source !== null || DIALECT_POLICY.lineTypes.includes(group.type);
}

// ============================================================================
// Front matter (a small YAML subset: block maps, scalars, one-line flow maps)
// ============================================================================

export type YamlValue = string | { [key: string]: YamlValue };

export interface FrontMatter {
  /** The front matter lines that are not the proof block, unchanged. */
  otherLines: string[];
  /** The parsed proof block (null when absent). */
  proof: { [key: string]: YamlValue } | null;
  /** True when the text began with a front matter block. */
  present: boolean;
}

function unquoteYamlScalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    return v.slice(1, -1).replace(/\\(["\\n])/g, (_m, c: string) => (c === 'n' ? '\n' : c));
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function splitFlowItems(inner: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (let i = 0; i < inner.length; i += 1) {
    const c = inner[i];
    if (quote) {
      current += c;
      if (c === '\\' && quote === '"' && i + 1 < inner.length) { current += inner[i + 1]; i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; current += c; continue; }
    if (c === '{') depth += 1;
    if (c === '}') depth -= 1;
    if (c === ',' && depth === 0) { items.push(current); current = ''; continue; }
    current += c;
  }
  if (current.trim()) items.push(current);
  return items;
}

function splitKeyValue(text: string): [string, string] | null {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === ':' && (i + 1 === text.length || isWs(text[i + 1]))) {
      return [unquoteYamlScalar(text.slice(0, i)), text.slice(i + 1).trim()];
    }
  }
  return null;
}

function parseYamlValue(raw: string): YamlValue {
  const v = raw.trim();
  if (v.startsWith('{') && v.endsWith('}')) {
    const out: { [key: string]: YamlValue } = {};
    for (const item of splitFlowItems(v.slice(1, -1))) {
      const kv = splitKeyValue(item.trim());
      if (kv) out[kv[0]] = parseYamlValue(kv[1]);
    }
    return out;
  }
  return unquoteYamlScalar(v);
}

/** Parses a block map from indented lines (each "key: value" or "key:" followed by a deeper block). */
function parseYamlBlock(lines: string[]): { [key: string]: YamlValue } {
  const out: { [key: string]: YamlValue } = {};
  const indentOf = (line: string) => line.length - line.trimStart().length;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) { i += 1; continue; }
    const indent = indentOf(line);
    const kv = splitKeyValue(line.trim());
    if (!kv) { i += 1; continue; }
    const [key, rest] = kv;
    if (rest) {
      out[key] = parseYamlValue(rest);
      i += 1;
      continue;
    }
    const child: string[] = [];
    i += 1;
    while (i < lines.length && (!lines[i].trim() || indentOf(lines[i]) > indent)) {
      child.push(lines[i]);
      i += 1;
    }
    out[key] = parseYamlBlock(child);
  }
  return out;
}

const FRONT_MATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Splits the leading front matter off a document. `body` is everything after it. */
export function splitFrontMatter(text: string): { frontMatter: FrontMatter; body: string } {
  const match = FRONT_MATTER.exec(text);
  if (!match) return { frontMatter: { otherLines: [], proof: null, present: false }, body: text };
  const lines = match[1].split(/\r?\n/);
  const otherLines: string[] = [];
  let proofLines: string[] | null = null;
  let proofInline: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const top = new RegExp(`^${DIALECT_POLICY.frontMatterKey}:(.*)$`).exec(line);
    if (top) {
      const rest = top[1].trim();
      if (rest) proofInline = rest;
      proofLines = [];
      i += 1;
      while (i < lines.length && (!lines[i].trim() || /^\s/.test(lines[i]))) {
        proofLines.push(lines[i]);
        i += 1;
      }
      i -= 1;
      continue;
    }
    otherLines.push(line);
  }
  let proof: { [key: string]: YamlValue } | null = null;
  if (proofInline) {
    const parsed = parseYamlValue(proofInline);
    proof = typeof parsed === 'string' ? {} : parsed;
  } else if (proofLines) {
    proof = parseYamlBlock(proofLines);
  }
  return { frontMatter: { otherLines, proof, present: true }, body: text.slice(match[0].length) };
}

function yamlScalar(value: string): string {
  if (/^[A-Za-z0-9_./@+-][A-Za-z0-9_./@+ -]*$/.test(value) && !/:\s|\s$|^(true|false|null|yes|no|~)$/i.test(value) && !value.includes(': ')) {
    return value.includes(':') ? JSON.stringify(value) : value;
  }
  return JSON.stringify(value);
}

function emitYaml(map: { [key: string]: YamlValue }, indent: number): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(map)) {
    const k = /^[A-Za-z0-9_.-]+$/.test(key) ? key : JSON.stringify(key);
    if (typeof value === 'string') out.push(`${' '.repeat(indent)}${k}: ${yamlScalar(value)}`);
    else {
      out.push(`${' '.repeat(indent)}${k}:`);
      out.push(...emitYaml(value, indent + 2));
    }
  }
  return out;
}

/** Writes front matter: the other lines unchanged, then the proof block (if any). */
export function serializeFrontMatter(frontMatter: Pick<FrontMatter, 'otherLines' | 'proof'>): string {
  const lines = [...frontMatter.otherLines];
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (frontMatter.proof && Object.keys(frontMatter.proof).length) {
    lines.push(...emitYaml({ [DIALECT_POLICY.frontMatterKey]: frontMatter.proof }, 0));
  }
  if (!lines.length) return '';
  return `---\n${lines.join('\n')}\n---\n`;
}

// ============================================================================
// Handles
// ============================================================================

/** handle → actor ("mw" → "human:mw@mike-wolf.com"). */
export type HandleTable = Record<string, string>;

function handleBase(actor: string): string {
  const colon = actor.indexOf(':');
  const body = colon >= 0 ? actor.slice(colon + 1) : actor;
  const local = body.includes('@') ? body.split('@')[0] : body;
  const cleaned = local.normalize('NFKD').replace(/[^\w.-]+/g, '-').replace(/^[^A-Za-z0-9]+|[-.]+$/g, '').toLowerCase();
  return cleaned || 'someone';
}

/** Builds a handle table for actors in the given order (a stable short handle for each). */
export function buildHandleTable(actors: string[], existing: HandleTable = {}): HandleTable {
  const table: HandleTable = { ...existing };
  const taken = new Set(Object.keys(table).map(h => h.toLowerCase()));
  const byActor = new Map(Object.entries(table).map(([h, a]) => [a.toLowerCase(), h]));
  for (const actor of actors) {
    if (!actor || byActor.has(actor.toLowerCase())) continue;
    const base = handleBase(actor);
    let handle = base;
    for (let n = 2; taken.has(handle.toLowerCase()); n += 1) handle = `${base}${n}`;
    taken.add(handle.toLowerCase());
    byActor.set(actor.toLowerCase(), handle);
    table[handle] = actor;
  }
  return table;
}

export function handleForActor(table: HandleTable, actor: string): string | null {
  const key = String(actor ?? '').toLowerCase();
  for (const [handle, value] of Object.entries(table)) if (value.toLowerCase() === key) return handle;
  return null;
}

/** Reads the handle table from a parsed proof block (values must be strings). */
export function handlesFromProofBlock(proof: { [key: string]: YamlValue } | null): HandleTable {
  const raw = proof?.handles;
  const out: HandleTable = {};
  if (!raw || typeof raw === 'string') return out;
  for (const [handle, actor] of Object.entries(raw)) {
    if (typeof actor === 'string' && DIALECT_POLICY.handlePattern.test(handle) && actor.trim()) out[handle] = actor.trim();
  }
  return out;
}

// ============================================================================
// Parsed document
// ============================================================================

/** A text mark: its target span in the base markdown, plus the groups written after it. */
export interface InlineMark {
  /** Offsets into `base` (for a pure insertion start === end). */
  start: number;
  end: number;
  /** Offsets into `current` (for a pure insertion: the inserted text). */
  cstart: number;
  cend: number;
  /** For a changed mark: the deleted text (in base between start and end) and the inserted text. */
  deleted: string | null;
  inserted: string | null;
  /** The groups after the bracket, in order ([x]{comment @a}{reply @b}). */
  groups: MarkGroup[];
  /** The raw content between the brackets (for history notes). */
  raw: string;
}

/** Line marks: the groups at the end of one line (0-based line numbers in base and in current). */
export interface LineGroups {
  line: number;
  currentLine?: number;
  groups: MarkGroup[];
}

export interface ParsedProofDocument {
  frontMatter: FrontMatter;
  handles: HandleTable;
  /** The document with every mark removed: deleted text kept, inserted text left out. */
  base: string;
  /** The document as the editor stores it: pending insertions in, deletions still present. */
  current: string;
  inline: InlineMark[];
  lines: LineGroups[];
  warnings: string[];
}

/** Adds `current` offsets to marks parsed against `base` (pure insertions go in at their point). */
export function withCurrentText(base: string, marks: Array<Omit<InlineMark, 'cstart' | 'cend'>>): { current: string; marks: InlineMark[] } {
  const inserts = marks
    .map((mark, order) => ({ mark, order }))
    .filter(({ mark }) => mark.deleted === null && mark.inserted !== null && mark.start === mark.end)
    .sort((a, b) => a.mark.start - b.mark.start || a.order - b.order);
  let current = '';
  let pos = 0;
  const insertAt = new Map<Omit<InlineMark, 'cstart' | 'cend'>, number>();
  for (const { mark } of inserts) {
    current += base.slice(pos, mark.start);
    insertAt.set(mark, current.length);
    current += mark.inserted ?? '';
    pos = mark.start;
  }
  current += base.slice(pos);
  const shift = (at: number): number => {
    let total = 0;
    for (const { mark } of inserts) if (mark.start <= at) total += (mark.inserted ?? '').length;
    return at + total;
  };
  const shiftStart = (at: number): number => {
    let total = 0;
    for (const { mark } of inserts) if (mark.start < at || mark.start === at) total += (mark.inserted ?? '').length;
    return at + total;
  };
  const out = marks.map((mark) => {
    const at = insertAt.get(mark);
    if (at !== undefined) return { ...mark, cstart: at, cend: at + (mark.inserted ?? '').length };
    return { ...mark, cstart: shiftStart(mark.start), cend: shift(mark.end) };
  });
  return { current, marks: out };
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;

interface RawLine { text: string; start: number }

function splitLinesWithOffsets(text: string): RawLine[] {
  const out: RawLine[] = [];
  let start = 0;
  for (let i = 0; i <= text.length; i += 1) {
    if (i === text.length || text[i] === '\n') {
      out.push({ text: text.slice(start, i), start });
      start = i + 1;
    }
  }
  return out;
}

/** True for a GFM table row line ("| a | b |"). The delimiter row counts too (it never gets marks). */
function isTableRowLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith('|') && t.endsWith('|') && t.length >= 2;
}

/**
 * Strips trailing mark groups off one line. Returns the line without them and the groups in the
 * order written. Table rows: the groups sit before the closing "|".
 */
export function stripTrailingGroups(line: string, options: { tableRow?: boolean } = {}): { text: string; groups: MarkGroup[] } {
  let head = line;
  let tail = '';
  if (options.tableRow) {
    const m = /^(.*?)(\s*\|\s*)$/.exec(line);
    if (m) { head = m[1]; tail = m[2]; }
  }
  const groups: MarkGroup[] = [];
  for (let guard = 0; guard < DIALECT_POLICY.maxGroupsPerLine; guard += 1) {
    const trimmed = head.replace(/[ \t]+$/, '');
    if (!trimmed.endsWith('}')) break;
    // Find the "{" that opens the last group: scan candidate "{" positions from the right.
    let found: { at: number; group: MarkGroup } | null = null;
    for (let at = trimmed.lastIndexOf('{'); at >= 0; at = trimmed.lastIndexOf('{', at - 1)) {
      const parsed = parseMarkGroupAt(trimmed, at);
      if (parsed && parsed.end === trimmed.length) { found = { at, group: parsed.group }; break; }
      if (at === 0) break;
    }
    if (!found || !isLineGroup(found.group)) break;
    const before = trimmed.slice(0, found.at);
    // A line group is preceded by whitespace (a bracket mark's group follows "]" or "}" directly).
    if (before.length > 0 && !/[ \t]$/.test(before)) break;
    groups.unshift(found.group);
    head = before;
  }
  if (!groups.length) return { text: line, groups };
  const cleaned = head.replace(/[ \t]+$/, '');
  return { text: options.tableRow ? `${cleaned}${tail.startsWith(' ') ? tail : ` ${tail.trimStart()}`}` : cleaned, groups };
}

function isEscaped(text: string, index: number): boolean {
  let n = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) n += 1;
  return n % 2 === 1;
}

/** Index of the "]" matching the "[" at `open`, or -1 (never crosses a blank line or a code span boundary). */
function findCloseBracket(text: string, open: number, limit: number): number {
  let depth = 0;
  for (let i = open; i < limit; i += 1) {
    const c = text[i];
    if (c === '`' && !isEscaped(text, i)) {
      let run = 1;
      while (text[i + run] === '`') run += 1;
      const fence = '`'.repeat(run);
      const close = text.indexOf(fence, i + run);
      if (close < 0 || close >= limit) return -1;
      i = close + run - 1;
      continue;
    }
    if (c === '\n' && text[i + 1] === '\n') return -1;
    if (c === '\n' && /^\n[ \t]*\n/.test(text.slice(i, i + 64))) return -1;
    if (isEscaped(text, i)) continue;
    if (c === '[') depth += 1;
    else if (c === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits a changed mark's content: "~~deleted~~ inserted" / "~~deleted~~" / "inserted". */
export function splitChangedContent(content: string): { deleted: string | null; inserted: string } {
  if (!content.startsWith('~~')) return { deleted: null, inserted: content };
  for (let i = 2; i < content.length - 1; i += 1) {
    if (content[i] === '~' && content[i + 1] === '~' && !isEscaped(content, i)) {
      const deleted = content.slice(2, i);
      let rest = content.slice(i + 2);
      if (rest.startsWith(' ')) rest = rest.slice(1);
      return { deleted, inserted: rest };
    }
  }
  return { deleted: null, inserted: content };
}

interface InlineParse {
  base: string;
  current: string;
  marks: InlineMark[];
  /** For each input index (and the end), the base and current lengths reached there. */
  mapBase: number[];
  mapCurrent: number[];
}

/**
 * Parses text marks in one stretch of non-code text. Returns the base text (pending insertions
 * left out), the current text (pending insertions in, as the editor stores them) and marks with
 * offsets into both (callers shift them). Nested marks are parsed inside content.
 */
function parseInlineSegment(text: string): InlineParse {
  let base = '';
  let current = '';
  const marks: InlineMark[] = [];
  const mapBase: number[] = [];
  const mapCurrent: number[] = [];
  const copy = (s: string) => { base += s; current += s; };
  const note = (from: number, to: number) => { for (let k = from; k < to; k += 1) { if (mapBase[k] === undefined) { mapBase[k] = base.length; mapCurrent[k] = current.length; } } };
  let i = 0;
  while (i < text.length) {
    note(i, i + 1);
    const c = text[i];
    if (c === '`' && !isEscaped(text, i)) {
      let run = 1;
      while (text[i + run] === '`') run += 1;
      const fence = '`'.repeat(run);
      const close = text.indexOf(fence, i + run);
      const end = close >= 0 ? close + run : i + run;
      for (let k = i; k < end; k += 1) { mapBase[k] = base.length + (k - i); mapCurrent[k] = current.length + (k - i); }
      copy(text.slice(i, end));
      i = end;
      continue;
    }
    if (c === '[' && !isEscaped(text, i)) {
      const close = findCloseBracket(text, i, text.length);
      if (close > i && text[close + 1] === '{' && close - i - 1 <= DIALECT_POLICY.maxContent) {
        const groups: MarkGroup[] = [];
        let j = close + 1;
        while (text[j] === '{') {
          const parsed = parseMarkGroupAt(text, j);
          if (!parsed) break;
          groups.push(parsed.group);
          j = parsed.end;
        }
        if (groups.length) {
          const content = text.slice(i + 1, close);
          const start = base.length;
          const cstart = current.length;
          const addInner = (inner: InlineParse) => {
            for (const m of inner.marks) marks.push({ ...m, start: m.start + start, end: m.end + start, cstart: m.cstart + cstart, cend: m.cend + cstart });
            base += inner.base;
            current += inner.current;
          };
          if (groups[0].type === 'changed') {
            const split = splitChangedContent(content);
            const inner = split.deleted === null ? null : parseInlineSegment(split.deleted);
            let inserted = split.inserted;
            if (inner) addInner(inner);
            else {
              // A pure insertion may carry marks of its own (a comment on the inserted words): they
              // sit in current only (base has no inserted text, so their base span is the point).
              const ins = parseInlineSegment(split.inserted);
              // A change nested in an insertion is part of that insertion's text, not a second one.
              for (const m of ins.marks) if (m.groups[0]?.type !== 'changed') marks.push({ ...m, start, end: start, cstart: m.cstart + cstart, cend: m.cend + cstart });
              inserted = ins.current;
              current += ins.current;
            }
            marks.push({ start, end: base.length, cstart, cend: current.length, deleted: inner ? inner.base : null, inserted, groups, raw: content });
          } else {
            addInner(parseInlineSegment(content));
            marks.push({ start, end: base.length, cstart, cend: current.length, deleted: null, inserted: null, groups, raw: content });
          }
          note(i, j);
          i = j;
          continue;
        }
      }
    }
    copy(c);
    i += 1;
  }
  mapBase[text.length] = base.length;
  mapCurrent[text.length] = current.length;
  return { base, current, marks, mapBase, mapCurrent };
}

/**
 * Parses a Proof Document (the dialect). Line groups are read first (per line, outside fenced
 * code), then text marks. `base` is the document the marks apply to.
 */
export function parseProofDocument(text: string): ParsedProofDocument {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  const { frontMatter, body } = splitFrontMatter(normalized);
  const warnings: string[] = [];
  const handles = handlesFromProofBlock(frontMatter.proof);
  // Pass 1: trailing line groups (outside fenced code; a fence's opening line may carry them).
  const rawLines = splitLinesWithOffsets(body);
  const stripped: string[] = [];
  const lineGroupsAtRawLine = new Map<number, MarkGroup[]>();
  const codeLines = new Set<number>();
  let fence: { char: string; len: number } | null = null;
  for (let n = 0; n < rawLines.length; n += 1) {
    const line = rawLines[n].text;
    if (fence) {
      codeLines.add(n);
      const close = new RegExp(`^ {0,3}${fence.char === '`' ? '`' : '~'}{${fence.len},}\\s*$`).exec(line);
      if (close) fence = null;
      stripped.push(line);
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open && !(open[2][0] === '`' && open[3].includes('`'))) {
      fence = { char: open[2][0], len: open[2].length };
      const info = stripTrailingGroups(line);
      if (info.groups.length) lineGroupsAtRawLine.set(n, info.groups);
      stripped.push(info.text);
      codeLines.add(n);
      continue;
    }
    // An indented code block (4 spaces after a blank line, not inside a list): leave it alone.
    if (/^( {4}|\t)/.test(line) && (n === 0 || !rawLines[n - 1].text.trim() || codeLines.has(n - 1))
      && !stripped.slice(-3).some(l => /^\s*([-*+]|\d+[.)])\s/.test(l))) {
      codeLines.add(n);
      stripped.push(line);
      continue;
    }
    const tableRow = isTableRowLine(line);
    const result = stripTrailingGroups(line, { tableRow });
    if (result.groups.length) lineGroupsAtRawLine.set(n, result.groups);
    stripped.push(result.text);
  }
  // Pass 2: text marks, over the stripped lines, skipping code lines (a text mark may span a soft
  // line break, so consecutive non-code lines are parsed together).
  let base = '';
  let current = '';
  const inline: InlineMark[] = [];
  /** Where each stripped line ends, in base and in current. */
  const lineEndIn: Array<{ base: number; current: number }> = [];
  let n = 0;
  while (n < stripped.length) {
    if (codeLines.has(n)) {
      base += stripped[n];
      current += stripped[n];
      lineEndIn[n] = { base: base.length, current: current.length };
      if (n < stripped.length - 1) { base += '\n'; current += '\n'; }
      n += 1;
      continue;
    }
    let m = n;
    while (m < stripped.length && !codeLines.has(m)) m += 1;
    const chunk = stripped.slice(n, m).join('\n') + (m < stripped.length ? '\n' : '');
    const parsed = parseInlineSegment(chunk);
    const bOff = base.length;
    const cOff = current.length;
    for (const mark of parsed.marks) inline.push({ ...mark, start: mark.start + bOff, end: mark.end + bOff, cstart: mark.cstart + cOff, cend: mark.cend + cOff });
    let rawAt = 0;
    for (let k = n; k < m; k += 1) {
      rawAt += stripped[k].length;
      lineEndIn[k] = { base: bOff + (parsed.mapBase[rawAt] ?? parsed.base.length), current: cOff + (parsed.mapCurrent[rawAt] ?? parsed.current.length) };
      rawAt += 1;
    }
    base += parsed.base;
    current += parsed.current;
    n = m;
  }
  const lineNumberAt = (text: string, at: number): number => {
    let count = 0;
    for (let k = 0; k < at && k < text.length; k += 1) if (text[k] === '\n') count += 1;
    return count;
  };
  const lines: LineGroups[] = [];
  for (const [rawLine, groups] of [...lineGroupsAtRawLine.entries()].sort((a, b) => a[0] - b[0])) {
    const end = lineEndIn[rawLine] ?? { base: base.length, current: current.length };
    lines.push({ line: lineNumberAt(base, end.base), currentLine: lineNumberAt(current, end.current), groups });
  }
  inline.sort((a, b) => a.start - b.start || b.end - a.end);
  return { frontMatter, handles, base, current, inline, lines, warnings };
}

// ============================================================================
// Serialize
// ============================================================================

/** A text mark to write: its span in `markdown` (the document as stored). */
export interface InlineMarkOut {
  start: number;
  end: number;
  /** changed marks: the replacement (replace) — null for a pure deletion; for an insertion the span IS the inserted text. */
  kind?: 'insert' | 'delete' | 'replace' | 'comment';
  inserted?: string | null;
  groups: MarkGroup[];
}

export interface SerializeInput {
  /** The document markdown (no front matter; pending insertions are part of it). */
  markdown: string;
  /** Existing front matter to keep (its proof block is replaced). */
  frontMatter?: Pick<FrontMatter, 'otherLines'> | null;
  /** The proof block to write (handles and any other metadata). */
  proof: { [key: string]: YamlValue };
  inline: InlineMarkOut[];
  /** Groups for the end of a markdown line (0-based line number in `markdown`). */
  lines: LineGroups[];
}

/** Escapes "[" and "]" that would unbalance a text mark's brackets (markdown escapes render the same). */
export function escapeContent(content: string): string {
  let depth = 0;
  let out = '';
  for (let i = 0; i < content.length; i += 1) {
    const c = content[i];
    if (isEscaped(content, i)) { out += c; continue; }
    if (c === '[') {
      const close = findCloseBracket(content, i, content.length);
      if (close < 0) { out += '\\['; continue; }
      depth += 1;
    } else if (c === ']') {
      if (depth === 0) { out += '\\]'; continue; }
      depth -= 1;
    }
    out += c;
  }
  return out;
}

function escapeTilde(content: string): string {
  return content.replace(/~~/g, '\\~~');
}

/**
 * Writes a Proof Document. Text marks nest when one contains another; a text mark that overlaps
 * another without nesting must be written by the caller as a line mark instead (see
 * `planInlineMarks`). Line groups go at the end of their line (inside the last table cell; after a
 * fence's info string).
 */
export function serializeProofDocument(input: SerializeInput): string {
  const md = input.markdown;
  const marks = [...input.inline].sort((a, b) => a.start - b.start || b.end - a.end);
  // Build the inline-marked text recursively over [from, to).
  const render = (from: number, to: number, list: InlineMarkOut[]): string => {
    let out = '';
    let pos = from;
    let idx = 0;
    while (idx < list.length) {
      const mark = list[idx];
      // Children: marks inside this one.
      let k = idx + 1;
      const children: InlineMarkOut[] = [];
      while (k < list.length && list[k].start >= mark.start && list[k].end <= mark.end && !(list[k].start === mark.start && list[k].end === mark.end && list[k] === mark)) {
        children.push(list[k]);
        k += 1;
      }
      out += md.slice(pos, mark.start);
      const inner = escapeContent(render(mark.start, mark.end, children));
      let content: string;
      if (mark.kind === 'replace') content = `~~${escapeTilde(inner)}~~ ${escapeTilde(escapeContent(mark.inserted ?? ''))}`;
      else if (mark.kind === 'delete') content = `~~${escapeTilde(inner)}~~`;
      else if (mark.kind === 'insert') content = inner.startsWith('~~') ? `\\${inner}` : inner;
      else content = inner;
      out += `[${content}]${mark.groups.map(serializeMarkGroup).join('')}`;
      pos = mark.end;
      idx = k;
    }
    out += md.slice(pos, to);
    return out;
  };
  // Line groups are attached per line AFTER inline rendering, so render line by line boundaries:
  // inline marks never span a line that carries groups at its end past the groups' position,
  // because groups go at the very end of the line.
  const byLine = new Map<number, MarkGroup[]>();
  for (const entry of input.lines) {
    if (!entry.groups.length) continue;
    byLine.set(entry.line, [...(byLine.get(entry.line) ?? []), ...entry.groups]);
  }
  // Insert a placeholder at each line end that carries groups, then render inline marks.
  const lineStarts: number[] = [0];
  for (let i = 0; i < md.length; i += 1) if (md[i] === '\n') lineStarts.push(i + 1);
  const rendered = render(0, md.length, marks);
  // Map line numbers of md → line numbers of rendered: inline marks never add or remove "\n"
  // (content is copied verbatim), so line numbers are identical.
  const outLines = rendered.split('\n');
  for (const [lineNo, groups] of byLine) {
    if (lineNo < 0 || lineNo >= outLines.length) continue;
    const text = outLines[lineNo];
    const suffix = groups.map(serializeMarkGroup).join(' ');
    if (isTableRowLine(text)) {
      const m = /^(.*?)(\s*\|\s*)$/.exec(text);
      outLines[lineNo] = m ? `${m[1].replace(/[ \t]+$/, '')} ${suffix}${m[2].startsWith(' ') ? m[2] : ` ${m[2].trimStart()}`}` : `${text} ${suffix}`;
    } else {
      outLines[lineNo] = `${text.replace(/[ \t]+$/, '')} ${suffix}`;
    }
  }
  const front = serializeFrontMatter({ otherLines: input.frontMatter?.otherLines ?? [], proof: input.proof });
  return `${front}${front ? '\n' : ''}${outLines.join('\n')}`;
}

/**
 * Chooses which text marks can be written inline: nested or disjoint spans are fine; a mark that
 * partly overlaps an earlier one is returned in `overlapping` (write it as a line mark with quote=).
 */
export function planInlineMarks<T extends { start: number; end: number }>(marks: T[], mustInline?: (mark: T) => boolean): { inline: T[]; overlapping: T[] } {
  if (mustInline) {
    // Marks that must stay in the text (a pending insertion: its text IS the document's) are
    // placed first; any other mark that crosses one of them (overlaps without nesting) goes out.
    const first = marks.filter(mustInline);
    const firstPlan = planInlineMarks(first);
    const kept = firstPlan.inline;
    const crosses = (a: T, b: { start: number; end: number }) => a.start < b.end && b.start < a.end
      && !(a.start >= b.start && a.end <= b.end) && !(b.start >= a.start && b.end <= a.end);
    const rest = marks.filter(m => !mustInline(m));
    const outside = rest.filter(m => kept.some(k => crosses(m, k)));
    const restPlan = planInlineMarks(rest.filter(m => !outside.includes(m)));
    const restOut: T[] = [];
    const inline = [...kept];
    for (const m of restPlan.inline) (inline.some(k => crosses(m, k)) ? restOut : inline).push(m);
    return {
      inline: inline.sort((a, b) => a.start - b.start || b.end - a.end),
      overlapping: [...firstPlan.overlapping, ...outside, ...restPlan.overlapping, ...restOut],
    };
  }
  const sorted = [...marks].sort((a, b) => a.start - b.start || b.end - a.end);
  const inline: T[] = [];
  const overlapping: T[] = [];
  const stack: T[] = [];
  for (const mark of sorted) {
    while (stack.length && stack[stack.length - 1].end <= mark.start && !(stack[stack.length - 1].start === mark.start && stack[stack.length - 1].end === mark.start)) stack.pop();
    const top = stack[stack.length - 1];
    if (top && mark.end > top.end) { overlapping.push(mark); continue; }
    // Two insertions at the same point, or an insertion at the edge of another span, are fine.
    inline.push(mark);
    stack.push(mark);
  }
  return { inline, overlapping };
}

// ============================================================================
// Placing pending insertions (export)
// ============================================================================

/**
 * How export finds the text of each pending insertion. The stored offsets of a suggestion
 * (startRel, range) go stale as soon as the document changes before it, and its quote is often a
 * fragment of interrupted typing ("jer", " M", "i") that occurs dozens of times. Searching each
 * quote alone put "on", " M" and "i" into the title "Waiting on Mike" of the live Waiting on Mike
 * document (ttq18nc1, 2026-09-19) and nested one insertion inside another. So insertions are placed
 * together: a person types in order, so an insertion made right after another by the same person
 * most likely starts where that one ends. A Viterbi pass over the insertions in creation order
 * chooses one occurrence each, rewarding such adjacency; the stale offset only breaks ties.
 * Two insertions never claim the same characters.
 */
export const INSERT_PLACEMENT_POLICY = {
  /** Score for an insertion that starts exactly where the previous one (same person) ends. */
  adjacentBonus: 100,
  /** Score when a few untracked characters (maxGap or fewer) sit between them. */
  nearBonus: 50,
  maxGap: 2,
  /** Penalty per character of distance from the stored offset (startRel): a tie-breaker only. */
  distanceWeight: 0.002,
  /** Penalty for matching the trimmed text instead of the exact inserted text. */
  trimmedPenalty: 5,
  /** Most re-plans while resolving two insertions that claim the same characters. */
  maxRounds: 400,
} as const;

export interface InsertToPlace {
  id: string;
  by: string;
  createdAt: string;
  /** The inserted text exactly (leading and trailing spaces included). */
  content: string;
  /** The stored quote (usually the trimmed content). */
  quote: string;
  /** The stored offset into the document's plain text (startRel), or null. */
  expected: number | null;
}

export interface StrippedText { stripped: string; map: number[] }

export interface InsertPlacement { start: number; end: number }

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/** Every legal occurrence of `text` in the markdown (through the plain-text view), as markdown spans. */
function insertCandidates(body: string, view: StrippedText, text: string): Array<{ s: number; e: number; start: number; end: number }> {
  const out: Array<{ s: number; e: number; start: number; end: number }> = [];
  if (!text) return out;
  for (let at = view.stripped.indexOf(text); at >= 0; at = view.stripped.indexOf(text, at + 1)) {
    const lastIdx = at + text.length - 1;
    if (lastIdx >= view.map.length) break;
    let start = view.map[at];
    const end = view.map[lastIdx] + 1;
    if (start === undefined || end === undefined || end <= start) continue;
    // A markdown escape belongs to the character it escapes ("sk\_live": the span starts at "\").
    if (start > 0 && body[start - 1] === '\\' && !isEscaped(body, start - 1)) start -= 1;
    const slice = body.slice(start, end);
    // The span must hold exactly the inserted text: no markdown syntax (emphasis delimiters, a
    // link's "](url)", a heading's "#") and no line break the insertion did not type.
    if (unescapeMarkdown(slice) !== text || /\n[ \t]*\n/.test(slice)) continue;
    out.push({ s: at, e: at + text.length, start, end });
  }
  return out;
}

/**
 * Chooses the markdown span of each pending insertion (null: its text is nowhere in the document,
 * an orphan). Pure; see INSERT_PLACEMENT_POLICY.
 */
export function placeInsertions(body: string, view: StrippedText, items: InsertToPlace[]): Map<string, InsertPlacement | null> {
  const P = INSERT_PLACEMENT_POLICY;
  const result = new Map<string, InsertPlacement | null>();
  const ordered = [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const cands = new Map<string, Array<{ s: number; e: number; start: number; end: number; penalty: number }>>();
  for (const item of ordered) {
    // Line breaks at the edges are the block's own (a new paragraph): the brackets hold the words.
    const tries = [item.content.replace(/^\n+|\n+$/g, ''), item.content.trim(), item.quote, item.quote.trim()].filter((t, i, all) => t && all.indexOf(t) === i);
    // Every occurrence of the exact text, and of the trimmed text (the stored content's edge space
    // may be the document's own, e.g. after an opening quote mark), the latter slightly penalised.
    const found: Array<{ s: number; e: number; start: number; end: number; penalty: number }> = [];
    tries.forEach((t, rank) => {
      for (const c of insertCandidates(body, view, t)) {
        if (!found.some(f => f.start === c.start && f.end === c.end)) found.push({ ...c, penalty: rank === 0 ? 0 : P.trimmedPenalty });
      }
    });
    cands.set(item.id, found);
  }
  for (let round = 0; round < P.maxRounds; round += 1) {
    const live = ordered.filter(item => (cands.get(item.id) ?? []).length > 0);
    // Viterbi over `live` in creation order.
    const score: number[][] = [];
    const back: number[][] = [];
    const linked: boolean[][] = [];
    for (let i = 0; i < live.length; i += 1) {
      const list = cands.get(live[i].id)!;
      const emit = (c: { s: number; penalty: number }) => -c.penalty - (live[i].expected === null ? 0 : P.distanceWeight * Math.abs(c.s - live[i].expected!));
      score[i] = [];
      back[i] = [];
      linked[i] = [];
      if (i === 0) {
        list.forEach((c, k) => { score[0][k] = emit(c); back[0][k] = -1; linked[0][k] = false; });
        continue;
      }
      const prevList = cands.get(live[i - 1].id)!;
      let bestPrev = 0;
      for (let k = 1; k < prevList.length; k += 1) if (score[i - 1][k] > score[i - 1][bestPrev]) bestPrev = k;
      const sameAuthor = live[i - 1].by === live[i].by;
      const byEnd = new Map<number, number>();
      if (sameAuthor) {
        prevList.forEach((c, k) => {
          const had = byEnd.get(c.e);
          if (had === undefined || score[i - 1][k] > score[i - 1][had]) byEnd.set(c.e, k);
        });
      }
      list.forEach((c, k) => {
        let best = score[i - 1][bestPrev];
        let from = bestPrev;
        let link = false;
        if (sameAuthor) {
          for (let gap = 0; gap <= P.maxGap; gap += 1) {
            const pk = byEnd.get(c.s - gap);
            if (pk === undefined) continue;
            const v = score[i - 1][pk] + (gap === 0 ? P.adjacentBonus : P.nearBonus);
            if (v > best) { best = v; from = pk; link = true; }
          }
        }
        score[i][k] = best + emit(c);
        back[i][k] = from;
        linked[i][k] = link;
      });
    }
    const choice: number[] = new Array(live.length).fill(-1);
    if (live.length) {
      const last = live.length - 1;
      let k = 0;
      for (let j = 1; j < score[last].length; j += 1) if (score[last][j] > score[last][k]) k = j;
      for (let i = last; i >= 0; i -= 1) { choice[i] = k; k = back[i][k]; }
    }
    // Two insertions may not claim the same characters: drop the weaker claim and re-plan.
    const chosen = live.map((item, i) => {
      const c = cands.get(item.id)![choice[i]];
      const links = (linked[i][choice[i]] ? 1 : 0) + (i + 1 < live.length && linked[i + 1][choice[i + 1]] ? 1 : 0);
      return { item, i, c, links };
    }).sort((a, b) => a.c.start - b.c.start || a.c.end - b.c.end);
    let conflict: { item: InsertToPlace; c: { s: number } } | null = null;
    for (let j = 1; j < chosen.length && !conflict; j += 1) {
      for (let q = j - 1; q >= 0; q -= 1) {
        const a = chosen[q];
        const b = chosen[j];
        if (a.c.end <= b.c.start) continue;
        // Keep the better-linked one; on a tie keep the older one.
        const loser = a.links !== b.links ? (a.links < b.links ? a : b) : (a.item.createdAt.localeCompare(b.item.createdAt) > 0 || (a.item.createdAt === b.item.createdAt && a.item.id > b.item.id) ? a : b);
        conflict = { item: loser.item, c: loser.c };
        break;
      }
    }
    if (!conflict) {
      for (const { item, c } of chosen) result.set(item.id, { start: c.start, end: c.end });
      break;
    }
    const lostId = conflict.item.id;
    const lostS = conflict.c.s;
    cands.set(lostId, cands.get(lostId)!.filter(c => c.s !== lostS));
  }
  if (!result.size) {
    // Rounds exhausted (pathological input): greedy, oldest first, nearest free occurrence.
    const claimed: InsertPlacement[] = [];
    for (const item of ordered) {
      const free = (cands.get(item.id) ?? []).filter(c => claimed.every(x => x.end <= c.start || c.end <= x.start));
      if (!free.length) continue;
      const pick = free.reduce((a, b) => (item.expected !== null && Math.abs(b.s - item.expected) < Math.abs(a.s - item.expected) ? b : a));
      claimed.push({ start: pick.start, end: pick.end });
      result.set(item.id, { start: pick.start, end: pick.end });
    }
  }
  for (const item of ordered) if (!result.has(item.id)) result.set(item.id, null);
  return result;
}

// ============================================================================
// Block lines: which markdown line carries each document line's marks
// ============================================================================

export interface BlockLine {
  /** Line kind in the editor's terms: heading, paragraph, list_item, code_block, table_row. */
  kind: string;
  /** Visible text, whitespace-normalized (table rows: cells joined with " | "). */
  text: string;
  /** 0-based markdown lines the block spans. */
  startLine: number;
  endLine: number;
  /** The markdown line that carries its line marks. */
  markLine: number;
}

/** The subset of an mdast node this module reads. */
export interface MdNode {
  type: string;
  children?: MdNode[];
  value?: string;
  alt?: string | null;
  position?: { start: { line: number; offset?: number }; end: { line: number; offset?: number } };
  depth?: number;
}

function mdText(node: MdNode): string {
  if (node.type === 'image' || node.type === 'imageReference') return '';
  if (node.type === 'break') return ' ';
  if (typeof node.value === 'string' && node.type !== 'html') return node.value;
  return (node.children ?? []).map(mdText).join('');
}

export function normalizeText(text: string): string {
  return String(text ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Walks an mdast tree (remark-parse + remark-gfm; positions are 1-based lines) and returns the
 * document lines in the editor's order: paragraphs, headings, code blocks and list-item text
 * blocks, and table rows. `bodyLineOffset` shifts line numbers (front matter already removed).
 */
export function blockLinesFromMdast(root: MdNode): BlockLine[] {
  const out: BlockLine[] = [];
  const push = (kind: string, node: MdNode, text: string, markLine?: number) => {
    const normalized = normalizeText(text);
    if (!normalized || !node.position) return;
    const startLine = node.position.start.line - 1;
    const endLine = node.position.end.line - 1;
    out.push({ kind, text: normalized, startLine, endLine, markLine: markLine ?? endLine });
  };
  const walk = (node: MdNode, parent: string) => {
    for (const child of node.children ?? []) {
      switch (child.type) {
        case 'paragraph':
          push(parent === 'listItem' ? 'list_item' : 'paragraph', child, mdText(child));
          break;
        case 'heading': {
          const start = (child.position?.start.line ?? 1) - 1;
          const end = (child.position?.end.line ?? 1) - 1;
          // A setext heading ends on its underline; its marks go on the text line above it.
          push(parent === 'listItem' ? 'list_item' : 'heading', child, mdText(child), end > start ? end - 1 : end);
          break;
        }
        case 'code':
          push(parent === 'listItem' ? 'list_item' : 'code_block', child, child.value ?? '', (child.position?.start.line ?? 1) - 1);
          break;
        case 'table':
          for (const row of child.children ?? []) {
            push('table_row', row, (row.children ?? []).map(cell => normalizeText(mdText(cell))).join(' | '));
          }
          break;
        case 'yaml':
        case 'html':
        case 'thematicBreak':
        case 'definition':
          break;
        default:
          if (child.children) walk(child, child.type);
      }
    }
  };
  walk(root, 'root');
  return out;
}

/** The subset of an editor line this module needs. */
export interface LineLike { index: number; kind: string; text: string }

/** Editor kinds this module does not map (front matter, html, math): their marks are reported unplaced. */
function kindsCompatible(docKind: string, blockKind: string): boolean {
  return docKind === blockKind;
}

/**
 * Aligns editor lines with markdown block lines in order: exact text first (looking a few blocks
 * ahead), else the next block of a compatible kind. Returns, for each editor line index, the
 * block line (or undefined when it could not be placed).
 */
export function alignLines(docLines: LineLike[], blocks: BlockLine[], lookahead = 8): Map<number, BlockLine> {
  const map = new Map<number, BlockLine>();
  let next = 0;
  for (const line of docLines) {
    let hit = -1;
    for (let k = next; k < Math.min(blocks.length, next + lookahead); k += 1) {
      if (blocks[k].text === line.text && kindsCompatible(line.kind, blocks[k].kind)) { hit = k; break; }
    }
    if (hit < 0) {
      for (let k = next; k < Math.min(blocks.length, next + 2); k += 1) {
        if (kindsCompatible(line.kind, blocks[k].kind)) { hit = k; break; }
      }
    }
    if (hit < 0) continue;
    map.set(line.index, blocks[hit]);
    next = hit + 1;
  }
  return map;
}

// ============================================================================
// Visible text helpers (quotes for the editor's anchor resolver)
// ============================================================================

/** A light markdown → visible text conversion for a fragment inside one line. */
export function visibleFragment(markdown: string): string {
  return String(markdown ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__|~~)/g, '')
    .replace(/(^|[^\w\\])[*_]+|[*_]+(?=[^\w]|$)/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, '$1')
    .replace(/<[^>]+>/g, '');
}

/** Counts non-overlapping occurrences of `needle` in `hay`. */
export function countOccurrences(hay: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) count += 1;
  return count;
}

// ============================================================================
// CriticMarkup
// ============================================================================

export const CRITIC_POLICY = {
  /** Comments may name their author as a leading "@handle:" or "@handle " (a common convention). */
  authorPrefix: /^@([A-Za-z0-9][A-Za-z0-9._-]*):?\s+/,
  /** Header written at the top of a CriticMarkup export (and ignored on import). */
  exportHeader: '<!-- CriticMarkup export from Proof: suggestions and comments only (lossy). Line marks, asks, tiers, flags, objections, alternatives, {do} lines and proxies are NOT included; use format=proof-dialect to keep them. -->',
  exportHeaderPattern: /^<!-- CriticMarkup export from Proof:[^\n]*-->\n*/,
};

/**
 * Converts CriticMarkup to the dialect's parse structure (base + text marks). Supports
 * {++ins++}, {--del--}, {~~old~>new~~}, {==highlight==}{>>comment<<} and a lone {>>comment<<}
 * (attached to the word before it, or after it at the start of a line). A lone highlight keeps its
 * text and is reported in warnings. Marks inside code spans and fenced code are left alone.
 */
export function parseCriticMarkup(text: string, options: { defaultSource?: string | null } = {}): ParsedProofDocument {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  const { frontMatter, body: rawBody } = splitFrontMatter(normalized);
  const body = rawBody.replace(CRITIC_POLICY.exportHeaderPattern, '');
  const handles = handlesFromProofBlock(frontMatter.proof);
  const warnings: string[] = [];
  const inline: Array<Omit<InlineMark, 'cstart' | 'cend'>> = [];
  let base = '';
  const source = options.defaultSource ?? null;
  const commentGroup = (raw: string, type = 'comment'): MarkGroup => {
    const m = CRITIC_POLICY.authorPrefix.exec(raw.trim());
    const handle = m ? m[1] : source;
    const textValue = m ? raw.trim().slice(m[0].length) : raw.trim();
    return { type, source: handle, fields: { text: textValue } };
  };
  const lines = body.split('\n');
  let inFence: string | null = null;
  const nonCode: boolean[] = lines.map(line => {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (inFence) { if (open && open[1][0] === inFence[0] && open[1].length >= inFence.length) inFence = null; return false; }
    if (open) { inFence = open[1]; return false; }
    return true;
  });
  let i = 0;
  const src = body;
  // Line index at each offset (to skip fenced code).
  const lineAt: number[] = [];
  { let ln = 0; for (let k = 0; k < src.length; k += 1) { lineAt[k] = ln; if (src[k] === '\n') ln += 1; } }
  let lastHighlight: Omit<InlineMark, 'cstart' | 'cend'> | null = null;
  let lastEnd = -1;
  const pendingAfter: Array<{ group: MarkGroup; wordLength: number; at: number }> = [];
  while (i < src.length) {
    if (!nonCode[lineAt[i] ?? 0]) { base += src[i]; i += 1; continue; }
    if (src[i] === '`') {
      let run = 1;
      while (src[i + run] === '`') run += 1;
      const close = src.indexOf('`'.repeat(run), i + run);
      if (close >= 0) { base += src.slice(i, close + run); i = close + run; continue; }
    }
    const two = src.slice(i, i + 3);
    const kind = two === '{++' ? 'ins' : two === '{--' ? 'del' : two === '{~~' ? 'sub' : two === '{==' ? 'hl' : two === '{>>' ? 'com' : null;
    if (kind) {
      const closer = kind === 'ins' ? '++}' : kind === 'del' ? '--}' : kind === 'sub' ? '~~}' : kind === 'hl' ? '==}' : '<<}';
      const close = src.indexOf(closer, i + 3);
      if (close >= 0) {
        const inner = src.slice(i + 3, close);
        const next = close + 3;
        if (kind === 'ins') {
          inline.push({ start: base.length, end: base.length, deleted: null, inserted: inner, groups: [{ type: 'changed', source, fields: {} }], raw: inner });
        } else if (kind === 'del') {
          const start = base.length;
          base += inner;
          inline.push({ start, end: base.length, deleted: inner, inserted: null, groups: [{ type: 'changed', source, fields: {} }], raw: inner });
        } else if (kind === 'sub') {
          const arrow = inner.indexOf('~>');
          const oldText = arrow >= 0 ? inner.slice(0, arrow) : inner;
          const newText = arrow >= 0 ? inner.slice(arrow + 2) : '';
          const start = base.length;
          base += oldText;
          inline.push({ start, end: base.length, deleted: oldText, inserted: newText, groups: [{ type: 'changed', source, fields: {} }], raw: inner });
        } else if (kind === 'hl') {
          const start = base.length;
          base += inner;
          const mark: Omit<InlineMark, 'cstart' | 'cend'> = { start, end: base.length, deleted: null, inserted: null, groups: [], raw: inner };
          lastHighlight = mark;
          lastEnd = next;
        } else {
          const group = commentGroup(inner);
          if (lastHighlight && lastEnd === i) {
            if (lastHighlight.groups.length === 0) { lastHighlight.groups.push(group); inline.push(lastHighlight); }
            else lastHighlight.groups.push({ ...group, type: 'reply' });
            lastEnd = next;
          } else {
            // A lone comment: the word before it on this line, else the word after it.
            const lineStart = base.lastIndexOf('\n') + 1;
            const before = base.slice(lineStart);
            const wordBefore = /(\S+)\s*$/.exec(before);
            if (wordBefore) {
              const end = lineStart + wordBefore.index + wordBefore[1].length;
              inline.push({ start: end - wordBefore[1].length, end, deleted: null, inserted: null, groups: [group], raw: wordBefore[1] });
              lastHighlight = inline[inline.length - 1];
              lastEnd = next;
            } else {
              const after = /^\s*(\S+)/.exec(src.slice(next, src.indexOf('\n', next) < 0 ? src.length : src.indexOf('\n', next)));
              if (after) {
                // Attach after we copy the following word: remember and patch below.
                pendingAfter.push({ group, wordLength: after[1].length, at: base.length + after[0].length - after[1].length });
              } else {
                warnings.push(`A comment with no text near it was dropped: "${inner.slice(0, 60)}"`);
              }
            }
          }
          i = next;
          continue;
        }
        if (kind !== 'hl') { lastHighlight = null; }
        i = next;
        continue;
      }
    }
    if (lastHighlight && lastHighlight.groups.length === 0 && lastEnd === i) {
      warnings.push(`A highlight without a comment was kept as plain text: "${lastHighlight.raw.slice(0, 60)}"`);
      lastHighlight = null;
    }
    base += src[i];
    i += 1;
  }
  if (lastHighlight && lastHighlight.groups.length === 0) warnings.push(`A highlight without a comment was kept as plain text: "${lastHighlight.raw.slice(0, 60)}"`);
  for (const pending of pendingAfter.splice(0)) {
    inline.push({ start: pending.at, end: pending.at + pending.wordLength, deleted: null, inserted: null, groups: [pending.group], raw: base.slice(pending.at, pending.at + pending.wordLength) });
  }
  const withCurrent = withCurrentText(base, inline as Array<Omit<InlineMark, 'cstart' | 'cend'>>);
  withCurrent.marks.sort((a, b) => a.start - b.start || b.end - a.end);
  return { frontMatter, handles, base, current: withCurrent.current, inline: withCurrent.marks, lines: [], warnings };
}

/** True when the text uses CriticMarkup rather than the dialect (used by import's auto-detection). */
export function looksLikeCriticMarkup(text: string): boolean {
  const s = String(text ?? '');
  if (CRITIC_POLICY.exportHeaderPattern.test(s.replace(FRONT_MATTER, ''))) return true;
  return /\{\+\+[\s\S]*?\+\+\}|\{--[\s\S]*?--\}|\{~~[\s\S]*?~>[\s\S]*?~~\}|\{>>[\s\S]*?<<\}/.test(s)
    && !/\]\{(changed|comment)\b/.test(s);
}

export interface CriticMarkOut {
  start: number;
  end: number;
  kind: 'insert' | 'delete' | 'replace' | 'comment';
  inserted?: string | null;
  /** Comment text and replies, each "@handle: text". */
  comments?: string[];
}

/** Writes CriticMarkup: suggestions and comments only (the header says it is lossy). */
export function serializeCriticMarkup(input: { markdown: string; marks: CriticMarkOut[]; header?: boolean }): string {
  const md = input.markdown;
  const { inline } = planInlineMarks(input.marks);
  // CriticMarkup does not nest: write outermost marks only; nested ones are dropped (lossy).
  const outer: CriticMarkOut[] = [];
  let lastEnd = -1;
  for (const mark of [...inline].sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (mark.start < lastEnd || (mark.start === lastEnd && mark.end === lastEnd && outer.length && outer[outer.length - 1].end === mark.start && outer[outer.length - 1].start === mark.start)) continue;
    outer.push(mark);
    lastEnd = Math.max(lastEnd, mark.end);
  }
  let out = '';
  let pos = 0;
  const clean = (s: string) => s.replace(/\+\+\}|--\}|~~\}|==\}|<<\}|~>/g, m => m.split('').join('\u200b'));
  for (const mark of outer) {
    out += md.slice(pos, mark.start);
    const span = md.slice(mark.start, mark.end);
    if (mark.kind === 'insert') out += `{++${clean(span)}++}`;
    else if (mark.kind === 'delete') out += `{--${clean(span)}--}`;
    else if (mark.kind === 'replace') out += `{~~${clean(span)}~>${clean(mark.inserted ?? '')}~~}`;
    else out += `{==${clean(span)}==}${(mark.comments ?? []).map(c => `{>>${clean(c)}<<}`).join('')}`;
    pos = mark.end;
  }
  out += md.slice(pos);
  return input.header === false ? out : `${CRITIC_POLICY.exportHeader}\n\n${out}`;
}
