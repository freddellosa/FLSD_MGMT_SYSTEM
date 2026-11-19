/** Deterministic JSON encoding shared by offline and browser-only evidence review. */
export function canonicalReviewJson(value: unknown): string {
  const encode = (item: unknown): string => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return '[' + item.map(encode).join(',') + ']';
    if (typeof item === 'object' && item !== null && Object.getPrototypeOf(item) === Object.prototype) {
      return '{' + Object.keys(item).sort().map(k => JSON.stringify(k) + ':' + encode((item as Record<string, unknown>)[k])).join(',') + '}';
    }
    throw new Error('Review artifact must contain finite JSON values only');
  };
  return encode(value);
}
