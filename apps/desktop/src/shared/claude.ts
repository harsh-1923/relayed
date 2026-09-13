// What the agent runner and the sync engine say to each other, and what the
// screen is told about the person's own Claude Code (docs/LOCAL-ROOMS.md §3, §5).
//
// Shared by three processes, for the reason topics.ts is: a shape asserted in
// two places is a shape that drifts, and across a MessagePort the drift is
// silent — structured clone delivers whatever it was given.
import type { MessagePart } from '@relayed/protocol';

/** Who Claude Code says is signed in. Every field is the CLI's, and may be absent. */
export interface ClaudeAccount {
  email: string | null;
  organization: string | null;
  /** `pro`, `max`, `team`, `enterprise` — or null for an API key or a cloud provider. */
  plan: string | null;
  /** How the CLI authenticated: its own token source or API key source. */
  authSource: string | null;
  /** `firstParty`, `bedrock`, `vertex`, … — null when the CLI did not say. */
  provider: string | null;
}

/** How hard the model thinks before answering. Which levels a model takes is its own list. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** A model the person's Claude Code offers, as its start-up handshake lists them. */
export interface ClaudeModel {
  /** What to pass as `model`: an alias (`sonnet`) or a full id. */
  value: string;
  /** The id an alias resolves to today, when the CLI says. */
  resolvedModel: string | null;
  displayName: string;
  description: string;
  /** Empty when the model takes no effort setting. */
  efforts: EffortLevel[];
}

/** A slash command the person's Claude Code offers in a folder: built in, their own, a skill, or a plugin's. */
export interface ClaudeCommand {
  /** Without the slash: `compact`, `codex:rescue`. */
  name: string;
  description: string;
  /** What it takes after the name, e.g. `<file>`. Empty when nothing. */
  argumentHint: string;
  /** Other names that run the same command (`/cost` for `/usage`). */
  aliases: string[];
}

/**
 * The model a local room runs on until the person picks one: Sonnet 5, chosen
 * over their Claude Code's own default (Opus 5 on a Max plan). The full id
 * rather than the `sonnet` alias, which may move.
 */
export const DEFAULT_ROOM_MODEL = 'claude-sonnet-5';

/**
 * The three states the screen must never merge (§3.2), plus the probe failing.
 *
 * `binary` is the path that was resolved and run, shown on the settings screen
 * so that a support conversation is one screenshot (§3.6).
 */
export type ClaudeStatus =
  | { state: 'not_installed'; searched: string[]; checkedAt: number }
  | { state: 'signed_out'; binary: string; version: string | null; checkedAt: number }
  | { state: 'ready'; binary: string; version: string | null; account: ClaudeAccount; models: ClaudeModel[]; checkedAt: number }
  | { state: 'error'; binary: string | null; version: string | null; reason: string; checkedAt: number };

// ── the runner's port ───────────────────────────────────────────────────────

/** How Claude may act in a room without asking (LOCAL-ROOMS.md §3.4). */
export type RoomMode = 'supervised' | 'accept-edits' | 'auto' | 'full-access';

/**
 * What a new local room runs in. `auto`: Claude Code's own classifier approves
 * or denies each permission prompt, so a turn never stops to ask — there is no
 * approvals UI yet (LOCAL-ROOMS.md §8.5) to answer one.
 */
export const DEFAULT_ROOM_MODE: RoomMode = 'auto';

/** The modes, in the order a picker offers them, with what each lets Claude do unasked. */
export const ROOM_MODES: readonly { mode: RoomMode; label: string; description: string }[] = [
  { mode: 'supervised', label: 'Ask first', description: 'Asks before editing files or running commands.' },
  { mode: 'accept-edits', label: 'Accept edits', description: 'Edits files without asking; asks before running commands.' },
  { mode: 'auto', label: 'Auto', description: 'Claude Code decides what is safe; asks only when unsure.' },
  { mode: 'full-access', label: 'Full access', description: 'Never asks. Anything it decides to run, runs.' },
];

export const EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export const isEffortLevel = (value: unknown): value is EffortLevel =>
  EFFORT_LEVELS.includes(value as EffortLevel);

export const isRoomMode = (value: unknown): value is RoomMode =>
  ROOM_MODES.some(entry => entry.mode === value);

// ── approvals (LOCAL-ROOMS.md §8.5) ─────────────────────────────────────────

