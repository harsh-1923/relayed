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

// ─── Annotations: going back to a passage (docs/ANNOTATIONS.md) ──────────────

/** What an annotation stores about where its passage is: the W3C TextQuoteSelector triple. */
export interface TextAnchor {
  exact: string;
  prefix?: string | undefined;
  suffix?: string | undefined;
}

/** The marker that begins a fragment directive, and hides the rest of the fragment from the page. */
const FRAGMENT_DIRECTIVE = ':~:';

/**
 * Longest one term of a directive gets before a range is named by its two ends.
 *
 * Not a guess about matching — the whole quote would match — but about the
 * address: an annotation's quote runs to a thousand characters, which
 * percent-encoded is a URL no browser should be handed.
 */
const MAX_TERM_CHARS = 120;

/**
 * Text as a directive term.
 *
 * `,` and `&` are the directive's own separators and `-` is half of the
 * prefix and suffix markers (`-,` and `,-`), so all three are percent-encoded
 * rather than left to be read as syntax. `encodeURIComponent` already does `,`
 * `&` and `%`; it leaves `-` alone, because a hyphen is unreserved in a URL and
 * only this grammar cares.
 */
const term = (text: string): string => encodeURIComponent(text).replaceAll('-', '%2D');

/**
 * Whitespace as the browser compares it.
 *
 * A selection that crosses a paragraph carries the newline between them, and the
 * directive matches against text the browser has already collapsed — so a quote
 * kept exactly as selected would fail to match the page it came from.
 */
const collapse = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The first whole words of `text` within the cap, and the last. */
function ends(text: string): [string, string] {
  const head = text.slice(0, MAX_TERM_CHARS);
  const tail = text.slice(-MAX_TERM_CHARS);
  const headCut = head.lastIndexOf(' ');
  const tailCut = tail.indexOf(' ');
  return [
    headCut > 0 ? head.slice(0, headCut) : head,
    tailCut >= 0 ? tail.slice(tailCut + 1) : tail,
  ];
}

/**
 * Where an annotation points, as an address: the page, plus Chromium's text
 * directive so it opens scrolled to the passage and highlights it.
 *
 * `[prefix-,]textStart[,textEnd][,-suffix]` — the same three fields the
 * annotation stores, which is why they are stored in that shape
 * (`packages/protocol`'s `AnnotationPart`). Proven to scroll in a panel, in
 * `spikes/text-fragments` (`pnpm verify:text-fragments`), including for a page
 * already open and without reloading it.
 *
 * A quote too long to put in an address is named by its **two ends**, which is
 * the grammar's own answer: the browser then matches everything between them,
 * so the whole passage is still highlighted.
 */
export function annotationAddress(url: string, anchor: TextAnchor): string {
  const exact = collapse(anchor.exact);
  if (exact === '') return url;
  const quoted = exact.length <= MAX_TERM_CHARS * 2
    ? term(exact)
    : ends(exact).map(term).join(',');
  const prefix = collapse(anchor.prefix ?? '');
  const suffix = collapse(anchor.suffix ?? '');
  const directive = `text=${prefix ? `${term(prefix)}-,` : ''}${quoted}${suffix ? `,-${term(suffix)}` : ''}`;
  // A page may already carry a fragment of its own, and the directive goes
  // after it inside the SAME fragment — one `#`, then `:~:`. Everything from
  // `:~:` on is the browser's and is hidden from the page, so `#section-3`
  // still takes the reader to that section.
  //
  // The `#` is decided from the base rather than from `url`: re-anchoring an
  // address that already carries a directive strips it, and with it the only
  // `#` there was.
  const base = withoutFragmentDirective(url);
  return `${base}${base.includes('#') ? '' : '#'}${FRAGMENT_DIRECTIVE}${directive}`;
}

/**
 * An address without its fragment directive, which is what a person should be
 * shown.
 *
 * Main's `getURL()` KEEPS `#:~:text=…` while the page's own `location.href` has
 * it stripped (`spikes/text-fragments`). The address bar reads `getURL()`, so
 * without this it shows the machinery that got the reader to the passage.
 */
export function withoutFragmentDirective(url: string): string {
  const at = url.indexOf(FRAGMENT_DIRECTIVE);
  if (at < 0) return url;
  // `#:~:…` leaves a bare `#`, which is noise rather than a fragment.
  return url.slice(0, at).replace(/#$/, '');
}
