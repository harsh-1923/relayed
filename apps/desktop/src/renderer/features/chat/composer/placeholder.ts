interface ComposerDocumentNode {
  childCount: number;
  firstChild: ComposerBlockNode | null;
}

interface ComposerBlockNode {
  childCount: number;
  type: { name: string };
}

/** The placeholder belongs only to Tiptap's untouched default document. */
export function shouldShowComposerPlaceholder(document: ComposerDocumentNode): boolean {
  const onlyBlock = document.firstChild;
  return document.childCount === 1
    && onlyBlock?.type.name === 'paragraph'
    && onlyBlock.childCount === 0;
}
