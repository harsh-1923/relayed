// Shared by the onboarding screens.

/**
 * Was this refusal an expired sign-in? The WorkOS token onboarding holds is
 * renewed before use, so this is the fallback when renewal itself failed — and
 * the one error a person can only fix by signing in again. Matched on the
 * message because an error crossing the bridge keeps nothing else.
 */
export const isExpiredSignIn = (message: string): boolean =>
  /invalid_token|"exp" claim|token.*expired|no pending sign-in/i.test(message);

export const EXPIRED_SIGN_IN = 'Your sign-in expired while this screen was open. Sign in again to continue.';
