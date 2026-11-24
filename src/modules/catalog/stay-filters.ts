const MEAL_PLAN_ALIASES: Record<string, string> = {
  room_only: 'room_only',
  ro: 'room_only',
  solo_alojamiento: 'room_only',
  breakfast: 'breakfast',
  bb: 'breakfast',
  desayuno: 'breakfast',
  half_board: 'half_board',
  hb: 'half_board',
  media_pension: 'half_board',
  full_board: 'full_board',
  fb: 'full_board',
  pension_completa: 'full_board',
  all_inclusive: 'all_inclusive',
  ai: 'all_inclusive',
  todo_incluido: 'all_inclusive',
};

export function canonicalMealPlan(raw?: string | null): string {
  if (!raw) return '';
  const key = raw.trim().toLowerCase().replace(/\s+/g, '_');
  return MEAL_PLAN_ALIASES[key] ?? key;
}

export function parseMealPlanFilters(
  mealPlan?: string,
  mealPlans?: string | string[]
): string[] {
  const raw: string[] = [];
  if (mealPlan) raw.push(mealPlan);
  if (Array.isArray(mealPlans)) raw.push(...mealPlans);
  else if (typeof mealPlans === 'string' && mealPlans.trim()) raw.push(...mealPlans.split(','));

  return Array.from(new Set(raw.map((value) => canonicalMealPlan(value)).filter(Boolean)));
}

export function hotelMatchesMealPlans(rateMealPlans: string[], selected: string[]): boolean {
  if (selected.length === 0) return true;
  const have = new Set(rateMealPlans.map((plan) => canonicalMealPlan(plan)));
  return selected.some((plan) => have.has(plan));
}

/** Website stay types. Anything that is not a posada or lodge counts as a hotel. */
export function hotelMatchesStayType(category: string, filter?: string): boolean {
  if (!filter?.trim()) return true;
  const cat = category.toLowerCase();
  const want = filter.trim().toLowerCase();
  if (want === 'posada') return cat.includes('posada');
  if (want === 'lodge') return cat.includes('lodge');
  if (want === 'hotel') return !cat.includes('posada') && !cat.includes('lodge');
  return cat === want;
}
