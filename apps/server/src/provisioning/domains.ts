// Company email domains (docs/ORG-DOMAINS.md §4).
//
// An org admin APPROVES a domain; anyone with a verified mailbox on it may then
// join that org's default workspace without an invitation. Approval is never
// exclusive — several orgs may approve one domain and sign-in lists them all
// (§4.4) — so being first to sign up from a company decides nothing for anybody
// else. Exclusive control is the enterprise tier's DNS verification (§11).
//
// Email is read here, from a profile fetched moments ago, and never written
// down (DESIGN.md §6.2). Only the DOMAIN is stored, and only once an admin has
// chosen to publish it.
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import type { DB } from '../db/schema.ts';
import { getOrganization, listOrganizationsByDomain } from '../workos/management.ts';

/**
 * Domains anyone can get an address on. Never approvable, and never matched —
 * checked again at join, not only at approval, so adding an entry here closes a
 * mistake that was already approved.
 *
 * A file, not a table: it changes with a release, and the risk is a MISSING
 * entry, which no amount of runtime configurability would have prevented.
 */
export const PUBLIC_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com',
  'msn.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.co.uk', 'ymail.com', 'icloud.com', 'me.com',
  'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'zoho.com', 'zohomail.com',
  'yandex.com', 'yandex.ru', 'gmx.com', 'gmx.de', 'gmx.net', 'mail.com', 'mail.ru',
  'rediffmail.com', 'qq.com', '163.com', '126.com', 'naver.com', 'fastmail.com', 'hey.com',
  'tutanota.com', 'tuta.io', 'web.de', 'inbox.com', 'duck.com',
]);

/** `' Ravi@ACME.com '` → `'acme.com'`; anything without a domain → `''`. */
export function domainOf(email: string): string {
  const at = email.trim().toLowerCase().lastIndexOf('@');
  return at < 0 ? '' : email.trim().toLowerCase().slice(at + 1);
}

/** A bare, lower-cased domain with at least one dot, or null. */
export function normaliseDomain(input: string): string | null {
  const d = input.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(d) ? d : null;
}

export const isPublicDomain = (domain: string): boolean => PUBLIC_MAIL_DOMAINS.has(domain);

export type ApprovalRefusal = 'invalid_domain' | 'public_domain' | 'not_your_domain' | 'email_unverified';

/**
 * May an admin whose mailbox is `adminEmail` approve `domain`?
 *
 * Only their OWN domain (Notion's rule, §4.2): it is what stops someone
 * creating "Acme" from a gmail account and approving acme.com to collect every
 * Acme employee who signs up after them.
 */
export function approvalRefusal(
  adminEmail: string, adminEmailVerified: boolean, domain: string,
): ApprovalRefusal | null {
  const d = normaliseDomain(domain);
  if (!d) return 'invalid_domain';
  if (isPublicDomain(d)) return 'public_domain';
  if (!adminEmailVerified) return 'email_unverified';
  if (domainOf(adminEmail) !== d) return 'not_your_domain';
  return null;
}

export interface OrgMatch {
  orgId: string;
  name: string;
  memberCount: number;
  workspaceId: string;
  workspaceName: string;
  /** The workspace's logo, else the org's, as a relative `/files/…` URL (FILES.md §5). */
  logoUrl: string | null;
  /** The org's default workspace — where colleagues land. */
  isDefault: boolean;
  /** Active people in THIS workspace; `memberCount` is the org's. */
  workspaceMemberCount: number;
}

/**
 * Every OPEN workspace of every org whose approved domains cover this mailbox —
 * orgs largest first, each org's default first within it (§4.4, §5).
 * `memberCount` is the ORG's size, the number that says "your team is here".
 *
 * Empty for an unverified address or a public domain — both are checked here,
 * at the one place a match is produced, so no caller can forget either. Orgs
 * listed in `exclude` (ones the person already belongs to) are left out.
 *
 * A VERIFIED domain (§11.2) is exclusive: if any org holds it verified, that org
 * is the only match.
 */
export async function orgMatches(
  db: Kysely<DB>, email: string, emailVerified: boolean, exclude: ReadonlySet<string> = new Set(),
): Promise<OrgMatch[]> {
  if (!emailVerified) return [];
  const domain = domainOf(email);
  if (!domain || isPublicDomain(domain)) return [];

  const rows = await db.selectFrom('organization_domains')
    .innerJoin('organizations', 'organizations.id', 'organization_domains.org_id')
    .innerJoin('workspaces', 'workspaces.org_id', 'organizations.id')
    .innerJoin('workspaces as dflt', 'dflt.id', 'organizations.default_workspace_id')
    .select((eb) => [
      'organizations.id as org_id', 'organizations.name as name',
      'workspaces.id as workspace_id', 'workspaces.name as workspace_name',
      'organization_domains.verified_at',
      'workspaces.logo_file_id as ws_logo', 'organizations.logo_file_id as org_logo',
      'organizations.default_workspace_id',
      eb.selectFrom('actors').select(sql<number>`count(DISTINCT identity_id)::int`.as('n'))
        .whereRef('actors.org_id', '=', 'organizations.id')
        .where('actors.type', '=', 'human').where('actors.state', '=', 'active')
        .as('member_count'),
      eb.selectFrom('actors as w').select(sql<number>`count(*)::int`.as('n'))
        .whereRef('w.workspace_id', '=', 'workspaces.id')
        .where('w.type', '=', 'human').where('w.state', '=', 'active')
        .as('workspace_member_count'),
    ])
    .where('organization_domains.domain', '=', domain)
    .where('workspaces.join_policy', '=', 'org_open')
    .execute();

  const verified = rows.filter(r => r.verified_at !== null);
  return (verified.length > 0 ? verified : rows)
    .filter(r => !exclude.has(r.org_id))
    .map(r => ({
      orgId: r.org_id, name: r.name, memberCount: r.member_count ?? 0,
      workspaceId: r.workspace_id, workspaceName: r.workspace_name,
      logoUrl: r.ws_logo ?? r.org_logo ? `/files/${r.ws_logo ?? r.org_logo}` : null,
      isDefault: r.workspace_id === r.default_workspace_id,
      workspaceMemberCount: r.workspace_member_count ?? 0,
    }))
    .sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name)
      || Number(b.isDefault) - Number(a.isDefault) || a.workspaceName.localeCompare(b.workspaceName));
}

