import { describe, it, expect } from 'vitest';
import { splitGuests, effectiveRooms } from '../../src/modules/pricing/split.js';

describe('Split guests & Effective rooms', () => {
  it('splits guests across rooms evenly without empty rooms', () => {
    // Spec examples:
    // (5,2) -> [3,2]
    expect(splitGuests(5, 2)).toEqual([3, 2]);
    // (2,3) -> [1,1] (never an empty room)
    expect(splitGuests(2, 3)).toEqual([1, 1]);

    expect(splitGuests(6, 3)).toEqual([2, 2, 2]);
    expect(splitGuests(7, 3)).toEqual([3, 2, 2]);
    expect(splitGuests(1, 1)).toEqual([1]);
  });

  it('calculates effective rooms properly', () => {
    // 4 guests, asked for 1 room, max occupancy 2 -> needs 2 rooms
    expect(effectiveRooms(1, 4, 2)).toBe(2);
    // 2 guests, asked for 2 rooms, max occupancy 4 -> 2 rooms
    expect(effectiveRooms(2, 2, 4)).toBe(2);
    // 10 guests, asked for 2 rooms, max occupancy 3 -> Math.ceil(10/3) = 4 rooms
    expect(effectiveRooms(2, 10, 3)).toBe(4);
    // Cannot exceed pax (never an empty room)
    expect(effectiveRooms(5, 2, 4)).toBe(2);
  });
});
