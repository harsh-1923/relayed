import type { DatabaseSync } from 'node:sqlite';

/**
 * Forward-only migrations keyed on SQLite's `user_version`.
 *
 * This must exist before the first build anyone else runs (RELEASE.md §6):
 * reinstalling replaces the app but leaves userData intact, so new code always
 * meets an old database, and a user who skips releases jumps several versions
 * at once.
 *
 * The local database is a replica — if a migration is ever infeasible,
 * wipe-and-resync is a legitimate escape hatch that a server DB never has.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'meta',
    up: `
      CREATE TABLE meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
      INSERT INTO meta(k, v) VALUES ('schema_origin', 'phase0');
    `,
  },
  {
    version: 2,
    name: 'actors',
    // DESIGN.md §8.3. Humans and agents in one table; Phase 1 writes only
    // type='human' and identity_kind='workos_user', but the shape is what lets
    // agents arrive in Phase 6 without a migration.
    //
    // No email column, deliberately: email lives in WorkOS and is never a join
    // key here, and agents have none at all.
    up: `
      CREATE TABLE actors (
        id             TEXT PRIMARY KEY,
        org_id         TEXT NOT NULL,
        workspace_id   TEXT NOT NULL,
        type           TEXT NOT NULL,
        handle         TEXT NOT NULL,
        display_name   TEXT NOT NULL,
        avatar_blob    TEXT,

        identity_kind  TEXT,
        identity_id    TEXT,

        owner_actor_id TEXT,
        provisioned_by TEXT NOT NULL,
        state          TEXT NOT NULL,
        updated_at     INTEGER NOT NULL,

        CHECK (type IN ('human','agent')),
        CHECK (provisioned_by IN ('self_signup','invite','sso_jit','scim','api')),
        CHECK (state IN ('invited','active','suspended','deactivated')),
        CHECK (identity_kind IS NULL OR identity_kind IN ('workos_user','workos_agent','system')),
        -- An agent must record who operates it; a human must not.
        CHECK (CASE WHEN type = 'agent' THEN owner_actor_id IS NOT NULL
                                        ELSE owner_actor_id IS NULL END)
      );

      -- One handle namespace for humans AND agents: this index is what stops
      -- @harsh and @deploy-bot colliding regardless of type.
      CREATE UNIQUE INDEX actor_handle   ON actors(workspace_id, handle);
      CREATE INDEX        actor_identity ON actors(identity_kind, identity_id);

      CREATE TABLE workspaces (
        id         TEXT PRIMARY KEY,
        org_id     TEXT NOT NULL,
        name       TEXT NOT NULL,
        slug       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX workspace_slug ON workspaces(org_id, slug);
    `,
  },
];

export interface MigrationResult { from: number; to: number; applied: string[] }

export function migrate(db: DatabaseSync): MigrationResult {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const from = row.user_version;
  const pending = migrations.filter(m => m.version > from).toSorted((a, b) => a.version - b.version);
  const applied: string[] = [];

  for (const m of pending) {
    db.exec('BEGIN');
    try {
      db.exec(m.up);
      // Not parameterisable, and the value comes from our own migration list,
      // never from input — so interpolation is safe here specifically.
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
      applied.push(`${m.version}:${m.name}`);
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.version} (${m.name}) failed: ${(e as Error).message}`);
    }
  }
  return { from, to: from + applied.length === from ? from : pending.at(-1)?.version ?? from, applied };
}
