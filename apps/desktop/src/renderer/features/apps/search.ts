import Fuse, { type IFuseOptions } from 'fuse.js';
import type { ToolkitSummary } from '../../../preload/api';

const OPTIONS: IFuseOptions<ToolkitSummary> = {
  keys: [
    { name: 'name', weight: 0.45 },
    { name: 'slug', weight: 0.25 },
    { name: 'description', weight: 0.2 },
    { name: 'categories', weight: 0.1 },
  ],
  threshold: 0.5,
  ignoreLocation: true,
  ignoreDiacritics: true,
  useTokenSearch: true,
  tokenMatch: 'all',
};

/** Build the catalogue index once, then return best matches first for each query. */
export function createToolkitSearch(
  toolkits: readonly ToolkitSummary[],
): (search: string) => ToolkitSummary[] {
  const fuse = new Fuse(toolkits, OPTIONS);

  return search => {
    const query = search.trim();
    if (!query) return [...toolkits];
    return fuse.search(query).map(result => result.item);
  };
}
