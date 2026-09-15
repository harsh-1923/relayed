// The daily refresh of `toolkits` and `toolkit_tools` (WORKSPACE-AGENTS.md
// §6.6). Nothing here writes `enabled` — that is `enable-toolkit.ts`'s job,
// by hand, once an auth config exists and the tools have been looked at
// (D10). This only keeps what Composio says true, for toolkits we already
// decided to offer.
import { sql, type Kysely } from 'kysely';
import type { DB } from '../db/schema.ts';
import { listToolkits, listTools, type ToolkitSummary, type ToolSummary } from './composio.ts';

/** `readOnlyHint`/`destructiveHint` are hints, not proof — §6.6's own words. `write` is the default a missing hint gets. */
function deriveEffect(hints: readonly string[]): 'read' | 'write' | 'destructive' {
  if (hints.includes('destructiveHint')) return 'destructive';
  if (hints.includes('readOnlyHint')) return 'read';
  return 'write';
}

async function* allToolkits(): AsyncGenerator<ToolkitSummary> {
  let cursor: string | undefined;
  do {
    const page = await listToolkits(cursor);
    yield* page.items;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

async function* allTools(toolkitSlug: string): AsyncGenerator<ToolSummary> {
  let cursor: string | undefined;
  do {
    const page = await listTools(toolkitSlug, cursor);
    yield* page.items;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
}

/**
 * Upsert every toolkit and tool Composio has, from its own catalogue. A
 * toolkit new to us lands `enabled = false` with no auth config — inert until
 * `enable-toolkit.ts` decides to offer it (D10) — and metadata on an existing
 * row is refreshed without touching `enabled` or how it authenticates, which
 * this refresh never decides.
 */
export async function refreshCatalogue(db: Kysely<DB>): Promise<{ toolkits: number; tools: number }> {
  let toolkitCount = 0;
  let toolCount = 0;

  for await (const toolkit of allToolkits()) {
    const existing = await db.selectFrom('toolkits')
      .select(['auth_scheme', 'auth_config_id', 'auth_managed_by'])
      .where('slug', '=', toolkit.slug).executeTakeFirst();

    // `toolkits.deprecated` is left at its default (false): Composio's
    // toolkit-level API has no boolean for it — `deprecated` in the raw
    // response is an unrelated metadata object (a toolkit id and per-scheme
    // proxy info), present whether or not the toolkit actually is one. Only
    // tools carry a real `is_deprecated` flag (below).
    await db.insertInto('toolkits').values({
      slug: toolkit.slug, name: toolkit.name, description: toolkit.description,
      logo_url: toolkit.logoUrl, categories: sql`${toolkit.categories}::text[]`,
      // A toolkit new to us has no auth config yet — `enable-toolkit.ts` fills
      // these in later; kept as-is on every later refresh, which never decides
      // how a toolkit authenticates.
      auth_scheme: existing?.auth_scheme ?? 'NONE',
      auth_config_id: existing?.auth_config_id ?? '',
      auth_managed_by: existing?.auth_managed_by ?? 'composio',
      refreshed_at: sql`now()`,
    })
      .onConflict(oc => oc.column('slug').doUpdateSet({
        name: toolkit.name, description: toolkit.description, logo_url: toolkit.logoUrl,
        categories: sql`${toolkit.categories}::text[]`, refreshed_at: sql`now()`,
      }))
      .execute();
    toolkitCount++;

    for await (const tool of allTools(toolkit.slug)) {
      await db.insertInto('toolkit_tools').values({
        toolkit: toolkit.slug, slug: tool.slug, name: tool.name, description: tool.description,
        hints: sql`${tool.hints}::text[]`, effect_derived: deriveEffect(tool.hints),
        important: tool.important, deprecated: tool.deprecated,
        input_schema: sql`${JSON.stringify(tool.inputSchema)}::jsonb`,
      })
        .onConflict(oc => oc.columns(['toolkit', 'slug']).doUpdateSet({
          name: tool.name, description: tool.description, hints: sql`${tool.hints}::text[]`,
          effect_derived: deriveEffect(tool.hints), important: tool.important, deprecated: tool.deprecated,
          input_schema: sql`${JSON.stringify(tool.inputSchema)}::jsonb`,
        }))
        .execute();
      toolCount++;
    }
  }

  return { toolkits: toolkitCount, tools: toolCount };
}

/** Start a refresh every 24 hours. Never awaited by a request. */
export function startCatalogueRefresh(db: Kysely<DB>, intervalMs = 24 * 60 * 60 * 1000): () => void {
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    void refreshCatalogue(db).catch(() => { /* the next tick tries again; nothing here is on a request path */ });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}