/** Does `orgId` approve the domain of this verified mailbox? The join-time re-check (§4.1). */
export async function domainAdmits(
  db: Kysely<DB>, orgId: string, email: string, emailVerified: boolean,
): Promise<boolean> {
  return (await orgMatches(db, email, emailVerified)).some(m => m.orgId === orgId);
}

/**
 * Bring our copy of each org's WorkOS-verified domains up to date (§11).
 *
 * A domain verified on an org in WorkOS makes WorkOS add every matching
 * sign-in to that org by itself. Without a copy here Relayed could not show it,
 * and would contradict it — an org page saying "nobody can join without an
 * invitation" while WorkOS admits everyone. So: read the orgs' domains, upsert
 * the verified ones as `source = 'workos'`, and drop our `workos` rows WorkOS no
 * longer has. App approvals are never touched, except that one on the SAME
 * domain of the SAME org is upgraded — it is the same fact, now proven.
 *
 * Asked at sign-in for the orgs the person belongs to, and when an org's page
 * opens. Never throws: WorkOS unreachable leaves what we knew.
 */
export async function syncWorkosDomains(db: Kysely<DB>, workosOrgIds: readonly string[]): Promise<void> {
  for (const workosOrgId of workosOrgIds) {
    let verified: string[];
    try {
      const org = await getOrganization(workosOrgId);
      verified = (org.domains ?? []).filter(d => d.state === 'verified')
        .map(d => normaliseDomain(d.domain)).filter((d): d is string => d !== null);
    } catch { continue; }

    const ours = await db.selectFrom('organizations').select('id')
      .where('workos_org_id', '=', workosOrgId).executeTakeFirst();
    if (!ours) continue;

    await db.transaction().execute(async (tx) => {
      const stale = tx.deleteFrom('organization_domains')
        .where('org_id', '=', ours.id).where('source', '=', 'workos');
      await (verified.length ? stale.where('domain', 'not in', verified) : stale).execute();
      for (const domain of verified) {
        await tx.insertInto('organization_domains')
          .values({ org_id: ours.id, domain, approved_by: 'workos', verified_at: new Date(), source: 'workos' })
          .onConflict((oc) => oc.columns(['org_id', 'domain']).doUpdateSet({ source: 'workos', verified_at: new Date() })
            .where('organization_domains.source', '=', 'app'))
          .execute();
      }
    }).catch(() => {
      // Another org already holds one of these verified (the partial unique
      // index). WorkOS allows a verified domain on one org only, so this is a
      // stale copy elsewhere that its own next sync will clear.
    });
  }
}

/** The domains verified on each of these orgs, for labelling who arrived by domain. */
export async function verifiedDomains(db: Kysely<DB>, orgIds: readonly string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (orgIds.length === 0) return out;
  const rows = await db.selectFrom('organization_domains').select(['org_id', 'domain'])
    .where('org_id', 'in', orgIds).where('verified_at', 'is not', null).execute();
  for (const r of rows) {
    if (!out.has(r.org_id)) out.set(r.org_id, new Set());
    out.get(r.org_id)!.add(r.domain);
  }
  return out;
}

/**
 * Refresh our copy for the orgs WorkOS routes THIS mailbox's domain to (§11).
 *
 * `syncWorkosDomains` at sign-in covers the orgs someone already belongs to.
 * A newcomer belongs to none, and WorkOS only adds them by domain when they
 * authenticate — so a domain verified in WorkOS after their sign-in would
 * stay invisible to them until they signed in again. Asking WorkOS which orgs
 * carry their domain closes that: onboarding's "check again" finds the org
 * the moment it exists. Public mail domains are never asked about. Never throws.
 */
export async function syncWorkosDomainsFor(db: Kysely<DB>, email: string): Promise<void> {
  const domain = domainOf(email);
  if (!domain || isPublicDomain(domain)) return;
  let ids: string[];
  try { ids = (await listOrganizationsByDomain(domain)).data.map(o => o.id); }
  catch { return; }
  await syncWorkosDomains(db, ids);
}
