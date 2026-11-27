import '../src/config/env.js';
import {
  PriceKind,
  PricingUnit,
  PrismaClient,
  RateConcept,
} from '@prisma/client';

const prisma = new PrismaClient();

const ROOM_TYPES = [
  { name: 'Standard', maxOccupancy: 2 },
  { name: 'Deluxe', maxOccupancy: 3 },
  { name: 'Suite', maxOccupancy: 4 },
];

const SEASON_TEMPLATES = [
  { name: 'Temporada Alta', priority: 5, from: '2026-12-01', to: '2027-02-28', markup: 1.3 },
  { name: 'Temporada Regular', priority: 1, from: '2027-03-01', to: '2027-05-31', markup: 1 },
  { name: 'Temporada Verano', priority: 4, from: '2027-06-01', to: '2027-08-31', markup: 1.2 },
  { name: 'Temporada Baja', priority: 2, from: '2027-09-01', to: '2027-11-30', markup: 0.9 },
  { name: 'Fin de Año', priority: 6, from: '2027-12-01', to: '2028-02-29', markup: 1.45 },
];

function countFor(seed: number, min: number, max: number): number {
  return min + (Math.abs(seed) % (max - min + 1));
}

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

async function main() {
  const hotels = await prisma.hotel.findMany({
    select: { id: true, name: true, _count: { select: { seasons: true, rooms: true } } },
    orderBy: { name: 'asc' },
  });

  let hotelsFilled = 0;
  let seasonsCreated = 0;
  let roomsCreated = 0;
  let ratesCreated = 0;

  for (let index = 0; index < hotels.length; index++) {
    const hotel = hotels[index];
    if (hotel._count.seasons > 0) continue;

    const rooms =
      hotel._count.rooms > 0
        ? await prisma.roomType.findMany({ where: { hotelId: hotel.id } })
        : [];

    if (rooms.length === 0) {
      for (const room of ROOM_TYPES) {
        rooms.push(
          await prisma.roomType.create({
            data: { hotelId: hotel.id, name: room.name, maxOccupancy: room.maxOccupancy, isActive: true },
          })
        );
        roomsCreated++;
      }
    }

    const seasonCount = countFor(index, 3, 5);
    const rateCount = countFor(index + 7, 3, 5);
    const base = 80 + (index % 40) * 5;

    for (let s = 0; s < seasonCount; s++) {
      const template = SEASON_TEMPLATES[s];
      const season = await prisma.season.create({
        data: {
          hotelId: hotel.id,
          name: template.name,
          priority: template.priority,
          dateFrom: day(template.from),
          dateTo: day(template.to),
          bookingFrom: day('2026-11-26'),
          bookingTo: day(template.to),
          isActive: true,
        },
      });
      seasonsCreated++;

      const plans = [
        { mealPlan: 'BB', concept: RateConcept.OCUPACION, unit: PricingUnit.per_room, add: 0 },
        { mealPlan: 'MAP', concept: RateConcept.OCUPACION, unit: PricingUnit.per_person, add: 25 },
        { mealPlan: 'BB', concept: RateConcept.OCUPACION, unit: PricingUnit.per_person, add: -30 },
        { mealPlan: 'AI', concept: RateConcept.OCUPACION, unit: PricingUnit.per_room, add: 55 },
        { mealPlan: 'BB', concept: RateConcept.OCUPACION, unit: PricingUnit.per_person, add: 20 },
      ];

      for (let r = 0; r < rateCount; r++) {
        const plan = plans[r];
        const room = rooms[r % rooms.length];
        const net = Math.round((base + plan.add) * template.markup * 100) / 100;
        const markupPercent = 12;
        await prisma.rate.create({
          data: {
            roomTypeId: room.id,
            seasonId: season.id,
            mealPlan: plan.mealPlan,
            concept: plan.concept,
            priceKind: PriceKind.IMPORTE,
            pricingUnit: plan.unit,
            netRate: net,
            markupPercent,
            sellRate: Math.round(net * (1 + markupPercent / 100) * 100) / 100,
            minNights: 1,
            isActive: true,
          },
        });
        ratesCreated++;
      }
    }

    hotelsFilled++;
  }

  console.log(
    `Filled ${hotelsFilled} hotels: ${roomsCreated} room types, ${seasonsCreated} seasons, ${ratesCreated} rates. Hotels that already had seasons were left as they are.`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
