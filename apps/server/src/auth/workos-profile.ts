// Fetches a user profile from WorkOS by verified user id.
//
// The client must NOT be trusted for email or display name. Its WorkOS token
// proves `sub` and nothing else, so a modified client could otherwise claim
// someone else's email — which would flow into handle derivation and into what
// every other member sees. The id is verified; the profile is fetched.
import { env } from '../env.ts';

export interface Profile {
  email: string;
  displayName: string;
  avatarUrl: string | null;
}

export async function fetchProfile(workosUserId: string): Promise<Profile> {
  if (!env.workosApiKey) throw new Error('WORKOS_API_KEY required to fetch profiles');
  const res = await fetch(`https://api.workos.com/user_management/users/${workosUserId}`, {
    headers: { authorization: `Bearer ${env.workosApiKey}` },
  });
  if (!res.ok) throw new Error(`profile fetch failed: ${res.status}`);
  const u = await res.json() as Record<string, string | null>;
  const name = [u['first_name'], u['last_name']].filter(Boolean).join(' ');
  return {
    email: u['email'] ?? '',
    displayName: name || u['email'] || 'Unknown',
    avatarUrl: u['profile_picture_url'] ?? null,
  };
}
