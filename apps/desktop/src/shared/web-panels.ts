// Web pages inside panels (docs/PANELS.md, web pages): the rules the window and
// main both apply to them.

/** A page a panel may show, or navigate to: http and https, nothing else. */
export function isWebUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;

/**
 * Where what a person typed into an address bar goes, or null for nothing.
 * A bare host is what people type: a dev server on this machine speaks http,
 * anything else is assumed to be https. Text that is not an address — no dot,
 * or a space in it — is a search. A scheme other than http or https stays
 * as typed, so the caller can refuse it rather than silently searching for it.
 */
export function addressFromTyped(typed: string): string | null {
  const text = typed.trim();
  if (text === '') return null;
  if (HAS_SCHEME.test(text)) return text;
  const looksLikeHost = !/\s/.test(text) && (LOOPBACK.test(text) || /^[^/?#]+\.[^/?#]+/.test(text));
  if (looksLikeHost) return `${LOOPBACK.test(text) ? 'http' : 'https'}://${text}`;
  return `https://www.google.com/search?q=${encodeURIComponent(text)}`;
}

/**
 * The browser session an account's pages share: their cookies and logins, apart
 * from the app's own origin and from every other account's. `persist:` keeps a
 * login across restarts.
 */
export const webPanelPartition = (accountId: string): string => `persist:panels:${accountId}`;
