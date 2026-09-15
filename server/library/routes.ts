import { injectSomaFeedback } from '../soma-page.js';
import { Router, type Request, type Response } from 'express';
import { readFileSync } from 'fs';
import {
  allowLibrarySigninAttempt,
  clearLibrarySessionCookie,
  consumeLibrarySigninToken,
  createLibraryMember,
  createLibrarySigninLink,
  getLibraryMemberByEmail,
  getLibrarySession,
  isLibraryEnabled,
  isSomaAuthEnabled,
  exchangeSomaSession,
  listLibraryPeople,
  publicLibraryOrigin,
  requireLibraryJsonOrigin,
  requireLibrarySession,
  removeLibraryMember,
  revokeLibrarySession,
  setLibrarySessionCookie,
} from './auth.js';
import {
  allowLibraryDocumentCreation,
  archiveLibraryDocument,
  createLibraryDocument,
  listLibraryDocuments,
  recordLibraryVisit,
  renameLibraryDocument,
  type LibraryDocumentFilter,
  type LibraryDocumentSort,
} from './documents.js';

const libraryClientScript = readFileSync(new URL('./client.js', import.meta.url), 'utf8');

export const libraryRoutes = Router();

const SIGNIN_FAILURE = {
  code: 'SIGNIN_LINK_INVALID',
  message: 'This sign-in link has already been used or has expired. Ask a teammate for a new one.',
};

libraryRoutes.use('/library', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!isLibraryEnabled()) {
    res.status(404).end();
    return;
  }
  if (isSomaAuthEnabled() && ['/signin', '/api/signin', '/api/device-link'].includes(_req.path.replace(/\/$/, '').toLowerCase())) {
    res.status(404).end();
    return;
  }
  next();
});

