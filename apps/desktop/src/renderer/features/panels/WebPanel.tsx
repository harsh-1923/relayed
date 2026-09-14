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
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowLeft, ArrowRight, Globe, Refresh, StopSmall } from '@relayed/icons';
import type { Panel } from '../../../preload/api';
import { useSession } from '@/app/state';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { addressFromTyped, isWebUrl, webPanelPartition } from '../../../shared/web-panels.ts';

/** The methods of Electron's `<webview>` this panel uses. Callable only once `dom-ready` has fired. */
interface WebviewElement extends HTMLElement {
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
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

/** Chromium's "aborted": a load replaced by another, which is not a failure anyone should see. */
const ERR_ABORTED = -3;

/**
 * Parsed by react-dom as an unknown attribute, so it must be the string: a
 * boolean is dropped. Popups are allowed through so a link that opens a window
 * reaches main, which sends it to the system browser rather than losing it.
 */
const ALLOW_POPUPS = { allowpopups: 'true' } as unknown as { allowpopups?: boolean };

export function WebPanel({ panel, shown }: { panel: Panel; shown: boolean }) {
  const { state: session } = useSession();
  const url = typeof panel.payload['url'] === 'string' ? panel.payload['url'] : '';
  // Read once: changing a webview's `src` navigates it, and the page moves on from where it started.
  const [src] = useState(url);
  const view = useRef<HTMLWebViewElement>(null);
  const [page, setPage] = useState<PageState>({ url, loading: true, canGoBack: false, canGoForward: false, failure: null });
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

    const updates = ['did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'];
    element.addEventListener('dom-ready', onReady);
    element.addEventListener('did-start-loading', onStart);
    element.addEventListener('did-fail-load', onFail);
    element.addEventListener('render-process-gone', onGone);
    for (const name of updates) element.addEventListener(name, read);
    return () => {
      element.removeEventListener('dom-ready', onReady);
      element.removeEventListener('did-start-loading', onStart);
      element.removeEventListener('did-fail-load', onFail);
      element.removeEventListener('render-process-gone', onGone);
      for (const name of updates) element.removeEventListener(name, read);
    };
  }, [session.accountId, drawable]);

  const element = (): WebviewElement | null => view.current as WebviewElement | null;
  /** Throws synchronously before `dom-ready`, and rejects on a failed load, which `did-fail-load` already shows. */
  const load = (address: string): void => {
    try { void element()?.loadURL(address).catch(() => {}); } catch { /* not attached yet */ }
  };
  const retry = (): void => {
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
        <Button variant="ghost" size="icon-xs" aria-label="Back" title="Back" disabled={!page.canGoBack} onClick={() => element()?.goBack()}>
          <ArrowLeft />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Forward" title="Forward" disabled={!page.canGoForward} onClick={() => element()?.goForward()}>
          <ArrowRight />
        </Button>
        {page.loading ? (
          <Button variant="ghost" size="icon-xs" aria-label="Stop loading" title="Stop loading" disabled={!drawable} onClick={() => element()?.stop()}>
            <StopSmall />
          </Button>
        ) : (
          <Button variant="ghost" size="icon-xs" aria-label="Reload" title="Reload" disabled={!drawable} onClick={retry}>
            <Refresh />
          </Button>
        )}
        <AddressBar
          url={page.url}
          disabled={!drawable}
          onGo={address => {
            // A failure message would otherwise stay over the page being loaded.
            setPage(previous => ({ ...previous, failure: null }));
            load(address);
          }}
        />
      </div>
      <div className="relative min-h-0 flex-1">
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
        {page.failure && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background p-6 text-center">
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
function AddressBar({ url, disabled, onGo }: { url: string; disabled: boolean; onGo: (address: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);

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
