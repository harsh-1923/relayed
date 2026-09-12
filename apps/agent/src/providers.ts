// The provider table, handed to pi (docs/AGENT-RUNTIME.md §4).
//
// pi chooses an adapter by WIRE FORMAT, not by vendor, so every target —
// LiteLLM, Vercel AI Gateway, Anthropic, anything else — is a row of config
// rather than a branch of code. This file is the only place that knows pi's
// registry exists.
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { env, type ProviderEntry } from './env.ts';

/**
 * Derived from the runtime rather than imported from `@earendil-works/pi-ai`.
 * The model type lives in a sub-package that is a transitive dependency, and
 * naming it directly would mean depending on it for a type we only pass
 * through.
 */
export type ResolvedModel = NonNullable<ReturnType<ModelRuntime['getModel']>>;

let runtime: ModelRuntime | undefined;

/**
 * Build the runtime once, from config alone.
 *
 * `modelsPath: null` and `allowModelNetwork: false` are what keep this
 * hermetic: pi otherwise reads `~/.pi/agent/models.json` and may refresh
 * catalogues over the network, which means a container behaves differently
 * from a laptop for reasons nobody can see.
 */
export async function modelRuntime(): Promise<ModelRuntime> {
  if (runtime) return runtime;
  const rt = await ModelRuntime.create({
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  for (const entry of env.providers) register(rt, entry);
  runtime = rt;
  return rt;
}

function register(rt: ModelRuntime, entry: ProviderEntry): void {
  rt.registerProvider(entry.name, {
    ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
    apiKey: entry.apiKey,
    api: entry.api,
    authHeader: true,
    models: entry.models.map(m => ({
      id: m.id,
      name: m.id,
      reasoning: m.reasoning,
      // Trap 4: OpenAI-compatible proxies commonly spell "off" as `none`.
      // Without the map, the off switch silently does nothing.
      ...(m.thinkingOff !== undefined ? { thinkingLevelMap: { off: m.thinkingOff } } : {}),
      input: ['text'] as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
  });
}

export class UnknownModelError extends Error {
  constructor(ref: string) {
    super(`no such model: "${ref}"`);
    this.name = 'UnknownModelError';
  }
}

/**
 * Resolve a request's optional `model` — `"<provider>/<id>"`, or a bare id when
 * exactly one provider serves it. Anything unresolvable is the caller's error,
 * answered with a 400 before a single token is spent.
 */
export async function resolveModel(ref: string | undefined): Promise<{ model: ResolvedModel; provider: string }> {
  const rt = await modelRuntime();
  const { provider, model } = ref === undefined ? env.fallback : parse(ref);
  const resolved = rt.getModel(provider, model);
  if (!resolved) throw new UnknownModelError(ref ?? `${provider}/${model}`);
  return { model: resolved, provider };
}

function parse(ref: string): { provider: string; model: string } {
  const slash = ref.indexOf('/');
  if (slash > 0 && slash < ref.length - 1) {
    const provider = ref.slice(0, slash);
    if (env.providers.some(p => p.name === provider)) {
      return { provider, model: ref.slice(slash + 1) };
    }
  }
  // A bare id, or a slash that belongs to the model id itself (Vercel spells
  // models `anthropic/claude-opus-5`). Unambiguous only if one entry has it.
  const owners = env.providers.filter(p => p.models.some(m => m.id === ref));
  const only = owners[0];
  if (only === undefined) throw new UnknownModelError(ref);
  if (owners.length > 1) {
    throw new UnknownModelError(`${ref}" is served by ${owners.length} providers — qualify it as "<provider>/${ref}`);
  }
  return { provider: only.name, model: ref };
}

/** Every model the process can serve. Logged at boot so config is visible. */
export function describeProviders(): string {
  return env.providers
    .map(p => `${p.name}(${p.api})=[${p.models.map(m => m.id).join(', ')}]`)
    .join(' ');
}
