import { Router, type Request, type Response } from 'express';
import {
  allowLibrarySigninAttempt,
  clearLibrarySessionCookie,
  consumeLibrarySigninToken,
  getLibrarySession,
  isLibraryEnabled,
  requireLibraryJsonOrigin,
  requireLibrarySession,
  revokeLibrarySession,
  setLibrarySessionCookie,
} from './auth.js';

export const libraryRoutes = Router();

const SIGNIN_FAILURE = {
  code: 'SIGNIN_LINK_INVALID',
  message: 'This sign-in link has already been used or has expired. Ask a teammate for a new one.',
};

libraryRoutes.use((_req, res, next) => {
  if (!isLibraryEnabled()) {
    res.status(404).end();
    return;
  }
  next();
});

libraryRoutes.get('/library/signin', (_req: Request, res: Response) => {
  res.type('html').send(`<!doctype html>
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
</html>`);
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
  requireLibraryJsonOrigin,
  requireLibrarySession,
  (req: Request, res: Response) => {
    revokeLibrarySession(req);
    clearLibrarySessionCookie(req, res);
    res.json({ ok: true });
  },
);
