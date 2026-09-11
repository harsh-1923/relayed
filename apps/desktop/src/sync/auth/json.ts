// Reading a value out of somebody else's JSON.
//
// A failed HTTP call is parsed into `Record<string, unknown>` and its fields are
// then used to build an error message. `String(json['error'])` does the right
// thing right up until the field is an object — WorkOS returns
// `{"errors": [{"code": ...}]}` on a validation failure — and then the message
// the user reads, and the message that reaches Loki, is the literal text
// `[object Object]`.
//
// That is a bad failure to have in an error path, because the error path is
// where you have already lost and the message is the only thing left. So the
// non-string case falls THROUGH to the next candidate rather than being
// stringified into noise.
export function firstString(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return '';
}

/** A field that should be a string, or the fallback. Never `[object Object]`. */
export const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;
