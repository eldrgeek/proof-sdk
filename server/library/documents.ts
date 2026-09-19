import { getDb, getDocumentBySlug, updateDocumentTitle } from '../db.js';
import { stripProofSpanTags } from '../proof-span-strip.js';
import { refreshSnapshotForSlug } from '../snapshot.js';
import { createProofDocument } from '../routes.js';
import type { LibraryMember } from './auth.js';
import { applyImportedMarks, hasProofMarks, parseImport, type ImportSummary } from '../proof-dialect.js';
import { isEmailAddress, verifiedHumanActor } from '../../src/shared/identity.js';

type StoredReviewMark = {
  kind?: unknown;
  by?: unknown;
  status?: unknown;
  resolved?: unknown;
  data?: { status?: unknown; resolved?: unknown };
};

type LibraryDocumentRow = {
  slug: string;
  title: string | null;
  markdown: string;
  marks: string;
  created_at: string;
  updated_at: string;
  created_by_member_id: string | null;
  created_by_name: string | null;
  archived_at: string | null;
  last_opened_at: string | null;
  last_left_at: string | null;
};

export type LibraryDocumentFilter = 'all' | 'review' | 'mine' | 'archived';
export type LibraryDocumentSort = 'edited' | 'title' | 'created';

export interface LibraryDocumentListItem {
  slug: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  archived: boolean;
  pendingSuggestions: number;
  suggestionsBy: Record<string, number>;
  openComments: number;
  updatedSinceYouLooked: boolean;
  snippet?: string;
  matchStart?: number;
  matchEnd?: number;
}

const creationBuckets = new Map<string, { count: number; resetAt: number }>();
const MAX_MARKDOWN_BYTES = 10 * 1024 * 1024;

function titleFromMarkdown(markdown: string): string | null {
  const match = stripProofSpanTags(markdown).match(/^#\s+(.+?)\s*$/m);
  return match?.[1]?.trim() || null;
}

function parseReviewMarks(raw: string): {
  pendingSuggestions: number;
  suggestionsBy: Record<string, number>;
  openComments: number;
} {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const source = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, StoredReviewMark>
    : {};
  let pendingSuggestions = 0;
  let openComments = 0;
  const suggestionsBy: Record<string, number> = {};
  for (const mark of Object.values(source)) {
    if (!mark || typeof mark !== 'object') continue;
    const kind = mark.kind;
    if (
      (kind === 'insert' || kind === 'delete' || kind === 'replace')
      && (mark.status ?? mark.data?.status) === 'pending'
    ) {
      pendingSuggestions += 1;
      const by = typeof mark.by === 'string' && mark.by ? mark.by : 'unknown';
      suggestionsBy[by] = (suggestionsBy[by] ?? 0) + 1;
    } else if (kind === 'comment' && (mark.resolved ?? mark.data?.resolved) !== true) {
      openComments += 1;
    }
  }
  return { pendingSuggestions, suggestionsBy, openComments };
}

function buildSnippet(text: string, query: string): {
  snippet: string;
  matchStart: number;
  matchEnd: number;
} | null {
  if (!query) return null;
  const normalizedText = text.replace(/\s+/g, ' ').trim();
  const matchIndex = normalizedText.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (matchIndex < 0) return null;
  const targetLength = 120;
  let start = Math.max(0, matchIndex - Math.floor((targetLength - query.length) / 2));
  let end = Math.min(normalizedText.length, start + targetLength);
  if (end - start < targetLength) start = Math.max(0, end - targetLength);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < normalizedText.length ? '…' : '';
  return {
    snippet: `${prefix}${normalizedText.slice(start, end)}${suffix}`,
    matchStart: prefix.length + Math.max(0, matchIndex - start),
    matchEnd: prefix.length + Math.max(0, matchIndex - start) + query.length,
  };
}

function mapDocument(row: LibraryDocumentRow, query: string): LibraryDocumentListItem {
  const cleanMarkdown = stripProofSpanTags(row.markdown);
  const title = row.title?.trim() || titleFromMarkdown(cleanMarkdown) || 'Untitled document';
  const review = parseReviewMarks(row.marks);
  const lastLooked = row.last_left_at || row.last_opened_at;
  const titleMatch = query ? title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) : false;
  const snippet = query && !titleMatch ? buildSnippet(cleanMarkdown, query) : null;
  return {
    slug: row.slug,
    title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by_name || 'API',
    archived: Boolean(row.archived_at),
    ...review,
    updatedSinceYouLooked: Boolean(lastLooked && Date.parse(row.updated_at) > Date.parse(lastLooked)),
    ...(snippet ?? {}),
  };
}

