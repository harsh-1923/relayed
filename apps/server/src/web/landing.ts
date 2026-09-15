// The page someone lands on after accepting an invitation.
//
// Deliberately NOT a web app. The only thing needed here is to stop a
// successful acceptance ending on a browser error page — which is what happens
// today, because AuthKit redirects to our loopback URL and nothing is listening
// on it: the loopback listener exists only while a sign-in is running IN the
// app, and this flow started from an email.
//
// A real web app would bring a second session model with it — httpOnly cookies,
// CSRF, a separate refresh path — where ours is desktop-shaped throughout
// (loopback, OS keychain, device_id). That is worth building when a dashboard
// needs it, not as a side effect of needing a redirect target.
//
// So: one route, no state, no auth, no JavaScript.
import type { FastifyInstance } from 'fastify';

/** Shared with `connections.ts`, for the same reason: a browser tab mid-flow deserves this, not a JSON 4xx. */
export const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Relayed</title>
<style>
  :root { color-scheme: light dark; }
  *, *::before, *::after { corner-shape: squircle; box-sizing: border-box; }
  body { margin:0; min-height:100svh; display:grid; place-items:center;
         font:16px/1.55 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;
         background:#0a0a0a; color:#fafafa; padding:24px; }
  main { max-width:30rem; text-align:center; }
  h1 { font-size:1.35rem; font-weight:600; margin:0 0 .6rem; letter-spacing:-.01em; }
  p  { margin:0 0 1rem; color:#a1a1aa; }
  .mark { width:44px; height:44px; border-radius:13px; margin:0 auto 1.5rem;
          background:linear-gradient(140deg,#6366f1,#a855f7); }
  ol { text-align:left; color:#a1a1aa; padding-left:1.15rem; margin:1.5rem 0 0; }
  li { margin:.4rem 0; }
  code { background:#18181b; padding:.1rem .4rem; border-radius:6px;
         font:0.85em ui-monospace,SFMono-Regular,Menlo,monospace; color:#e4e4e7; }
  @media (prefers-color-scheme: light) {
    body { background:#fafafa; color:#18181b } p, ol { color:#52525b }
    code { background:#f4f4f5; color:#27272a }
  }
</style></head>
<body><main><div class="mark"></div>${body}</main></body></html>`;

export async function landingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Where an accepted invitation ends up.
   *
   * The membership already exists in WorkOS by the time this renders — nothing
   * on this page performs it. It exists to say so, because a blank error page
   * after a successful action reads as a failure.
   */
  app.get('/welcome', async (_req, reply) => {
    reply.type('text/html; charset=utf-8').send(page('You are in', `
      <h1>You're in</h1>
      <p>Your invitation is accepted. The workspace is waiting in the Relayed app.</p>
      <ol>
        <li>Open <strong>Relayed</strong> on your computer.</li>
        <li>Sign in with the same email you just used.</li>
        <li>Choose a handle for this workspace — handles are per workspace, so
            one you use elsewhere may already be taken.</li>
      </ol>`));
  });

  /**
   * Where the loopback redirect lands when nothing is listening.
   *
   * Not an error: it means the flow began in an email rather than in the app,
   * so the code in the URL has no listener waiting for it and is simply unused.
   */
  app.get('/auth/callback', async (_req, reply) => {
    reply.type('text/html; charset=utf-8').send(page('Return to Relayed', `
      <h1>Nearly there</h1>
      <p>This step finishes inside the app rather than in the browser.</p>
      <p>Open <strong>Relayed</strong> and sign in — anything you just accepted
         will be waiting.</p>`));
  });
}
