// The `source` of a `show_ui` call, read from its input while the input is
// still arriving (docs/AGENT-RESPONSES.md §3.4).
//
// The model's tool input streams as fragments of JSON — `{"source": "root = Ca`
// — which JSON.parse cannot read until the last one lands. This decodes the one
// string field as far as it has got, so a card can draw while it is written.
// Anything it cannot read yet is left out rather than guessed: the complete
// source always arrives with the call itself.

const ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** The `source` string so far, or null while its opening quote has not arrived. */
export function partialSource(json: string): string | null {
  const start = /"source"\s*:\s*"/.exec(json);
  if (!start) return null;

  let out = '';
  for (let i = start.index + start[0].length; i < json.length; i++) {
    const char = json[i];
    if (char === '"') return out;              // the string is complete
    if (char !== '\\') { out += char; continue; }

    const next = json[i + 1];
    if (next === undefined) return out;          // an escape cut in half: wait for the rest
    if (next === 'u') {
      const hex = json.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 5;
      continue;
    }
    out += ESCAPES[next] ?? next;
    i += 1;
  }
  return out;
}
