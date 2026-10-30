import crypto from 'node:crypto';
import { TarifarioDocument, TarifarioHotel, TarifarioRate } from './schema.js';

export interface PlanRateItem {
  action: 'create' | 'deactivate' | 'keep' | 'manual_review';
  existingRateId?: string;
  hotelSlug: string;
  roomName: string;
  seasonName: string;
  mealPlan: string;
  occupancy: number | null;
  concept: string | null;
  priceKind: string;
  pricingUnit: string;
  netRate: number;
  reason?: string;
}

export interface PlanHotelItem {
  action: 'create_draft' | 'update';
  existingHotelId?: string;
  slug: string;
  name: string;
  destination: string;
  category: string;
  currency: 'USD' | 'EUR';
  isSoloDivisas: boolean;
}

export interface ImportPlan {
  planId: string;
  snapshotHash: string;
  source: string;
  hotels: PlanHotelItem[];
  rates: PlanRateItem[];
  summary: {
    hotelsToCreate: number;
    ratesToCreate: number;
    ratesToDeactivate: number;
    ratesUnchanged: number;
    manualReviewCount: number;
  };
  diffMarkdown: string;
}

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

export function computeImportPlan(
  doc: TarifarioDocument,
  existingHotels: any[],
  aliases: Record<string, string> = {}
): ImportPlan {
  const hasher = crypto.createHash('sha256');
  hasher.update(JSON.stringify(doc));
  const snapshotHash = hasher.digest('hex');

  const planHotels: PlanHotelItem[] = [];
  const planRates: PlanRateItem[] = [];

  for (const h of doc.hotels) {
    // 1. Match hotel: slug, alias, or normalized name
    const matchedHotel =
      existingHotels.find((eh) => eh.slug === h.slug) ||
      (aliases[h.slug] && existingHotels.find((eh) => eh.slug === aliases[h.slug])) ||
      existingHotels.find((eh) => normalizeName(eh.name) === normalizeName(h.name));

    if (!matchedHotel) {
      planHotels.push({
        action: 'create_draft',
        slug: h.slug,
        name: h.name,
        destination: h.destination,
        category: h.category,
        currency: h.currency,
        isSoloDivisas: h.is_solo_divisas,
      });

      for (const r of h.rates) {
        if (r.price_kind === 'BAJO_PEDIDO') {
          planRates.push({
            action: 'manual_review',
            hotelSlug: h.slug,
            roomName: r.room_name,
            seasonName: r.season_name,
            mealPlan: r.meal_plan,
            occupancy: r.occupancy,
            concept: r.concept,
            priceKind: r.price_kind,
            pricingUnit: r.pricing_unit,
            netRate: r.net_rate,
            reason: 'BAJO_PEDIDO fare requires manual quoting',
          });
        } else {
          planRates.push({
            action: 'create',
            hotelSlug: h.slug,
            roomName: r.room_name,
            seasonName: r.season_name,
            mealPlan: r.meal_plan,
            occupancy: r.occupancy,
            concept: r.concept,
            priceKind: r.price_kind,
            pricingUnit: r.pricing_unit,
            netRate: r.net_rate,
          });
        }
      }
      continue;
    }

    planHotels.push({
      action: 'update',
      existingHotelId: matchedHotel.id,
      slug: matchedHotel.slug,
      name: matchedHotel.name,
      destination: matchedHotel.destination,
      category: matchedHotel.category,
      currency: matchedHotel.baseCurrency,
      isSoloDivisas: matchedHotel.isSoloDivisas,
    });

    // 2. Existing rates map
    const existingRates: any[] = [];
    matchedHotel.seasons?.forEach((s: any) => {
      s.rates?.forEach((r: any) => {
        existingRates.push({
          ...r,
          seasonName: s.name,
          roomName: matchedHotel.rooms?.find((rm: any) => rm.id === r.roomTypeId)?.name,
        });
      });
    });

    const seenExistingRateIds = new Set<string>();

    for (const r of h.rates) {
      if (r.price_kind === 'BAJO_PEDIDO') {
        planRates.push({
          action: 'manual_review',
          hotelSlug: h.slug,
          roomName: r.room_name,
          seasonName: r.season_name,
          mealPlan: r.meal_plan,
          occupancy: r.occupancy,
          concept: r.concept,
          priceKind: r.price_kind,
          pricingUnit: r.pricing_unit,
          netRate: r.net_rate,
          reason: 'BAJO_PEDIDO rate flagged for manual review',
        });
        continue;
      }

      // Match rate in existing
      const match = existingRates.find((er) => {
        if (!er.isActive) return false;
        if (normalizeName(er.roomName || '') !== normalizeName(r.room_name)) return false;
        if (er.mealPlan !== r.meal_plan) return false;
        if ((er.concept ?? null) !== (r.concept ?? null)) return false;
        if (er.priceKind !== r.price_kind) return false;
        if ((er.occupancy ?? null) !== (r.occupancy ?? null)) return false;
        if (er.minNights !== r.min_nights) return false;
        return true;
      });

      if (match) {
        seenExistingRateIds.add(match.id);
        const diff = Math.abs(Number(match.netRate) - r.net_rate);
        if (diff <= 0.005) {
          planRates.push({
            action: 'keep',
            existingRateId: match.id,
            hotelSlug: h.slug,
            roomName: r.room_name,
            seasonName: r.season_name,
            mealPlan: r.meal_plan,
            occupancy: r.occupancy,
            concept: r.concept,
            priceKind: r.price_kind,
            pricingUnit: r.pricing_unit,
            netRate: r.net_rate,
          });
        } else {
          // Changed price: deactivate old, create new
          planRates.push({
            action: 'deactivate',
            existingRateId: match.id,
            hotelSlug: h.slug,
            roomName: r.room_name,
            seasonName: r.season_name,
            mealPlan: r.meal_plan,
            occupancy: r.occupancy,
            concept: r.concept,
            priceKind: r.price_kind,
            pricingUnit: r.pricing_unit,
            netRate: Number(match.netRate),
            reason: `Price updated from ${match.netRate} to ${r.net_rate}`,
          });
          planRates.push({
            action: 'create',
            hotelSlug: h.slug,
            roomName: r.room_name,
            seasonName: r.season_name,
            mealPlan: r.meal_plan,
            occupancy: r.occupancy,
            concept: r.concept,
            priceKind: r.price_kind,
            pricingUnit: r.pricing_unit,
            netRate: r.net_rate,
          });
        }
      } else {
        planRates.push({
          action: 'create',
          hotelSlug: h.slug,
          roomName: r.room_name,
          seasonName: r.season_name,
          mealPlan: r.meal_plan,
          occupancy: r.occupancy,
          concept: r.concept,
          priceKind: r.price_kind,
          pricingUnit: r.pricing_unit,
          netRate: r.net_rate,
        });
      }
    }

    // Existing active rates not in sheet -> deactivate
    for (const er of existingRates) {
      if (er.isActive && !seenExistingRateIds.has(er.id)) {
        planRates.push({
          action: 'deactivate',
          existingRateId: er.id,
          hotelSlug: h.slug,
          roomName: er.roomName || 'Unknown',
          seasonName: er.seasonName || 'Unknown',
          mealPlan: er.mealPlan,
          occupancy: er.occupancy,
          concept: er.concept,
          priceKind: er.priceKind,
          pricingUnit: er.pricingUnit,
          netRate: Number(er.netRate),
          reason: 'Removed from supplier tarifario',
        });
      }
    }
  }

  const summary = {
    hotelsToCreate: planHotels.filter((h) => h.action === 'create_draft').length,
    ratesToCreate: planRates.filter((r) => r.action === 'create').length,
    ratesToDeactivate: planRates.filter((r) => r.action === 'deactivate').length,
    ratesUnchanged: planRates.filter((r) => r.action === 'keep').length,
    manualReviewCount: planRates.filter((r) => r.action === 'manual_review').length,
  };

  const lines = [
    `# Tarifario Import Plan (${doc.source})`,
    `Snapshot Hash: \`${snapshotHash}\``,
    '',
    '## Summary',
    `- Hotels to create (draft): ${summary.hotelsToCreate}`,
    `- Rates to create: ${summary.ratesToCreate}`,
    `- Rates to deactivate: ${summary.ratesToDeactivate}`,
    `- Rates unchanged: ${summary.ratesUnchanged}`,
    `- Rates flagged for manual review: ${summary.manualReviewCount}`,
    '',
    '## Changes Breakdown',
  ];

  for (const r of planRates) {
    if (r.action === 'keep') continue;
    lines.push(
      `- [${r.action.toUpperCase()}] Hotel: ${r.hotelSlug} | Room: ${r.roomName} | Meal: ${r.mealPlan} | Occ: ${r.occupancy ?? 'any'} | Rate: $${r.netRate} (${r.reason || 'new'})`
    );
  }

  const diffMarkdown = lines.join('\n');
  const planId = crypto.randomUUID();

  return {
    planId,
    snapshotHash,
    source: doc.source,
    hotels: planHotels,
    rates: planRates,
    summary,
    diffMarkdown,
  };
}
