export const splitGuests = (pax: number, rooms: number): number[] => {
  if (pax <= 0 || rooms <= 0) return [];
  const n = Math.min(rooms, pax); // never an empty room
  const base = Math.floor(pax / n);
  return Array.from({ length: n }, (_, i) => base + (i < pax % n ? 1 : 0));
};

export const effectiveRooms = (rooms: number, pax: number, maxOcc: number): number => {
  if (pax <= 0 || maxOcc <= 0) return 0;
  return Math.min(pax, Math.max(rooms, Math.ceil(pax / maxOcc)));
};
