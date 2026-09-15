import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

process.env.DATABASE_PATH = `${tmpdir()}/proof-cli-${process.pid}-${Date.now()}.db`;
Object.assign(process.env, { PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test', PROOF_LIBRARY_ENABLED: '1' });
const root = '../../server';
const auth = await import(`${root}/library/auth.js`);
const { getDb } = await import(`${root}/db.js`);
const member = auth.createLibraryMember({ name: 'CLI Member', email: 'cli@example.test' });
function run(flag: string | undefined, args: string[]) {
  const env = { ...process.env };
  delete env.PROOF_SOMA_AUTH_ENABLED;
  delete env.PROOF_FEEDBACK_ENABLED;
  if (flag !== undefined) env.PROOF_SOMA_AUTH_ENABLED = flag;
  return spawnSync(process.execPath, ['--import', 'tsx', 'server/library/cli.ts', 'signin-link', ...args], { env, encoding: 'utf8' });
}
for (const flag of [undefined, '0']) {
  const result = run(flag, ['--email', member.email, '--origin', 'http://127.0.0.1:4000', '--hours', '2']);
  assert.equal(result.status, 0, result.stderr);
  const link = new URL(result.stdout.trim());
  assert.equal(link.origin, 'http://127.0.0.1:4000');
  assert.equal(link.pathname, '/library/signin');
  const signedIn = auth.consumeLibrarySigninToken(link.hash.slice(3), null);
  assert(signedIn.sessionId, 'legacy CLI link must create a usable session');
}
const before = getDb().prepare('SELECT COUNT(*) AS n FROM library_signin_links').get().n;
const refused = run('1', []);
assert.equal(refused.status, 1);
assert.equal(refused.stdout, '');
assert.equal(refused.stderr.trim(), 'Sign in with SOMA Auth; signin-link is disabled.');
assert.equal(getDb().prepare('SELECT COUNT(*) AS n FROM library_signin_links').get().n, before);
console.log('Library CLI flag-off and SOMA Auth tests passed');
