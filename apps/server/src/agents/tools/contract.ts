// What every app tool is, and what it is given (docs/WORKSPACE-AGENTS.md §5.5).
//
// ONE FILE PER TOOL, each holding its name, its schema, the prompt that
// explains it and the code that answers it. The previous shape split those
// across `run-tools.ts` (every definition) and `broker.ts` (every handler),
// which meant one tool lived in two files organised on different axes: adding
// one touched four places, and a schema could drift from the handler reading
// its arguments without anything noticing.
//
// The Composio pair is deliberately NOT this shape. `find_tools` fits, because
// it answers from a search; `call_tool` does not, because it carries the
// permission check, the access card, the audit row and the execution through a
// person's own session — a lifecycle no other tool has. It stays in the broker
// route, named there as the exception it is.
import type { Kysely } from 'kysely';
import type { RunTool } from '@relayed/protocol';
import type { DB } from '../../db/schema.ts';
import type { AppendedEvent } from '../../sync/events.ts';
import type { FanoutResult } from '../../sync/fanout.ts';
import type { BrokerComposio } from '../composio-broker.ts';

/** A tool's answer, as the runtime receives it. */
export interface ToolReply {
  /** `ok`, or a refusal the model is expected to act on — `tool_not_allowed`, `failed`, … */
  result: string;
  data?: unknown;
  message?: string;
}

/** Everything a handler may reach. The same set for every tool, so a new one needs no new wiring. */
export interface ToolDeps {
  db: Kysely<DB>;
  deliver: (event: AppendedEvent) => Promise<FanoutResult>;
  composio: BrokerComposio;
  /** Nudged when a message an agent sends mentions another agent, so that run starts now rather than at the next poll. */
  dispatcher?: { wake(): void };
}

/**
 * The run a tool call belongs to.
 *
 * Every field comes from the GRANT or from our own row, never from the model's
 * arguments — which is what stops a run acting as somebody else by saying so.
 */
export interface ToolContext {
  runId: string;
  toolCallId: string;
  chatId: string;
  invokerActorId: string;
  agentActorId: string;
  chainDepth: number;
}

/**
 * Where a run is, and who is running — the facts that decide which tools it is
 * offered at all.
 *
 * `isRoomkeeper` is the one policy that depends on WHICH agent is running
 * (DOCUMENTS.md §4.8). It stays a plain boolean rather than a capability
 * system: two tools key off it today, and a third is the moment to ask for a
 * general shape rather than to assume one now.
 */
export interface Where {
  inRoom: boolean;
  isRoomkeeper: boolean;
}

/** A toolkit this deployment offers, as the model is told about it. */
export interface OfferedToolkit { slug: string; name: string }

/** One app tool: what it is called, when it is offered, what to say about it, and what it does. */
export interface AppTool {
  name: string;
  /**
   * Its schema when this run is offered it, or null when it is not. A tool
   * that is never offered is also never dispatched — the registry refuses a
   * call for one, so the offer is the authorisation and not merely a hint.
   */
  definition: (where: Where) => RunTool | null;
  /**
   * What the system prompt says about it, when it is offered. Omitted for a
   * tool whose description carries its own instructions.
   */
  prompt?: (where: Where) => string;
  handle: (deps: ToolDeps, run: ToolContext, args: Record<string, unknown>) => Promise<ToolReply>;
}

/** An argument the model supplied, as an object — anything else is treated as absent. */
export const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** A trimmed string argument, or '' — the shape every handler wants from `args`. */
export const asText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** A timestamp as the wire carries one. */
export const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));