/** One of Claude Code's `AskUserQuestion` questions, as it asked it. */
export interface ApprovalQuestion {
  question: string;
  /** A chip of at most a dozen characters: "Library", "Approach". */
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

/**
 * Something Claude Code is waiting on the person for. The turn is paused until
 * it is answered, stopped, or the child goes away.
 *
 *   tool      may it use this tool, with this input?
 *   question  its AskUserQuestion: pick among options, or say something else
 *   plan      its ExitPlanMode: go ahead with this plan, or keep planning
 */
export type PendingApproval = {
  id: string;
  chatId: string;
  /** The reply row the paused turn is writing. */
  messageId: string;
  createdAt: number;
} & (
  | {
    kind: 'tool';
    toolName: string;
    /** Claude Code's own sentence for the ask, e.g. "Claude wants to run npm test". */
    title: string | null;
    description: string | null;
    /** What the tool acts on, one line — the command, the file. */
    summary: string;
    /** Bounded like a tool part's input. */
    input: unknown;
    /** "Always allow" is offered: Claude Code has a rule to suggest, and did not forbid one. */
    canAlwaysAllow: boolean;
    /** Open on Deny; offer no one-key approve. */
    defaultToNo: boolean;
  }
  | { kind: 'question'; questions: ApprovalQuestion[] }
  | { kind: 'plan'; plan: string }
);

/** The person's answer. Which ones fit depends on the approval's kind. */
export type ApprovalDecision =
  | { type: 'allow'; always?: boolean }
  | { type: 'deny'; message?: string }
  /** For a question: question text → the chosen label(s), comma-separated, or what they typed. */
  | { type: 'answer'; answers: Record<string, string> };

/** Start a turn in a chat: continue its live session, resume it, or begin one. */
export interface TurnStart {
  chatId: string;
  /** The streaming row this turn's reply is written into. */
  messageId: string;
  cwd: string;
  mode: RoomMode;
  /** Claude Code's own session id for this chat, once one is known. */
  sessionId: string | null;
  /** The room's model, or null for DEFAULT_ROOM_MODEL. */
  model: string | null;
  /** The room's effort, or null for the model's own default. */
  effort: EffortLevel | null;
  text: string;
}

/**
 * One short piece of text from a small model, with no tools and no session:
 * a room's title today. The caller owns the wording; the runner only runs it.
 */
export interface TextRequest {
  /** Replaces Claude Code's system prompt entirely. */
  instructions: string;
  input: string;
  model: string;
  /** The answer's shape, as JSON Schema. The runner returns the parsed object. */
  schema: Record<string, unknown>;
}

/** Every request the sync engine may make of the runner, and what each returns. */
export interface RunnerOps {
  /** Resolve the binary and probe it. Spends nothing: no message reaches Anthropic. */
  'claude.status': { params: undefined; result: ClaudeStatus };
  /** The slash commands Claude Code offers in a folder: its own, the project's, skills and plugins. Spends nothing. */
  'claude.commands': { params: { cwd: string }; result: ClaudeCommand[] };
  /** Spends a small request on the person's account. Resolves with the structured answer. */
  'text.generate': { params: TextRequest; result: { output: unknown } };
  /** Accepted at once; what happens arrives as events. */
  'turn.start': { params: TurnStart; result: null };
  /** Close the chat's Claude Code session. The turn ends as `stopped`. */
  'turn.stop': { params: { chatId: string }; result: null };
  /** Answer a pending approval. Refused if the runner no longer holds it. */
  'approval.respond': { params: { chatId: string; approvalId: string; decision: ApprovalDecision }; result: null };
  /** A room's model or effort changed. The model applies from the next message; effort restarts the child. */
  'room.model': { params: { chatIds: string[]; model: string | null; effort: EffortLevel | null }; result: null };
  /** A room's mode changed: applied to each chat's live session from its next tool call. */
  'room.mode': { params: { chatIds: string[]; mode: RoomMode }; result: null };
}

/**
 * What the runner reports, unasked, as a turn happens (LOCAL-ROOMS.md §8.3).
 *
 * `parts` is always the WHOLE reply so far, never a diff, so a report that is
 * lost or repeated cannot leave a tool missing or listed twice. `delta` is the
 * text of the block Claude is writing now, also whole, and is never stored.
 */
export type RunnerEvent =
  | { event: 'turn.delta'; chatId: string; messageId: string; text: string; ui: string | null }
  | { event: 'turn.parts'; chatId: string; messageId: string; parts: MessagePart[] }
  | { event: 'turn.session'; chatId: string; sessionId: string }
  | { event: 'approval.requested'; approval: PendingApproval }
  /** A live session's command list changed, e.g. a skill found in a subfolder. The whole list, not a diff. */
  | { event: 'commands.changed'; chatId: string; commands: ClaudeCommand[] }
  /** No longer waiting: answered, or the turn it paused ended. */
  | { event: 'approval.settled'; chatId: string; approvalId: string }
  | {
    event: 'turn.done'; chatId: string; messageId: string;
    outcome: 'completed' | 'failed' | 'stopped'; parts: MessagePart[]; reason: string | null;
  };

export type RunnerOp = keyof RunnerOps;

export interface RunnerRequest<Op extends RunnerOp = RunnerOp> {
  id: number;
  op: Op;
  params: RunnerOps[Op]['params'];
}

export type RunnerReply =
  | { id: number; ok: true; data: unknown }
  | { id: number; ok: false; error: string };

/** Anything the runner sends: a reply to a request, or an event nobody asked for. */
export type RunnerMessage = RunnerReply | RunnerEvent;
