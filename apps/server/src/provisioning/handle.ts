// Handle derivation and validation (PHASE-1-IDENTITY.md §10).
//
// Handles are a convenience, not an identity: mentions store actor_id, so a
// collision is a display problem rather than a correctness one. That is why
// this offers *candidates* for a human to choose from and never silently
// assigns one.

export const RESERVED = new Set([
  'everyone', 'here', 'channel', 'all', 'admin', 'system', 'relayed',
  'support', 'help', 'root', 'me', 'you',
]);

const MIN = 3, MAX = 30;

export type HandleError = 'too_short' | 'too_long' | 'bad_start' | 'bad_chars' | 'reserved';

export function validateHandle(raw: string): HandleError | null {
  const h = raw.toLowerCase();
  // Reserved FIRST, so a reserved word reports the accurate reason regardless
  // of length. `me` is currently unclaimable only because it is two characters
  // — incidental protection that would evaporate if MIN ever changed.
  if (RESERVED.has(h)) return 'reserved';
  if (h.length < MIN) return 'too_short';
  if (h.length > MAX) return 'too_long';
  if (!/^[a-z]/.test(h)) return 'bad_start';
  if (!/^[a-z0-9._-]+$/.test(h)) return 'bad_chars';
  return null;
}

const clean = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9._-]/g, '').replace(/^[^a-z]+/, '');

/**
 * Candidates derived from the email local-part and display name, in the order
 * a person would most likely want them.
 *
 * Deliberately NOT numeric suffixes: `@harsh2` is a poor first impression and
 * is exactly what a flow produces when it declines to ask (§10). If every
 * candidate is taken the caller prompts rather than inventing one.
 */
export function handleCandidates(email: string, displayName?: string): string[] {
  const local = clean(email.split('@')[0] ?? '');
  const parts = (displayName ?? '').split(/\s+/).map(clean).filter(Boolean);
  const [first, last] = [parts[0] ?? '', parts.at(-1) ?? ''];

  const out = [
    local,
    first,
    first && last && first !== last ? `${first}.${last}` : '',
    first && last && first !== last ? `${first[0]}${last}` : '',
    first && last && first !== last ? `${first}${last[0]}` : '',
    local.replace(/[._-].*$/, ''),
  ];
  return [...new Set(out.filter(h => h && validateHandle(h) === null))];
}
