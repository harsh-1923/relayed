// The catalogues, with no SDK attached.
//
// `index.ts` is the emitting surface and it reaches for node — process, timers,
// fetch. The renderer must not pull any of that in just to type-check an event
// name, and it must not pull a second SDK in at all (OBSERVABILITY.md §3), so
// the types it needs are exported from here instead.
//
// The point is that the renderer is held to the SAME catalogue as everything
// else: an undeclared event or a mistyped field fails to build there exactly as
// it does in the sync process, even though the emitting happens elsewhere.
export {
  events,
  type EventName, type EventFields, type EventSpec, type FieldType,
} from './events.ts';
export {
  metrics,
  type MetricName, type MetricLabelsFor, type MetricSpec, type LabelValues,
} from './metrics.ts';
