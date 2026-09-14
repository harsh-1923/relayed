// First sign-in provisioning (PHASE-1-IDENTITY.md §9).
//
// Organizations are created ON DEMAND, never on signup: someone arriving via an
// invite lands in that workspace and gets no personal org at all. Auto-creating
// one would make multi-org the default state and, worse, drop invited users
// into an empty workspace of their own — which reads as a broken invite.
import { emit, count } from "@relayed/telemetry";
import type { Kysely } from "kysely";
import {
  createOrganization,
  addMember,
  WorkOSError,
} from "../workos/management.ts";
import { ulid } from "../db/ulid.ts";
import type { DB } from "../db/schema.ts";
import { recordActor } from "../sync/directory.ts";
import { handleCandidates } from "./handle.ts";
import type { Role } from "@relayed/authz";

export interface Identity {
  workosUserId: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export interface Resolved {
  actorId: string;
  orgId: string;
  workspaceId: string;
  /** True when the caller must run onboarding: no org exists for this identity. */
  needsWorkspace: boolean;
  handleSuggestions: string[];
}

/** One workspace this identity belongs to. The client caches these (STORAGE.md §6). */
/**
 * One workspace this identity belongs to. The client caches these
 * (STORAGE.md §6).
 *
 * Two subjects in one shape, so every field says whose it is. An unqualified
 * `avatarUrl` here once got rendered as the workspace's icon when it is the
 * member's face — the same class of mistake as a column named for a blob that
 * held a URL.
 */
export interface Membership {
  workspaceId: string;
  orgId: string;
  /** The workspace. */
  name: string;
  slug: string;
  /** Its own image, falling back to its organization's. */
  workspaceAvatarUrl: string | null;
  /** Me, in this workspace. */
  actorId: string;
  actorHandle: string;
  actorDisplayName: string;
  actorAvatarUrl: string | null;
  /**
   * My role HERE. Sent so the client can answer `can()` offline (AUTHZ.md §3);
   * it is a projection of the authoritative row, never the authority itself —
   * the server re-checks every write regardless (invariant 49).
   */
  actorRole: Role;
}

/**
 * EVERY workspace this identity belongs to, oldest first.
 *
 * One WorkOS user can hold several OrganizationMemberships — accepting an
 * invite on an email that already has an org is the ordinary way it happens —
 * and our unique index is (workspace_id, identity_kind, identity_id), so two
 * actors for one identity is a correct state, not a conflict.
 *
 * The ordering is load-bearing. This previously took the first row of an
 * unordered query, which returns an arbitrary actor once there are two:
 * repeatable in testing, undefined by contract, and free to change after a
 * vacuum or an index change (STORAGE.md §10.1).
 */
export async function resolveMemberships(
  db: Kysely<DB>,
  workosUserId: string,
): Promise<Membership[]> {
  const rows = await db
    .selectFrom("actors")
    .innerJoin("workspaces", "workspaces.id", "actors.workspace_id")
    .innerJoin("organizations", "organizations.id", "actors.org_id")
    // LEFT join: an actor with no membership row can do nothing, which is the
    // correct answer — but it must not make them vanish from their own
    // workspace list.
    .leftJoin("memberships", (join) =>
      join
        .onRef("memberships.scope_id", "=", "actors.workspace_id")
        .on("memberships.scope_type", "=", "workspace")
        .onRef("memberships.actor_id", "=", "actors.id")
        .on("memberships.left_at", "is", null),
    )
    .select((eb) => [
      "actors.id as actor_id",
      "actors.org_id",
      "actors.workspace_id",
      "actors.handle",
      "actors.display_name",
      "actors.avatar_url",
      "workspaces.name",
      "workspaces.slug",
      // A workspace with no image of its own shows its organization's. Resolved
      // HERE so the client never needs an organizations table of its own.
      eb.fn
        .coalesce("workspaces.avatar_url", "organizations.avatar_url")
        .as("workspace_avatar_url"),
      "memberships.role as actor_role",
    ])
    .where("actors.identity_kind", "=", "workos_user")
    .where("actors.identity_id", "=", workosUserId)
    .where("actors.state", "not in", ["deactivated", "suspended"])
    // ULIDs break a same-transaction timestamp tie deterministically.
    .orderBy("actors.created_at", "asc")
    .orderBy("actors.id", "asc")
    .execute();

  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    orgId: r.org_id,
    name: r.name,
    slug: r.slug,
    workspaceAvatarUrl: r.workspace_avatar_url,
    actorId: r.actor_id,
    actorHandle: r.handle,
    actorDisplayName: r.display_name,
    actorAvatarUrl: r.avatar_url,
    actorRole: (r.actor_role ?? "member") as Role,
  }));
}

/**
 * Which membership a new session is scoped to.
 *
 * `preferred` is the workspace the client had open (STORAGE.md §10.1); a fresh
 * install sends none and gets the oldest. A `preferred` that is not ours is an
 * error, never a silent fallback — quietly signing someone into a different
 * workspace than they asked for is worse than failing.
 */
