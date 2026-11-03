export type AppLocale = 'en' | 'es';

export function resolveDisplayLocale(
  bookingLocale: string | null | undefined,
  preferred?: string | null
): AppLocale {
  const fromPreferred = parseLocaleTag(preferred);
  if (fromPreferred) return fromPreferred;
  return bookingLocale === 'en' ? 'en' : 'es';
}

function parseLocaleTag(raw?: string | null): AppLocale | null {
  if (!raw) return null;
  const tag = raw.split(',')[0]?.trim().toLowerCase() ?? '';
  if (tag.startsWith('en')) return 'en';
  if (tag.startsWith('es')) return 'es';
  return null;
}

export function preferredLocaleFromRequest(req: {
  query: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}): string | undefined {
  const q = req.query?.locale;
  if (typeof q === 'string' && q.trim()) return q.trim();
  const al = req.headers['accept-language'];
  if (typeof al === 'string' && al.trim()) return al;
  if (Array.isArray(al) && typeof al[0] === 'string') return al[0];
  return undefined;
}
