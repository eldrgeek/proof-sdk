// Optional: the COS runs this on the VPS. Never reads credential files.
import assert from 'node:assert/strict';
if (process.env.PROOF_VERSO_LIVE_SMOKE !== '1') {
  console.log('SKIP: set PROOF_VERSO_LIVE_SMOKE=1 on the VPS to spend one Verso call.');
} else {
  const origin = process.env.PROOF_PUBLIC_ORIGIN;
  const slug = process.env.PROOF_VERSO_SMOKE_SLUG;
  assert(origin && slug, 'Set the public origin and a disposable smoke document slug.');
  const response = await fetch(`${origin}/api/documents/${encodeURIComponent(slug)}/verso`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Proof-Client-Version': '0.31.2', 'X-Proof-Client-Protocol': '3', 'X-Proof-Client-Build': 'u2-live-smoke' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'In one short sentence, what is this document about?' }] }),
  });
  assert.equal(response.status, 200);
  const body = await response.json(); assert(typeof body.reply === 'string' && body.reply.length > 0);
  console.log('✓ one live Verso reply (content withheld)');
}
