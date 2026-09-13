// A short piece of text from the person's own Claude Code, with nothing else
// attached (docs/LOCAL-ROOMS.md §7.1): no tools, no MCP servers, no hooks, no
// project, and no transcript left behind. Today that is a room's title.
//
// Unlike the status probe this DOES send a request, so it spends a little of
// the person's usage. What it is asked is the caller's business: the prompts
// live with the feature that needs them (sync/local/titles.ts), and this file
// only knows how to run one and hand back the answer.
import { tmpdir } from 'node:os';
import { query as sdkQuery, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { TextRequest } from '../../shared/claude.ts';
import { claudeEnv, resolveClaude } from './binary.ts';

/** A title is a second or two; a cold start on a slow disk is the rest. Under the sync engine's 30s request timeout. */
const GENERATE_TIMEOUT_MS = 25_000;

export interface GenerateDeps {
  query: (params: { prompt: string; options: Options }) => AsyncIterable<SDKMessage> & { close(): void };
  binary: () => string | null;
}

const defaultDeps: GenerateDeps = { query: sdkQuery, binary: () => resolveClaude().path };

export async function generateText(request: TextRequest, deps: GenerateDeps = defaultDeps): Promise<{ output: unknown }> {
  const binary = deps.binary();
  if (!binary) throw new Error('The claude command was not found.');

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), GENERATE_TIMEOUT_MS);
  const session = deps.query({
    prompt: request.input,
    options: {
      pathToClaudeCodeExecutable: binary,
      env: claudeEnv(binary),
      // Not a project: no CLAUDE.md, no project settings, no working tree to wander.
      cwd: tmpdir(),
      model: request.model,
      systemPrompt: request.instructions,
      outputFormat: { type: 'json_schema', schema: request.schema },
      persistSession: false,
      tools: [],
      allowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      // User settings only, for how they sign in (an apiKeyHelper, an env block).
      settingSources: ['user'],
      settings: { disableAllHooks: true },
      abortController: abort,
    },
  });

  try {
    for await (const message of session) {
      if (message.type !== 'result') continue;
      if (message.subtype !== 'success' || message.is_error) {
        const reason = message.subtype === 'success' ? message.result : message.errors.join('\n');
        throw new Error(reason || message.subtype.replaceAll('_', ' '));
      }
      return { output: message.structured_output ?? message.result };
    }
    throw new Error(abort.signal.aborted ? `No answer within ${GENERATE_TIMEOUT_MS / 1000}s` : 'Claude Code ended without an answer');
  } finally {
    clearTimeout(timer);
    session.close();
  }
}
