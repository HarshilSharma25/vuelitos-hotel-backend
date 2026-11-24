import { describe, it, expect } from 'vitest';
import {
  hotelMatchesMealPlans,
  hotelMatchesStayType,
  parseMealPlanFilters,
} from '../../src/modules/catalog/stay-filters.js';

describe('stay filters', () => {
  it('treats desayuno and breakfast as the same meal plan', () => {
    const selected = parseMealPlanFilters(undefined, 'breakfast,half_board');
    expect(hotelMatchesMealPlans(['desayuno'], selected)).toBe(true);
    expect(hotelMatchesMealPlans(['todo_incluido'], selected)).toBe(false);
    expect(hotelMatchesMealPlans(['media_pension'], selected)).toBe(true);
  });

  it('keeps a single meal_plan query', () => {
    expect(parseMealPlanFilters('desayuno')).toEqual(['breakfast']);
  });

  it('matches stay type by category words', () => {
    expect(hotelMatchesStayType('Hotel', 'hotel')).toBe(true);
    expect(hotelMatchesStayType('Resort', 'hotel')).toBe(true);
    expect(hotelMatchesStayType('Posada', 'hotel')).toBe(false);
    expect(hotelMatchesStayType('Posada La Rivera', 'posada')).toBe(true);
    expect(hotelMatchesStayType('Mountain Lodge', 'lodge')).toBe(true);
  });
});