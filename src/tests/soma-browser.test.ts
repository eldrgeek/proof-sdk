import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import express from 'express';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
process.env.DATABASE_PATH = `${tmpdir()}/proof-soma-browser-${process.pid}-${Date.now()}.db`;
process.env.SNAPSHOT_DIR = `${tmpdir()}/proof-soma-browser-snapshots-${process.pid}`;
Object.assign(process.env, { PROOF_ENV: 'test', PROOF_DB_ENV_INIT: 'test', PROOF_LIBRARY_ENABLED: '1', PROOF_SOMA_AUTH_ENABLED: '1', PROOF_FEEDBACK_ENABLED: '1', SOMA_AUTH_URL: 'https://soma.test', SOMA_AUTH_ANON_KEY: 'public' });
const root = '../../server';
const { libraryRoutes } = await import(`${root}/library/routes.js`);
const { renderLibraryHome } = await import(`${root}/library/page.js`);
const { somaFeedbackRoutes } = await import(`${root}/soma-feedback.js`);
const { clientErrorRoutes } = await import(`${root}/client-errors.js`);
const { injectSomaFeedback } = await import(`${root}/soma-page.js`);
const nativeFetch = globalThis.fetch;
const forwarded: any[] = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url === 'https://soma.test/auth/v1/user') return Response.json({ email: 'admin@example.test', email_confirmed_at: '2026-09-01T00:00:00.000Z', user_metadata: { full_name: 'Browser Admin' } });
  if (url === 'https://soma.test/rest/v1/rpc/is_app_admin') return Response.json(true);
  assert.equal(url, 'http://127.0.0.1:4252/feedback');
  forwarded.push(JSON.parse(String(init?.body)));
  return Response.json({ status: 'accepted', filedAt: new Date().toISOString(), build: false });
};
const app = express();
app.use(express.json(), express.static('public'), libraryRoutes, somaFeedbackRoutes, clientErrorRoutes);
app.get('/', renderLibraryHome);
// Exercise the editor's actual pre-module error banner without booting collab.
const editorHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const catcher = editorHtml.slice(editorHtml.indexOf('  <script>\n    // Error catcher'), editorHtml.indexOf('  <script type="module"'));
app.get('/d/error-fixture', (_req, res) => res.type('html').send(injectSomaFeedback(`<html><head></head><body>${catcher}</body></html>`, 'editor')));
const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.route('**/*', async (route: any) => {
    const url = route.request().url();
    if (url.startsWith(origin)) return route.continue();
    if (url.startsWith('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.57.4/')) {
      return route.fulfill({ contentType: 'application/javascript', body: `window.supabase={createClient:function(){var callback;var session=sessionStorage.getItem('test-session')?{access_token:'browser-token'}:null;return {auth:{
        onAuthStateChange:function(cb){callback=cb;setTimeout(function(){cb('INITIAL_SESSION',session)},0)},
        signInWithOtp:async function(input){window.testOtp=input;return {}},
        signInWithOAuth:async function(input){window.testOAuth=input;session={access_token:'browser-token'};sessionStorage.setItem('test-session','1');callback('SIGNED_IN',session);return {}},
        getSession:async function(){return {data:{session:session}}},
        signOut:async function(){sessionStorage.removeItem('test-session');session=null;callback('SIGNED_OUT',null);return {}}
      }}}};` });
    }
    await route.abort();
    throw new Error(`Unexpected external browser request: ${url}`);
  });
  await page.addInitScript(() => {
    localStorage.setItem('soma-feedback:name', 'Previous Person');
    localStorage.setItem('soma-feedback:email', 'previous@example.test');
  });
  await page.goto(origin);
  await page.locator('.soma-feedback-root').waitFor();
  await page.locator('#soma-email').fill('admin@example.test');
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await page.getByText('Check your email for your sign-in link.').waitFor();
  assert.equal(await page.evaluate(() => (window as any).testOtp.options.emailRedirectTo), origin + '/');
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.locator('#new-document').waitFor();
  await page.locator('.soma-feedback-tab').click();
  await page.getByPlaceholder('What should we change? Be as specific as you can.').fill('Please improve the library');
  const submitted = page.waitForResponse((response: any) => response.url() === origin + '/api/soma-feedback' && response.request().method() === 'POST');
  await page.locator('.soma-feedback-submit').filter({ hasText: 'Submit' }).click();
  assert.equal((await submitted).status(), 200);
  assert.equal(forwarded[0].name, 'Browser Admin');
  assert.equal(forwarded[0].email, 'admin@example.test');
  assert(!JSON.stringify(forwarded[0]).includes('Previous Person'));
  assert(!JSON.stringify(forwarded[0]).includes('previous@example.test'));
  assert.equal(await page.evaluate(() => (window as any).somaFeedbackIdentity().email), 'admin@example.test');
  await page.locator('.soma-feedback-tab').click();
  await page.locator('#avatar').click();
  await page.getByRole('button', { name: 'People', exact: true }).click();
  await page.locator('#invite-name').fill('New Person');
  await page.locator('#invite-email').fill('new@example.test');
  await page.getByRole('button', { name: 'Add member', exact: true }).click();
  await page.getByText('New Person can now sign in with SOMA Auth using that email.').waitFor();
  assert.equal(await page.getByText('Sign in on another device', { exact: true }).count(), 0);
  await page.locator('#people-dialog [data-close]').click();
  await page.locator('#avatar').click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByText('You’re signed out.', { exact: true }).waitFor();
  await page.locator('.soma-feedback-root').waitFor();
  assert(!(await page.context().cookies()).some((cookie: any) => cookie.name === 'proof_library_session'));
  await page.goto(origin + '/d/error-fixture?token=private');
  await page.locator('.soma-feedback-root').waitFor();
  await page.evaluate(() => { setTimeout(() => { throw new Error('Browser report test'); }, 0); });
  await page.locator('[id^="error-banner-"]').filter({ hasText: 'Reported to the builder.' }).waitFor();
  await page.evaluate(() => console.error('Caught error while handling a Yjs update', new Error('Yjs browser test'), { document: 'NEVER SEND' }));
  await page.getByText(/JS Error: Caught error while handling a Yjs update.*Reported to the builder/).waitFor();
  assert.equal(forwarded.filter(body => body.area === 'error').length, 2);
  assert(!JSON.stringify(forwarded).includes('private')); assert(!JSON.stringify(forwarded).includes('NEVER SEND'));
  await page.getByText(/JS Error: Caught error while handling a Yjs update.*Reported to the builder/).click();
  await page.locator('[id^="error-banner-"]').click();
  assert.equal(await page.locator('[id^="error-banner-"]').count(), 0);
  console.log('SOMA browser sign-in, People, sign-out, chip and editor-banner tests passed');
} finally {
  await browser.close();
  globalThis.fetch = nativeFetch;
  await new Promise<void>(resolve => server.close(() => resolve()));
}
