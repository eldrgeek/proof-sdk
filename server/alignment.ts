/**
 * Mike, 2026-09-23 (usability brief): blind snapshot files require the administrative owner credential; stored snapshots stay intact.
 * Proof Documents Step B3c — server side of "Since you" and aligned snapshots.
 *
 * Authorship: direction by Mike Wolf (Proof Documents, 2026-09-18); built by Claude Opus 5
 * (worker proof-honest), 2026-09-18. Pure rules live in src/shared/alignment.ts.
 *
 * A snapshot is frozen whenever the server computes an Issue report that is aligned (agent
 * /state, the page's alignment check, and a debounced check after every line-mark write and ask
 * answer). Frozen rows are never changed; a document keeps the newest ALIGNED_SNAPSHOT.keepPerDocument.
 */
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import {
  addDocumentEvent,
  getAlignedSnapshot,
  getDocumentBySlug,
  insertAlignedSnapshot,
  latestAlignedSnapshot,
  listAlignedSnapshots,
  type DocumentAlignedSnapshotRow,
} from './db.js';
import { broadcastToRoom } from './ws.js';
import { buildIssueReport, computeServerLines, listCanonicalLineMarks, reviewMarksFromStored, type IssueReport } from './line-marks.js';
import { ownObjections } from './review-aids.js';
import { serverSuggestionsOnLine } from './review-aids-eval.js';
import { evaluateObjection } from '../src/shared/objections.js';
import { buildAskReport, listCanonicalAsks } from './asks.js';
import { buildDirectory } from './identity.js';
import { getProofSettings } from './proof-extras-store.js';
import { blindViewFor } from './proof-extras-eval.js';
import { recoverCanonicalDocumentIfNeeded } from './canonical-document.js';
import { executeDocumentOperationAsync } from './document-engine.js';
import { resolveTargetActor } from '../src/shared/identity.js';
import { actorKey } from '../src/shared/line-marks.js';
import { askTeamActors } from '../src/shared/asks.js';
import {
  ALIGNED_SNAPSHOT,
  buildSnapshotPayload,
  computeSinceYou,
  renderSnapshotLedger,
  snapshotFingerprint,
  type SinceReviewMark,
  type SinceYouReport,
  type SnapshotPayload,
} from '../src/shared/alignment.js';

export interface SnapshotInfo {
  id: string;
  createdAt: string;
  team: string[];
  counts: SnapshotPayload['counts'] | null;
}

function parsePayload(row: DocumentAlignedSnapshotRow): SnapshotPayload | null {
  try {
    const parsed = JSON.parse(row.payload);
    return parsed && typeof parsed === 'object' ? parsed as SnapshotPayload : null;
  } catch {
    return null;
  }
}

export function snapshotInfo(row: DocumentAlignedSnapshotRow | undefined | null): SnapshotInfo | null {
  if (!row) return null;
  const payload = parsePayload(row);
  return { id: row.id, createdAt: row.created_at, team: payload?.team ?? [], counts: payload?.counts ?? null };
}

export function latestSnapshotInfo(slug: string): SnapshotInfo | null {
  try { return snapshotInfo(latestAlignedSnapshot(slug)); } catch { return null; }
}

export function listSnapshotInfos(slug: string, limit = 50): SnapshotInfo[] {
  return listAlignedSnapshots(slug, limit).map(row => snapshotInfo(row)!).filter(Boolean);
}

export function snapshotLedger(slug: string, id: string): string | null {
  const row = getAlignedSnapshot(slug, id);
  if (!row) return null;
  const payload = parsePayload(row);
  if (!payload) return null;
  return renderSnapshotLedger(row.id, row.markdown, payload);
}

export function snapshotJson(slug: string, id: string): (SnapshotPayload & { id: string; markdown: string }) | null {
  const row = getAlignedSnapshot(slug, id);
  const payload = row ? parsePayload(row) : null;
  return row && payload ? { ...payload, id: row.id, markdown: row.markdown } : null;
}

/**
 * Freezes a snapshot when `report` (computed from `markdown`) is aligned and differs from the
 * latest snapshot. Returns the latest snapshot and whether this call created it.
 */
