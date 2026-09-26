// Fetches a user profile from WorkOS by verified user id.
//
// The client must NOT be trusted for email or display name. Its WorkOS token
// proves `sub` and nothing else, so a modified client could otherwise claim
// someone else's email — which would flow into handle derivation and into what
// every other member sees. The id is verified; the profile is fetched.
import { env } from '../env.ts';

export interface Profile {
  email: string;
  /**
   * Whether WorkOS has confirmed the mailbox. Joining a company's org by its
   * email domain rests on this and on nothing else (ORG-DOMAINS.md §4.1), so an
   * absent field reads as false.
   */
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string | null;
}

export async function fetchProfile(workosUserId: string): Promise<Profile> {
  if (!env.workosApiKey) throw new Error('WORKOS_API_KEY required to fetch profiles');
  const res = await fetch(`https://api.workos.com/user_management/users/${workosUserId}`, {
    headers: { authorization: `Bearer ${env.workosApiKey}` },
  });
  if (!res.ok) throw new Error(`profile fetch failed: ${res.status}`);
  const u = await res.json() as Record<string, string | boolean | null>;
  const str = (k: string) => (typeof u[k] === 'string' ? u[k] as string : null);
  const name = [str('first_name'), str('last_name')].filter(Boolean).join(' ');
  return {
    email: str('email') ?? '',
    emailVerified: u['email_verified'] === true,
    displayName: name || str('email') || 'Unknown',
    avatarUrl: str('profile_picture_url'),
  };
}
