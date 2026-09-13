// Spike 5 — the guard that keeps stored UI blocks meaningful.
//
// Questions:
//   a. What actually happens to an already-stored block when a component's
//      prop order changes? (The fear: it breaks. The finding may be worse.)
//   b. Can a check over the library's JSON schema tell a safe change from an
//      unsafe one, so CI can refuse the unsafe kind?
//
// The rule it enforces (docs/AGENT-RESPONSES.md, "Changing the library"):
// components are never removed; an existing prop is never moved, renamed,
// retyped or has an enum value removed; new props go at the end and are optional.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod/v4';
import { createLibrary, createParser, defineComponent } from '@openuidev/lang-core';
import { library } from './library.mjs';

const SNAPSHOT = 'spec-snapshot.json';

/** name → [{ prop, schema, required }] in positional order. */
export function shape(jsonSchema) {
  const out = {};
  for (const [name, definition] of Object.entries(jsonSchema.$defs ?? {})) {
    const required = new Set(definition.required ?? []);
    out[name] = Object.entries(definition.properties ?? {}).map(([prop, schema]) => ({
      prop, schema, required: required.has(prop),
    }));
  }
  return out;
}

const typeOf = schema => schema.type ?? (schema.anyOf ? 'union' : schema.enum ? 'enum' : schema.$ref ? 'ref' : 'any');

/** Every change between two shapes that would alter the meaning of a stored block. */
export function unsafeChanges(before, after) {
  const problems = [];
  for (const [component, props] of Object.entries(before)) {
    const next = after[component];
    if (!next) { problems.push(`${component}: removed`); continue; }
    props.forEach((old, index) => {
      const now = next[index];
      if (!now) return problems.push(`${component}: prop ${index} "${old.prop}" removed`);
      if (now.prop !== old.prop) problems.push(`${component}: position ${index} was "${old.prop}", now "${now.prop}"`);
      if (typeOf(now.schema) !== typeOf(old.schema)) problems.push(`${component}.${old.prop}: type ${typeOf(old.schema)} → ${typeOf(now.schema)}`);
      const removedValues = (old.schema.enum ?? []).filter(value => !(now.schema.enum ?? []).includes(value));
      if (removedValues.length) problems.push(`${component}.${old.prop}: enum values removed ${removedValues.join(', ')}`);
      if (!old.required && now.required) problems.push(`${component}.${old.prop}: optional → required`);
    });
    next.slice(props.length).forEach(added => {
      if (added.required) problems.push(`${component}: new prop "${added.prop}" must be optional`);
    });
  }
  return problems;
}

// ── a. what reordering does to a block that is already stored ──────────────
const statLibrary = (props) => {
  const Stat = defineComponent({ name: 'Stat', description: 'x', props, component: null });
  const Card = defineComponent({ name: 'Card', description: 'x', component: null,
    props: z.object({ children: z.array(Stat.ref) }) });
  return createLibrary({ root: 'Card', components: [Card, Stat] });
};
const stored = 'root = Card([s])\ns = Stat("Passed", "17", "success")';
const tone = z.enum(['neutral', 'success', 'warning', 'danger']);

const variants = {
  original: z.object({ label: z.string(), value: z.string(), tone: tone.optional() }),
  swappedLabelAndValue: z.object({ value: z.string(), label: z.string(), tone: tone.optional() }),
  optionalPropAppended: z.object({ label: z.string(), value: z.string(), tone: tone.optional(), hint: z.string().optional() }),
  toneRemoved: z.object({ label: z.string(), value: z.string() }),
  enumValueRemoved: z.object({ label: z.string(), value: z.string(), tone: z.enum(['neutral', 'success']).optional() }),
  requiredPropAppended: z.object({ label: z.string(), value: z.string(), tone: tone.optional(), unit: z.string() }),
};

const report = { storedBlock: stored, reading: {}, guard: {} };
const before = shape(statLibrary(variants.original).toJSONSchema());
for (const [name, props] of Object.entries(variants)) {
  const candidate = statLibrary(props);
  const parsed = createParser(candidate.toJSONSchema(), 'Card').parse(stored);
  const stat = parsed.root?.props?.children?.[0]?.props;
  report.reading[name] = {
    validationErrors: parsed.meta.errors.map(error => error.code),
    renderedAs: stat,
  };
  report.guard[name] = unsafeChanges(before, shape(candidate.toJSONSchema()));
}

// ── b. the real library against its committed snapshot ─────────────────────
const current = shape(library.toJSONSchema());
if (!existsSync(SNAPSHOT)) writeFileSync(SNAPSHOT, JSON.stringify(current, null, 2));
report.realLibraryAgainstSnapshot = unsafeChanges(JSON.parse(readFileSync(SNAPSHOT, 'utf8')), current);

writeFileSync('results/5-guard.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.realLibraryAgainstSnapshot.length ? 1 : 0;