export async function freezeIfAligned(slug: string, markdown: string, report: IssueReport): Promise<{ snapshot: SnapshotInfo | null; created: boolean }> {
  const latest = latestAlignedSnapshot(slug);
  if (!report.aligned || (ALIGNED_SNAPSHOT.requireLinesAndTeam && (report.counts.lines === 0 || report.team.length === 0))) {
    return { snapshot: snapshotInfo(latest), created: false };
  }
  const lines = await computeServerLines(markdown);
  const dir = buildDirectory(slug);
  const createdAt = new Date().toISOString();
  const payload = buildSnapshotPayload({
    slug,
    title: getDocumentBySlug(slug)?.title ?? null,
    createdAt,
    team: report.team,
    lines,
    lineMarks: listCanonicalLineMarks(slug, dir),
    asks: listCanonicalAsks(slug, dir),
  });
  const fingerprint = snapshotFingerprint(markdown, payload);
  if (latest && latest.fingerprint === fingerprint) return { snapshot: snapshotInfo(latest), created: false };
  const row: DocumentAlignedSnapshotRow = {
    id: `snap_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    document_slug: slug,
    created_at: createdAt,
    fingerprint,
    markdown,
    payload: JSON.stringify(payload),
  };
  insertAlignedSnapshot(row, ALIGNED_SNAPSHOT.keepPerDocument);
  try {
    addDocumentEvent(slug, 'alignment.snapshot', { snapshotId: row.id, team: payload.team, counts: payload.counts }, 'system');
  } catch (error) {
    console.warn('[alignment] failed to record snapshot event', { slug, error: String(error) });
  }
  broadcastToRoom(slug, { type: 'line-marks.updated', by: 'system', timestamp: createdAt });
  return { snapshot: snapshotInfo(row), created: true };
}

/** The document's current markdown and stored marks (the live projection when there is one). */
export async function currentDocumentState(slug: string): Promise<{ markdown: string; marks: unknown } | null> {
  const doc = getDocumentBySlug(slug);
  if (!doc) return null;
  try {
    await recoverCanonicalDocumentIfNeeded(slug, 'state');
    const state = await executeDocumentOperationAsync(slug, 'GET', '/state');
    const body = (state.body && typeof state.body === 'object' ? state.body : {}) as Record<string, unknown>;
    const markdown = typeof body.markdown === 'string' ? body.markdown : doc.markdown ?? '';
    const marks = body.marks && typeof body.marks === 'object' ? body.marks : doc.marks;
    return { markdown, marks };
  } catch {
    return { markdown: doc.markdown ?? '', marks: doc.marks };
  }
}

/** Computes the Issue report now and freezes a snapshot when aligned. */
export async function checkAlignment(slug: string): Promise<{ aligned: boolean; issues: number; snapshot: SnapshotInfo | null; created: boolean } | null> {
  const state = await currentDocumentState(slug);
  if (!state) return null;
  const report = await buildIssueReport(slug, state.markdown, state.marks, {
    asks: (lines) => buildAskReport(slug, lines).issueInputs,
    teamExtra: askTeamActors(listCanonicalAsks(slug)),
  });
  const frozen = await freezeIfAligned(slug, state.markdown, report);
  return { aligned: report.aligned, issues: report.counts.total, ...frozen };
}

const pendingChecks = new Map<string, ReturnType<typeof setTimeout>>();
/** Debounce between a write and its alignment check (many writes in a row check once). */
export const ALIGNMENT_CHECK_DEBOUNCE_MS = 600;

/** After a line-mark write or an ask answer: check alignment soon (never throws). */
export function scheduleAlignmentCheck(slug: string): void {
  const existing = pendingChecks.get(slug);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingChecks.delete(slug);
    checkAlignment(slug).catch(error => console.warn('[alignment] check failed', { slug, error: String(error) }));
  }, ALIGNMENT_CHECK_DEBOUNCE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  pendingChecks.set(slug, timer);
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

/** Comments and suggestions with their times, for "Since you". */
export function reviewMarksForSince(rawMarks: unknown): SinceReviewMark[] {
  const out: SinceReviewMark[] = [];
  const str = (value: unknown) => (typeof value === 'string' ? value : null);
  for (const [id, mark] of Object.entries(parseStoredMarks(rawMarks))) {
    if (!mark || typeof mark !== 'object') continue;
    const kind = str(mark.kind) ?? '';
    if (!['comment', 'insert', 'delete', 'replace'].includes(kind)) continue;
    const repliesRaw = Array.isArray(mark.replies) ? mark.replies : (Array.isArray(mark.thread) ? mark.thread : []);
    out.push({
      id,
      kind,
      by: str(mark.by),
      quote: str(mark.quote) ?? '',
      createdAt: str(mark.createdAt),
      open: kind === 'comment' ? mark.resolved !== true : (str(mark.status) ?? 'pending') === 'pending',
      status: str(mark.status),
      text: str(mark.text),
      content: str(mark.content),
      replies: (repliesRaw as Array<Record<string, unknown>>).map(reply => ({ by: str(reply?.by), at: str(reply?.at), text: str(reply?.text) })),
    });
  }
  return out;
}

/** "Since you" for one verified actor (or a guest's typed actor) on the current document. */
export async function buildSinceYou(slug: string, actor: string, state?: { markdown: string; marks: unknown } | null): Promise<SinceYouReport | null> {
  const current = state ?? await currentDocumentState(slug);
  if (!current) return null;
  const lines = await computeServerLines(current.markdown);
  const dir = buildDirectory(slug);
  const latest = latestAlignedSnapshot(slug);
  const payload = latest ? parsePayload(latest) : null;
  const me = actorKey(actor);
  // Step B4f: under blind marking, others' rejections show only on lines this actor has marked.
  let lineMarks = listCanonicalLineMarks(slug, dir);
  if (getProofSettings(slug).blind) lineMarks = blindViewFor({ lines, lineMarks, viewer: actor, picks: [] }).lineMarks;
  const report = computeSinceYou({
    actor,
    lines,
    lineMarks,
    asks: listCanonicalAsks(slug, dir),
    reviewMarks: reviewMarksForSince(current.marks),
    snapshot: latest && payload ? { id: latest.id, createdAt: latest.created_at, team: payload.team, lines: payload.lines } : null,
    isMe: (by) => Boolean(by) && actorKey(resolveTargetActor(String(by), dir)) === me,
  });
  // Step B4d: "a repair was proposed" to each of your open objections whose lines changed,
  // were deleted, or gained a suggestion since you objected (or last chose Keep).
  try {
    const onLine = serverSuggestionsOnLine(lines, reviewMarksFromStored(current.marks));
    for (const objection of ownObjections(slug, actor)) {
      const view = evaluateObjection(objection, lines, onLine);
      if (!view.repairPending) continue;
      const first = view.lineIndices.find((index): index is number => index !== null) ?? null;
      const line = first === null ? null : lines[first];
      const what: string[] = [];
      const edited = view.changed.filter((c, i) => c && view.lineIndices[i] !== null).length;
      if (edited) what.push(`${edited} ${edited === 1 ? 'line' : 'lines'} edited`);
      if (view.deletedLines) what.push(`${view.deletedLines} deleted`);
      const fresh = view.suggestions.filter(id => !objection.ack.suggestions.includes(id)).length;
      if (fresh) what.push(`${fresh} new ${fresh === 1 ? 'suggestion' : 'suggestions'}`);
      report.repairs.push({
        type: 'repair',
        lineIndex: first,
        hash: line?.hash ?? null,
        occurrence: line?.occurrence ?? null,
        excerpt: line ? line.text.slice(0, 160) : (objection.lines[0]?.original.excerpt ?? ''),
        objectionId: objection.id,
        by: objection.by,
        at: objection.keptAt ?? objection.createdAt,
        reason: objection.reason,
        detail: `${objection.condition ? `You'd agree if: ${objection.condition}. ` : ''}${what.join(', ')}`,
      });
    }
  } catch (error) {
    console.warn('[alignment] since-you repairs failed', { slug, error: String(error) });
  }
  report.counts.repairs = report.repairs.length;
  report.counts.total += report.repairs.length;
  return report;
}

/** Step B3c: one snapshot as its markdown ledger (<id>.md) or JSON (<id>). */
export function sendSnapshotFile(res: Response, slug: string, file: string, administrative = false): void {
  if (getProofSettings(slug).blind && !administrative) {
    res.status(403).json({ success: false, code: 'BLIND_SNAPSHOT_PRIVATE', error: 'Blind snapshots require the owner credential until per-viewer filtering is available' });
    return;
  }
  const md = file.endsWith('.md');
  const id = md ? file.slice(0, -3) : file;
  if (!/^snap_[a-z0-9]{1,40}$/i.test(id)) { res.status(404).json({ success: false, error: 'No such snapshot' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  if (md) {
    const ledger = snapshotLedger(slug, id);
    if (!ledger) { res.status(404).json({ success: false, error: 'No such snapshot' }); return; }
    res.type('text/markdown; charset=utf-8').send(ledger);
    return;
  }
  const json = snapshotJson(slug, id);
  if (!json) { res.status(404).json({ success: false, error: 'No such snapshot' }); return; }
  res.json({ success: true, snapshot: json });
}