export function listLibraryDocuments(input: {
  memberId: string;
  query?: string;
  filter?: LibraryDocumentFilter;
  sort?: LibraryDocumentSort;
}): {
  documents: LibraryDocumentListItem[];
  counts: Record<LibraryDocumentFilter, number>;
} {
  const query = input.query?.trim() || '';
  const rows = getDb().prepare(`
    SELECT
      d.slug, d.title, d.markdown, d.marks, d.created_at, d.updated_at,
      meta.created_by_member_id, creator.name AS created_by_name, meta.archived_at,
      visits.last_opened_at, visits.last_left_at
    FROM documents d
    LEFT JOIN library_document_meta meta ON meta.slug = d.slug
    LEFT JOIN library_members creator ON creator.id = meta.created_by_member_id
    LEFT JOIN library_visits visits ON visits.slug = d.slug AND visits.member_id = ?
    WHERE d.share_state != 'DELETED'
  `).all(input.memberId) as LibraryDocumentRow[];

  const all = rows.map((row) => mapDocument(row, query));
  const searched = query
    ? all.filter((doc) => {
      const row = rows.find((candidate) => candidate.slug === doc.slug);
      if (!row) return false;
      const haystack = `${doc.title}\n${stripProofSpanTags(row.markdown)}`.toLocaleLowerCase();
      return haystack.includes(query.toLocaleLowerCase());
    })
    : all;
  const counts: Record<LibraryDocumentFilter, number> = {
    all: searched.filter((doc) => !doc.archived).length,
    review: searched.filter((doc) => !doc.archived && (doc.pendingSuggestions > 0 || doc.openComments > 0)).length,
    mine: searched.filter((doc) => {
      const row = rows.find((candidate) => candidate.slug === doc.slug);
      return !doc.archived && row?.created_by_member_id === input.memberId;
    }).length,
    archived: searched.filter((doc) => doc.archived).length,
  };

  const filter = input.filter ?? 'all';
  const filtered = searched.filter((doc) => {
    const row = rows.find((candidate) => candidate.slug === doc.slug);
    if (filter === 'archived') return doc.archived;
    if (doc.archived) return false;
    if (filter === 'review') return doc.pendingSuggestions > 0 || doc.openComments > 0;
    if (filter === 'mine') return row?.created_by_member_id === input.memberId;
    return true;
  });
  const sort = input.sort ?? 'edited';
  filtered.sort((left, right) => {
    if (sort === 'title') return left.title.localeCompare(right.title, undefined, { sensitivity: 'base' });
    if (sort === 'created') return Date.parse(right.createdAt) - Date.parse(left.createdAt);
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
  return { documents: filtered, counts };
}

export function allowLibraryDocumentCreation(memberId: string): boolean {
  const now = Date.now();
  const current = creationBuckets.get(memberId);
  if (!current || current.resetAt <= now) {
    creationBuckets.set(memberId, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (current.count >= 30) return false;
  current.count += 1;
  return true;
}

export async function createLibraryDocument(input: {
  member: LibraryMember;
  title: string;
  markdown?: string;
}): Promise<{ slug: string; url: string; import?: ImportSummary }> {
  const rawMarkdown = typeof input.markdown === 'string' ? input.markdown : '';
  if (Buffer.byteLength(rawMarkdown, 'utf8') > MAX_MARKDOWN_BYTES) {
    throw new Error('This document is too large. The limit is 10 MB.');
  }
  // "Import .md" (2026-09-19): a Proof Document or a CriticMarkup file keeps its marks. The member
  // imports as themselves: their own marks become live; other people's become guest proposals or
  // history notes (IMPORT_POLICY in server/proof-dialect.ts).
  const parsedImport = rawMarkdown && hasProofMarks(rawMarkdown) ? parseImport(rawMarkdown, 'auto') : null;
  const markdown = parsedImport ? parsedImport.markdown : rawMarkdown;
  const importTitle = parsedImport && typeof parsedImport.parsed.frontMatter.proof?.title === 'string' ? String(parsedImport.parsed.frontMatter.proof.title) : '';
  const title = input.title.replace(/\s+/g, ' ').trim() || importTitle || 'Untitled document';
  const created = await createProofDocument({
    markdown,
    title,
    source: 'library',
    actor: `human:${input.member.name}`,
    ownerId: input.member.id,
  });
  getDb().prepare(`
    INSERT INTO library_document_meta (slug, created_by_member_id, archived_at, archived_by)
    VALUES (?, ?, NULL, NULL)
  `).run(created.doc.slug, input.member.id);
  let summary: ImportSummary | undefined;
  if (parsedImport) {
    const email = input.member.email;
    summary = await applyImportedMarks(created.doc.slug, {
      parsed: parsedImport.parsed,
      format: parsedImport.format,
      authority: email && isEmailAddress(email) ? { kind: 'session', actor: verifiedHumanActor(email) } : { kind: 'anonymous' },
    });
  }
  return { slug: created.doc.slug, url: `/d/${created.doc.slug}`, ...(summary ? { import: summary } : {}) };
}

export function renameLibraryDocument(slug: string, title: string): boolean {
  const normalized = title.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!normalized) throw new Error('Title is required');
  const changed = updateDocumentTitle(slug, normalized);
  if (changed) refreshSnapshotForSlug(slug);
  return changed;
}

export function archiveLibraryDocument(slug: string, archived: boolean, memberId: string): boolean {
  if (!getDocumentBySlug(slug)) return false;
  const result = getDb().prepare(`
    INSERT INTO library_document_meta (slug, created_by_member_id, archived_at, archived_by)
    VALUES (?, NULL, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET archived_at = excluded.archived_at, archived_by = excluded.archived_by
  `).run(slug, archived ? new Date().toISOString() : null, archived ? memberId : null);
  return result.changes > 0;
}

export function recordLibraryVisit(memberId: string, slug: string, event: 'open' | 'leave'): boolean {
  if (!getDocumentBySlug(slug)) return false;
  const now = new Date().toISOString();
  if (event === 'open') {
    getDb().prepare(`
      INSERT INTO library_visits (member_id, slug, last_opened_at, last_left_at)
      VALUES (?, ?, ?, NULL)
      ON CONFLICT(member_id, slug) DO UPDATE SET last_opened_at = excluded.last_opened_at
    `).run(memberId, slug, now);
  } else {
    getDb().prepare(`
      INSERT INTO library_visits (member_id, slug, last_opened_at, last_left_at)
      VALUES (?, ?, NULL, ?)
      ON CONFLICT(member_id, slug) DO UPDATE SET last_left_at = excluded.last_left_at
    `).run(memberId, slug, now);
  }
  return true;
}
