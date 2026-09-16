// A web page in a panel (PANELS.md, web pages).
//
// A `<webview>` in this DOM: CSS sizes it, and menus and dialogs draw over it
// like over anything else. Main checks every attach and decides what the page
// may do (main/web-panels.ts); this component only shows it and drives its
// back, forward and reload.
//
// A webview unmounted or moved to another parent loads its page again, so the
// container keeps every open page mounted and parks the ones not shown out of
// sight rather than hiding them. Parked, not `visibility: hidden`: t3code found
// Electron can leave a macOS webview blank for good after that.
import { useEffect, useRef, useState, type ComponentProps, type FormEvent } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, ExternalLink, Globe, Refresh, Spinner } from '@relayed/icons';
import type { Panel } from '../../../preload/api';
import { useSession } from '@/app/state';
import { bridge, call } from '@/lib/ipc';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  addressFromTyped, annotationAddress, isWebUrl, webPanelPartition, withoutFragmentDirective,
} from '../../../shared/web-panels.ts';
import { markAnnotation } from '@/lib/pending-annotations';
import { openLink, usePanelPointer } from '@/lib/panel-navigation';
import { annotationLabel, anchorScript, readAnchor } from '../../../shared/annotations.ts';

/** The methods of Electron's `<webview>` this panel uses. Callable only once `dom-ready` has fired. */
interface WebviewElement extends HTMLElement {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getWebContentsId(): number;
  getTitle(): string;
  isLoading(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
}

interface DidFailLoad extends Event {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  isMainFrame: boolean;
}

interface PageState {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** Why the page could not be shown, and the address that failed; null while it is fine. */
  failure: { reason: string; url: string } | null;
}

/**
 * What Chromium reports about a right-click, and the whole of how a passage is
 * captured (docs/ANNOTATIONS.md, capture).
 *
 * NOTHING RUNS IN THE PAGE for this. The selection, the address it came from
 * and where it was clicked all arrive on the event, so marking a passage costs
 * none of the attach guard that keeps this app's code out of a page holding
 * somebody's logins (`main/web-panels.ts`).
 *
 * `x` and `y` are **WINDOW** coordinates, not the webview's, however much they
 * look like the latter. A panel on the right of a split is offset by hundreds
 * of pixels, so a menu placed inside the panel straight from these lands well
 * outside it and is never seen — which is indistinguishable from the event not
 * firing at all. They are converted against the surface's own rect, an
 * invariant `spikes/text-fragments` measures and then asserts both halves of.
 */
interface ContextMenuParams {
  x: number;
  y: number;
  selectionText: string;
  pageURL: string;
  frameURL: string;
}

/**
 * NESTED UNDER `params`, unlike every other webview event this file reads.
 *
 * `did-fail-load` and `page-title-updated` carry their fields directly on the
 * DOM event, and `context-menu` looks like it should too. It does not: the
 * event itself has none of them, and reading `event.selectionText` yields
 * `undefined` — which, trimmed, is an empty selection, so the menu silently
 * never opened on any page. Measured in `spikes/text-fragments`
 * (`pnpm verify:text-fragments`), which now asserts the nesting so an Electron
 * upgrade that flattens it fails a check rather than the feature.
 */
interface ContextMenuEvent extends Event {
  params?: ContextMenuParams;
}

/** A right-click worth drawing a menu for: where it was, and what was under it. */
interface PageMenu {
  x: number;
  y: number;
  selection: string;
  url: string;
}

/** The menu's own size, to keep it inside the panel. `min-w-44` is 176px; one row is about 30. */
const MENU_WIDTH = 176;
const MENU_HEIGHT = 34;

/**
 * Read a page's icon from inside the page, as a `data:` URL.
 *
 * Inside, because that is where the icon is reachable: the page's own session
 * and cookies, and the cache it just loaded it into — so an icon behind a
 * login, or on a page opened offline from cache, still resolves. The renderer
 * could not fetch it itself (its CSP allows no remote images, on purpose). An
 * icon on another origin that does not allow CORS fails here, and the tab keeps
 * the globe. Whatever comes back is the page's to say, so sync checks it.
 */
const readIconScript = (href: string): string => `(async () => {
  const href = ${JSON.stringify(href)};
  if (href.startsWith('data:')) return href;
  const response = await fetch(href);
  if (!response.ok) return null;
  let blob = await response.blob();
  if (blob.size === 0 || blob.size > ${256 * 1024}) return null;
  if (!blob.type.startsWith('image/')) blob = new Blob([blob], { type: 'image/x-icon' });
  return await new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
})().catch(() => null)`;

interface FaviconUpdated extends Event { favicons: string[] }
interface TitleUpdated extends Event { title: string }

/** Chromium's "aborted": a load replaced by another, which is not a failure anyone should see. */
const ERR_ABORTED = -3;

/**
 * Parsed by react-dom as an unknown attribute, so it must be the string: a
 * boolean is dropped. Popups are allowed through so a link that opens a window
 * reaches main, which sends it to the system browser rather than losing it.
 */
const ALLOW_POPUPS = { allowpopups: 'true' } as unknown as { allowpopups?: boolean };

/** An icon-only browser control whose visible label works with a mouse or keyboard. */
export function UrlBarButton({ label, disabled = false, ...props }: {
  label: string;
} & Omit<ComponentProps<typeof Button>, 'aria-label' | 'title'>) {
  const button = <Button {...props} disabled={disabled} aria-label={label} />;

  return (
    <Tooltip>
      {disabled ? (
        // A disabled button receives no pointer events, so its wrapper owns the
        // hover target while the button keeps its native disabled semantics.
        <TooltipTrigger delay={300} render={<span className="inline-flex" />}>
          {button}
        </TooltipTrigger>
      ) : (
        <TooltipTrigger delay={300} render={button} />
      )}
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function WebPanel({ panel, shown }: { panel: Panel; shown: boolean }) {
  const { state: session } = useSession();
  const url = typeof panel.payload['url'] === 'string' ? panel.payload['url'] : '';
  // Read once: changing a webview's `src` navigates it, and the page moves on from where it started.
  const [src] = useState(url);
  const view = useRef<HTMLWebViewElement>(null);
  const [page, setPage] = useState<PageState>({ url, loading: true, canGoBack: false, canGoForward: false, failure: null });
  const [menu, setMenu] = useState<PageMenu | null>(null);
  /** The box the page and the menu share, and what window coordinates are measured against. */
  const surface = useRef<HTMLDivElement>(null);
  const drawable = session.accountId !== null && isWebUrl(src);

  useEffect(() => {
    const element = view.current as WebviewElement | null;
    if (!element) return;
    let ready = false;
    const read = (): void => {
      if (!ready) return;
      setPage(previous => ({
        ...previous,
        url: element.getURL() || previous.url,
        loading: element.isLoading(),
        canGoBack: element.canGoBack(),
        canGoForward: element.canGoForward(),
      }));
    };
    const onReady = (): void => { ready = true; read(); };
    const onStart = (): void => { setPage(previous => ({ ...previous, loading: true, failure: null })); };
    const onFail = (event: Event): void => {
      const { errorCode, errorDescription, validatedURL, isMainFrame } = event as DidFailLoad;
      if (!isMainFrame || errorCode === ERR_ABORTED) return;
      setPage(previous => ({ ...previous, failure: { reason: errorDescription || 'The page could not be loaded.', url: validatedURL || previous.url } }));
    };
    const onGone = (): void => {
      setPage(previous => ({ ...previous, failure: { reason: 'The page stopped responding.', url: previous.url } }));
    };

    // What this device learned about the page, kept with the panel so its tab
    // draws the title and icon before the page loads again (PANELS.md).
    const report = (fields: { pageTitle?: string; icon?: string }): void => {
      void call(api => api.query('local.panels.reportMeta', { panelId: panel.id, spaceId: panel.spaceId, ...fields }));
    };
    const onTitle = (event: Event): void => { report({ pageTitle: (event as TitleUpdated).title }); };
    const onFavicon = (event: Event): void => {
      const href = (event as FaviconUpdated).favicons.find(candidate => !/\.svg(?:$|[?#])/i.test(candidate));
      if (!href) return;
      void element.executeJavaScript(readIconScript(href))
        .then(icon => { if (typeof icon === 'string') report({ icon }); })
        .catch(() => { /* the page went away mid-read; the next load reports again */ });
    };

    // Electron draws no menu of its own in a webview, so until now a right-click
    // in a panel did nothing at all. This is the only one there is.
    const onContextMenu = (event: Event): void => {
      const params = (event as ContextMenuEvent).params;
      if (!params) return setMenu(null);
      const selection = (params.selectionText ?? '').trim();
      // Nothing to cite, so nothing to offer. A menu with only disabled items
      // is worse than the silence it replaces.
      if (selection === '') return setMenu(null);
      // Window coordinates into surface coordinates. Read at the click rather
      // than at render: the split can be dragged, and the rect then means
      // something different from what it meant when the menu opened.
      const box = surface.current?.getBoundingClientRect();
      // Kept inside the panel: a right-click near its right or bottom edge
      // would otherwise put the menu over the rest of the app, or past it.
      const within = (point: number, extent: number, size: number): number =>
        Math.max(4, Math.min(point, extent - size - 4));
      setMenu({
        x: within(params.x - (box?.left ?? 0), box?.width ?? 0, MENU_WIDTH),
        y: within(params.y - (box?.top ?? 0), box?.height ?? 0, MENU_HEIGHT),
        selection,
        // The FRAME's address, not the page's: a passage inside an embedded
        // document belongs to that document, and it is the one a text
        // directive would have to match.
        url: params.frameURL || params.pageURL || element.getURL(),
      });
    };

    /** A page that moves under an open menu leaves it pointing at nothing. */
    const closeMenu = (): void => { setMenu(null); };

    const updates = ['did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'];
    const closers = ['did-start-loading', 'did-navigate', 'did-navigate-in-page'];
    element.addEventListener('context-menu', onContextMenu);
    for (const name of closers) element.addEventListener(name, closeMenu);
    element.addEventListener('dom-ready', onReady);
    element.addEventListener('did-start-loading', onStart);
    element.addEventListener('did-fail-load', onFail);
    element.addEventListener('render-process-gone', onGone);
    element.addEventListener('page-title-updated', onTitle);
    element.addEventListener('page-favicon-updated', onFavicon);
    for (const name of updates) element.addEventListener(name, read);
    return () => {
      element.removeEventListener('context-menu', onContextMenu);
      for (const name of closers) element.removeEventListener(name, closeMenu);
      element.removeEventListener('dom-ready', onReady);
      element.removeEventListener('did-start-loading', onStart);
      element.removeEventListener('did-fail-load', onFail);
      element.removeEventListener('render-process-gone', onGone);
      element.removeEventListener('page-title-updated', onTitle);
      element.removeEventListener('page-favicon-updated', onFavicon);
      for (const name of updates) element.removeEventListener(name, read);
    };
  }, [session.accountId, drawable, panel.id, panel.spaceId]);

  const element = (): WebviewElement | null => view.current as WebviewElement | null;
  /** Throws synchronously before `dom-ready`, and rejects on a failed load, which `did-fail-load` already shows. */
  const load = (address: string): void => {
    try { void element()?.loadURL(address).catch(() => {}); } catch { /* not attached yet */ }
  };
  // Sent back to a passage while already open (docs/ANNOTATIONS.md). Only the
  // fragment changes, so the document survives and the page simply moves.
  usePanelPointer(panel.id, address => {
    setPage(previous => ({ ...previous, failure: null }));
    load(address);
  });

  // A link in this page that wants a tab: main says which page it came from,
  // and only this panel's page is this panel's to pass on to the room.
  useEffect(() => bridge()?.onWebPanelOpen(request => {
    let own: number | null = null;
    try { own = element()?.getWebContentsId() ?? null; } catch { /* not attached yet */ }
    if (own === request.webContentsId) openLink(panel.spaceId, { address: request.url, background: request.background });
  }), [panel.spaceId]);

  const retry = (): void => {
    setPage(previous => ({ ...previous, loading: true, failure: null }));
    const failed = page.failure;
    if (failed) load(failed.url);
    else element()?.reload();
  };

  return (
    <div
      className={cn('flex min-h-0 flex-1 flex-col', !shown && 'pointer-events-none absolute top-0 left-[-100000px] h-full w-full')}
      aria-hidden={!shown || undefined}
      inert={!shown}
    >
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border/60 px-1.5">
        <UrlBarButton label="Back" variant="ghost" size="icon-xs" disabled={!page.canGoBack} onClick={() => element()?.goBack()}>
          <ArrowLeft />
        </UrlBarButton>
        <UrlBarButton label="Forward" variant="ghost" size="icon-xs" disabled={!page.canGoForward} onClick={() => element()?.goForward()}>
          <ArrowRight />
        </UrlBarButton>
        {page.loading ? (
          <UrlBarButton label="Loading" variant="ghost" size="icon-xs" disabled>
            <span className="flex animate-spin" aria-hidden="true">
              <Spinner />
            </span>
          </UrlBarButton>
        ) : (
          <UrlBarButton label="Reload" variant="ghost" size="icon-xs" disabled={!drawable} onClick={retry}>
            <Refresh />
          </UrlBarButton>
        )}
        <AddressBar
          // Never the directive: it is how the reader got to the passage, not
          // where they are (docs/ANNOTATIONS.md, §7.2).
          url={withoutFragmentDirective(page.url)}
          disabled={!drawable}
          onGo={address => {
            // A failure message would otherwise stay over the page being loaded.
            setPage(previous => ({ ...previous, failure: null }));
            load(address);
          }}
        />
        <UrlBarButton
          label="Open in browser" variant="ghost" size="icon-xs"
          disabled={!isWebUrl(page.url)}
          onClick={() => { void call(api => api.query('web.openExternal', { url: withoutFragmentDirective(page.url) })); }}
        >
          <ExternalLink />
        </UrlBarButton>
      </div>
      <div ref={surface} className="relative min-h-0 flex-1">
        {drawable && session.accountId ? (
          <webview
            // A different account is a different session, which a webview takes only when it attaches.
            key={session.accountId}
            ref={view}
            src={src}
            partition={webPanelPartition(session.accountId)}
            {...ALLOW_POPUPS}
            className="absolute inset-0 flex size-full bg-white"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <Globe className="size-6 text-muted-foreground" />
            <p className="max-w-full truncate text-sm font-medium select-text" title={url}>{url}</p>
            <p className="text-xs text-muted-foreground">This panel does not point at a web page.</p>
          </div>
        )}
        {menu && (
          // The backdrop is what dismisses it: a click inside the page belongs
          // to another process and never reaches this window, so there is no
          // outside-click to listen for without covering the page first.
          <div
            className="absolute inset-0 z-10"
            onMouseDown={() => setMenu(null)}
            onContextMenu={event => { event.preventDefault(); setMenu(null); }}
          >
            <div
              className="absolute min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
              style={{ left: menu.x, top: menu.y }}
              onMouseDown={event => event.stopPropagation()}
            >
              <button
                type="button"
                className="flex w-full items-center rounded-sm px-2 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                onClick={() => {
                  const selection = menu.selection;
                  const page = menu.url;
                  // The anchor is read from the page, and the page may refuse
                  // to answer — a selection inside an iframe, or one that went
                  // away. The quote is kept either way: without an anchor the
                  // link lands on the first copy of its text, which is worse
                  // than exact and much better than nothing.
                  void element()?.executeJavaScript(anchorScript())
                    .then(readAnchor)
                    .catch(() => null)
                    .then(anchor => {
                      const exact = anchor?.exact ?? selection;
                      markAnnotation(panel.spaceId, {
                        label: annotationLabel(exact),
                        address: annotationAddress(page, {
                          exact,
                          ...(anchor?.prefix ? { prefix: anchor.prefix } : {}),
                          ...(anchor?.suffix ? { suffix: anchor.suffix } : {}),
                        }),
                      });
                    });
                  setMenu(null);
                }}
              >
                Add to message
              </button>
            </div>
          </div>
        )}
        {page.failure && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-background p-6 text-center">
            <AlertTriangle className="size-6 text-muted-foreground" />
            <p className="max-w-full truncate text-sm font-medium select-text" title={page.failure.url}>{page.failure.url}</p>
            <p className="text-xs text-muted-foreground">{page.failure.reason}</p>
            <Button variant="outline" size="xs" onClick={retry}>Try again</Button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Where the page is, and where to take it. Shows the page's address until the
 * person starts typing, then what they typed until Enter or Escape: a page that
 * navigates on its own must not overwrite an address half typed. Anything the
 * web panel may show can be typed; another scheme is refused here as main would
 * refuse it anyway.
 */
export function AddressBar({ url, disabled, onGo, focusRequest }: {
  url: string; disabled: boolean; onGo: (address: string) => void;
  /** Focus the bar on mount and whenever this changes; absent, the bar waits to be clicked. */
  focusRequest?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusRequest !== undefined) input.current?.focus();
  }, [focusRequest]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const address = addressFromTyped(draft ?? url);
    if (!address) return;
    if (!isWebUrl(address)) { setInvalid(true); return; }
    setDraft(null);
    setInvalid(false);
    input.current?.blur();
    onGo(address);
  };

  return (
    <form onSubmit={submit} className="min-w-0 flex-1 px-1">
      <input
        ref={input}
        type="text"
        aria-label="Address"
        aria-invalid={invalid || undefined}
        title={invalid ? 'Only http and https pages open here.' : url}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        disabled={disabled}
        value={draft ?? url}
        onChange={event => { setDraft(event.target.value); setInvalid(false); }}
        onFocus={event => event.target.select()}
        onBlur={() => { setDraft(null); setInvalid(false); }}
        onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); input.current?.blur(); } }}
        className={cn(
          'h-6 w-full min-w-0 truncate rounded-md border border-transparent bg-muted/50 px-2 text-xs text-muted-foreground outline-none transition-colors',
          'hover:bg-muted focus:border-ring focus:bg-background focus:text-foreground aria-invalid:border-destructive disabled:opacity-50',
        )}
      />
    </form>
  );
}
