import { prisma } from '../../lib/prisma.js';
import { resolveSingleRoomStay, parseStayWindow, SeasonInput } from '../pricing/index.js';
import { ratesService } from '../rates/service.js';

export interface CatalogFix {
  id: string;
  description: string;
  hotelSlug: string;
  testCheckIn: string;
  testCheckOut: string;
  testGuests: number;
  expectedPriceBefore: boolean;
  expectedPriceAfter: boolean;
  apply: (tx: any) => Promise<void>;
}

export async function runCatalogFixes(fixes: CatalogFix[]): Promise<{ fixId: string; success: boolean; error?: string }[]> {
  const results: { fixId: string; success: boolean; error?: string }[] = [];

  for (const fix of fixes) {
    try {
      const hotel = await prisma.hotel.findUnique({
        where: { slug: fix.hotelSlug },
        include: {
          rooms: true,
          seasons: { include: { rates: true } },
        },
      });

      if (!hotel) {
        throw new Error(`Hotel '${fix.hotelSlug}' not found`);
      }

      const window = parseStayWindow(fix.testCheckIn, fix.testCheckOut);
      if (!window) throw new Error('Invalid stay window in test fix');

      const pureSeasons: SeasonInput[] = hotel.seasons.map((s) => ({
        id: s.id,
        hotelId: s.hotelId,
        name: s.name,
        priority: s.priority,
        dateFrom: s.dateFrom.toISOString().slice(0, 10),
        dateTo: s.dateTo.toISOString().slice(0, 10),
        bookingFrom: s.bookingFrom ? s.bookingFrom.toISOString().slice(0, 10) : null,
        bookingTo: s.bookingTo ? s.bookingTo.toISOString().slice(0, 10) : null,
        isActive: s.isActive,
        rates: s.rates.map((r) => ({
          id: r.id,
          roomTypeId: r.roomTypeId,
          seasonId: r.seasonId,
          mealPlan: r.mealPlan,
          concept: r.concept as any,
          priceKind: r.priceKind as any,
          occupancy: r.occupancy,
          pricingUnit: r.pricingUnit as any,
          netRate: r.netRate.toString(),
          daysOfWeek: r.daysOfWeek,
          minNights: r.minNights,
          maxNights: r.maxNights,
          isActive: r.isActive,
        })),
      }));

      // 1. Assertion before
      const firstRoom = hotel.rooms[0];
      const firstSeason = hotel.seasons[0];
      const firstMeal = firstSeason?.rates[0]?.mealPlan || 'desayuno';

      const beforePriced = resolveSingleRoomStay(
        pureSeasons,
        firstRoom.id,
        firstMeal,
        window,
        fix.testGuests,
        '2026-10-29'
      );

      if (beforePriced.priced !== fix.expectedPriceBefore) {
        throw new Error(
          `Assertion before failed: expected priced=${fix.expectedPriceBefore}, got ${beforePriced.priced}`
        );
      }

      // 2. Run fix in its own transaction
      await prisma.$transaction(async (tx) => {
        await fix.apply(tx);
      });

      // 3. Assertion after
      const updatedHotel = await prisma.hotel.findUnique({
        where: { slug: fix.hotelSlug },
        include: {
          rooms: true,
          seasons: { include: { rates: true } },
        },
      });

      const updatedSeasons: SeasonInput[] = updatedHotel!.seasons.map((s) => ({
        id: s.id,
        hotelId: s.hotelId,
        name: s.name,
        priority: s.priority,
        dateFrom: s.dateFrom.toISOString().slice(0, 10),
        dateTo: s.dateTo.toISOString().slice(0, 10),
        bookingFrom: s.bookingFrom ? s.bookingFrom.toISOString().slice(0, 10) : null,
        bookingTo: s.bookingTo ? s.bookingTo.toISOString().slice(0, 10) : null,
        isActive: s.isActive,
        rates: s.rates.map((r) => ({
          id: r.id,
          roomTypeId: r.roomTypeId,
          seasonId: r.seasonId,
          mealPlan: r.mealPlan,
          concept: r.concept as any,
          priceKind: r.priceKind as any,
          occupancy: r.occupancy,
          pricingUnit: r.pricingUnit as any,
          netRate: r.netRate.toString(),
          daysOfWeek: r.daysOfWeek,
          minNights: r.minNights,
          maxNights: r.maxNights,
          isActive: r.isActive,
        })),
      }));

      const afterPriced = resolveSingleRoomStay(
        updatedSeasons,
        firstRoom.id,
        firstMeal,
        window,
        fix.testGuests,
        '2026-10-29'
      );

      if (afterPriced.priced !== fix.expectedPriceAfter) {
        throw new Error(
          `Assertion after failed: expected priced=${fix.expectedPriceAfter}, got ${afterPriced.priced}`
        );
      }

      await ratesService.bumpCatalogCache();
      results.push({ fixId: fix.id, success: true });
    } catch (err: any) {
      results.push({ fixId: fix.id, success: false, error: err.message });
    }
  }

  return results;
}
