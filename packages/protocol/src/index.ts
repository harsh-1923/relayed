// The wire contract, shared so the two sides cannot disagree (docs/SYNC-FLOWS.md §8).
//
// Only the FORMAT lives here. What a frame means is the server's or the
// client's, and neither's to reinterpret — the same split that keeps `can()`
// shared while loading grants stays local to each side.
export * from './frames.ts';
export * from './parts.ts';
