const MAX_TAG_LENGTH = 80;
const MAX_TAGS = 40;

export function normalizeAmenityTag(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LENGTH);
}

/** Free-form amenity tags stored on the hotel (deduped, trimmed). */
export function parseHotelAmenities(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const tag = normalizeAmenityTag(item);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export function amenityTagMatches(hotelTag: string, required: string): boolean {
  const h = normalizeAmenityTag(hotelTag).toLowerCase();
  const r = normalizeAmenityTag(required).toLowerCase();
  if (!h || !r) return false;
  return h === r || h.includes(r) || r.includes(h);
}

export function hotelMatchesRequiredAmenities(
  raw: unknown,
  required: string[],
): boolean {
  if (required.length === 0) return true;
  const hotelTags = parseHotelAmenities(raw);
  return required.every((req) =>
    hotelTags.some((tag) => amenityTagMatches(tag, req)),
  );
}

/** Legacy: amenity tags that indicate pets are welcome. */
export function hotelAllowsPets(raw: unknown): boolean {
  return parseHotelAmenities(raw).some((tag) => /pet|mascot/i.test(tag));
}

/** Admin `pets_allowed` flag or legacy amenity tags. */
export function hotelAcceptsPets(hotel: {
  petsAllowed?: boolean | null;
  amenities?: unknown;
}): boolean {
  if (hotel.petsAllowed === true) return true;
  return hotelAllowsPets(hotel.amenities);
}

export function parseAmenityFilterTags(amenities?: string): string[] {
  if (!amenities) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of amenities.split(',')) {
    const tag = normalizeAmenityTag(part);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export function isPetsAllowedFilter(value: string | boolean | undefined): boolean {
  return value === true || value === 'true' || value === '1';
}
