// docs/WORKSPACE-AGENTS.md §4.1 — the callback-verification half of the spike.
//
// A minimal stand-in for the real `/connections/start` and `/connections/verify`
// routes (step 4, not built yet) — just enough to answer two questions:
//   1. Does a SameSite=Lax cookie we set survive provider → Composio → us?
//   2. Does `complete_auth` with the WRONG user_id actually fail the account?
//
// Not the real design: no signed attempt token, no loopback port, no `state`.
// Those exist to defeat fixation (§6.5) — a concern for the real flow, not for
// proving Composio's own behaviour against a cookie and an actor mismatch.
import { createServer } from 'node:http';
import { Composio } from '@composio/core';

const apiKey = process.env.COMPOSIO_API_KEY;
if (!apiKey) throw new Error('COMPOSIO_API_KEY is not set');
const composio = new Composio({ apiKey });

const PORT = 8790;
// Set by the CLI arg so one server binary serves both the "correct" and the
// "wrong" run without editing code between them.
const mode = process.argv[2]; // 'wrong' | 'correct'
const correctUserId = 'spike_user_verify';
const claimedUserId = mode === 'wrong' ? 'someone_else_entirely' : correctUserId;

let authConfigId;
{
  const existing = await composio.authConfigs.list({ toolkit: 'github', isComposioManaged: true });
  authConfigId = existing.items[0]?.id;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/start') {
    const request = await composio.connectedAccounts.link(correctUserId, authConfigId, { allowMultiple: true });
    console.log(`[start] connected_account_id=${request.id} mode=${mode} (link() always uses the real, correct user_id — the mismatch is injected later, at complete_auth, exactly as an attacker forging that call would)`);
    res.writeHead(302, {
      'Set-Cookie': 'spike_attempt=cookie-survived; HttpOnly; SameSite=Lax; Max-Age=600',
      Location: request.redirectUrl,
    });
    res.end();
    return;
  }

  if (url.pathname === '/connections/verify') {
    const sessionUri = url.searchParams.get('session_uri');
    const cookieHeader = req.headers.cookie ?? '';
    const cookieSurvived = cookieHeader.includes('spike_attempt=cookie-survived');
    console.log(`\n[verify] session_uri=${sessionUri}`);
    console.log(`[verify] Cookie header received: ${JSON.stringify(cookieHeader)}`);
    console.log(`[verify] SameSite=Lax cookie survived the redirect chain: ${cookieSurvived}`);
    console.log(`[verify] Calling complete_auth with user_id="${claimedUserId}" (${mode === 'wrong' ? 'DELIBERATELY WRONG' : 'correct'})`);

    const completeRes = await fetch('https://backend.composio.dev/api/v3.1/connected_accounts/complete_auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ session_uri: sessionUri, user_id: claimedUserId }),
    });
    const body = await completeRes.text();
    console.log(`[verify] complete_auth -> ${completeRes.status}`);
    console.log(`[verify] ${body}`);

    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`Cookie survived: ${cookieSurvived}\ncomplete_auth: ${completeRes.status}\n${body}\n\nYou can close this tab.`);
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`spike verify server on http://127.0.0.1:${PORT} — mode=${mode}`);
  console.log(`Open http://127.0.0.1:${PORT}/start THROUGH THE TUNNEL to begin.`);
});
