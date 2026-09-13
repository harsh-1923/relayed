// Whether a keydown happened in a text-entry control (SHORTCUTS.md §8.2, step 6).
//
// Our own rather than TanStack's `isInputElement`, which counts a checkbox as
// editable and misses `role="textbox"` and shadow roots (spikes/hotkeys).
// Read from the composed path so a text input inside a shadow root counts.
const TEXT_INPUT_TYPES = new Set([
  '', 'text', 'search', 'url', 'tel', 'email', 'password', 'number',
  'date', 'datetime-local', 'month', 'time', 'week',
]);

export function isEditableEvent(event: Event): boolean {
  for (const node of event.composedPath()) {
    if (!(node instanceof HTMLElement)) continue;
    if (node instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(node.type.toLowerCase());
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement) return true;
    if (node.isContentEditable || node.getAttribute('role') === 'textbox') return true;
  }
  return false;
}
