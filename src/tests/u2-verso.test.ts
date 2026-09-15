import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
const dir = mkdtempSync(path.join(tmpdir(), 'proof-u2-verso-'));
process.env.DATABASE_PATH = path.join(dir, 'test.db');
process.env.PROOF_VERSO_CRED_FILES = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.PROOF_PUBLIC_ORIGIN = '';
const { createVersoRoutes, documentContext } = await import('../../server/verso/routes');
const { loadVersoKey } = await import('../../server/verso/runtime');
const reads: string[] = [];
assert.equal(loadVersoKey('', file => { reads.push(file); return ''; }), '');
assert.equal(reads.length, 0);
assert(loadVersoKey('/fake', file => { reads.push(file); return 'UNRELATED_KEY=ignored\nANTHROPIC_API_KEY="fake-value"'; }) === 'fake-value');
assert.deepEqual(reads, ['/fake']);
const { createDocument } = await import('../../server/db');
const doc = createDocument('versotest', '# A document\n\nAn example.', {}, 'owner');
const logs: unknown[] = []; const requests: any[] = [];
const fakeKey = 'synthetic-secret-for-redaction-test';
const client = { messages: { create: async (request: any) => { requests.push(request); return {
  content: [{ type: 'text', text: 'A short answer. ' + fakeKey }, { type: 'tool_use', name: 'propose_comment', input: { quote: 'An example.', text: 'Explain this.' } }, { type: 'tool_use', name: 'propose_suggestion', input: { quote: 'An example.', replacement: 'An illustration.' } }],
  usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 80 },
}; } } };
const app = express(); app.use(express.json());
app.use('/api', createVersoRoutes({ client, key: fakeKey, dataDir: dir, dailyCap: 2, log: line => logs.push(line) }));
app.use('/off', createVersoRoutes({ client: null, key: '', dataDir: dir, log: line => logs.push(line) }));
const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;
const call = (prefix = '/api', extra: Record<string, string> = {}, body: any = { messages: [{ role: 'user', content: 'Explain this.' }] }) => fetch(`${base}${prefix}/documents/versotest/verso`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
try {
  assert.equal((await call('/api', { 'x-share-token': 'invalid' })).status, 401);
  assert.equal((await call('/api', { Origin: 'https://cross-site.example' })).status, 403);
  assert.equal((await call('/api', { 'Content-Type': 'text/plain' })).status, 403);
  const off = await call('/off'); assert.equal(off.status, 503); assert.equal((await off.json()).error, 'Verso is not available right now.');
  const result = await call(); assert.equal(result.status, 200); const raw = await result.text(); assert(!raw.includes(fakeKey));
  const data = JSON.parse(raw); assert.equal(data.proposals.length, 2); assert.equal(data.proposals[0].kind, 'comment');
  assert.equal(requests[0].system.filter((s: any) => s.cache_control?.type === 'ephemeral').length, 2);
  assert(requests[0].system.some((s: any) => s.text.includes('An example.')));
  assert.equal((await call()).status, 200);
  const limited = await call(); assert.equal(limited.status, 429); assert.equal(requests.length, 2);
  assert.equal(statSync(path.join(dir, 'verso-daily.json')).mode & 0o777, 0o600);
  assert(!JSON.stringify(logs).includes(fakeKey)); assert(!JSON.stringify(logs).includes('An example.'));
  assert.equal((logs[0] as any).model, 'claude-haiku-4-5'); assert.equal(typeof (logs[0] as any).usd, 'number');
  const long = 'x'.repeat(90000) + 'CHOSEN REGION' + 'y'.repeat(90000);
  const capped = documentContext(long, { quote: 'CHOSEN REGION' }); assert(capped.length <= 60100); assert(capped.includes('CHOSEN REGION'));
  console.log('✓ Verso access, origin, off state, durable cap, caching, context, proposal-only tools and private cost log');
} finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); }
