// Signing web panels in from a browser already on this Mac (docs/PANELS.md,
// browser import). What the settings screen and main agree on.
//
// Only cookies come over: they carry the signed-in sessions, which is what makes
// a page open already signed in. Saved passwords are out of scope — Electron has
// nowhere to put them. The copy is one-time: signing in or out later in either
// browser does not reach the other.

export const BROWSER_IMPORT_SOURCE_IDS = [
  'chrome', 'arc', 'brave', 'edge', 'vivaldi', 'opera', 'helium', 'firefox', 'safari',
] as const;
export type BrowserImportSourceId = typeof BROWSER_IMPORT_SOURCE_IDS[number];

export const isBrowserImportSourceId = (value: unknown): value is BrowserImportSourceId =>
  typeof value === 'string' && (BROWSER_IMPORT_SOURCE_IDS as readonly string[]).includes(value);

/**
 * Why a source cannot be imported now. Some the person can fix — quit the
 * browser, grant access — and one they cannot, and the screen says which.
 */
export type BrowserImportUnavailable =
  | 'notInstalled' | 'browserRunning' | 'needsFullDiskAccess' | 'unsupportedPlatform';

/** Why an import that was attempted did not happen. */
export type BrowserImportFailure =
  | BrowserImportUnavailable
  | 'needsKeychainApproval' | 'keychainItemMissing' | 'keychainUnavailable'
  | 'unknownSource' | 'unknownProfile' | 'noAccount' | 'readFailed';

export interface BrowserImportProfile {
  /** The source's own name for its profile directory. Echoed back to import it, and checked against a fresh listing then. */
  directory: string;
  name: string;
  /** Counted without decrypting anything; absent when the store could not be read. */
  cookieCount?: number;
}

export interface BrowserImportSource {
  id: BrowserImportSourceId;
  name: string;
  profiles: BrowserImportProfile[];
  /** Absent when it can be imported. */
  unavailable?: BrowserImportUnavailable;
  /**
   * Whether the running browser can be offered a quit — true only when its own
   * lock named a live process we could resolve to an application. Firefox keeps
   * no pid in its lock, so the screen offers it nothing it cannot deliver.
   */
  canQuit?: boolean;
}

/**
 * What came of asking a browser to quit. `refused` is the ordinary failure: a
 * page with unsaved work raises its own dialog and the browser stays open, which
 * is the browser working correctly rather than an error.
 */
export type BrowserImportQuitOutcome = 'quit' | 'refused' | 'cannotIdentify';

export const BROWSER_IMPORT_QUIT_COPY: Record<BrowserImportQuitOutcome, string> = {
  quit: '',
  refused: 'The browser is still open — it may be asking you about unsaved work.',
  cannotIdentify: 'Could not tell which application to quit. Quit it yourself, then check again.',
};

export type BrowserImportResult =
  | {
    ok: true;
    imported: number;
    /** Read but not written: expired, malformed, or under a key this build does not hold. */
    skipped: number;
    /** A few of the sites skipped cookies were for, so the screen can say what did not come over. */
    skippedSites: string[];
  }
  | { ok: false; reason: BrowserImportFailure };

export const BROWSER_IMPORT_FAILURE_COPY: Record<BrowserImportFailure, string> = {
  notInstalled: 'Not installed on this Mac.',
  browserRunning: 'Quit the browser first, so its cookies can be read.',
  needsFullDiskAccess: 'Give Relayed Full Disk Access in System Settings → Privacy & Security, then try again.',
  unsupportedPlatform: 'Importing from browsers works on macOS for now.',
  needsKeychainApproval: 'Relayed needs Keychain access to read this browser’s cookies. Choose Allow when macOS asks.',
  keychainItemMissing: 'This browser has no cookie key in your Keychain. Open it and sign in to something once, then try again.',
  keychainUnavailable: 'The Keychain could not be reached.',
  unknownSource: 'That browser is no longer available to import from.',
  unknownProfile: 'That browser profile no longer exists.',
  noAccount: 'Sign in to Relayed first.',
  readFailed: 'The browser’s cookies could not be read.',
};