export function selectMembership(
  memberships: readonly Membership[],
  preferred?: string,
): Membership | "not_a_member" | null {
  if (memberships.length === 0) return null;
  if (!preferred) return memberships[0]!;
  return memberships.find((m) => m.workspaceId === preferred) ?? "not_a_member";
}

/** Find the existing actor for a WorkOS identity, or report that none exists. */
export async function resolveActor(
  db: Kysely<DB>,
  id: Identity,
): Promise<Resolved | null> {
  const first = (await resolveMemberships(db, id.workosUserId))[0];
  if (!first) return null;
  return {
    actorId: first.actorId,
    orgId: first.orgId,
    workspaceId: first.workspaceId,
    needsWorkspace: false,
    handleSuggestions: [],
  };
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "workspace";

/**
 * Creates an organization, its single workspace, and the founding actor.
 * One transaction: a half-created tenant is worse than a failed sign-in.
 */
export async function createWorkspace(
  db: Kysely<DB>,
  id: Identity,
  opts: { workspaceName: string; handle: string },
): Promise<Resolved> {
  // WorkOS FIRST, outside the transaction.
  //
  // Not inside it: holding a database transaction open across a network call
  // makes the slowest external service the lock duration. Not after it either:
  // that leaves rows claiming an organization that may not exist.
  //
  // Doing it first means a WorkOS failure aborts before anything is written,
  // and the only debris is an orphaned organization on their side — rare, and
  // far cheaper than a tenant of ours pointing at nothing. Onboarding already
  // required WorkOS to be reachable a moment ago (AuthKit authenticated this
  // person), so this adds no failure mode that was not already present.
  const org = await createOrganization(opts.workspaceName);
  const workosOrgId = org.id;

  // The step that is easy to miss: an organization with no members is one
  // invitations cannot be addressed to, and one a later Directory Sync would
  // reconcile against as empty. Not fatal if it fails — the org exists and the
  // membership can be repaired — so it must not abort a sign-up.
  try {
    await addMember(workosOrgId, id.workosUserId);
  } catch (e) {
    console.warn(
      "[provision] organization created but membership failed:",
      (e as WorkOSError).code,
      (e as Error).message,
    );
  }

  return db.transaction().execute(async (tx) => {
    const orgId = ulid("org");
    const workspaceId = ulid("wsp");
    const actorId = ulid("act");

    await tx
      .insertInto("organizations")
      .values({
        id: orgId,
        workos_org_id: workosOrgId,
        name: opts.workspaceName,
      })
      .execute();

    await tx
      .insertInto("workspaces")
      .values({
        id: workspaceId,
        org_id: orgId,
        name: opts.workspaceName,
        slug: slugify(opts.workspaceName),
      })
      .execute();

    await tx
      .insertInto("actors")
      .values({
        id: actorId,
        org_id: orgId,
        workspace_id: workspaceId,
        type: "human",
        handle: opts.handle,
        display_name: id.displayName,
        avatar_url: id.avatarUrl,
        identity_kind: "workos_user",
        identity_id: id.workosUserId,
        owner_actor_id: null,
        provisioned_by: "self_signup",
        state: "active",
      })
      .execute();

    // The founding row of this workspace's directory, at revision 1 of its
    // stream. There is nobody to deliver it to yet — the audience is the
    // workspace's members and this actor is the only one — but the event has to
    // exist so that a later member's catch-up over the directory returns the
    // founder rather than starting from whoever joined second.
    await recordActor(tx, "actor.created", {
      id: actorId,
      workspaceId,
      type: "human",
      handle: opts.handle,
      displayName: id.displayName,
      avatarUrl: id.avatarUrl,
      ownerActorId: null,
      state: "active",
    });

    // The founder owns the workspace. A permission is a row (AUTHZ.md §4), so
    // this is what makes them able to invite — not a column, and not the fact
    // that they happen to be first.
    await tx
      .insertInto("memberships")
      .values({
        scope_type: "workspace",
        scope_id: workspaceId,
        actor_id: actorId,
        role: "owner",
        left_at: null,
      })
      .execute();

    // `via` separates people who signed themselves up from people who were
    // invited — two very different growth stories, and the distinction is
    // unrecoverable once the row exists.
    count("identity.provisioned", { via: "self_signup" });
    emit("identity.provisioned", {
      actor: actorId,
      org: orgId,
      workspace: workspaceId,
      via: "self_signup",
    });
    return {
      actorId,
      orgId,
      workspaceId,
      needsWorkspace: false,
      handleSuggestions: [],
    };
  });
}

/** Suggestions for the onboarding form, filtered to what is actually free. */
export async function suggestHandles(
  db: Kysely<DB>,
  workspaceId: string,
  id: Identity,
): Promise<string[]> {
  const candidates = handleCandidates(id.email, id.displayName);
  if (candidates.length === 0) return [];
  const taken = new Set(
    (
      await db
        .selectFrom("actors")
        .select("handle")
        .where("workspace_id", "=", workspaceId)
        .execute()
    ).map((r) => r.handle.toLowerCase()),
  );
  return candidates.filter((c) => !taken.has(c));
}
