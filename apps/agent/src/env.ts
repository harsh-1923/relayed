// Configuration for the agent runtime (docs/AGENT-RUNTIME.md §4, §6, §11).
//
// Everything here is read once, at import, and anything wrong stops the
// process. That is deliberate: a provider table is config, so every mistake in
// it is a config mistake that would otherwise boot fine and then misbehave
// per-run in a way that reads as model failure (§4, "four traps").

/** pi-ai's built-in adapters. The set is open upstream; ours is not. */
const KNOWN_APIS = [
  'anthropic-messages',
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
  'mistral-conversations',
  'google-generative-ai',
  'google-vertex',
  'bedrock-converse-stream',
] as const;

export type Api = (typeof KNOWN_APIS)[number];

/**
 * Default wire format per well-known entry name, so the common case needs no
 * `_API` line. This is a config convenience, not vendor branching — nothing
 * downstream of `loadProviders` knows what a vendor is (§4).
 */
const API_BY_NAME: Record<string, Api> = {
  litellm: 'openai-completions',
  vercel: 'openai-completions',
  openai: 'openai-responses',
  anthropic: 'anthropic-messages',
};

export interface ModelEntry {
  id: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** How this provider spells "no thinking". OpenAI-compatible proxies want `none`. */
  thinkingOff: string | undefined;
}

export interface ProviderEntry {
  name: string;
  api: Api;
  baseUrl: string | undefined;
  apiKey: string;
  models: ModelEntry[];
}

class ConfigError extends Error {
  constructor(message: string) {
    super(`agent config: ${message}`);
    this.name = 'ConfigError';
  }
}

const read = (name: string): string | undefined => {
  const v = process.env[name]?.trim();
  return v && v.length > 0 ? v : undefined;
};

const list = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map(s => s.trim()).filter(s => s.length > 0);

const num = (name: string, fallback: number): number => {
  const raw = read(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(`${name} must be a positive number, got ${raw}`);
  return n;
};

/** Model ids that must not be served over an OpenAI-compatible shim (§4, trap 2). */
const looksLikeClaude = (modelId: string): boolean => /(^|\/)claude[-.]/i.test(modelId);

function loadProvider(name: string): ProviderEntry {
  const key = `AGENT_PROVIDER_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

  const api = (read(`${key}_API`) ?? API_BY_NAME[name]) as Api | undefined;
  if (api === undefined) {
    throw new ConfigError(`${key}_API is unset and "${name}" is not a known name — set it to one of: ${KNOWN_APIS.join(', ')}`);
  }
  if (!(KNOWN_APIS as readonly string[]).includes(api)) {
    throw new ConfigError(`${key}_API="${api}" is not a pi adapter — one of: ${KNOWN_APIS.join(', ')}`);
  }

  const apiKey = read(`${key}_API_KEY`);
  if (apiKey === undefined) throw new ConfigError(`${key}_API_KEY is required`);

  const modelIds = list(read(`${key}_MODELS`));
  if (modelIds.length === 0) throw new ConfigError(`${key}_MODELS is required — a comma-separated list of model ids`);

  // Metadata pi cannot discover and will not guess. Unset is a boot failure
  // rather than a default, because a wrong context window surfaces as model
  // misbehaviour rather than as a config error (§4, trap 3).
  const contextWindow = read(`${key}_CONTEXT_WINDOW`);
  if (contextWindow === undefined) throw new ConfigError(`${key}_CONTEXT_WINDOW is required — pi does not discover it, and a wrong value looks like model misbehaviour`);

  const reasoning = read(`${key}_REASONING`) !== 'false';
  const thinkingOff = read(`${key}_THINKING_OFF`);

  const models = modelIds.map((id): ModelEntry => {
    // Trap 2: an OpenAI-compat shim mangles Claude's thinking blocks, and the
    // provider reports it as a fabricated signature error that points nowhere
    // near the cause. Refuse the combination instead of debugging it later.
    if (api === 'openai-completions' && looksLikeClaude(id) && reasoning) {
      throw new ConfigError(
        `${key}: model "${id}" looks like Claude but is configured for openai-completions with reasoning enabled. ` +
        `Route Claude over anthropic-messages, or set ${key}_REASONING=false if the shim is genuinely non-reasoning.`,
      );
    }
    return {
      id,
      reasoning,
      contextWindow: num(`${key}_CONTEXT_WINDOW`, 0),
      maxTokens: num(`${key}_MAX_TOKENS`, 16_384),
      thinkingOff,
    };
  });

  return { name, api, baseUrl: read(`${key}_BASE_URL`), apiKey, models };
}

function loadProviders(): { providers: ProviderEntry[]; fallback: { provider: string; model: string } } {
  const names = list(read('AGENT_PROVIDERS'));
  if (names.length === 0) {
    throw new ConfigError('AGENT_PROVIDERS is required — a comma-separated list of provider entry names, e.g. "litellm"');
  }
  const providers = names.map(loadProvider);

  // The entry a request with no `model` gets. Named "fallback" because that is
  // the role it plays: LiteLLM fronts everything, so it is what a run lands on
  // when nothing more specific was asked for (§4).
  const raw = read('AGENT_MODEL_FALLBACK');
  if (raw === undefined) throw new ConfigError('AGENT_MODEL_FALLBACK is required — "<provider>/<model-id>"');
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash === raw.length - 1) {
    throw new ConfigError(`AGENT_MODEL_FALLBACK must be "<provider>/<model-id>", got "${raw}"`);
  }
  const provider = raw.slice(0, slash);
  const model = raw.slice(slash + 1);
  const entry = providers.find(p => p.name === provider);
  if (!entry) throw new ConfigError(`AGENT_MODEL_FALLBACK names provider "${provider}", which is not in AGENT_PROVIDERS`);
  if (!entry.models.some(m => m.id === model)) {
    throw new ConfigError(`AGENT_MODEL_FALLBACK names model "${model}", which is not in AGENT_PROVIDER_${provider.toUpperCase()}_MODELS`);
  }
  return { providers, fallback: { provider, model } };
}

const s2sKey = read('AGENT_S2S_KEY');
if (s2sKey === undefined) {
  // Fail closed at boot, not per request. An unset key must stop the process
  // rather than disable authentication — this endpoint executes shell (§5).
  throw new ConfigError('AGENT_S2S_KEY is required. Refusing to boot an unauthenticated agent runtime — there is no insecure escape hatch.');
}

const { providers, fallback } = loadProviders();

export const env = {
  port: num('AGENT_PORT', 8788),
  s2sKey,
  providers,
  fallback,
  maxConcurrentRuns: num('AGENT_MAX_CONCURRENT_RUNS', 4),
  runTimeoutMs: num('AGENT_RUN_TIMEOUT_MS', 300_000),
  maxTurns: num('AGENT_MAX_TURNS', 40),
  /** How often accumulated text deltas are flushed to an SSE consumer (§3). */
  streamCoalesceMs: num('AGENT_STREAM_COALESCE_MS', 80),
  /** Thinking text is debug output, not part of the answer (§3). Off by default. */
  exposeReasoning: read('AGENT_STREAM_REASONING') === 'true',
  drainTimeoutMs: num('AGENT_DRAIN_TIMEOUT_MS', 30_000),
} as const;
