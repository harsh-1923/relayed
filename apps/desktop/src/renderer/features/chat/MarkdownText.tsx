// Message text, as Markdown — a person's and an agent's alike.
//
// react-markdown rather than a streaming-specific renderer, deliberately: its
// defaults are the safe ones (no raw HTML, safe URL protocols), where the
// streaming renderers weighed start permissive and would be overridden almost
// entirely. Half-written Markdown while a reply streams is a phase-5 concern,
// and `remend` handles it on its own when that lands.
//
// Sizing, spacing and colour live in markdown.css rather than on the elements:
// the space above a block depends on what precedes it, which only a sibling
// selector can say.
//
// Two elements are never drawn as the browser would draw them:
//   - LINKS are buttons. There is no navigation guard in the main process yet, so
//     a real `<a href>` in this window would load the page into the app itself.
//     Where a link goes is the caller's decision, through `onOpenLink`. Hovering
//     one shows the whole address, with a copy button.
//   - IMAGES are their description. The CSP allows no remote image, and a
//     network fetch from message content is the tracking this app does not do.
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { cn } from '@/lib/utils';
import { CopyButton } from './CopyButton';
import './markdown.css';

export function MarkdownText({
  text, className, onOpenLink,
}: { text: string; className?: string; onOpenLink?: (url: string) => void }) {
  const components: Components = {
    a: ({ href, children }) => (
      isSemanticMention(href) ? (
        <span className="md-mention" data-mention-kind={href.startsWith('actor:') ? 'actor' : 'audience'}>
          @{children}
        </span>
      ) :
      <HoverCard>
        <HoverCardTrigger
          delay={300}
          render={<button type="button" className="md-link" onClick={() => { if (href) onOpenLink?.(href); }} />}
        >
          {href && isBareUrl(children, href) ? shortUrl(href) : children}
        </HoverCardTrigger>
        {/* Where it goes, in full: the text on screen is a title or a shortened
            address, and a link should never hide its destination. */}
        {href && (
          <HoverCardContent side="top" align="start" className="flex w-auto max-w-sm items-center gap-2 py-1.5 pr-1.5">
            <span className="min-w-0 font-mono text-xs break-all select-text">{href}</span>
            <CopyButton text={href} label="Copy link" />
          </HoverCardContent>
        )}
      </HoverCard>
    ),
    table: ({ children }) => <div className="md-table"><table>{children}</table></div>,
    img: ({ alt, src }) => (
      <span className="opacity-70" title={src}>[image{alt ? `: ${alt}` : ''}]</span>
    ),
  };

  return (
    <div className={cn('markdown', className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={components}
        urlTransform={(url) => isSemanticMention(url) ? url : defaultUrlTransform(url)}
      >
        {text}
      </Markdown>
    </div>
  );
}

const isSemanticMention = (href: string | undefined): href is string =>
  Boolean(href && (/^actor:act_[A-Za-z0-9_-]+$/.test(href) || /^audience:(here|chat|channel|room)$/.test(href)));

/** A bare URL, autolinked by GFM: its text is the address itself. */
const isBareUrl = (children: React.ReactNode, href: string): boolean =>
  typeof children === 'string' && (children === href || `https://${children}` === href || `http://${children}` === href);

/**
 * A bare URL as the reader needs it: the site and the page, without the scheme,
 * `www.`, the query or a trailing slash. The whole address is the link's title.
 */
function shortUrl(href: string): string {
  try {
    const url = new URL(href);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}`;
  } catch {
    return href;
  }
}
