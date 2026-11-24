import { describe, it, expect } from 'vitest';
import { guestNetRate } from '../../src/modules/pricing/guest-rate.js';

describe('guestNetRate', () => {
  it('adds the rate markup when it is set', () => {
    expect(guestNetRate(100, 10, 25)).toBe('110.00');
  });

  it('uses the hotel commission when the rate markup is missing', () => {
    expect(guestNetRate(100, null, 10)).toBe('110.00');
    expect(guestNetRate('100', undefined, '10')).toBe('110.00');
  });

  it('keeps the net amount when the rate markup is 0', () => {
    expect(guestNetRate(100, 0, 10)).toBe('100');
  });

  it('keeps the net amount when neither commission is set', () => {
    expect(guestNetRate(100, null, null)).toBe('100');
  });
});
