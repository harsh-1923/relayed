// Is the person's Claude Code installed, signed in, and who as — without
// spending anything (docs/LOCAL-ROOMS.md §3.2).
//
// Two probes. `claude --version` is an ordinary child process and says whether
// the binary runs at all. The account comes from a real Claude Code session
// whose prompt NEVER YIELDS: the CLI completes its local start-up handshake —
// account, plan, how it signed in — and hands that back through
// `initializationResult()`, and since no message is ever sent, no request
// reaches Anthropic. Then the child is closed.
//
// Blunted so it is safe to run whenever the screen asks: no transcript written,
// no tools, no MCP servers, and none of the person's hooks — without
// `disableAllHooks` their SessionStart hooks would fire on every check.
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { query, type ModelInfo, type SDKUserMessage, type SettingSource, type SlashCommand } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeAccount, ClaudeCommand, ClaudeModel, ClaudeStatus } from '../../shared/claude.ts';
import { claudeEnv, resolveClaude } from './binary.ts';

/** Long enough for a cold start on a slow disk; short enough that a hung CLI is reported. */
const PROBE_TIMEOUT_MS = 20_000;
const VERSION_TIMEOUT_MS = 10_000;

/** The raw account fields, as the CLI reports them. */
export interface CliAccount {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: string;
}

/** What the start-up handshake says: who is signed in, and the models they can pick. */
export interface CliStartup {
  account: CliAccount;
  models: ModelInfo[];
  commands?: SlashCommand[];
}

/**
 * Where the handshake starts. The status check asks from nowhere in particular
 * with only the person's user settings; a folder's command list asks from that
 * folder with its project settings too, so its own commands and skills appear.
 */
export interface StartupPlace {
  cwd: string;
  settingSources: SettingSource[];
}

export interface ProbeDeps {
  resolve: typeof resolveClaude;
  version: (binary: string) => Promise<string | null>;
  startup: (binary: string) => Promise<CliStartup>;
  now: () => number;
}

export async function probeStatus(deps: ProbeDeps = { resolve: resolveClaude, version: readVersion, startup: readStartup, now: Date.now }): Promise<ClaudeStatus> {
  const found = deps.resolve();
  if (found.path === null) return { state: 'not_installed', searched: found.searched, checkedAt: deps.now() };
  const binary = found.path;

  const version = await deps.version(binary);
  let startup: CliStartup;
  try {
    startup = await deps.startup(binary);
  } catch (error) {
    return { state: 'error', binary, version, reason: reasonOf(error), checkedAt: deps.now() };
  }
  const { account } = startup;

  return signedIn(account)
    ? { state: 'ready', binary, version, account: accountOf(account), models: startup.models.map(modelOf), checkedAt: deps.now() }
    : { state: 'signed_out', binary, version, checkedAt: deps.now() };
}

/**
 * Whether the CLI holds a way to reach a model.
 *
 * An email means a claude.ai login. An API key or token source other than
 * `none` means a key. A provider other than first party means a cloud account
 * whose auth lives outside the CLI entirely, where the CLI reports no email.
 */
export function signedIn(account: CliAccount): boolean {
  const real = (value: string | undefined) => value !== undefined && value !== '' && value !== 'none';
  return real(account.email) || real(account.apiKeySource) || real(account.tokenSource)
    || (account.apiProvider !== undefined && account.apiProvider !== 'firstParty');
}

const modelOf = (model: ModelInfo): ClaudeModel => ({
  value: model.value,
  resolvedModel: model.resolvedModel ?? null,
  displayName: model.displayName,
  description: model.description,
  efforts: model.supportsEffort ? [...(model.supportedEffortLevels ?? [])] : [],
});

const accountOf = (account: CliAccount): ClaudeAccount => ({
  email: account.email ?? null,
  organization: account.organization ?? null,
  plan: account.subscriptionType ?? null,
  // A claude.ai login reports an email and no key source at all (measured).
  authSource: [account.tokenSource, account.apiKeySource].find(source => source && source !== 'none')
    ?? (account.email ? 'claude.ai' : null),
  provider: account.apiProvider ?? null,
});

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** `2.1.270 (Claude Code)` → `2.1.270`. Null when the binary will not even say. */
export function readVersion(binary: string): Promise<string | null> {
  return new Promise(resolve => {
    execFile(binary, ['--version'], { timeout: VERSION_TIMEOUT_MS, env: claudeEnv(binary) }, (error, stdout) => {
      resolve(error ? null : (/^\s*(\S+)/.exec(stdout)?.[1] ?? null));
    });
  });
}

export const commandOf = (command: SlashCommand): ClaudeCommand => ({
  name: command.name,
  description: command.description,
  argumentHint: command.argumentHint,
  aliases: [...(command.aliases ?? [])],
});

/** The account, models and commands from a session that is started, handshaken, and closed unused. */
export async function readStartup(binary: string, place: StartupPlace = { cwd: tmpdir(), settingSources: ['user'] }): Promise<CliStartup> {
  const abort = new AbortController();
  // A prompt stream whose first read waits for the abort and then ends, so no
  // user message is ever sent.
  const never: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<SDKUserMessage>>(resolve => {
        abort.signal.addEventListener('abort', () => resolve({ done: true, value: undefined }), { once: true });
      }),
    }),
  };

  const session = query({
    prompt: never,
    options: {
      pathToClaudeCodeExecutable: binary,
      env: claudeEnv(binary),
      // By default not a project: no CLAUDE.md, no project settings are read.
      cwd: place.cwd,
      persistSession: false,
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      // The person's user settings still apply, because an `apiKeyHelper` or an
      // `env` block there is how some people sign in at all.
      settingSources: place.settingSources,
      settings: { disableAllHooks: true },
      abortController: abort,
    },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Claude Code did not start within ${PROBE_TIMEOUT_MS / 1000}s`)), PROBE_TIMEOUT_MS);
    });
    const init = await Promise.race([session.initializationResult(), timeout]);
    return { account: init.account, models: init.models, commands: init.commands };
  } finally {
    clearTimeout(timer);
    abort.abort();
    session.close();
  }
}

/**
 * The slash commands Claude Code offers in a folder, from the same unused
 * handshake as the status check — so it spends nothing — but started in the
 * folder, with its project and local settings, so the project's own commands
 * and skills are listed beside the built-ins and the person's.
 */
export async function readCommands(cwd: string, binary = resolveClaude().path): Promise<ClaudeCommand[]> {
  if (!binary) throw new Error('The claude command was not found.');
  const { commands } = await readStartup(binary, { cwd, settingSources: ['user', 'project', 'local'] });
  return (commands ?? []).map(commandOf);
}
