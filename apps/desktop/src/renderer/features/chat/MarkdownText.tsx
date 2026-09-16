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
import { Children, Fragment, type ReactNode } from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TextQuote } from '@relayed/icons';
import { ActorAvatar } from '@/components/ActorAvatar';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { cn } from '@/lib/utils';
import { isAnnotationLink } from '../../../shared/annotations.ts';
import { parseSlashCommand } from '../../../shared/slash-commands.ts';
import { spaceLinkTarget } from '../../../shared/spaces.ts';
import { CopyButton } from './CopyButton';
import './markdown.css';

export function MarkdownText({
  text, className, onOpenLink,
}: { text: string; className?: string; onOpenLink?: (url: string) => void }) {
  const slashCommand = parseSlashCommand(text);
  const components: Components = {
    p: ({ node, children }) => (
      <p>
        {slashCommand && node?.position?.start.offset === 0
          ? commandChip(children, `/${slashCommand.name}`)
          : children}
      </p>
    ),
    a: ({ href, children }) => (
      isSemanticMention(href) ? (
        actorLinkId(href)
          ? <ActorMention actorId={actorLinkId(href) ?? ''}>{children}</ActorMention>
          : <span className="md-mention" data-mention-kind="audience">@{children}</span>
      ) :
      // A room in this app: opens it, with no address to show on hover. Drawn
      // as `#name`, the way it was typed and the way a mention is drawn — the
      // sigil is not in the label, so it is added here rather than stored.
      spaceLinkTarget(href) ? (
        <button
          type="button"
          className="md-mention md-mention-button"
          data-mention-kind="space"
          onClick={() => { if (href) onOpenLink?.(href); }}
        >
          #{children}
        </button>
      ) :
      <HoverCard>
        <HoverCardTrigger
          delay={300}
          render={<button type="button" className="md-link" onClick={() => { if (href) onOpenLink?.(href); }} />}
        >
          {/* A passage someone marked reads as an ordinary link, because that is
              what it is (docs/ANNOTATIONS.md). The mark says it is a quotation
              rather than a page — the label is somebody's words, not a title,
              and without it the two are indistinguishable. */}
          {isAnnotationLink(href) && <TextQuote className="md-link-icon" aria-hidden />}
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
        urlTransform={(url) => isSemanticMention(url) || spaceLinkTarget(url) ? url : defaultUrlTransform(url)}
      >
        {text}
      </Markdown>
    </div>
  );
}

/**
 * A person or agent, with their face before the name. The label is the one the
 * author typed, so a rename does not rewrite what was said.
 */
function ActorMention({ actorId, children }: { actorId: string; children: ReactNode }) {
  const label = Children.toArray(children).filter(child => typeof child === 'string').join('');
  return (
    <span className="md-mention md-mention-actor" data-mention-kind="actor">
      <ActorAvatar id={actorId} fallbackName={label} className="md-mention-avatar" fallbackClassName="text-[8px]" />
      {children}
    </span>
  );
}

/** The wire and stored body stay ordinary Markdown; only its leading command token is decorated. */
function commandChip(children: ReactNode, command: string): ReactNode {
  const content = Children.toArray(children);
  const first = content[0];
  if (typeof first !== 'string' || !first.startsWith(command)) return children;
  return (
    <Fragment>
      <span className="md-command">{command}</span>
      {first.slice(command.length)}
      {content.slice(1)}
    </Fragment>
  );
}

const isSemanticMention = (href: string | undefined): href is string =>
  Boolean(href && (actorLinkId(href) !== null || /^audience:(here|chat|channel|room)$/.test(href)));

/**
 * The actor a link names: a mention (`actor:`) or a reference (`actor-ref:`),
 * drawn alike — the difference is only whether it notified anyone, which the
 * server decided when it was sent (`sync/mentions.ts`).
 */
function actorLinkId(href: string): string | null {
  return /^actor(?:-ref)?:(act_[A-Za-z0-9_-]+)$/.exec(href)?.[1] ?? null;
}

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
