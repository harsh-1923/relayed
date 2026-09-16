/**
 * cmdk needs a unique value for each row, but those values contain opaque ids
 * that must not affect ranking. Match only the human keywords a source
 * supplies; every typed term must occur somewhere in them.
 */
export function rankKeywords(search: string, keywords: readonly string[]): number {
  const query = normalized(search);
  if (!query) return 1;
  const searchable = normalized(keywords.join(' '));
  const terms = query.split(' ');
  if (!terms.every(term => searchable.includes(term))) return 0;
  if (searchable === query) return 1;
  if (searchable.startsWith(query)) return 0.95;
  if (searchable.split(' ').some(word => word.startsWith(query))) return 0.9;
  return 0.75;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, ' ');
}
