import { describe, it, expect } from 'vitest';
import { tarifarioSchema, TarifarioDocument } from '../../src/modules/tarifario/schema.js';
import { computeImportPlan } from '../../src/modules/tarifario/diff.js';

describe('Tarifario Schema and Diff Engine', () => {
  const sampleDoc: TarifarioDocument = {
    format_version: '1.0',
    source: 'proveedor_caribe_2026.xlsx',
    hotels: [
      {
        slug: 'hotel-playa-el-agua',
        name: 'Hotel Playa El Agua',
        destination: 'Isla de Margarita',
        category: 'Hotel',
        currency: 'USD',
        is_solo_divisas: false,
        rooms: [
          { name: 'Habitación Estándar', max_occupancy: 3 },
          { name: 'Suite Familiar', max_occupancy: 5 },
        ],
        seasons: [
          {
            name: 'Temporada Alta 2026',
            priority: 1,
            date_from: '2026-11-01',
            date_to: '2026-11-30',
            booking_from: null,
            booking_to: null,
          },
        ],
        rates: [
          {
            room_name: 'Habitación Estándar',
            season_name: 'Temporada Alta 2026',
            meal_plan: 'desayuno',
            concept: 'OCUPACION',
            price_kind: 'IMPORTE',
            occupancy: 2,
            pricing_unit: 'per_room',
            net_rate: 100,
            days_of_week: [],
            min_nights: 1,
            max_nights: null,
            child_age_min: null,
            child_age_max: null,
          },
          {
            room_name: 'Habitación Estándar',
            season_name: 'Temporada Alta 2026',
            meal_plan: 'todo_incluido',
            concept: 'OCUPACION',
            price_kind: 'BAJO_PEDIDO',
            occupancy: 2,
            pricing_unit: 'per_room',
            net_rate: 0,
            days_of_week: [],
            min_nights: 1,
            max_nights: null,
            child_age_min: null,
            child_age_max: null,
          },
        ],
      },
    ],
  };

  it('validates normalized tarifario schema', () => {
    const parsed = tarifarioSchema.parse(sampleDoc);
    expect(parsed.format_version).toBe('1.0');
    expect(parsed.hotels).toHaveLength(1);
  });

  it('computes import plan against existing hotel database snapshot', () => {
    const existingHotels = [
      {
        id: 'h-1',
        slug: 'hotel-playa-el-agua',
        name: 'Hotel Playa El Agua',
        destination: 'Isla de Margarita',
        category: 'Hotel',
        baseCurrency: 'USD',
        isSoloDivisas: false,
        rooms: [{ id: 'rm-1', name: 'Habitación Estándar', maxOccupancy: 3 }],
        seasons: [
          {
            id: 's-1',
            name: 'Temporada Alta 2026',
            rates: [
              {
                id: 'r-1',
                roomTypeId: 'rm-1',
                seasonId: 's-1',
                mealPlan: 'desayuno',
                concept: 'OCUPACION',
                priceKind: 'IMPORTE',
                occupancy: 2,
                pricingUnit: 'per_room',
                netRate: '100.00',
                minNights: 1,
                isActive: true,
              },
            ],
          },
        ],
      },
    ];

    const plan = computeImportPlan(sampleDoc, existingHotels);
    expect(plan.snapshotHash).toBeTruthy();
    expect(plan.summary.hotelsToCreate).toBe(0);
    expect(plan.summary.ratesUnchanged).toBe(1); // Standard desayuno 100 is unchanged
    expect(plan.summary.manualReviewCount).toBe(1); // BAJO_PEDIDO is flagged for manual review
    expect(plan.diffMarkdown).toContain('BAJO_PEDIDO');
  });

  it('flags modified rates to deactivate old and create new', () => {
    const existingHotels = [
      {
        id: 'h-1',
        slug: 'hotel-playa-el-agua',
        name: 'Hotel Playa El Agua',
        destination: 'Isla de Margarita',
        category: 'Hotel',
        baseCurrency: 'USD',
        isSoloDivisas: false,
        rooms: [{ id: 'rm-1', name: 'Habitación Estándar', maxOccupancy: 3 }],
        seasons: [
          {
            id: 's-1',
            name: 'Temporada Alta 2026',
            rates: [
              {
                id: 'r-1',
                roomTypeId: 'rm-1',
                seasonId: 's-1',
                mealPlan: 'desayuno',
                concept: 'OCUPACION',
                priceKind: 'IMPORTE',
                occupancy: 2,
                pricingUnit: 'per_room',
                netRate: '80.00', // Previous was 80, new is 100
                minNights: 1,
                isActive: true,
              },
            ],
          },
        ],
      },
    ];

    const plan = computeImportPlan(sampleDoc, existingHotels);
    expect(plan.summary.ratesToDeactivate).toBe(1);
    expect(plan.summary.ratesToCreate).toBe(1);
  });
});
