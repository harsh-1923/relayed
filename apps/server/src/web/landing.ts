// The page someone lands on after accepting an invitation.
//
// Deliberately NOT a web app. The only thing needed here is to stop a
// successful acceptance ending nowhere — which is what happens when this page
// is not the environment's DEFAULT redirect URI at WorkOS. An invitation
// carries no `redirect_uri` of its own (`workos/management.ts` sends none, and
// AuthKit owns acceptance — AUTHZ.md §9.1), so AuthKit falls back to that
// default. Pointed at `relayed://auth/callback`, the browser of someone who has
// not installed the app yet silently drops the navigation and the hosted page
// hangs on its last step forever. DEPLOY.md §3a is the configuration.
//
// So the audience here is specifically a person WITHOUT the app: the download
// is the whole point of the page, not a footnote.
//
// A real web app would bring a second session model with it — httpOnly cookies,
// CSRF, a separate refresh path — where ours is desktop-shaped throughout
// (loopback, OS keychain, device_id). That is worth building when a dashboard
// needs it, not as a side effect of needing a redirect target.
//
// So: one route, no state, no auth, no JavaScript.
import type { FastifyInstance } from 'fastify';
import { versionAnswer } from './version.ts';

// The twin of `apps/web/src/lib/download.ts`. That site shares no code with the
// product (AGENTS.md), so the string lives twice and moves together — the same
// bargain `download.ts` already strikes with RELAYED_DOWNLOAD_URL.
//
// Said BEFORE they meet it. An unsigned Electron app carries an ad-hoc
// signature that actively fails validation, so macOS says "damaged" rather than
// "unidentified", and someone who was not warned concludes the download is
// corrupt and bins it (RELEASE.md §2).
const UNQUARANTINE = 'xattr -cr /Applications/Relayed.app';

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
  code.cmd { display:block; margin:.45rem 0; padding:.5rem .65rem;
             user-select:all; overflow-wrap:anywhere; }
  .btn { display:inline-flex; align-items:center; gap:.4rem; margin-top:.5rem;
         padding:.6rem 1.15rem; border-radius:999px; text-decoration:none;
         font-size:.9rem; font-weight:500; background:#fafafa; color:#0a0a0a; }
  .btn span { opacity:.55; font-weight:400 }
  .note { font-size:.82rem; margin:1.25rem 0 0; }
  @media (prefers-color-scheme: light) {
    body { background:#fafafa; color:#18181b } p, ol { color:#52525b }
    code { background:#f4f4f5; color:#27272a }
    .btn { background:#18181b; color:#fafafa }
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
    // Read per request rather than at module load, so the URL follows the
    // Railway variable the way `/version` does — one source, set by hand
    // (version.ts), never two that can disagree about where the build lives.
    const download = versionAnswer().url;
    reply.type('text/html; charset=utf-8').send(page('You are in', `
      <h1>You're in</h1>
      <p>Your invitation is accepted. The workspace is waiting in the Relayed app.</p>
      <a class="btn" href="${download}">Download Relayed <span>· macOS, Apple Silicon</span></a>
      <ol>
        <li>Open the <code>.dmg</code> and drag <strong>Relayed</strong> into
            Applications.</li>
        <li>In Terminal, run:
            <code class="cmd">${UNQUARANTINE}</code>
            This build is not signed by Apple yet. Without that command macOS
            calls the app <em>damaged</em> — it is not, and the step disappears
            once signing lands.</li>
        <li>Open <strong>Relayed</strong> and sign in with the same email you
            just used.</li>
        <li>Choose a handle for this workspace — handles are per workspace, so
            one you use elsewhere may already be taken.</li>
      </ol>
      <p class="note">Already have Relayed installed? Skip to step 3.</p>`));
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
