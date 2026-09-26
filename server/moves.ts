/** ac-l71: owner-controlled immediate moves; the default is a proposal. */
import { getDb, assertWritesAllowed, addDocumentEvent } from './db.js';
import { MOVE_POLICY } from '../src/shared/moves.js';
import { actorKey } from '../src/shared/line-marks.js';
import { broadcastToRoom } from './ws.js';

export function immediateMoveActors(slug: string): string[] {
  const row = getDb().prepare('SELECT actors_json FROM document_move_settings WHERE document_slug = ?').get(slug) as { actors_json: string } | undefined;
  return row ? JSON.parse(row.actors_json) : [];
}
export function setImmediateMoveActors(slug: string, actors: unknown, by: string, owner: boolean) {
  if (!owner) return { status: 403, body: { success: false, error: 'Only an owner can change move settings.' } };
  if (!Array.isArray(actors) || actors.length > MOVE_POLICY.maxImmediateActors || actors.some(a => typeof a !== 'string' || !/^(human|ai):\S{1,200}$/.test(a))) {
    return { status: 400, body: { success: false, error: 'immediateMoveActors must be an array of actor IDs.' } };
  }
  assertWritesAllowed('setImmediateMoveActors');
  const values = [...new Set(actors.map(actorKey))];
  getDb().prepare('INSERT INTO document_move_settings (document_slug, actors_json) VALUES (?, ?) ON CONFLICT(document_slug) DO UPDATE SET actors_json = excluded.actors_json').run(slug, JSON.stringify(values));
  addDocumentEvent(slug, 'moves.settings', { immediateMoveActors: values }, by);
  broadcastToRoom(slug, { type: 'line-marks.updated', by, timestamp: new Date().toISOString() });
  return { status: 200, body: { success: true, immediateMoveActors: values } };
}
