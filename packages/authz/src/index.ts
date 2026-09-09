// Shared authorization (docs/AUTHZ.md).
//
// This package exists because the client and the server must not be able to
// disagree. AUTHZ.md §12.2 asks for a shared fixture set; sharing the CODE is
// strictly stronger — there is no second implementation to drift.
//
// Only the pure evaluator lives here. Loading grants from a database is the
// server's, and loading them from a replica is the client's; the decision
// itself is neither's to reinterpret.
export * from './model.ts';
export * from './can.ts';
