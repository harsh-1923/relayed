// Conversations with the person's Claude Code, one session per chat
// (docs/LOCAL-ROOMS.md §3.3, §8).
//
// Each chat that has been spoken to keeps a Claude Code child alive, fed from a
// queue: a new message is pushed into the prompt stream rather than starting a
// new process. What the child emits is translated into three reports the sync
// engine understands — live text, the reply's parts, and the end of the turn —
// and everything else it emits is dropped.
//
// A tool that needs the person's say pauses the turn: Claude Code calls
// `canUseTool`, the ask goes to the sync engine as an approval, and the promise
// it waits on resolves when the person answers (§8.5). Stopping the turn, or the
// child going away, answers every open ask with a denial — nothing is left
// waiting on a question nobody can see.
//
// A session that ends (stopped, crashed, the runner restarted) is simply gone.
// The next message resumes it by session id from Claude Code's own transcript,
// which is why a child is allowed to die at all (§3.6).
import { randomUUID } from 'node:crypto';
import {
  createSdkMcpServer, query as sdkQuery, tool,
  type CanUseTool, type McpServerConfig, type Options, type PermissionMode, type PermissionResult,
  type PermissionUpdate, type Query, type SDKMessage, type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { PART_LIMITS, type MessagePart, type ToolPart } from '@relayed/protocol';
import {
  formatForModel, LANG, LIBRARY_VERSION, SHOW_UI, summariseTool, uiInstructions, validateUi,
} from '@relayed/genui';
import {
  DEFAULT_ROOM_MODEL,
  type ApprovalDecision, type ApprovalQuestion, type EffortLevel, type PendingApproval, type RoomMode, type RunnerEvent, type TurnStart,
} from '../../shared/claude.ts';
import { claudeEnv, resolveClaude } from './binary.ts';
import { commandOf } from './status.ts';
import { partialSource } from './partial-source.ts';

/** The model a room runs on when it has not picked one (shared/claude.ts). A resumed session runs on the room's, whatever it started on. */
export const LOCAL_ROOM_MODEL = DEFAULT_ROOM_MODEL;

/** Live text is sent at most this often. A lost frame is cosmetic: the parts carry the text in the end. */
const DELTA_INTERVAL_MS = 50;

/** Two lines appended to Claude Code's own system prompt, saying where it is. */
const RUNTIME_NOTE = [
  'You are running inside Relayed, a desktop chat app, in a local room the person opened on this folder.',
  'They read your replies in a chat window that renders Markdown; they cannot see your terminal output unless you include it.',
  'Write links as [a short title](url) rather than a bare URL, so the reader sees the title.',
].join('\n');

/**
 * The tool as Claude Code names it: MCP tools are `mcp__<server>__<tool>`
 * (AGENT-RESPONSES.md §5.1).
 */
export const SHOW_UI_TOOL = `mcp__relayed__${SHOW_UI.name}`;

/** A tool's answer, in the shape an MCP server returns. A type, not an interface, so it fits the SDK's open result type. */
export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

/**
 * What is appended to Claude Code's system prompt: where it is, and the OpenUI
 * contract shared with the service agent. Built once: it is stable, so it caches.
 */
let appended: string | null = null;
const systemAppend = (): string => (appended ??= `${RUNTIME_NOTE}\n\n${uiInstructions()}`);

const PERMISSION_MODES: Record<RoomMode, Pick<Options, 'permissionMode' | 'allowDangerouslySkipPermissions'>> = {
  supervised: { permissionMode: 'default' },
  'accept-edits': { permissionMode: 'acceptEdits' },
  auto: { permissionMode: 'auto' },
  'full-access': { permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true },
};

export interface TurnDeps {
  query: (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query | AsyncIterable<SDKMessage> & { close(): void };
  binary: () => string | null;
  now: () => number;
  /** The in-process MCP server that carries `show_ui` for one session. A seam, so a test can call the tool. */
  uiServer: (showUi: (source: string) => Promise<ToolResult>) => McpServerConfig;
}

const defaultDeps: TurnDeps = {
  query: sdkQuery,
  binary: () => resolveClaude().path,
  now: Date.now,
  uiServer: (showUi) => createSdkMcpServer({
    name: 'relayed',
    tools: [tool(SHOW_UI.name, SHOW_UI.description, { source: z.string() }, ({ source }) => showUi(source))],
  }),
};

/** A prompt stream the sessions push into, one message per send. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  #queued: SDKUserMessage[] = [];
  #waiting: ((result: IteratorResult<SDKUserMessage>) => void) | null = null;
  #closed = false;

  push(text: string): void {
    const message: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    if (this.#waiting) { this.#waiting({ done: false, value: message }); this.#waiting = null; }
    else this.#queued.push(message);
  }

  close(): void {
    this.#closed = true;
    this.#waiting?.({ done: true, value: undefined });
    this.#waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const next = this.#queued.shift();
        if (next) return Promise.resolve({ done: false, value: next });
        if (this.#closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise(resolve => { this.#waiting = resolve; });
      },
    };
  }
}

/** One turn's reply, as it is being built. */
interface Turn {
  messageId: string;
  parts: MessagePart[];
  /** The text block Claude is writing now, before it lands as a part. */
  openText: string;
  /**
   * The input of a `show_ui` call being written now, as raw JSON so far, and the
   * index of its content block. Null when no call is arriving.
   */
  openUiJson: string | null;
  uiBlock: number | null;
  started: Map<string, number>;
  deltaTimer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
}

/** An ask Claude Code is waiting on. `answer` settles it once; a second call does nothing. */
interface Pending {
  approval: PendingApproval;
  answer: (decision: ApprovalDecision) => void;
  cancel: () => void;
}

interface Session {
  chatId: string;
  inbox: Inbox;
  query: { close(): void; setPermissionMode?(mode: PermissionMode): Promise<void>; setModel?(model?: string): Promise<void> };
  turn: Turn | null;
  sessionId: string | null;
  mode: RoomMode;
  /**
   * Started with `allowDangerouslySkipPermissions`. Full access can only be
   * entered by a child started with it, so moving into full access otherwise
   * closes the child — at once if idle, after the turn if not — and the next
   * message resumes it with the flag.
   */
  bypassAllowed: boolean;
  /** Effort is fixed when the child starts; a different one needs a restart, like full access. */
  startedEffort: EffortLevel | null;
  effort: EffortLevel | null;
  pending: Map<string, Pending>;
}

export class ChatSessions {
  readonly #emit: (event: RunnerEvent) => void;
  readonly #deps: TurnDeps;
  readonly #sessions = new Map<string, Session>();

  constructor(emit: (event: RunnerEvent) => void, deps: TurnDeps = defaultDeps) {
    this.#emit = emit;
    this.#deps = deps;
  }

  /** Accepted at once. Everything that follows arrives as events. */
  start(request: TurnStart): void {
    const existing = this.#sessions.get(request.chatId);
    if (existing?.turn) throw new Error('a turn is already running in this chat');

    const session = existing ?? this.#open(request);
    if (!session) return;
    session.turn = {
      messageId: request.messageId, parts: [], openText: '', openUiJson: null, uiBlock: null,
      started: new Map(), deltaTimer: null, stopping: false,
    };
    session.inbox.push(request.text);
  }

  /** Close the chat's child. Interrupt means close (§3.6): the SDK escalates to SIGKILL if it must. */
  stop(chatId: string): void {
    const session = this.#sessions.get(chatId);
    if (!session) return;
    if (session.turn) session.turn.stopping = true;
    cancelAll(session);
    session.inbox.close();
    session.query.close();
  }

  /** The person's answer to an ask. Throws if nothing is waiting on it any more. */
  respond(chatId: string, approvalId: string, decision: ApprovalDecision): void {
    const pending = this.#sessions.get(chatId)?.pending.get(approvalId);
    if (!pending) throw new Error('That request is no longer waiting.');
    const fits = decision.type === 'deny'
      || (pending.approval.kind === 'question' ? decision.type === 'answer' : decision.type === 'allow');
    if (!fits) throw new Error(`a ${pending.approval.kind} request cannot be answered with "${decision.type}"`);
    pending.answer(decision);
  }

  /**
   * A room's mode changed. A live child takes it from its next permission
   * check; one that cannot enter full access is closed so the next message
   * restarts it able to (see `bypassAllowed`). Chats with no child need nothing:
   * the mode is read from the store when one starts.
   */
  setMode(chatIds: readonly string[], mode: RoomMode): void {
    for (const chatId of chatIds) {
      const session = this.#sessions.get(chatId);
      if (!session) continue;
      session.mode = mode;
      if (this.#restartIfDue(session)) continue;
      // A mode the CLI refuses leaves the child on its old one until it restarts.
      void session.query.setPermissionMode?.(PERMISSION_MODES[mode].permissionMode ?? 'default').catch(() => {});
    }
  }

  /** A room's model or effort changed. The model is switched in place; effort needs the child restarted. */
  setModel(chatIds: readonly string[], model: string | null, effort: EffortLevel | null): void {
    for (const chatId of chatIds) {
      const session = this.#sessions.get(chatId);
      if (!session) continue;
      session.effort = effort;
      if (this.#restartIfDue(session)) continue;
      void session.query.setModel?.(model ?? LOCAL_ROOM_MODEL).catch(() => {});
    }
  }

  /**
   * Whether the child must be restarted to honour what the room now asks of it:
   * full access it was not started able to enter, or a different effort. An
   * idle child is closed now and a busy one when its turn ends; either way the
   * next message resumes the session with the room's settings.
   */
  #restartIfDue(session: Session): boolean {
    if (!restartDue(session)) return false;
    if (!session.turn) this.stop(session.chatId);
    return true;
  }

  closeAll(): void {
    for (const chatId of [...this.#sessions.keys()]) this.stop(chatId);
  }

  #open(request: TurnStart): Session | null {
    const binary = this.#deps.binary();
    if (!binary) {
      this.#emit({ event: 'turn.done', chatId: request.chatId, messageId: request.messageId, outcome: 'failed', parts: [],
        reason: 'The claude command was not found. See Settings → Claude Agent.' });
      return null;
    }

    const env = claudeEnv(binary);
    // A conversation is the person's own Claude Code: their claude.ai connectors
    // apply here, unlike in the status probe. Attaching to an IDE still does not.
    delete env['ENABLE_CLAUDEAI_MCP_SERVERS'];

    const inbox = new Inbox();
    const session: Session = {
      chatId: request.chatId, inbox, query: { close: () => {} }, turn: null, sessionId: request.sessionId,
      mode: request.mode, bypassAllowed: request.mode === 'full-access',
      startedEffort: request.effort, effort: request.effort, pending: new Map(),
    };
    const query = this.#deps.query({
      prompt: inbox,
      options: {
        pathToClaudeCodeExecutable: binary,
        env,
        cwd: request.cwd,
        model: request.model ?? LOCAL_ROOM_MODEL,
        ...(request.effort ? { effort: request.effort } : {}),
        // Their CLAUDE.md, settings, hooks and skills: most of what makes it feel
        // like THEIR Claude Code (§3.3).
        settingSources: ['user', 'project', 'local'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend() },
        includePartialMessages: true,
        // One server per session, so the tool knows whose reply a block belongs to.
        mcpServers: { relayed: this.#deps.uiServer(source => Promise.resolve(this.#showUi(session, source))) },
        // Listed so it never waits on an approval: it touches nothing but the
        // reply. The SDK approves a listed tool before any permission check
        // runs (measured, spikes/genui), so nothing else belongs in this list.
        allowedTools: [SHOW_UI_TOOL],
        canUseTool: (toolName, input, options) => this.#canUseTool(session, toolName, input, options),
        ...PERMISSION_MODES[request.mode],
        ...(request.sessionId ? { resume: request.sessionId } : {}),
      },
    });

    session.query = query;
    this.#sessions.set(request.chatId, session);
    void this.#consume(session, query as AsyncIterable<SDKMessage>);
    return session;
  }

  async #consume(session: Session, messages: AsyncIterable<SDKMessage>): Promise<void> {
    let failure: string | null = null;
    try {
      for await (const message of messages) this.#handle(session, message);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    this.#sessions.delete(session.chatId);
    const turn = session.turn;
    if (!turn) return;
    // The child is gone with a turn still open: stopped on purpose, or it died.
    this.#finish(session, turn.stopping ? 'stopped' : 'failed',
      turn.stopping ? 'Stopped.' : `Claude Code exited before finishing${failure ? `: ${failure}` : '.'}`);
  }

  #handle(session: Session, message: SDKMessage): void {
    // Adopt the session id once the CLI reports one on a real message, not a
    // placeholder from early start-up (§3.5).
    if ('session_id' in message && typeof message.session_id === 'string' && message.session_id !== session.sessionId
        && (message.type === 'system' || message.type === 'assistant' || message.type === 'result')) {
      session.sessionId = message.session_id;
      this.#emit({ event: 'turn.session', chatId: session.chatId, sessionId: message.session_id });
    }

    // The command list can change with no turn running: a skill loaded, a plugin reloaded.
    if (message.type === 'system' && message.subtype === 'commands_changed') {
      this.#emit({ event: 'commands.changed', chatId: session.chatId, commands: message.commands.map(commandOf) });
      return;
    }

    const turn = session.turn;
    if (!turn) return;
    // A subagent's frames belong to its Task tool, not to this reply.
    if ('parent_tool_use_id' in message && message.parent_tool_use_id) return;

    switch (message.type) {
      case 'stream_event': {
        const event = message.event as {
          type: string; index?: number;
          content_block?: { type: string; name?: string };
          delta?: { type: string; text?: string; partial_json?: string };
        };
        if (event.type === 'content_block_start') {
          if (event.content_block?.type === 'text') turn.openText = '';
          // A new block of any kind ends the last card's live preview; its stored part (or its absence) is the truth now.
          const startsUi = event.content_block?.type === 'tool_use' && event.content_block.name === SHOW_UI_TOOL;
          if (turn.openUiJson !== null || startsUi) {
            turn.openUiJson = startsUi ? '' : null;
            turn.uiBlock = startsUi ? event.index ?? null : null;
            this.#scheduleDelta(session, turn);
          }
        } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
          turn.openText += event.delta.text;
          this.#scheduleDelta(session, turn);
        } else if (event.type === 'content_block_delta' && event.delta?.type === 'input_json_delta'
                   && turn.openUiJson !== null && event.index === turn.uiBlock && event.delta.partial_json) {
          turn.openUiJson += event.delta.partial_json;
          this.#scheduleDelta(session, turn);
        }
        return;
      }
      case 'assistant': {
        let changed = false;
        for (const block of message.message.content as { type: string; text?: string; id?: string; name?: string; input?: unknown }[]) {
          if (block.type === 'text' && block.text?.trim()) {
            turn.parts.push({ kind: 'markdown', text: block.text });
            changed = true;
          } else if (block.type === 'tool_use' && block.name === SHOW_UI_TOOL) {
            // Not a tool card: a valid call becomes a `ui` part when it runs (#showUi).
            continue;
          } else if (block.type === 'tool_use' && block.id && block.name) {
            turn.started.set(block.id, this.#deps.now());
            // `ms: 0` is "still running" while the reply streams; a finished tool is at least 1.
            turn.parts.push({ kind: 'tool', tool_use_id: block.id, name: block.name, ok: true, ms: 0, input: boundInput(block.input) });
            changed = true;
          }
        }
        if (changed) {
          turn.openText = '';
          this.#flushDelta(session, turn);
          this.#emitParts(session, turn);
        }
        return;
      }
      case 'user': {
        const content = message.message.content;
        if (!Array.isArray(content)) return;
        let changed = false;
        for (const block of content as { type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]) {
          if (block.type !== 'tool_result' || !block.tool_use_id) continue;
          const index = turn.parts.findIndex(part => part.kind === 'tool' && part.tool_use_id === block.tool_use_id);
          const part = turn.parts[index];
          if (!part || part.kind !== 'tool') continue;
          const output = textOf(block.content);
          const started = turn.started.get(block.tool_use_id) ?? this.#deps.now();
          turn.parts[index] = {
            ...part, ok: block.is_error !== true, ms: Math.max(1, this.#deps.now() - started),
            ...(output ? { output_preview: output.slice(0, PART_LIMITS.maxOutputPreviewChars), output_bytes: Buffer.byteLength(output) } : {}),
          };
          changed = true;
        }
        if (changed) this.#emitParts(session, turn);
        return;
      }
      case 'system': {
        // What a slash command printed (/context, /usage): part of the reply,
        // as the terminal would have shown it. Colour codes do not survive.
        if (message.subtype === 'local_command_output' && message.content.trim()) {
          turn.parts.push({ kind: 'markdown', text: fenced(stripAnsi(message.content)) });
          this.#emitParts(session, turn);
        } else if (message.subtype === 'compact_boundary') {
          const { pre_tokens: before, post_tokens: after } = message.compact_metadata;
          turn.parts.push({ kind: 'markdown', text: `_Context compacted${after !== undefined ? `: ${tokens(before)} → ${tokens(after)} tokens` : ''}._` });
          this.#emitParts(session, turn);
        }
        return;
      }
      case 'result': {
        const failed = message.subtype !== 'success' || message.is_error;
        if (!failed && !turn.parts.some(part => part.kind === 'markdown') && message.result.trim()) {
          turn.parts.push({ kind: 'markdown', text: message.result });
        }
        const reason = !failed ? null
          : message.subtype === 'success' ? (message.result || 'Claude Code reported an error.')
          : message.errors.join('\n') || message.subtype.replaceAll('_', ' ');
        this.#finish(session, failed ? 'failed' : 'completed', reason);
        return;
      }
      default:
        return;
    }
  }

  /**
   * `show_ui`, as it runs (AGENT-RESPONSES.md §5.1). The same check the server
   * runs on write: a valid block becomes a `ui` part at this point in the
   * reply; an invalid one stores NOTHING and its errors go back to Claude, which
   * fixes them and calls again.
   */
  #showUi(session: Session, source: string): ToolResult {
    const turn = session.turn;
    if (!turn) return { isError: true, content: [{ type: 'text', text: 'No reply is being written in this chat.' }] };

    const result = validateUi(source);
    if (!result.ok) {
      // The broken card's live preview goes; nothing of it is kept.
      turn.openUiJson = null;
      this.#flushDelta(session, turn);
      return { isError: true, content: [{ type: 'text', text: formatForModel(result.errors) }] };
    }
    turn.parts.push({ kind: 'ui', lang: LANG, library: LIBRARY_VERSION, source });
    this.#emitParts(session, turn);
    return { content: [{ type: 'text', text: 'Shown to the people in this chat.' }] };
  }

  /**
   * Claude Code asking whether it may go on (§8.5). The ask becomes an approval
   * the screen shows; the returned promise is what the child waits on.
   */
  #canUseTool(session: Session, toolName: string, input: Record<string, unknown>, options: Parameters<CanUseTool>[2]): Promise<PermissionResult> {
    const turn = session.turn;
    if (!turn) return Promise.resolve({ behavior: 'deny', message: 'Nobody is here to approve this.' });

    const base = { id: `apr_${randomUUID()}`, chatId: session.chatId, messageId: turn.messageId, createdAt: this.#deps.now() };
    const approval: PendingApproval = toolName === 'AskUserQuestion'
      ? { ...base, kind: 'question', questions: questionsOf(input) }
      : toolName === 'ExitPlanMode'
        ? { ...base, kind: 'plan', plan: typeof input['plan'] === 'string' ? input['plan'] : '' }
        : {
          ...base, kind: 'tool', toolName,
          title: options.title ?? null,
          description: options.description ?? options.decisionReason ?? null,
          summary: summariseTool(input),
          input: boundInput(input),
          canAlwaysAllow: options.suppressAlwaysAllowRule !== true && (options.suggestions?.length ?? 0) > 0,
          defaultToNo: options.defaultToNo === true,
        };

    // Whatever Claude wrote before asking is on screen before the ask is.
    this.#flushDelta(session, turn);

    return new Promise(resolve => {
      const settle = (result: PermissionResult): void => {
        if (!session.pending.delete(approval.id)) return;
        options.signal.removeEventListener('abort', cancel);
        this.#emit({ event: 'approval.settled', chatId: session.chatId, approvalId: approval.id });
        resolve(result);
      };
      const cancel = (): void => { settle({ behavior: 'deny', message: 'The turn ended before the person answered.' }); };
      session.pending.set(approval.id, {
        approval,
        answer: decision => { settle(permissionOf(approval, input, options.suggestions, decision)); },
        cancel,
      });
      options.signal.addEventListener('abort', cancel, { once: true });
      this.#emit({ event: 'approval.requested', approval });
    });
  }

  #finish(session: Session, outcome: 'completed' | 'failed' | 'stopped', reason: string | null): void {
    const turn = session.turn;
    if (!turn) return;
    session.turn = null;
    cancelAll(session);
    if (turn.deltaTimer) clearTimeout(turn.deltaTimer);
    // Text that was still arriving when the turn ended is kept, not lost.
    if (turn.openText.trim() && !turn.parts.some(part => part.kind === 'markdown' && part.text === turn.openText)) {
      turn.parts.push({ kind: 'markdown', text: turn.openText });
    }
    // A tool that never reported back did not finish.
    const parts = turn.parts.map(part => (part.kind === 'tool' && part.ms === 0 ? { ...part, ok: false, ms: 1 } satisfies ToolPart : part));
    this.#emit({ event: 'turn.done', chatId: session.chatId, messageId: turn.messageId, outcome, parts, reason });
    if (restartDue(session)) {
      session.inbox.close();
      session.query.close();
    }
  }

  #emitParts(session: Session, turn: Turn): void {
    this.#emit({ event: 'turn.parts', chatId: session.chatId, messageId: turn.messageId, parts: [...turn.parts] });
  }

  #scheduleDelta(session: Session, turn: Turn): void {
    if (turn.deltaTimer) return;
    turn.deltaTimer = setTimeout(() => this.#flushDelta(session, turn), DELTA_INTERVAL_MS);
  }

  #flushDelta(session: Session, turn: Turn): void {
    if (turn.deltaTimer) { clearTimeout(turn.deltaTimer); turn.deltaTimer = null; }
    this.#emit({
      event: 'turn.delta', chatId: session.chatId, messageId: turn.messageId, text: turn.openText,
      ui: turn.openUiJson === null ? null : partialSource(turn.openUiJson),
    });
  }
}

