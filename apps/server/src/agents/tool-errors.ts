// Composio's errors, mapped to what the person can do (docs/WORKSPACE-AGENTS.md
// §6.8), rewritten from live calls against the real `tool_router` API rather
// than trusted from the design doc's paraphrase (AGENTS.md rule 1).
//
// LIVE-VERIFIED (2026-09-14, `@composio/core` 0.18.1's REST surface):
//   - `ToolRouterV2_NoActiveConnection` (HTTP 400) — the account our
//     `connections` row says is ACTIVE is not what the session sees. Mapped
//     to `needs_reauth` rather than a generic failure: this is exactly the
//     mirror-drift case §6.9 exists to correct, and the broker's caller is
//     expected to mark the connection and raise the card, same as any other
//     `needs_reauth`.
//   - `[Session Restriction] …` / `ToolRouterV2_ToolkitNotAllowed` (400, code 4324,
//     observed 2026-09-15) — our catalogue check allowed a toolkit the
//     session's own config does not. `refused`, and ALSO an alert (§5.5): our
//     catalogue and the session disagreeing is a bug, never a user problem.
//
// DOCUMENTED IN §6.8 BUT NOT INDIVIDUALLY LIVE-TESTED (no safe way to force a
// real GitHub 403/410/429 through this endpoint without spending a real
// account's rate limit or a real deprecated call): the HTTP-status fallbacks
// below. Re-check these against a real occurrence before leaning on them.
import type { ComposioError } from './composio.ts';
import type { ExecuteResult } from './composio.ts';

export type BrokerOutcome =
  | { code: 'ok'; data: unknown }
  | { code: 'needs_reauth' }
  | { code: 'failed'; message: string }
  /** `alert`: this path should never be reached — log it as a bug, not a rate. */
  | { code: 'refused'; alert: true }
  | { code: 'tool_deprecated' }
  | { code: 'rate_limited' }
  | { code: 'provider_forbidden'; message: string }
  | { code: 'provider_unavailable' };

const MESSAGE_CAP = 1024;

/** A 200 from Composio with its own `error` set — §6.8's "successful: false", never an HTTP failure. */
export function mapExecuteResult(result: ExecuteResult): BrokerOutcome {
  return result.ok ? { code: 'ok', data: result.data } : { code: 'failed', message: result.message.slice(0, MESSAGE_CAP) };
}

/** Everything the HTTP call itself failed on — thrown by `composio.ts`'s `call()`. */
export function mapComposioError(err: ComposioError): BrokerOutcome {
  if (err.code === 'ToolRouterV2_NoActiveConnection') return { code: 'needs_reauth' };
  // Our catalogue still lists the tool, so step 5 passed; Composio no longer
  // has it. Observed code 4301 in `spikes/composio-discovery/` (2026-09-15).
  if (err.code === 'ToolRouterV2_ToolNotFound') return { code: 'tool_deprecated' };
  if (err.code === 'ToolRouterV2_ToolkitNotAllowed' || err.code === 'ToolRouterV2_ToolNotInEnabledList'
      || err.message.startsWith('[Session Restriction]')) {
    return { code: 'refused', alert: true };
  }
  if (err.status === 403) return { code: 'provider_forbidden', message: err.message.slice(0, MESSAGE_CAP) };
  if (err.status === 410) return { code: 'tool_deprecated' };
  if (err.status === 429) return { code: 'rate_limited' };
  if (err.status === 0 || err.status >= 500) return { code: 'provider_unavailable' };
  return { code: 'failed', message: err.message.slice(0, MESSAGE_CAP) };
}
