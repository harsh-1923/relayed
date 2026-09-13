// The guard that keeps stored UI blocks meaning what they meant
// (docs/AGENT-RESPONSES.md, changing the library).
//
// Arguments are positional. Reorder two props and every stored block still
// validates — and says something else. So the library's shape is compared with a
// committed snapshot, and only additions pass: new components, and new optional
// props at the end.

/** One component's props, in positional order. */
export interface PropShape {
  prop: string;
  type: string;
  enum?: readonly unknown[];
  required: boolean;
}

export type LibraryShape = Record<string, PropShape[]>;

interface JsonSchemaLike {
  $defs?: Record<string, { properties?: Record<string, Record<string, unknown>>; required?: string[] }>;
}

const typeOf = (schema: Record<string, unknown>): string => {
  if (typeof schema['type'] === 'string') return schema['type'];
  if (Array.isArray(schema['enum'])) return 'enum';
  if (Array.isArray(schema['anyOf'])) return 'union';
  if (typeof schema['$ref'] === 'string') return 'ref';
  return 'any';
};

/** The positional shape of a library, from `library.toJSONSchema()`. */
export function libraryShape(jsonSchema: unknown): LibraryShape {
  const shape: LibraryShape = {};
  for (const [name, definition] of Object.entries((jsonSchema as JsonSchemaLike).$defs ?? {})) {
    const required = new Set(definition.required ?? []);
    shape[name] = Object.entries(definition.properties ?? {}).map(([prop, schema]) => {
      const entry: PropShape = { prop, type: typeOf(schema), required: required.has(prop) };
      if (Array.isArray(schema['enum'])) entry.enum = schema['enum'];
      return entry;
    });
  }
  return shape;
}

/** Every difference that would change what an already-stored block means. */
export function unsafeChanges(before: LibraryShape, after: LibraryShape): string[] {
  const problems: string[] = [];
  for (const [component, props] of Object.entries(before)) {
    const next = after[component];
    if (!next) { problems.push(`${component}: removed`); continue; }

    props.forEach((old, position) => {
      const now = next[position];
      if (!now) { problems.push(`${component}: argument ${position} "${old.prop}" removed`); return; }
      if (now.prop !== old.prop) {
        problems.push(`${component}: argument ${position} was "${old.prop}", now "${now.prop}"`);
      }
      if (now.type !== old.type) problems.push(`${component}.${old.prop}: type ${old.type} → ${now.type}`);
      const removed = (old.enum ?? []).filter(value => !(now.enum ?? []).includes(value));
      if (removed.length > 0) problems.push(`${component}.${old.prop}: enum values removed: ${removed.join(', ')}`);
      if (!old.required && now.required) problems.push(`${component}.${old.prop}: optional → required`);
    });

    for (const added of next.slice(props.length)) {
      if (added.required) problems.push(`${component}: new argument "${added.prop}" must be optional`);
    }
  }
  return problems;
}

/** What the library has that the snapshot does not lock yet. */
export function unsnapshotted(snapshot: LibraryShape, current: LibraryShape): string[] {
  const missing: string[] = [];
  for (const [component, props] of Object.entries(current)) {
    const locked = snapshot[component];
    if (!locked) { missing.push(component); continue; }
    for (const added of props.slice(locked.length)) missing.push(`${component}.${added.prop}`);
  }
  return missing;
}