const restartDue = (session: Session): boolean =>
  (session.mode === 'full-access' && !session.bypassAllowed) || session.effort !== session.startedEffort;

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');

/** Text shown exactly as printed: in a fence longer than any run of backticks inside it. */
function fenced(text: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), match => match[0].length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}text\n${text.replace(/\s+$/, '')}\n${fence}`;
}

const tokens = (count: number): string => (count >= 1000 ? `${Math.round(count / 1000)}k` : String(count));

/** Answer every ask a session holds with a denial: its turn is over. */
function cancelAll(session: Session): void {
  for (const pending of [...session.pending.values()]) pending.cancel();
}

/** What Claude Code is told, for each kind of ask and each answer. */
function permissionOf(
  approval: PendingApproval, input: Record<string, unknown>, suggestions: PermissionUpdate[] | undefined, decision: ApprovalDecision,
): PermissionResult {
  if (decision.type === 'deny') {
    const message = decision.message?.trim() || {
      tool: 'The person declined this. Do not try it another way; ask them what they would like instead.',
      question: 'The person dismissed the question without answering.',
      plan: 'The person does not want to go ahead with this plan yet. Ask what to change.',
    }[approval.kind];
    return { behavior: 'deny', message };
  }
  if (approval.kind === 'question') {
    if (decision.type !== 'answer') return { behavior: 'deny', message: 'The question was not answered.' };
    return { behavior: 'allow', updatedInput: { ...input, answers: decision.answers } };
  }
  if (decision.type !== 'allow') return { behavior: 'deny', message: 'The request was not approved.' };
  return {
    behavior: 'allow', updatedInput: input,
    // "Always": Claude Code's own suggested rule, for this session only.
    ...(decision.always && approval.kind === 'tool' && suggestions
      ? { updatedPermissions: suggestions.map(update => ('destination' in update ? { ...update, destination: 'session' as const } : update)) }
      : {}),
  };
}

/** `AskUserQuestion`'s questions, keeping only what is well formed. */
function questionsOf(input: Record<string, unknown>): ApprovalQuestion[] {
  const raw = Array.isArray(input['questions']) ? input['questions'] as unknown[] : [];
  return raw.flatMap(entry => {
    if (typeof entry !== 'object' || entry === null) return [];
    const q = entry as Record<string, unknown>;
    if (typeof q['question'] !== 'string') return [];
    const options = (Array.isArray(q['options']) ? q['options'] as unknown[] : []).flatMap(option => {
      const o = option as Record<string, unknown> | null;
      return o && typeof o['label'] === 'string'
        ? [{ label: o['label'], description: typeof o['description'] === 'string' ? o['description'] : '' }]
        : [];
    });
    return [{
      question: q['question'], header: typeof q['header'] === 'string' ? q['header'] : '',
      options, multiSelect: q['multiSelect'] === true,
    }];
  });
}

/**
 * A tool's input, small enough to keep. An edit or a file write carries the
 * whole content, which is Claude Code's transcript's to hold, not every
 * message's: past the limit only what says WHAT it acted on is kept.
 */
export function boundInput(input: unknown): unknown {
  const json = JSON.stringify(input) ?? '';
  if (Buffer.byteLength(json) <= PART_LIMITS.maxToolInputBytes) return input;
  const summary = summariseTool(input);
  const fields = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
  const kept: Record<string, unknown> = { truncated: true };
  for (const key of ['file_path', 'path', 'command', 'pattern', 'url', 'description']) {
    const value = fields[key];
    if (typeof value === 'string') kept[key] = value.slice(0, 1_000);
  }
  if (Object.keys(kept).length === 1 && summary) kept['summary'] = summary.slice(0, 1_000);
  return kept;
}

/** A tool result's content as plain text: a string, or the text blocks of an array. */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(block => {
      const text = typeof block === 'object' && block !== null && (block as { type?: string }).type === 'text'
        ? (block as { text?: unknown }).text : undefined;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}
