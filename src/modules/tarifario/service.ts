import { prisma } from '../../lib/prisma.js';
import { ratesService } from '../rates/service.js';
import { tarifarioSchema, TarifarioDocument } from './schema.js';
import { computeImportPlan, ImportPlan, normalizeName } from './diff.js';
import { ConflictError, NotFoundError } from '../../lib/errors.js';

const activePlans = new Map<string, { plan: ImportPlan; doc: TarifarioDocument }>();

export class TarifarioService {
  async dryRun(data: unknown): Promise<ImportPlan> {
    const doc = tarifarioSchema.parse(data);

    const existingHotels = await prisma.hotel.findMany({
      include: {
        rooms: true,
        seasons: { include: { rates: true } },
      },
    });

    const plan = computeImportPlan(doc, existingHotels);
    activePlans.set(plan.planId, { plan, doc });

    return plan;
  }

  async commit(planId: string, expectedHash: string): Promise<{ applied: boolean; summary: any; markdown: string }> {
    const cached = activePlans.get(planId);
    if (!cached) {
      throw new NotFoundError(`Tarifario import plan '${planId}' not found or expired`);
    }

    if (cached.plan.snapshotHash !== expectedHash) {
      throw new ConflictError('Plan snapshot hash does not match expected hash');
    }

    const { doc } = cached;

    const result = await prisma.$transaction(async (tx) => {
      // 1. Fetch current hotels again to ensure no divergence
      const currentHotels = await tx.hotel.findMany({
        include: {
          rooms: true,
          seasons: { include: { rates: true } },
        },
      });

      const recomputedPlan = computeImportPlan(doc, currentHotels);
      if (recomputedPlan.snapshotHash !== expectedHash) {
        throw new ConflictError('Database changed; recomputed plan hash differs from expected hash');
      }

      // 2. Apply hotel creations (is_active = false drafts)
      for (const h of doc.hotels) {
        let hotel = currentHotels.find((eh) => eh.slug === h.slug);
        if (!hotel) {
          hotel = await tx.hotel.create({
            data: {
              slug: h.slug,
              name: h.name,
              destination: h.destination,
              category: h.category,
              baseCurrency: h.currency,
              isSoloDivisas: h.is_solo_divisas,
              isActive: false, // Draft!
            },
            include: { rooms: true, seasons: { include: { rates: true } } },
          });
        }

        // Rooms
        const roomMap = new Map<string, string>();
        for (const rm of h.rooms) {
          let existingRoom = hotel.rooms.find(
            (r) => normalizeName(r.name) === normalizeName(rm.name)
          );
          if (!existingRoom) {
            existingRoom = await tx.roomType.create({
              data: {
                hotelId: hotel.id,
                name: rm.name,
                maxOccupancy: rm.max_occupancy,
                isActive: true,
              },
            });
          }
          roomMap.set(normalizeName(rm.name), existingRoom.id);
        }

        // Seasons
        const seasonMap = new Map<string, string>();
        for (const sn of h.seasons) {
          let existingSeason = hotel.seasons.find(
            (s) => normalizeName(s.name) === normalizeName(sn.name)
          );
          if (!existingSeason) {
            existingSeason = await tx.season.create({
              data: {
                hotelId: hotel.id,
                name: sn.name,
                priority: sn.priority,
                dateFrom: new Date(`${sn.date_from}T00:00:00Z`),
                dateTo: new Date(`${sn.date_to}T00:00:00Z`),
                bookingFrom: sn.booking_from ? new Date(`${sn.booking_from}T00:00:00Z`) : null,
                bookingTo: sn.booking_to ? new Date(`${sn.booking_to}T00:00:00Z`) : null,
                isActive: true,
              },
              include: { rates: true },
            });
          }
          seasonMap.set(normalizeName(sn.name), existingSeason.id);
        }

        // Apply rate creations
        for (const r of h.rates) {
          if (r.price_kind === 'BAJO_PEDIDO') continue; // Skip manual review

          const roomTypeId = roomMap.get(normalizeName(r.room_name));
          const seasonId = seasonMap.get(normalizeName(r.season_name));
          if (!roomTypeId || !seasonId) continue;

          // Check if rate already exists
          const existingRate = hotel.seasons
            .flatMap((s) => s.rates)
            .find(
              (er) =>
                er.isActive &&
                er.roomTypeId === roomTypeId &&
                er.seasonId === seasonId &&
                er.mealPlan === r.meal_plan &&
                Math.abs(Number(er.netRate) - r.net_rate) <= 0.005
            );

          if (!existingRate) {
            await tx.rate.create({
              data: {
                roomTypeId,
                seasonId,
                mealPlan: r.meal_plan,
                concept: r.concept as any,
                priceKind: r.price_kind as any,
                occupancy: r.occupancy,
                pricingUnit: r.pricing_unit as any,
                netRate: r.net_rate,
                daysOfWeek: r.days_of_week || [],
                minNights: r.min_nights || 1,
                maxNights: r.max_nights,
                childAgeMin: r.child_age_min,
                childAgeMax: r.child_age_max,
                isActive: true,
              },
            });
          }
        }
      }

      // 3. Deactivate removed rates
      for (const pr of recomputedPlan.rates) {
        if (pr.action === 'deactivate' && pr.existingRateId) {
          await tx.rate.update({
            where: { id: pr.existingRateId },
            data: { isActive: false }, // Deactivate, NEVER hard-delete
          });
        }
      }

      return recomputedPlan;
    });

    activePlans.delete(planId);
    await ratesService.bumpCatalogCache();

    return {
      applied: true,
      summary: result.summary,
      markdown: result.diffMarkdown,
    };
  }
}

export const tarifarioService = new TarifarioService();
