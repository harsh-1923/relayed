// Typed local-blob URLs shared by main and the renderer (DESIGN.md, blob
// serving §13.3). The renderer names content, never a filesystem path.

export type ImageMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'image/avif'
  | 'image/x-icon'
  | 'image/vnd.microsoft.icon'
  | 'image/svg+xml';

const EXTENSION_BY_TYPE: Readonly<Record<ImageMediaType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'icon',
  'image/svg+xml': 'svg',
};

const TYPE_BY_EXTENSION = new Map(
  Object.entries(EXTENSION_BY_TYPE).map(([mediaType, extension]) => [extension, mediaType as ImageMediaType]),
);

export function localBlobUrl(id: string, mediaType?: ImageMediaType | null): string {
  const extension = mediaType ? EXTENSION_BY_TYPE[mediaType] : null;
  return `relayed-blob://${id}${extension ? `/image.${extension}` : ''}`;
}

/** A typed route is what lets an extensionless content-addressed file render as SVG. */
export function imageMediaTypeFromBlobUrl(url: URL): ImageMediaType | null {
  const match = /^\/image\.([a-z]+)$/.exec(url.pathname);
  return match?.[1] ? TYPE_BY_EXTENSION.get(match[1]) ?? null : null;
}
