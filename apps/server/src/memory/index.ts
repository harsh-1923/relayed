// What the rest of the server may use from memory (docs/MEMORY.md).
//
// A single entry point so the Hindsight client stays reachable from exactly one
// place — `client.ts` owns the import, and nothing outside this directory should
// name the vendor at all.
export {
  MEMORY_MISSION, bankForSpace, banksForRun, ensureBank, isPublicSpace,
  personBank, publicSpaceIds, refilter, spaceBank, workspaceBank,
  type ReadableBank, type SpacePlacement,
} from './banks.ts';
export {
  documentIdFor, documentsCovering, documentsForSpace, forgetDocument, recordDocument,
  type MemoryDocument,
} from './documents.ts';
export { forgetSweep, staleDocuments, rebuild, type StaleDocument } from './forget.ts';
export { MemoryError, memoryConfigured, type Fact } from './client.ts';
