// Annotations (docs/ANNOTATIONS.md): a passage someone marked in a web panel,
// carried in a message.
//
// AN ANNOTATION IS AN ORDINARY MARKDOWN LINK, and nothing else:
//
//   [the quoted text](https://page#:~:text=before-,the%20quoted%20text,-after)
//
// The label is the quote a reader sees and an agent reads. The target is the
// page with Chromium's text directive on it, so opening it scrolls to the
// passage and highlights it — the anchor lives IN the address rather than
// beside it.
//
// WHY NOT A MESSAGE PART. It was one, briefly. A part means a schema, a write
// rule, a place in the draft, and a collision with the server's own contract
// that a message says "a body, or parts it is derived from — never both"
// (`sync/ops.ts`): an annotation is neither, because the body is the person's
// own Markdown and the part only describes something inside it. A link needs
// none of that, degrades to a link everywhere that has not heard of
// annotations, and is already carried by every path a message body travels.
import { isWebUrl } from './web-panels.ts';

/** How much text either side of a passage is kept to tell two copies of it apart. */
export const ANCHOR_CHARS = 32;

/** How long a quote gets in a link's label before it is elided in the middle. */
const LABEL_CHARS = 48;

/**
 * A link that is an annotation: a web address carrying a text directive.
 *
 * Decided from the address itself rather than from a scheme of our own, which
 * is the point of the whole design — anything that can produce such a URL
 * produces an annotation, and anything that cannot read one still sees a link
 * to the right page.
 */
export const isAnnotationLink = (href: string | undefined): href is string =>
  href !== undefined && isWebUrl(href) && href.includes(':~:text=');

/**
 * The quote, short enough to sit inside a sentence.
 *
 * Elided in the MIDDLE rather than at the end: the start and the end of a
 * sentence are what tell two quotations from the same page apart, and a run of
 * quotes that all begin the same way is the case a trailing ellipsis loses.
 */
export function annotationLabel(exact: string): string {
  const text = exact.replace(/\s+/g, ' ').trim();
  if (text.length <= LABEL_CHARS) return text;
  const head = Math.ceil((LABEL_CHARS - 1) / 2);
  return `${text.slice(0, head).trimEnd()}…${text.slice(-(LABEL_CHARS - 1 - head)).trimStart()}`;
}

/**
 * Read the selection and the text either side of it, from inside the page.
 *
 * WHY A SCRIPT AT ALL, when capture otherwise runs no code in the page. The
 * `context-menu` event hands over the selected text but not its surroundings,
 * and without them a passage that appears twice always resolves to the first
 * copy. This runs ONCE, at capture — never on the click path, and never as a
 * listener left behind.
 *
 * Bounded to the nearest block rather than the document: the useful context is
 * the sentence around the passage, and building a string of a long page to take
 * 32 characters from either end of it would be absurd.
 *
 * Returns null when the selection is not in the top document — a selection
 * inside an iframe belongs to that frame, and `getSelection()` here cannot see
 * it. The caller then keeps the quote and goes without the anchor, which is the
 * ordinary degraded case rather than a failure.
 */
export const anchorScript = (): string => `(() => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || String(selection).trim() === '') return null;
  const range = selection.getRangeAt(0);
  const tidy = text => text.replace(/\\s+/g, ' ').trim();
  const blockOf = node => {
    let element = node.nodeType === 1 ? node : node.parentElement;
    while (element && element !== document.body) {
      const display = getComputedStyle(element).display;
      if (display === 'block' || display === 'list-item' || display === 'table-cell') return element;
      element = element.parentElement;
    }
    return document.body;
  };
  const before = document.createRange();
  before.selectNodeContents(blockOf(range.startContainer));
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.selectNodeContents(blockOf(range.endContainer));
  after.setStart(range.endContainer, range.endOffset);
  return {
    exact: tidy(String(selection)),
    prefix: tidy(before.toString()).slice(-${ANCHOR_CHARS}),
    suffix: tidy(after.toString()).slice(0, ${ANCHOR_CHARS}),
  };
})()`;

/** What `anchorScript` returns, once it has been checked. */
export interface ReadAnchor {
  exact: string;
  prefix: string;
  suffix: string;
}

/** The anchor a page reported, or null for anything that is not one. Page output is never trusted. */
export function readAnchor(value: unknown): ReadAnchor | null {
  if (typeof value !== 'object' || value === null) return null;
  const { exact, prefix, suffix } = value as Record<string, unknown>;
  if (typeof exact !== 'string' || exact.trim() === '') return null;
  return {
    exact,
    prefix: typeof prefix === 'string' ? prefix.slice(-ANCHOR_CHARS) : '',
    suffix: typeof suffix === 'string' ? suffix.slice(0, ANCHOR_CHARS) : '',
  };
}
