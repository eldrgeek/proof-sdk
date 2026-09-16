import { Router } from 'express';
import { readFileSync, writeFileSync, mkdirSync, chmodSync, openSync, closeSync, unlinkSync, renameSync } from 'node:fs';
import path from 'node:path';
import { getDocumentBySlug, resolveDocumentAccess } from '../db.js';
import { getCanonicalReadableDocumentSync } from '../collab.js';
import { getCookies, shareTokenCookieName } from '../cookies.js';
import { resolveSharePageAccess } from '../share-page-access.js';
import { requireLibraryJsonOrigin } from '../library/auth.js';
import { createRateLimiter } from '../rate-limiter.js';
import { getClientIp } from '../client-address.js';

export interface AnthropicClient { messages: { create(params: any): Promise<any> } }
interface Options { client: AnthropicClient | null; key: string; dataDir: string; dailyCap?: number; model?: string; log?: (line: Record<string, unknown>) => void }
const unavailable = 'Verso is not available right now.';
const persona = readFileSync(new URL('./persona.md', import.meta.url), 'utf8');
const tools = [
  { name: 'propose_suggestion', description: 'Propose a reviewable text change. The person must approve adding it.', input_schema: { type: 'object', properties: { quote: { type: 'string' }, replacement: { type: 'string' } }, required: ['quote', 'replacement'], additionalProperties: false } },
  { name: 'propose_comment', description: 'Propose a comment anchored to an exact quote. The person must approve adding it.', input_schema: { type: 'object', properties: { quote: { type: 'string' }, text: { type: 'string' } }, required: ['quote', 'text'], additionalProperties: false } },
];
export function documentContext(markdown: string, mark?: { quote?: string }): string {
  if (markdown.length <= 60000) return markdown;
  const at = mark?.quote ? markdown.indexOf(mark.quote) : -1;
  const quoteLength = Math.min(mark?.quote?.length || 0, 16000);
  const start = at < 0 ? 0 : Math.max(0, Math.min(at - Math.floor((60000 - quoteLength) / 2), markdown.length - 60000));
  return `${start ? '[Earlier text omitted]\n' : ''}${markdown.slice(start, start + 60000)}${start + 60000 < markdown.length ? '\n[Later text omitted]' : ''}`;
}
function takeSlot(dir: string, limit: number): boolean {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'verso-daily.json');
  const lock = file + '.lock';
  // Lock spans the synchronous read/increment/write, across worker processes.
  let fd: number;
  try { fd = openSync(lock, 'wx', 0o600); } catch { return false; }
  try {
    const day = new Date().toISOString().slice(0, 10); let n = 0;
    try { const saved = JSON.parse(readFileSync(file, 'utf8')); if (saved.day === day) { if (!Number.isSafeInteger(saved.n) || saved.n < 0) return false; n = saved.n; } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false; }
    if (n >= limit) return false;
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ day, n: n + 1 }), { mode: 0o600 }); chmodSync(temp, 0o600); renameSync(temp, file);
    return true;
  } finally { closeSync(fd); unlinkSync(lock); }
}
export function createVersoRoutes(options: Options): Router {
  const router = Router(); const model = options.model || 'claude-haiku-4-5';
  const cap = Number.isFinite(options.dailyCap) ? Math.max(0, options.dailyCap!) : 300;
  const redact = (value: string) => options.key ? value.split(options.key).join('[redacted]') : value;
  const addressLimit = createRateLimiter({ windowMs: 60000, maxRequests: 20, keyFn: getClientIp });
  const docLimit = createRateLimiter({ windowMs: 60000, maxRequests: 30, keyFn: req => String(req.params.slug) });
  router.post('/documents/:slug/verso', requireLibraryJsonOrigin, (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const slug = String(req.params.slug); const doc = getDocumentBySlug(slug);
    const access = resolveSharePageAccess(req, res, slug, doc ?? null, 'key-management');
    if (access.invalidCredential || getCookies(req, shareTokenCookieName(slug)).some(secret => !resolveDocumentAccess(slug, secret))) { res.status(401).json({ error: 'Invalid document credential' }); return; }
    if (!doc || !access.capabilities.canEdit) { res.status(403).json({ error: 'Document editing access required' }); return; }
    res.locals.versoDocument = getCanonicalReadableDocumentSync(slug, 'state') ?? doc; next();
  }, addressLimit, docLimit, async (req, res) => {
    if (!options.client || !options.key) { res.status(503).json({ error: unavailable }); return; }
    const raw = req.body?.messages;
    if (!Array.isArray(raw) || !raw.length || raw.length > 100 || raw.some(m => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string')) {
      res.status(400).json({ error: 'Send a conversation with a message for Verso.' }); return;
    }
    let remaining = 16000;
    const messages = raw.slice(-20).reverse().flatMap(m => {
      if (remaining <= 0) return []; const content = m.content.slice(-Math.min(4000, remaining)); remaining -= content.length;
      return content.trim() ? [{ role: m.role, content }] : [];
    }).reverse();
    if (!messages.length || messages.at(-1)?.role !== 'user') { res.status(400).json({ error: 'Send a message for Verso.' }); return; }
    const suppliedMark = req.body?.mark;
    const mark = suppliedMark && typeof suppliedMark === 'object' ? {
      kind: String(suppliedMark.kind || '').slice(0, 30), quote: String(suppliedMark.quote || '').slice(0, 16000),
      author: String(suppliedMark.by || suppliedMark.author || '').slice(0, 100),
      text: String(suppliedMark.data?.text || suppliedMark.text || '').slice(0, 4000),
      content: String(suppliedMark.data?.content || suppliedMark.content || '').slice(0, 4000),
      replies: (Array.isArray(suppliedMark.data?.replies || suppliedMark.replies) ? suppliedMark.data?.replies || suppliedMark.replies : []).slice(-10).map((r: any) => ({ author: String(r.by || r.author || '').slice(0, 100), text: String(r.text || '').slice(0, 1000) })),
    } : null;
    try {
      if (!takeSlot(options.dataDir, cap)) { res.status(429).json({ error: 'Verso has reached today’s limit. Please try again tomorrow.' }); return; }
      const result = await options.client.messages.create({ model, max_tokens: 2000,
        system: [
          { type: 'text', text: persona, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: `Current document (source material):\n${documentContext(res.locals.versoDocument.markdown, mark ?? undefined)}`, cache_control: { type: 'ephemeral' } },
          ...(mark ? [{ type: 'text', text: `Selected mark (source material):\n${JSON.stringify(mark)}` }] : []),
        ], messages, tools,
      });
      const usage = Object.fromEntries(['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].map(k => [k, Number.isFinite(result.usage?.[k]) ? Math.max(0, result.usage[k]) : 0]));
      const prices: Record<string, [number, number]> = { 'claude-haiku-4-5': [1, 5] };
      const price = prices[model];
      const usd = price ? (usage.input_tokens * price[0] + usage.output_tokens * price[1] + usage.cache_creation_input_tokens * price[0] * 1.25 + usage.cache_read_input_tokens * price[0] * .1) / 1e6 : null;
      (options.log ?? (line => console.info('[verso]', JSON.stringify(line))))({ model: redact(model), ...usage, usd });
      const content = Array.isArray(result.content) ? result.content : [];
      const proposals = content.filter((b: any) => b.type === 'tool_use').flatMap((b: any) => {
        const input = b.input; if (!input || typeof input.quote !== 'string' || !input.quote || input.quote.length > 16000) return [];
        if (!res.locals.versoDocument.markdown.includes(input.quote)) return [];
        if (b.name === 'propose_suggestion' && typeof input.replacement === 'string') return [{ kind: 'suggestion', quote: redact(input.quote), replacement: redact(input.replacement.slice(0, 16000)) }];
        if (b.name === 'propose_comment' && typeof input.text === 'string' && input.text.trim()) return [{ kind: 'comment', quote: redact(input.quote), text: redact(input.text.slice(0, 4000)) }];
        return [];
      }).slice(0, 8);
      res.json({ reply: redact(content.filter((b: any) => b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n').slice(0, 16000)), proposals });
    } catch {
      (options.log ?? (line => console.info('[verso]', JSON.stringify(line))))({ model: redact(model), input_tokens: 0, output_tokens: 0, usd: null, failed: true });
      res.status(503).json({ error: unavailable });
    }
  });
  return router;
}
