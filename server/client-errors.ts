import { createHash } from 'node:crypto';
import { Router } from 'express';
import { getDb } from './db.js';
import { getClientIp } from './client-address.js';
import { requireLibraryJsonOrigin } from './library/auth.js';
import { forwardFeedback, isFeedbackEnabled } from './soma-feedback.js';

export const ERROR_WINDOW_MS = 30 * 60 * 1000;
const buckets = new Map<string, { count: number; until: number }>();

export function stripUrlSecrets(text: string): string {
  // Includes URLs in messages and stack frames, not just the page URL field.
  return text.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|\/)[^\s<>"'`]+/gi, url => url.split(/[?#]/, 1)[0]);
}
function bounded(value: unknown, size: number): string {
  return stripUrlSecrets(typeof value === 'string' ? value : '').slice(0, size);
}
function boundedStack(value: unknown): string {
  let text = bounded(value, 4096);
  while (Buffer.byteLength(text, 'utf8') > 4096) text = text.slice(0, -1);
  return text;
}
export function sanitizeClientError(body: Record<string, unknown>) {
  return {
    message: bounded(body.message, 500), stack: boundedStack(body.stack),
    url: bounded(body.url, 1000).split(/[?#]/, 1)[0],
    page: bounded(body.page, 1000).split(/[?#]/, 1)[0],
    build: bounded(body.build, 100), userAgent: bounded(body.userAgent, 500),
    area: body.area === 'editor' ? 'editor' : body.area === 'sign-in' ? 'sign-in' : 'library',
  };
}
function allowReport(ip: string, now: number): boolean {
  for (const [key, bucket] of buckets) if (bucket.until <= now) buckets.delete(key);
  let bucket = buckets.get(ip);
  if (!bucket) { bucket = { count: 0, until: now + 10 * 60 * 1000 }; buckets.set(ip, bucket); }
  return ++bucket.count <= 20;
}

export const clientErrorRoutes = Router();
clientErrorRoutes.post('/api/client-error', (req, res, next) => {
  if (!isFeedbackEnabled()) { res.status(404).end(); return; }
  next();
}, requireLibraryJsonOrigin, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const now = Date.now();
  if (!allowReport(getClientIp(req), now)) { res.status(429).json({ accepted: false, error: 'Too many reports.' }); return; }
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) { res.status(400).json({ accepted: false }); return; }
  const sample = sanitizeClientError(req.body);
  if (!sample.message) { res.status(400).json({ accepted: false, error: 'message is required' }); return; }
  const frames = sample.stack.split('\n').filter(line => /^\s*at\s|@(?:https?:|\/)/.test(line));
  const signature = createHash('sha256').update(`${sample.message}\n${frames[0]?.trim() || ''}`).digest('hex');
  const db = getDb();
  const first = db.transaction(() => {
    const row = db.prepare('SELECT first_seen FROM client_errors WHERE signature = ?').get(signature) as { first_seen: number } | undefined;
    if (row && now - row.first_seen < ERROR_WINDOW_MS) {
      db.prepare('UPDATE client_errors SET count=count+1, last_seen=? WHERE signature=?').run(now, signature);
      return false;
    }
    db.prepare(`INSERT INTO client_errors (signature, count, first_seen, last_seen, sample, forwarded)
      VALUES (?, 1, ?, ?, ?, 0) ON CONFLICT(signature) DO UPDATE SET count=1,
      first_seen=excluded.first_seen, last_seen=excluded.last_seen, sample=excluded.sample, forwarded=0
    `).run(signature, now, now, JSON.stringify(sample));
    return true;
  })();
  if (!first) {
    const row = db.prepare('SELECT forwarded FROM client_errors WHERE signature=?').get(signature) as { forwarded: number };
    res.status(202).json({ accepted: row.forwarded === 1, duplicate: true }); return;
  }
  try {
    const response = await forwardFeedback({
      site: 'proof-plus', area: 'error', page: sample.page, url: sample.url,
      text: ['Automatic browser error report', sample.message, ...frames.slice(0, 8), `Build: ${sample.build}`, `Page: ${sample.url || sample.page}`].join('\n'),
    });
    const result = await response.json() as { status?: string };
    if (!response.ok || result.status !== 'accepted') throw new Error('Report was not accepted');
    db.prepare('UPDATE client_errors SET forwarded=1 WHERE signature=? AND first_seen=?').run(signature, now);
    res.status(202).json({ accepted: true });
  } catch {
    // Keep the local evidence, but never claim that the builder received it.
    res.status(502).json({ accepted: false, error: 'Report saved locally; feedback service unavailable.' });
  }
});
