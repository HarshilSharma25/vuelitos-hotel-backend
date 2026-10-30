import { describe, it, expect } from 'vitest';
import {
  calculateSlaDueAt,
  toCaracasTime,
} from '../../src/lib/caracas-time.js';

describe('SLA Business Hours Calculation', () => {
  it('implements spec case: Saturday 17:00 Caracas is due Monday 11:00 Caracas', () => {
    // 2026-10-31 is Saturday
    // 17:00 Caracas = 21:00 UTC (since Caracas is UTC-4)
    const sat17hUtc = new Date('2026-10-31T21:00:00Z');

    const dueAt = calculateSlaDueAt(sat17hUtc, []);
    const caracasDue = toCaracasTime(dueAt);

    // Should be Monday 2026-11-02 at 11:00 Caracas
    expect(caracasDue.dateString).toBe('2026-11-02');
    expect(caracasDue.dayOfWeek).toBe(1); // Monday
    expect(caracasDue.hour).toBe(11);
    expect(caracasDue.minute).toBe(0);
  });

  it('skips registered holidays in calculation', () => {
    const sat17hUtc = new Date('2026-10-31T21:00:00Z');
    // Monday 2026-11-02 is registered as a holiday
    const holidays = ['2026-11-02'];

    const dueAt = calculateSlaDueAt(sat17hUtc, holidays);
    const caracasDue = toCaracasTime(dueAt);

    // Skips Monday, moves to Tuesday 2026-11-03 at 11:00 Caracas
    expect(caracasDue.dateString).toBe('2026-11-03');
    expect(caracasDue.dayOfWeek).toBe(2); // Tuesday
    expect(caracasDue.hour).toBe(11);
    expect(caracasDue.minute).toBe(0);
  });

  it('handles requests arriving outside business hours (e.g. night)', () => {
    // Tuesday 22:00 Caracas (Wednesday 02:00 UTC)
    const tuesdayNight = new Date('2026-11-04T02:00:00Z');

    const dueAt = calculateSlaDueAt(tuesdayNight, []);
    const caracasDue = toCaracasTime(dueAt);

    // Starts Wednesday at 08:00 Caracas + 4 hours = Wednesday 12:00 Caracas
    expect(caracasDue.dateString).toBe('2026-11-04');
    expect(caracasDue.hour).toBe(12);
    expect(caracasDue.minute).toBe(0);
  });
});