libraryRoutes.get('/library/signin', (_req: Request, res: Response) => {
  res.type('html').send(injectSomaFeedback(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in · Proof</title>
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png?v=20260310r">
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;color:#111;background:#fff}
    main{width:min(420px,calc(100% - 48px));text-align:center}h1{font-size:22px;margin:0 0 12px}p{color:#666;line-height:1.5}
    @media(prefers-color-scheme:dark){body{background:#111;color:#f5f5f5}p{color:#aaa}}
  </style>
</head>
<body>
  <main>
    <h1 id="title">Signing you in…</h1>
    <p id="message"><noscript>Sign-in needs JavaScript.</noscript></p>
  </main>
  <script>
    (async function () {
      const title = document.getElementById('title');
      const message = document.getElementById('message');
      const token = new URLSearchParams(location.hash.slice(1)).get('t') || '';
      history.replaceState(null, '', '/library/signin');
      if (!token) {
        title.textContent = 'This link cannot sign you in';
        message.textContent = 'This sign-in link has already been used or has expired. Ask a teammate for a new one.';
        return;
      }
      try {
        const response = await fetch('/library/api/signin', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({token})
        });
        if (!response.ok) throw new Error('invalid');
        location.replace('/');
      } catch {
        title.textContent = 'This link cannot sign you in';
        message.textContent = 'This sign-in link has already been used or has expired. Ask a teammate for a new one.';
      }
    })();
  </script>
</body>
</html>`, 'sign-in'));
});

libraryRoutes.post('/library/api/session', (req, res, next) => {
  if (!isSomaAuthEnabled()) { res.status(404).end(); return; }
  next();
}, requireLibraryJsonOrigin, async (req, res) => {
  if (!allowLibrarySigninAttempt(req)) {
    res.status(429).json({ message: 'Too many sign-in attempts. Try again later.' });
    return;
  }
  const result = await exchangeSomaSession(req);
  if (result.sessionId) setLibrarySessionCookie(req, res, result.sessionId);
  res.status(result.status).json({ ok: result.status === 200, message: result.message, email: result.email, isAdmin: result.isAdmin, refreshAfterMs: result.refreshAfterMs });
});

libraryRoutes.get('/library/client.js', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.type('application/javascript').send(libraryClientScript);
});

libraryRoutes.post(
  '/library/api/signin',
  requireLibraryJsonOrigin,
  (req: Request, res: Response) => {
    if (!allowLibrarySigninAttempt(req)) {
      res.status(429).json({ code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Try again later.' });
      return;
    }
    const token = typeof req.body?.token === 'string' ? req.body.token : '';
    const result = consumeLibrarySigninToken(token, req.header('user-agent') || null);
    if (!result) {
      res.status(400).json(SIGNIN_FAILURE);
      return;
    }
    setLibrarySessionCookie(req, res, result.sessionId);
    res.json({ ok: true });
  },
);

libraryRoutes.get('/library/api/me', requireLibrarySession, (_req: Request, res: Response) => {
  const session = res.locals.librarySession as ReturnType<typeof getLibrarySession>;
  if (!session) {
    res.status(401).json({ code: 'SIGNED_OUT' });
    return;
  }
  res.json({
    id: session.member.id,
    name: session.member.name,
    isOwner: session.member.isOwner,
  });
});

libraryRoutes.post(
  '/library/api/signout',
  requireLibrarySession,
  requireLibraryJsonOrigin,
  (req: Request, res: Response) => {
    revokeLibrarySession(req);
    clearLibrarySessionCookie(req, res);
    res.json({ ok: true });
  },
);

function librarySessionFromResponse(res: Response): NonNullable<ReturnType<typeof getLibrarySession>> {
  return res.locals.librarySession as NonNullable<ReturnType<typeof getLibrarySession>>;
}

function stringParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

libraryRoutes.get(
  '/library/api/documents',
  requireLibrarySession,
  (_req: Request, res: Response) => {
    const req = _req;
    const filterValue = typeof req.query.filter === 'string' ? req.query.filter : 'all';
    const sortValue = typeof req.query.sort === 'string' ? req.query.sort : 'edited';
    const filter: LibraryDocumentFilter = ['all', 'review', 'mine', 'archived'].includes(filterValue)
      ? filterValue as LibraryDocumentFilter
      : 'all';
    const sort: LibraryDocumentSort = ['edited', 'title', 'created'].includes(sortValue)
      ? sortValue as LibraryDocumentSort
      : 'edited';
    const result = listLibraryDocuments({
      memberId: librarySessionFromResponse(res).member.id,
      query: typeof req.query.q === 'string' ? req.query.q : '',
      filter,
      sort,
    });
    res.json(result);
  },
);

libraryRoutes.post(
  '/library/api/documents',
  requireLibrarySession,
  requireLibraryJsonOrigin,
  async (req: Request, res: Response) => {
    const session = librarySessionFromResponse(res);
    if (!allowLibraryDocumentCreation(session.member.id)) {
      res.status(429).json({
        code: 'RATE_LIMITED',
        message: 'You have created 30 documents in the last hour. Try again later.',
      });
      return;
    }
    const title = typeof req.body?.title === 'string' ? req.body.title : '';
    const markdown = req.body?.markdown;
    if (markdown !== undefined && typeof markdown !== 'string') {
      res.status(400).json({ code: 'INVALID_MARKDOWN', message: 'Markdown must be text.' });
      return;
    }
    try {
      const created = await createLibraryDocument({ member: session.member, title, markdown });
      res.status(201).json(created);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not create the document.';
      res.status(message.includes('too large') ? 413 : 400).json({ code: 'CREATE_FAILED', message });
    }
  },
);

libraryRoutes.patch(
  '/library/api/documents/:slug',
  requireLibrarySession,
  requireLibraryJsonOrigin,
  (req: Request, res: Response) => {
    const slug = stringParam(req.params.slug);
    let changed = false;
    try {
      if (req.body?.title !== undefined) {
        if (typeof req.body.title !== 'string') {
          res.status(400).json({ code: 'INVALID_TITLE', message: 'Title must be text.' });
          return;
        }
        changed = renameLibraryDocument(slug, req.body.title) || changed;
      }
      if (req.body?.archived !== undefined) {
        if (typeof req.body.archived !== 'boolean') {
          res.status(400).json({ code: 'INVALID_ARCHIVED', message: 'Archived must be true or false.' });
          return;
        }
        changed = archiveLibraryDocument(
          slug,
          req.body.archived,
          librarySessionFromResponse(res).member.id,
        ) || changed;
      }
    } catch (error) {
      res.status(400).json({
        code: 'UPDATE_FAILED',
        message: error instanceof Error ? error.message : 'Could not update the document.',
      });
      return;
    }
    if (!changed) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Document not found.' });
      return;
    }
    res.json({ ok: true });
  },
);

libraryRoutes.post(
  '/library/api/visits/:slug',
  requireLibrarySession,
  requireLibraryJsonOrigin,
  (req: Request, res: Response) => {
    const event = req.body?.event;
    if (event !== 'open' && event !== 'leave') {
      res.status(400).json({ code: 'INVALID_EVENT', message: 'Event must be open or leave.' });
      return;
    }
    const recorded = recordLibraryVisit(
      librarySessionFromResponse(res).member.id,
      stringParam(req.params.slug),
      event,
    );
    if (!recorded) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Document not found.' });
      return;
    }
    res.json({ ok: true });
  },
);

libraryRoutes.get(
  '/library/api/people',
  requireLibrarySession,
  (_req: Request, res: Response) => {
    res.json({ people: listLibraryPeople() });
  },
);

libraryRoutes.post(
  '/library/api/people',
  requireLibrarySession,
  requireLibraryJsonOrigin,
  (req: Request, res: Response) => {
    if (isSomaAuthEnabled() && !librarySessionFromResponse(res).member.isOwner) {
      res.status(403).json({ message: 'Only an admin can add a member.' });
      return;
    }
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    if (getLibraryMemberByEmail(email)) {
      res.status(409).json({ code: 'EMAIL_EXISTS', message: 'A member already uses that email.' });
      return;
    }
    try {
      const session = librarySessionFromResponse(res);
      const member = createLibraryMember({ name, email, invitedBy: session.member.id });
      if (isSomaAuthEnabled()) { res.status(201).json({ member }); return; }
      const { link } = createLibrarySigninLink({
        memberId: member.id,
        purpose: 'invite',
        createdBy: session.member.id,
        origin: publicLibraryOrigin(req),
      });
      res.status(201).json({ member, link });
    } catch (error) {
      res.status(400).json({
        code: 'INVITE_FAILED',
        message: error instanceof Error ? error.message : 'Could not invite this person.',
      });
    }
  },
);

libraryRoutes.post(
  '/library/api/people/:id/remove',
  requireLibrarySession,
  requireLibraryJsonOrigin,
  (req: Request, res: Response) => {
    const session = librarySessionFromResponse(res);
    const memberId = stringParam(req.params.id);
    if (!session.member.isOwner) {
      res.status(403).json({ code: 'OWNER_REQUIRED', message: 'Only an owner can remove a member.' });
      return;
    }
    if (memberId === session.member.id) {
      res.status(400).json({ code: 'CANNOT_REMOVE_SELF', message: 'You cannot remove yourself.' });
      return;
    }
    if (!removeLibraryMember(memberId)) {
      res.status(404).json({ code: 'NOT_FOUND', message: 'Member not found.' });
      return;
    }
    res.json({ ok: true });
  },
);

libraryRoutes.post(
  '/library/api/device-link',
  requireLibrarySession,
  requireLibraryJsonOrigin,
  (req: Request, res: Response) => {
    const session = librarySessionFromResponse(res);
    const { link } = createLibrarySigninLink({
      memberId: session.member.id,
      purpose: 'device',
      createdBy: session.member.id,
      origin: publicLibraryOrigin(req),
    });
    res.json({ link });
  },
);
