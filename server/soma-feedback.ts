import { Router } from 'express';
import { getLibrarySession, isLibraryEnabled, requireLibraryJsonOrigin } from './library/auth.js';

export function isFeedbackEnabled(): boolean {
  return process.env.PROOF_FEEDBACK_ENABLED === '1';
}

export function feedbackEndpoint(): string {
  return process.env.SOMA_FEEDBACK_ENDPOINT || 'http://127.0.0.1:4252/feedback';
}

// Express port of SOMA/standards/soma-feedback-proxy/netlify/functions/soma-feedback.js.
// Deliberately derives privilege from our session; never forwards inbound credentials.
export async function forwardFeedback(body: Record<string, unknown>): Promise<Response> {
  return fetch(feedbackEndpoint(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
}

export const somaFeedbackRoutes = Router();
somaFeedbackRoutes.use('/api/soma-feedback', (_req, res, next) => {
  if (!isFeedbackEnabled()) { res.status(404).end(); return; }
  res.setHeader('Cache-Control', 'no-store');
  next();
});
somaFeedbackRoutes.get('/api/soma-feedback', async (_req, res) => {
  try {
    const upstream = await forwardFeedback({});
    await upstream.text();
    const ok = upstream.status < 500;
    const payload: Record<string, unknown> = { ok, configured: true, upstream_reachable: true, upstream_status: upstream.status, error: null };
    if (process.env.SOMA_FEEDBACK_HEALTH_VERBOSE === '1') payload.upstream_host = new URL(feedbackEndpoint()).host;
    res.status(ok ? 200 : 503).json(payload);
  } catch {
    res.status(503).json({ ok: false, configured: true, upstream_reachable: false, upstream_status: null, error: 'Feedback service unreachable.' });
  }
});
somaFeedbackRoutes.post('/api/soma-feedback', requireLibraryJsonOrigin, async (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    res.status(400).json({ error: 'A JSON object is required.' }); return;
  }
  const body = { ...req.body };
  delete body.adminToken;
  delete body.googleIdToken;
  // Share links are bearer credentials. Feedback may name a document, but
  // must not pass access tokens to the feedback service.
  if (typeof body.url === 'string') body.url = body.url.split(/[?#]/, 1)[0];
  for (const field of ['text', 'page', 'elementHint']) {
    if (typeof body[field] === 'string') {
      body[field] = body[field].replace(/([?&]token=|#token=?)[^\s&#\"'`<>\])}]*/gi, '$1[redacted]');
    }
  }
  body.site = 'proof-plus';
  const session = isLibraryEnabled() ? getLibrarySession(req) : null;
  if (session?.member.isOwner && process.env.SOMA_ADMIN_TOKEN) body.adminToken = process.env.SOMA_ADMIN_TOKEN;
  try {
    const upstream = await forwardFeedback(body);
    const text = await upstream.text();
    // A gateway can return HTML on failure; make that failure visible in the chip.
    try { JSON.parse(text); } catch { throw new Error('Non-JSON upstream response'); }
    res.status(upstream.status).type('json').send(text);
  } catch {
    res.status(502).json({ error: 'Feedback service unreachable. Please try again.' });
  }
});
