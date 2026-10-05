// When the composer says it is typing, and when it says it stopped
// (docs/ACTIVITY.md §6.2). Pure apart from its timer, which is injectable, so
// the rules run under `node --test`.

/** At most one `active` this often while the person keeps typing. Under the receiver's 6 s TTL. */
export const ACTIVE_EVERY_MS = 3_000;
/** A pause this long is stopping, even with text still in the composer. */
export const IDLE_AFTER_MS = 5_000;

export interface SenderClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: SenderClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

export class TypingSender {
  #send: (state: 'active' | 'ended') => void;
  #clock: SenderClock;
  /** When `active` was last sent, or null when this is not typing as far as anyone knows. */
  #lastActiveAt: number | null = null;
  #idle: unknown = null;

  constructor(send: (state: 'active' | 'ended') => void, clock: SenderClock = systemClock) {
    this.#send = send;
    this.#clock = clock;
  }

  /** The composer changed. Empty is stopping; anything else is typing. */
  changed(hasContent: boolean): void {
    if (!hasContent) { this.stop(); return; }
    const now = this.#clock.now();
    if (this.#lastActiveAt === null || now - this.#lastActiveAt >= ACTIVE_EVERY_MS) {
      this.#lastActiveAt = now;
      this.#send('active');
    }
    if (this.#idle !== null) this.#clock.clearTimeout(this.#idle);
    this.#idle = this.#clock.setTimeout(() => { this.stop(); }, IDLE_AFTER_MS);
  }

  /** Sent, cleared, left or paused. Says so once, and only if it had said it was typing. */
  stop(): void {
    if (this.#idle !== null) { this.#clock.clearTimeout(this.#idle); this.#idle = null; }
    if (this.#lastActiveAt === null) return;
    this.#lastActiveAt = null;
    this.#send('ended');
  }
}
