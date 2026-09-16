// Composio, as the broker and its tools use it.
//
// A named interface with a default implementation, rather than the module's
// functions called directly, so a test never reaches the network — `search`
// and `execute` are the two calls that would, and both are injected.
//
// It lives apart from `broker.ts` because the tools need the TYPE and the
// broker needs the tools: with the interface declared in the route file, that
// is a cycle. Here it is a leaf, which is the whole reason for the file.
import type { Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { sessionFor } from './sessions.ts';
import { executeSessionTool, searchSessionTools, type ExecuteResult, type SearchResult } from './composio.ts';

export interface BrokerComposio {
  session(db: Kysely<DB>, invokerActorId: string): Promise<string>;
  search(sessionId: string, useCase: string): Promise<SearchResult>;
  execute(sessionId: string, tool: string, args: Record<string, unknown>): Promise<ExecuteResult>;
}

/** The real one. A route takes it unless a caller passed its own. */
export const COMPOSIO: BrokerComposio = {
  session: sessionFor,
  search: searchSessionTools,
  execute: executeSessionTool,
};
