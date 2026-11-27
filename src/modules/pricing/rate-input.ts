import type { RateInput } from './types.js';

type DbRate = {
  id: string;
  roomTypeId: string;
  seasonId: string;
  mealPlan: string;
  concept: string | null;
  priceKind: string;
  pricingUnit: string;
  netRate: { toString(): string } | number | string;
  minNights: number;
  isActive: boolean;
};

export function toRateInput(rate: DbRate, maxOccupancy: number): RateInput {
  return {
    id: rate.id,
    roomTypeId: rate.roomTypeId,
    seasonId: rate.seasonId,
    mealPlan: rate.mealPlan,
    concept: rate.concept as RateInput['concept'],
    priceKind: rate.priceKind as RateInput['priceKind'],
    pricingUnit: rate.pricingUnit as RateInput['pricingUnit'],
    netRate: rate.netRate.toString(),
    minNights: rate.minNights,
    maxOccupancy: Math.max(1, maxOccupancy),
    isActive: rate.isActive,
  };
}

export function roomMaxOccupancyMap(
  rooms: { id: string; maxOccupancy: number }[]
): Map<string, number> {
  return new Map(rooms.map((r) => [r.id, Math.max(1, r.maxOccupancy)]));
}

export function mapSeasonRatesToInput(
  rates: DbRate[],
  roomOcc: Map<string, number>
): RateInput[] {
  return rates.map((r) =>
    toRateInput(r, roomOcc.get(r.roomTypeId) ?? 2)
  );
}