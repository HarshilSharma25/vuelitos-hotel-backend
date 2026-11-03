import { describe, expect, it } from 'vitest';
import { preferredLocaleFromRequest, resolveDisplayLocale } from '../../src/lib/display-locale.js';

describe('display-locale', () => {
  it('prefers Accept-Language over stored booking locale', () => {
    expect(resolveDisplayLocale('es', 'en')).toBe('en');
    expect(resolveDisplayLocale('en', 'es-VE')).toBe('es');
  });

  it('falls back to booking locale', () => {
    expect(resolveDisplayLocale('en', undefined)).toBe('en');
    expect(resolveDisplayLocale('es', null)).toBe('es');
  });

  it('reads locale query and Accept-Language from request', () => {
    expect(
      preferredLocaleFromRequest({
        query: { locale: 'en' },
        headers: {},
      })
    ).toBe('en');

    expect(
      preferredLocaleFromRequest({
        query: {},
        headers: { 'accept-language': 'es-VE,en;q=0.8' },
      })
    ).toBe('es-VE,en;q=0.8');
  });
});
