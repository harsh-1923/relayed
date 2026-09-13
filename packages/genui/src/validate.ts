// One check for a UI block, run in three places (docs/AGENT-RESPONSES.md,
// validation): by the runtime, to answer the model; by the server, on write; and
// by the renderer, for fallback text.
//
// It is also the free equivalent of a correcting gateway. `show_ui` sends these
// errors back to the model, and nothing is stored until a call passes.
import { createParser } from '@openuidev/lang-core';
import { LANG, library, LIBRARY_VERSION, ROOT, toText } from './library.ts';

/** Hard limits on one block, checked before parsing. */
export const LIMITS = { maxSourceBytes: 16_000, maxStatements: 200 } as const;

export interface UiError {
  /** The parser's own codes, plus the ones below. See the doc for the full list. */
  code: string;
  message: string;
  /** The statement the error is about, when there is one. */
  statement?: string;
}

export type UiValidation =
  | { ok: true; text: string }
  | { ok: false; errors: UiError[]; text: string };

const parser = createParser(library.toJSONSchema(), ROOT);

export function validateUi(source: string): UiValidation {
  if (source.trim().length === 0) {
    return { ok: false, errors: [{ code: 'empty', message: 'source is empty' }], text: '' };
  }

  const errors: UiError[] = [];
  const at = (code: string, message: string, statement: string | undefined): UiError =>
    statement === undefined ? { code, message } : { code, message, statement };

  // TextEncoder rather than Buffer: the renderer runs this too.
  if (new TextEncoder().encode(source).length > LIMITS.maxSourceBytes) {
    errors.push({ code: 'too-large', message: `source exceeds ${LIMITS.maxSourceBytes} bytes` });
  }

  let result;
  try {
    result = parser.parse(source);
  } catch (error) {
    // The parser is documented not to throw; this is for the day it does.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [{ code: 'parse-exception', message }], text: '' };
  }

  const { meta } = result;
  for (const issue of meta.errors) errors.push(at(issue.code, issue.message, issue.statementId));

  if (!result.root) {
    errors.push({ code: 'no-root', message: `no renderable root; begin with \`root = ${ROOT}([...])\`` });
  } else if (result.root.typeName !== ROOT) {
    errors.push({ code: 'wrong-root', message: `root must be ${ROOT}, got ${result.root.typeName}` });
  }
  if (meta.incomplete) errors.push({ code: 'incomplete', message: 'the source ends mid-statement' });
  for (const name of meta.unresolved) {
    errors.push(at('unresolved', `"${name}" is referenced but never defined`, name));
  }
  // The parser drops these silently. A definition nothing reaches is something
  // the model meant to show and did not, so it goes back rather than being lost.
  for (const name of meta.orphaned) {
    errors.push(at('orphaned', `"${name}" is defined but not reachable from root`, name));
  }
  if (meta.statementCount > LIMITS.maxStatements) {
    errors.push({ code: 'too-many-statements', message: `more than ${LIMITS.maxStatements} statements` });
  }
  // Nothing in a stored block may run on a reader's machine (the doc, why static).
  if (result.queryStatements.length > 0 || result.mutationStatements.length > 0) {
    errors.push({ code: 'data-not-allowed', message: 'Query() and Mutation() are not allowed; put the data in directly' });
  }
  if (Object.keys(result.stateDeclarations).length > 0) {
    errors.push({ code: 'state-not-allowed', message: '$variables are not allowed' });
  }

  const text = toText(result.root);
  return errors.length === 0 ? { ok: true, text } : { ok: false, errors, text };
}

/** Errors, phrased as the tool result the model reads. */
export function formatForModel(errors: readonly UiError[]): string {
  const lines = errors.map(error =>
    `- [${error.code}]${error.statement === undefined ? '' : ` "${error.statement}":`} ${error.message}`);
  return ['The UI block was not shown. Fix these and call show_ui again:', ...lines].join('\n');
}

/**
 * The version number in a library name — 1 for `relayed-ui@1` — or NaN for a
 * name that is not this library at all.
 */
export function libraryVersion(name: string): number {
  const match = /^relayed-ui@(\d+)$/.exec(name);
  return match ? Number(match[1]) : Number.NaN;
}

/**
 * Why the server would refuse to store a ui part, as one code, or null.
 *
 * A code rather than the errors: this is what a refused write reports, and a
 * nack is read by a client and counted by a metric, neither of which should
 * carry the block's source. The model already had the full errors from
 * `show_ui` before it ever got this far.
 */
export function uiPartRefusal(part: { lang: string; library: string; source: string }): string | null {
  if (part.lang !== LANG) return 'unknown-lang';
  const version = libraryVersion(part.library);
  // Newer than this build is refused too: the server must be able to derive
  // `body` from every block it stores, and it cannot read a component it lacks.
  if (!(version >= 1 && version <= libraryVersion(LIBRARY_VERSION))) return 'unknown-library';
  const result = validateUi(part.source);
  return result.ok ? null : (result.errors[0]?.code ?? 'invalid');
}
