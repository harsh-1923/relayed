// UI blocks in agent replies (docs/AGENT-RESPONSES.md).
//
// Shared so the service agent, the local agent runner, the server and the
// renderer cannot disagree about which components exist, what a valid block is,
// or what the model is told. No React in here: the renderer binds its own
// components to `library`.
export { library, toText, LIBRARY_VERSION, LANG, ROOT } from './library.ts';
export type { ChildText } from './library.ts';
export { validateUi, formatForModel, libraryVersion, uiPartRefusal, LIMITS } from './validate.ts';
export { deriveBody, summariseTool } from './body.ts';
export type { UiError, UiValidation } from './validate.ts';
export { uiInstructions, SHOW_UI } from './instructions.ts';
export { libraryShape, unsafeChanges, unsnapshotted } from './guard.ts';
export type { LibraryShape, PropShape } from './guard.ts';
