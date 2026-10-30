import {
  PrismaClient,
  BookingStatus,
  PaymentMethod,
  PaymentStatus,
  CheckStatus,
  ImageStatus,
  Currency,
  AvailabilityMode,
  RateConcept,
  PriceKind,
  PricingUnit,
  Role,
  RateSource,
} from '@prisma/client';
import argon2 from 'argon2';
import crypto from 'node:crypto';

const prisma = new PrismaClient();

export async function main() {
  console.log('🌱 Starting comprehensive database seed for Vuelitos Hotels...');

  // 1. Clean existing records safely with triggers disabled on immutable tables
  console.log('🧹 Cleaning previous seed data...');
  await prisma.$executeRawUnsafe('ALTER TABLE booking_events DISABLE TRIGGER ALL;');
  await prisma.$executeRawUnsafe('DELETE FROM booking_events;');
  await prisma.$executeRawUnsafe('ALTER TABLE booking_events ENABLE TRIGGER ALL;');
  await prisma.$executeRawUnsafe('DELETE FROM payments;');
  await prisma.$executeRawUnsafe('DELETE FROM availability_checks;');
  await prisma.$executeRawUnsafe('DELETE FROM booking_items;');
  await prisma.$executeRawUnsafe('DELETE FROM bookings;');
  await prisma.$executeRawUnsafe('DELETE FROM rates;');
  await prisma.$executeRawUnsafe('DELETE FROM seasons;');
  await prisma.$executeRawUnsafe('DELETE FROM room_types;');
  await prisma.$executeRawUnsafe('DELETE FROM hotel_payment_tax_rules;');
  await prisma.$executeRawUnsafe('DELETE FROM hotel_images;');
  await prisma.$executeRawUnsafe('DELETE FROM hotels;');
  await prisma.$executeRawUnsafe('DELETE FROM exchange_rates;');
  await prisma.$executeRawUnsafe('DELETE FROM holidays;');
  await prisma.$executeRawUnsafe('DELETE FROM sessions;');
  await prisma.$executeRawUnsafe('DELETE FROM staff_users;');
  try {
    const { redis } = await import('../src/lib/redis.js');
    await redis.del('exchange:latest');
  } catch {}

  // 2. Seed Exchange Rates
  console.log('💱 Seeding exchange rates...');
  await prisma.exchangeRate.create({
    data: {
      bcvUsd: 45.00,
      bcvEur: 49.00,
      binanceUsdt: 46.80,
      bcvUsdSource: 'Banco Central de Venezuela (BCV)',
      bcvEurSource: 'Banco Central de Venezuela (BCV)',
      usdtSource: 'Binance P2P VES/USDT',
      recordedAt: new Date(),
      fetchedAt: new Date(),
      bcvValueDate: new Date('2026-10-30T00:00:00Z'),
      source: RateSource.manual,
      isManualOverride: true,
    },
  });

  // 3. Seed Venezuelan Holidays (2026-2027)
  console.log('📅 Seeding national holidays...');
  const holidaysData = [
    { date: new Date('2026-01-01T00:00:00Z'), name: 'Año Nuevo' },
    { date: new Date('2026-02-16T00:00:00Z'), name: 'Lunes de Carnaval' },
    { date: new Date('2026-02-17T00:00:00Z'), name: 'Martes de Carnaval' },
    { date: new Date('2026-04-02T00:00:00Z'), name: 'Jueves Santo' },
    { date: new Date('2026-04-03T00:00:00Z'), name: 'Viernes Santo' },
    { date: new Date('2026-04-19T00:00:00Z'), name: 'Declaración de la Independencia' },
    { date: new Date('2026-05-01T00:00:00Z'), name: 'Día del Trabajador' },
    { date: new Date('2026-06-24T00:00:00Z'), name: 'Batalla de Carabobo' },
    { date: new Date('2026-07-05T00:00:00Z'), name: 'Día de la Independencia' },
    { date: new Date('2026-07-24T00:00:00Z'), name: 'Natalicio del Libertador Simón Bolívar' },
    { date: new Date('2026-10-12T00:00:00Z'), name: 'Día de la Resistencia Indígena' },
    { date: new Date('2026-12-25T00:00:00Z'), name: 'Navidad' },
    { date: new Date('2027-01-01T00:00:00Z'), name: 'Año Nuevo 2027' },
    { date: new Date('2027-02-08T00:00:00Z'), name: 'Carnaval 2027' },
    { date: new Date('2027-03-25T00:00:00Z'), name: 'Semana Santa 2027' },
    { date: new Date('2027-05-01T00:00:00Z'), name: 'Día del Trabajador 2027' },
    { date: new Date('2027-12-25T00:00:00Z'), name: 'Navidad 2027' },
  ];
  for (const h of holidaysData) {
    await prisma.holiday.create({ data: h });
  }

  // 4. Seed Staff Users (Admin & Agent)
  console.log('👤 Seeding staff users...');
  const adminPasswordHash = await argon2.hash('Admin123!', { type: argon2.argon2id });
  const agentPasswordHash = await argon2.hash('Agent123!', { type: argon2.argon2id });

  await prisma.staffUser.createMany({
    data: [
      {
        email: 'admin@vuelitos.com',
        passwordHash: adminPasswordHash,
        role: Role.super_admin,
      },
      {
        email: 'agent@vuelitos.com',
        passwordHash: agentPasswordHash,
        role: Role.agent,
      },
    ],
  });

  // 5. Seed Hotels
  console.log('🏨 Seeding 8 realistic hotels across top destinations...');

  const hotelsToSeed = [
    {
      slug: 'gran-melia-caracas',
      name: 'Gran Meliá Caracas & Suites',
      destination: 'Caracas',
      category: 'Luxury',
      starRating: 5,
      baseCurrency: Currency.USD,
      isSoloDivisas: false,
      defaultCommissionPercent: 12.00,
      availabilityMode: AvailabilityMode.manual,
      coverImageUrl: 'https://images.unsplash.com/photo-1566073771259-6a8506099945?auto=format&fit=crop&w=1200&q=80',
      description: 'Emblemático hotel 5 estrellas en Sabana Grande y El Recreo. Cuenta con habitaciones y suites de lujo con vistas panorámicas al Cerro El Ávila, tres restaurantes galardonados, piscina templada al aire libre y spa de clase mundial.',
      gallery: [
        'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=1000&q=80',
        'https://images.unsplash.com/photo-1590490360182-c33d57733427?auto=format&fit=crop&w=1000&q=80',
        'https://images.unsplash.com/photo-1584132967334-10e028bd69f7?auto=format&fit=crop&w=1000&q=80',
      ],
      rooms: [
        { name: 'Habitación Clásica Deluxe', maxOccupancy: 2, netRate: 140.00 },
        { name: 'Executive Ávila Suite', maxOccupancy: 3, netRate: 210.00 },
        { name: 'Grand Royal Presidential Suite', maxOccupancy: 4, netRate: 340.00 },
      ],
      mealPlans: ['CP', 'MAP', 'EP'],
    },
    {
      slug: 'hesperia-isla-margarita',
      name: 'Hesperia Isla Margarita Resort & Golf',
      destination: 'Isla de Margarita',
      category: 'Resort',
      starRating: 5,
      baseCurrency: Currency.USD,
      isSoloDivisas: false,
      defaultCommissionPercent: 15.00,
      availabilityMode: AvailabilityMode.manual,
      coverImageUrl: 'https://images.unsplash.com/photo-1582719508461-905c673771fd?auto=format&fit=crop&w=1200&q=80',
      description: 'El resort de playa más completo de Nueva Esparta, ubicado en el Valle de Pedro González. Campo de golf profesional de 18 hoyos, acceso directo a playa privada, piscinas en cascada y exclusivo régimen todo incluido con cocina internacional.',
      gallery: [
        'https://images.unsplash.com/photo-1571003123894-1f0594d2b5d9?auto=format&fit=crop&w=1000&q=80',
        'https://images.unsplash.com/photo-1540541338287-41700207dee6?auto=format&fit=crop&w=1000&q=80',
        'https://images.unsplash.com/photo-1561501900-3701fa6a0864?auto=format&fit=crop&w=1000&q=80',
      ],
      rooms: [
        { name: 'Habitación Doble Vista al Mar', maxOccupancy: 3, netRate: 140.00 },
        { name: 'Junior Suite Golf & Mar', maxOccupancy: 4, netRate: 220.00 },
        { name: 'Villa Familiar de Playa', maxOccupancy: 6, netRate: 320.00 },
      ],
      mealPlans: ['AI', 'MAP', 'CP'],
    },
    {
      slug: 'posada-acuarela-los-roques',
      name: 'Posada Acuarela Boutique',
      destination: 'Los Roques',
      category: 'Boutique',
      starRating: 4,
      baseCurrency: Currency.USD,
      isSoloDivisas: true,
      defaultCommissionPercent: 15.00,
      availabilityMode: AvailabilityMode.manual,
      coverImageUrl: 'https://images.unsplash.com/photo-1540555700478-4be289fbecef?auto=format&fit=crop&w=1200&q=80',
      description: 'Joyel arquitectónico en el Gran Roque con terrazas diseñadas por artistas italianos. Patios coloniales repletos de vegetación marina, gastronomía de autor a base de pesca fresca del archipiélago y excursiones diarias a los cayos vírgenes.',
      gallery: [
        'https://images.unsplash.com/photo-1507525428033-b723cf961d3e?auto=format&fit=crop&w=1000&q=80',
        'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?auto=format&fit=crop&w=1000&q=80',
        'https://images.unsplash.com/photo-1512917774080-9991f1c4c750?auto=format&fit=crop&w=1000&q=80',
      ],
      rooms: [
        { name: 'Habitación Superior Jardín', maxOccupancy: 2, netRate: 190.00 },
        { name: 'Suite Terraza Brisa Marina', maxOccupancy: 3, netRate: 280.00 },
      ],
      mealPlans: ['MAP', 'AP'],
    },
    {
      slug: 'waku-lodge-canaima',
      name: 'Waku Lodge Canaima',
      destination: 'Canaima',
      category: 'Eco-Lodge',
      starRating: 5,
      baseCurrency: Currency.USD,
      isSoloDivisas: true,
      defaultCommissionPercent: 15.00,
      availabilityMode: AvailabilityMode.manual,
      coverImageUrl: 'https://images.unsplash.com/photo-1571896349842-33c89424de2d?auto=format&fit=crop&w=1200&q=80',
      description: 'Alojamiento ecoturístico prémium frente a la Laguna de Canaima. Vista incomparable a las cataratas Ucaima, Golondrina y Hacha. Paquetes todo incluido con traslados fluviales en curiara pemona y sobrevuelo al Kerepakupai Vená (Salto Ángel).',
      gallery: [
        'https://images.unsplash.com/photo-1470071459604-3b5ec3a7fe05?auto=format&fit=crop&w=1000&q=80',
        'https://images.unsplash.com/photo-1518780664697-55e3ad937233?auto=format&fit=crop&w=1000&q=80',
        'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1000&q=80',
      ],
      rooms: [
        { name: 'Habitación Estándar Selva', maxOccupancy: 2, netRate: 210.00 },
        { name: 'Suite Mirador Laguna & Saltos', maxOccupancy: 3, netRate: 290.00 },
        { name: 'Bungalow Tepuy Familiar', maxOccupancy: 5, netRate: 360.00 },
      ],
      mealPlans: ['AP', 'AI'],
    },
    {
      slug: 'posada-la-esmeralda-morrocoy',
      name: 'Posada La Esmeralda Morrocoy',
      destination: 'Morrocoy',
      category: 'Boutique',
      starRating: 4,
      baseCurrency: Currency.USD,
      isSoloDivisas: false,
      defaultCommissionPercent: 12.00,
      availabilityMode: AvailabilityMode.manual,
      coverImageUrl: 'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?auto=format&fit=crop&w=1200&q=80',
      description: 'Posada boutique con embarcadero privado para botes deportivos directo a Cayo Sombrero, Cayo Muerto y Playa Azul. Ambiente íntimo y exclusivo, piscina de agua dulce entre cocoteros y menú caribeño gourmet.',
      gallery: [
        'https://images.unsplash.com/photo-1544644181-1484b3fdfc62?auto=format&fit=crop&w=1000&q=80',
        'https://images.unsplash.com/photo-1563911302283-d2bc129e7570?auto=format&fit=crop&w=1000&q=80',
        'https://images.unsplash.com/photo-1571896349842-33c89424de2d?auto=format&fit=crop&w=1000&q=80',
      ],
      rooms: [
        { name: 'Habitación Coralina', maxOccupancy: 2, netRate: 110.00 },
        { name: 'Suite Manglar con Balcón', maxOccupancy: 3, netRate: 175.00 },
        { name: 'Cabaña Familiar Morrocoy', maxOccupancy: 5, netRate: 290.00 },
      ],
      mealPlans: ['CP', 'MAP'],
    },
    {
      slug: 'paradise-hotel-puerto-la-cruz',
      name: 'Paradise Hotel & Marina Puerto La Cruz',
      destination: 'Puerto La Cruz',
      category: 'Resort',
      starRating: 4,
      baseCurrency: Currency.USD,
      isSoloDivisas: false,
      defaultCommissionPercent: 10.00,
      availabilityMode: AvailabilityMode.manual,
      coverImageUrl: 'https://images.unsplash.com/photo-1571003123894-1f0594d2b5d9?auto=format&fit=crop&w=1200&q=80',
      description: 'Complejo hotelero de sol y playa con marina propia para zarpar hacia las islas vírgenes del Parque Nacional Mochima. Amplias piscinas con toboganes, restaurantes de mariscos y modernas salas para convenciones.',
      gallery: [
        'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=1000&q=80',
        'https://images.unsplash.com/photo-1566073771259-6a8506099945?auto=format&fit=crop&w=1000&q=80',
        'https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?auto=format&fit=crop&w=1000&q=80',
      ],
      rooms: [
        { name: 'Habitación Estándar Marina', maxOccupancy: 3, netRate: 85.00 },
        { name: 'Suite Ejecutiva Vista Bahía', maxOccupancy: 2, netRate: 135.00 },
        { name: 'Suite Familiar Mochima', maxOccupancy: 4, netRate: 210.00 },
      ],
      mealPlans: ['EP', 'CP', 'MAP'],
    },
    {
      slug: 'estancia-san-francisco-merida',
      name: 'Estancia San Francisco Eco-Lodge',
      destination: 'Mérida',
      category: 'Eco-Lodge',
      starRating: 4,
      baseCurrency: Currency.USD,
      isSoloDivisas: false,
      defaultCommissionPercent: 10.00,
      availabilityMode: AvailabilityMode.manual,
      coverImageUrl: 'https://images.unsplash.com/photo-1445019980597-93fa8acb246c?auto=format&fit=crop&w=1200&q=80',
      description: 'Refugio de montaña rodeado de pinos y senderos andinos en el Valle de San Javier, Mérida. Cabañas rústicas con chimeneas de leña, chocolate caliente artesanal, cabalgatas guiadas y excursiones al Sistema Teleférico Mukumbarí.',
      gallery: [
        'https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?auto=format&fit=crop&w=1000&q=80',
        'https://images.unsplash.com/photo-1510798831971-661eb04b3739?auto=format&fit=crop&w=1000&q=80',
        'https://images.unsplash.com/photo-1506744038136-46273834b3fb?auto=format&fit=crop&w=1000&q=80',
      ],
      rooms: [
        { name: 'Habitación Andina con Chimenea', maxOccupancy: 2, netRate: 65.00 },
        { name: 'Cabaña de Montaña San Javier', maxOccupancy: 4, netRate: 120.00 },
        { name: 'Master Chalet Nevado', maxOccupancy: 6, netRate: 230.00 },
      ],
      mealPlans: ['CP', 'MAP'],
    },
    {
      slug: 'eurobuilding-hotel-caracas',
      name: 'Eurobuilding Hotel & Suites Caracas',
      destination: 'Caracas',
      category: 'Business',
      starRating: 5,
      baseCurrency: Currency.USD,
      isSoloDivisas: false,
      defaultCommissionPercent: 12.00,
      availabilityMode: AvailabilityMode.manual,
      coverImageUrl: 'https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?auto=format&fit=crop&w=1200&q=80',
      description: 'El epicentro corporativo y de eventos en Chuao, Caracas. Cuenta con el prestigioso Business Class Floor, salones de conferencias de alta tecnología, sushi bar, piscina al aire libre y canchas de tenis.',
      gallery: [
        'https://images.unsplash.com/photo-1590490360182-c33d57733427?auto=format&fit=crop&w=1000&q=80',
        'https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&w=1000&q=80',
        'https://images.unsplash.com/photo-1566073771259-6a8506099945?auto=format&fit=crop&w=1000&q=80',
      ],
      rooms: [
        { name: 'Habitación Deluxe King', maxOccupancy: 2, netRate: 130.00 },
        { name: 'Business Class Executive Suite', maxOccupancy: 3, netRate: 200.00 },
        { name: 'Grand Presidential Suite', maxOccupancy: 4, netRate: 340.00 },
      ],
      mealPlans: ['EP', 'CP'],
    },
  ];

  interface HotelEntities {
    hotel: any;
    rooms: any[];
    seasons: any[];
  }

  const seededHotels: Record<string, HotelEntities> = {};

  for (const h of hotelsToSeed) {
    // 1. Create Hotel
    const hotel = await prisma.hotel.create({
      data: {
        slug: h.slug,
        name: h.name,
        destination: h.destination,
        category: h.category,
        starRating: h.starRating,
        baseCurrency: h.baseCurrency,
        isSoloDivisas: h.isSoloDivisas,
        defaultCommissionPercent: h.defaultCommissionPercent,
        availabilityMode: h.availabilityMode,
        isActive: true,
        description: h.description,
        coverImageUrl: h.coverImageUrl,
        coverImageKey: `${h.slug}-cover`,
      },
    });

    // 2. Create Gallery Images
    let sortIdx = 0;
    for (const imgUrl of h.gallery) {
      await prisma.hotelImage.create({
        data: {
          hotelId: hotel.id,
          key: `${h.slug}-gallery-${sortIdx + 1}`,
          sourceUrl: imgUrl,
          sourceKind: 'unsplash',
          status: ImageStatus.published,
          sortOrder: sortIdx,
          alt: `${h.name} - Galería ${sortIdx + 1}`,
        },
      });
      sortIdx++;
    }

    // 3. Create Payment Tax Rules
    const paymentMethods: PaymentMethod[] = [
      PaymentMethod.stripe_card,
      PaymentMethod.pago_movil,
      PaymentMethod.bs_transfer,
      PaymentMethod.zelle,
      PaymentMethod.usdt_binance,
      PaymentMethod.cash_usd,
      PaymentMethod.cash_eur,
    ];

    for (const method of paymentMethods) {
      const isCard = method === PaymentMethod.stripe_card;
      const isBs = method === PaymentMethod.pago_movil || method === PaymentMethod.bs_transfer;
      const iva = h.isSoloDivisas ? 0.0000 : (isCard || isBs ? 0.1600 : 0.0000);
      const surcharge = isCard ? 3.00 : null;

      await prisma.hotelPaymentTaxRule.create({
        data: {
          hotelId: hotel.id,
          method,
          ivaRate: iva,
          surchargePercent: surcharge,
        },
      });
    }

    // 4. Create Room Types
    const createdRooms = [];
    for (const r of h.rooms) {
      const room = await prisma.roomType.create({
        data: {
          hotelId: hotel.id,
          name: r.name,
          maxOccupancy: r.maxOccupancy,
          isActive: true,
        },
      });
      createdRooms.push({ ...room, baseNetRate: r.netRate });
    }

    // 5. Create Active Seasons (covering 2026 and 2027)
    const seasonsData = [
      {
        name: 'Temporada Regular 2026-2027',
        priority: 1,
        dateFrom: new Date('2026-01-01T00:00:00Z'),
        dateTo: new Date('2027-12-31T00:00:00Z'),
        bookingFrom: new Date('2025-10-01T00:00:00Z'),
        bookingTo: new Date('2027-12-31T00:00:00Z'),
        rateMultiplier: 1.0,
      },
      {
        name: 'Temporada Alta Vacaciones 2026-2027',
        priority: 5,
        dateFrom: new Date('2026-07-01T00:00:00Z'),
        dateTo: new Date('2026-09-15T00:00:00Z'),
        bookingFrom: new Date('2025-10-01T00:00:00Z'),
        bookingTo: new Date('2026-09-15T00:00:00Z'),
        rateMultiplier: 1.25,
      },
    ];

    const createdSeasons = [];
    for (const s of seasonsData) {
      const season = await prisma.season.create({
        data: {
          hotelId: hotel.id,
          name: s.name,
          priority: s.priority,
          dateFrom: s.dateFrom,
          dateTo: s.dateTo,
          bookingFrom: s.bookingFrom,
          bookingTo: s.bookingTo,
          isActive: true,
        },
      });
      createdSeasons.push(season);

      // 6. Create Rates for each Room and Meal Plan in this Season
      for (const room of createdRooms) {
        for (const mp of h.mealPlans) {
          let mpAdditive = 0;
          if (mp === 'CP') mpAdditive = 15;
          if (mp === 'MAP') mpAdditive = 35;
          if (mp === 'AP') mpAdditive = 55;
          if (mp === 'AI') mpAdditive = 75;

          const baseNet = (room.baseNetRate + mpAdditive) * s.rateMultiplier;
          const markup = 12.0;
          const sellRate = Math.round(baseNet * (1 + markup / 100) * 100) / 100;

          await prisma.rate.create({
            data: {
              roomTypeId: room.id,
              seasonId: season.id,
              mealPlan: mp,
              concept: RateConcept.OCUPACION,
              priceKind: PriceKind.IMPORTE,
              pricingUnit: PricingUnit.per_room,
              occupancy: null,
              netRate: baseNet,
              markupPercent: markup,
              sellRate: sellRate,
              daysOfWeek: [],
              minNights: 1,
              isActive: true,
            },
          });
        }
      }
    }

    seededHotels[h.slug] = {
      hotel,
      rooms: createdRooms,
      seasons: createdSeasons,
    };
  }

  // 6. Seed Realistic Dummy Bookings
  console.log('📋 Seeding 16 realistic dummy bookings across full lifecycle...');

  const now = new Date();
  const MS_PER_HOUR = 60 * 60 * 1000;
  const MS_PER_DAY = 24 * MS_PER_HOUR;

  interface BookingDefinition {
    code: string;
    hotelSlug: string;
    roomIndex: number;
    mealPlan: string;
    status: BookingStatus;
    userId: string | null;
    contactName: string;
    contactEmail: string;
    contactPhone: string;
    notes: string;
    paymentMethodPref: PaymentMethod;
    checkInOffsetDays: number;
    durationNights: number;
    adults: number;
    children: number;
    basePriceTotal: number;
    slaHoursLeft: number | null;
    payment?: {
      method: PaymentMethod;
      currency: string;
      reference: string;
      status: PaymentStatus;
      amount: number;
      offsetHoursSubmitted: number;
      offsetHoursVerified?: number;
      verifiedBy?: string;
    };
  }

  const bookingDefinitions: BookingDefinition[] = [
    // 1. Requested (Guest, active SLA countdown)
    {
      code: 'VH-2026-000101',
      hotelSlug: 'gran-melia-caracas',
      roomIndex: 0,
      mealPlan: 'CP',
      status: BookingStatus.requested,
      userId: null,
      contactName: 'Carlos Eduardo Mendoza',
      contactEmail: 'carlos.mendoza@gmail.com',
      contactPhone: '+58 412-5550192',
      notes: 'Solicitud de piso alto con vista panorámica a El Ávila. Llegada estimada a las 16:00.',
      paymentMethodPref: PaymentMethod.zelle,
      checkInOffsetDays: 12,
      durationNights: 3,
      adults: 2,
      children: 0,
      basePriceTotal: 465.00,
      slaHoursLeft: 3.5,
    },
    // 2. Requested (Customer userId: "1", active SLA countdown)
    {
      code: 'VH-2026-000102',
      hotelSlug: 'hesperia-isla-margarita',
      roomIndex: 0,
      mealPlan: 'AI',
      status: BookingStatus.requested,
      userId: '1',
      contactName: 'Valentina Gómez Silva',
      contactEmail: 'valentina.gomez@hotmail.com',
      contactPhone: '+58 414-8899123',
      notes: 'Viaje de aniversario familiar. Solicitamos cuna para infante de 1 año.',
      paymentMethodPref: PaymentMethod.stripe_card,
      checkInOffsetDays: 20,
      durationNights: 4,
      adults: 2,
      children: 1,
      basePriceTotal: 940.00,
      slaHoursLeft: 2.1,
    },
    // 3. Checking Availability (Customer userId: "2")
    {
      code: 'VH-2026-000103',
      hotelSlug: 'posada-acuarela-los-roques',
      roomIndex: 1,
      mealPlan: 'MAP',
      status: BookingStatus.checking_availability,
      userId: '2',
      contactName: 'Alejandro Rafael Silva',
      contactEmail: 'alejandro.silva@yahoo.com',
      contactPhone: '+58 424-3321980',
      notes: 'Coordinando vuelo charter de Maiquetía a Los Roques.',
      paymentMethodPref: PaymentMethod.zelle,
      checkInOffsetDays: 15,
      durationNights: 3,
      adults: 2,
      children: 0,
      basePriceTotal: 1065.00,
      slaHoursLeft: 1.2,
    },
    // 4. Checking Availability (Guest, overdue SLA)
    {
      code: 'VH-2026-000104',
      hotelSlug: 'waku-lodge-canaima',
      roomIndex: 0,
      mealPlan: 'AP',
      status: BookingStatus.checking_availability,
      userId: null,
      contactName: 'Marianela Rivas',
      contactEmail: 'marianela.rivas@gmail.com',
      contactPhone: '+58 416-7788990',
      notes: 'Excursión combinada a Salto El Sapo y sobrevuelo a Salto Ángel. SLA vencido para pruebas.',
      paymentMethodPref: PaymentMethod.usdt_binance,
      checkInOffsetDays: 25,
      durationNights: 4,
      adults: 2,
      children: 0,
      basePriceTotal: 1340.00,
      slaHoursLeft: -1.5,
    },
    // 5. Awaiting Payment (Hotel confirmed availability, guest)
    {
      code: 'VH-2026-000105',
      hotelSlug: 'posada-la-esmeralda-morrocoy',
      roomIndex: 0,
      mealPlan: 'CP',
      status: BookingStatus.awaiting_payment,
      userId: null,
      contactName: 'Daniel Enrique Herrera',
      contactEmail: 'daniel.herrera@cantv.net',
      contactPhone: '+58 412-4455667',
      notes: 'Disponibilidad confirmada por posada. Esperando reporte de pago del cliente.',
      paymentMethodPref: PaymentMethod.pago_movil,
      checkInOffsetDays: 8,
      durationNights: 2,
      adults: 2,
      children: 0,
      basePriceTotal: 250.00,
      slaHoursLeft: null,
    },
    // 6. Awaiting Payment (Hotel confirmed, customer userId: "1")
    {
      code: 'VH-2026-000106',
      hotelSlug: 'paradise-hotel-puerto-la-cruz',
      roomIndex: 1,
      mealPlan: 'CP',
      status: BookingStatus.awaiting_payment,
      userId: '1',
      contactName: 'Valentina Gómez Silva',
      contactEmail: 'valentina.gomez@hotmail.com',
      contactPhone: '+58 414-8899123',
      notes: 'Ventana de 48 horas activa para completar el pago.',
      paymentMethodPref: PaymentMethod.stripe_card,
      checkInOffsetDays: 14,
      durationNights: 3,
      adults: 2,
      children: 0,
      basePriceTotal: 450.00,
      slaHoursLeft: null,
    },
    // 7. Awaiting Payment (Hotel confirmed, customer userId: "2")
    {
      code: 'VH-2026-000107',
      hotelSlug: 'estancia-san-francisco-merida',
      roomIndex: 1,
      mealPlan: 'CP',
      status: BookingStatus.awaiting_payment,
      userId: '2',
      contactName: 'Alejandro Rafael Silva',
      contactEmail: 'alejandro.silva@yahoo.com',
      contactPhone: '+58 424-3321980',
      notes: 'Reserva para grupo familiar en cabaña de montaña.',
      paymentMethodPref: PaymentMethod.zelle,
      checkInOffsetDays: 30,
      durationNights: 4,
      adults: 4,
      children: 0,
      basePriceTotal: 540.00,
      slaHoursLeft: null,
    },
    // 8. Payment Submitted (Zelle, customer userId: "1")
    {
      code: 'VH-2026-000108',
      hotelSlug: 'eurobuilding-hotel-caracas',
      roomIndex: 1,
      mealPlan: 'CP',
      status: BookingStatus.payment_submitted,
      userId: '1',
      contactName: 'Valentina Gómez Silva',
      contactEmail: 'valentina.gomez@hotmail.com',
      contactPhone: '+58 414-8899123',
      notes: 'Transferencia Zelle enviada desde cuenta Chase Bank.',
      paymentMethodPref: PaymentMethod.zelle,
      checkInOffsetDays: 10,
      durationNights: 2,
      adults: 2,
      children: 0,
      basePriceTotal: 430.00,
      slaHoursLeft: null,
      payment: {
        method: PaymentMethod.zelle,
        currency: 'USD',
        reference: 'ZEL-89472610-CHASE',
        status: PaymentStatus.submitted,
        amount: 430.00,
        offsetHoursSubmitted: 2,
      },
    },
    // 9. Payment Submitted (Pago Móvil, guest)
    {
      code: 'VH-2026-000109',
      hotelSlug: 'hesperia-isla-margarita',
      roomIndex: 1,
      mealPlan: 'AI',
      status: BookingStatus.payment_submitted,
      userId: null,
      contactName: 'Gabriel José Rivas',
      contactEmail: 'gabriel.rivas@gmail.com',
      contactPhone: '+58 424-9988776',
      notes: 'Comprobante de Pago Móvil Banesco cargado.',
      paymentMethodPref: PaymentMethod.pago_movil,
      checkInOffsetDays: 18,
      durationNights: 3,
      adults: 2,
      children: 2,
      basePriceTotal: 1005.00,
      slaHoursLeft: null,
      payment: {
        method: PaymentMethod.pago_movil,
        currency: 'VES',
        reference: 'PM-BANESCO-772819',
        status: PaymentStatus.submitted,
        amount: 45727.50,
        offsetHoursSubmitted: 3,
      },
    },
    // 10. Payment Verified (Credit card, customer userId: "2")
    {
      code: 'VH-2026-000110',
      hotelSlug: 'gran-melia-caracas',
      roomIndex: 1,
      mealPlan: 'CP',
      status: BookingStatus.payment_verified,
      userId: '2',
      contactName: 'Alejandro Rafael Silva',
      contactEmail: 'alejandro.silva@yahoo.com',
      contactPhone: '+58 424-3321980',
      notes: 'Pago con tarjeta internacional verificado exitosamente.',
      paymentMethodPref: PaymentMethod.stripe_card,
      checkInOffsetDays: 16,
      durationNights: 3,
      adults: 2,
      children: 0,
      basePriceTotal: 705.00,
      slaHoursLeft: null,
      payment: {
        method: PaymentMethod.stripe_card,
        currency: 'USD',
        reference: 'ch_3NzkA1992XkO1L2k',
        status: PaymentStatus.verified,
        amount: 838.95,
        offsetHoursSubmitted: 6,
        offsetHoursVerified: 4,
        verifiedBy: 'admin@vuelitos.com',
      },
    },
    // 11. Confirmed (Payment verified + booking vouchers issued, customer userId: "1")
    {
      code: 'VH-2026-000111',
      hotelSlug: 'waku-lodge-canaima',
      roomIndex: 1,
      mealPlan: 'AP',
      status: BookingStatus.confirmed,
      userId: '1',
      contactName: 'Valentina Gómez Silva',
      contactEmail: 'valentina.gomez@hotmail.com',
      contactPhone: '+58 414-8899123',
      notes: 'Reserva totalmente confirmada. Vouchers de vuelo y hospedaje emitidos.',
      paymentMethodPref: PaymentMethod.zelle,
      checkInOffsetDays: 28,
      durationNights: 3,
      adults: 2,
      children: 0,
      basePriceTotal: 1425.00,
      slaHoursLeft: null,
      payment: {
        method: PaymentMethod.zelle,
        currency: 'USD',
        reference: 'ZEL-55443322-BOFA',
        status: PaymentStatus.verified,
        amount: 1425.00,
        offsetHoursSubmitted: 24,
        offsetHoursVerified: 20,
        verifiedBy: 'agent@vuelitos.com',
      },
    },
    // 12. Confirmed (Guest booking, Binance USDT)
    {
      code: 'VH-2026-000112',
      hotelSlug: 'posada-acuarela-los-roques',
      roomIndex: 0,
      mealPlan: 'MAP',
      status: BookingStatus.confirmed,
      userId: null,
      contactName: 'Guillermo Fernández',
      contactEmail: 'guillermo.fernandez@icloud.com',
      contactPhone: '+58 414-1122334',
      notes: 'Confirmación de luna de miel. Servicio de champaña de bienvenida programado.',
      paymentMethodPref: PaymentMethod.usdt_binance,
      checkInOffsetDays: 22,
      durationNights: 4,
      adults: 2,
      children: 0,
      basePriceTotal: 980.00,
      slaHoursLeft: null,
      payment: {
        method: PaymentMethod.usdt_binance,
        currency: 'USDT',
        reference: 'TX-BINANCE-990011223344',
        status: PaymentStatus.verified,
        amount: 980.00,
        offsetHoursSubmitted: 48,
        offsetHoursVerified: 45,
        verifiedBy: 'admin@vuelitos.com',
      },
    },
    // 13. Confirmed (Customer userId: "2", Eurobuilding)
    {
      code: 'VH-2026-000113',
      hotelSlug: 'eurobuilding-hotel-caracas',
      roomIndex: 0,
      mealPlan: 'EP',
      status: BookingStatus.confirmed,
      userId: '2',
      contactName: 'Alejandro Rafael Silva',
      contactEmail: 'alejandro.silva@yahoo.com',
      contactPhone: '+58 424-3321980',
      notes: 'Viaje corporativo para cumbre empresarial en Caracas.',
      paymentMethodPref: PaymentMethod.stripe_card,
      checkInOffsetDays: 7,
      durationNights: 2,
      adults: 1,
      children: 0,
      basePriceTotal: 260.00,
      slaHoursLeft: null,
      payment: {
        method: PaymentMethod.stripe_card,
        currency: 'USD',
        reference: 'ch_3O7pLm221AaB9990',
        status: PaymentStatus.verified,
        amount: 309.40,
        offsetHoursSubmitted: 12,
        offsetHoursVerified: 10,
        verifiedBy: 'agent@vuelitos.com',
      },
    },
    // 14. Cancelled (Guest cancelled before payment)
    {
      code: 'VH-2026-000114',
      hotelSlug: 'posada-la-esmeralda-morrocoy',
      roomIndex: 0,
      mealPlan: 'CP',
      status: BookingStatus.cancelled,
      userId: null,
      contactName: 'Patricia Morales',
      contactEmail: 'patricia.morales@gmail.com',
      contactPhone: '+58 412-9900112',
      notes: 'Cancelación solicitada por el cliente por motivos personales.',
      paymentMethodPref: PaymentMethod.zelle,
      checkInOffsetDays: -5,
      durationNights: 3,
      adults: 2,
      children: 0,
      basePriceTotal: 375.00,
      slaHoursLeft: null,
    },
    // 15. Refund Pending (Customer userId: "1", confirmed then cancelled)
    {
      code: 'VH-2026-000115',
      hotelSlug: 'hesperia-isla-margarita',
      roomIndex: 0,
      mealPlan: 'AI',
      status: BookingStatus.refund_pending,
      userId: '1',
      contactName: 'Valentina Gómez Silva',
      contactEmail: 'valentina.gomez@hotmail.com',
      contactPhone: '+58 414-8899123',
      notes: 'Cancelación aprobada bajo políticas flexibles. Reembolso en trámite bancario.',
      paymentMethodPref: PaymentMethod.stripe_card,
      checkInOffsetDays: 45,
      durationNights: 5,
      adults: 2,
      children: 0,
      basePriceTotal: 1175.00,
      slaHoursLeft: null,
      payment: {
        method: PaymentMethod.stripe_card,
        currency: 'USD',
        reference: 'ch_3M4qLp887TxB6521',
        status: PaymentStatus.verified,
        amount: 1398.25,
        offsetHoursSubmitted: 72,
        offsetHoursVerified: 70,
        verifiedBy: 'admin@vuelitos.com',
      },
    },
    // 16. Refunded (Customer userId: "2", completed refund)
    {
      code: 'VH-2026-000116',
      hotelSlug: 'paradise-hotel-puerto-la-cruz',
      roomIndex: 0,
      mealPlan: 'CP',
      status: BookingStatus.refunded,
      userId: '2',
      contactName: 'Alejandro Rafael Silva',
      contactEmail: 'alejandro.silva@yahoo.com',
      contactPhone: '+58 424-3321980',
      notes: 'Reembolso procesado en su totalidad mediante transferencia bancaria.',
      paymentMethodPref: PaymentMethod.bs_transfer,
      checkInOffsetDays: -30,
      durationNights: 3,
      adults: 2,
      children: 0,
      basePriceTotal: 300.00,
      slaHoursLeft: null,
      payment: {
        method: PaymentMethod.bs_transfer,
        currency: 'VES',
        reference: 'TRANS-REFUNDED-882910',
        status: PaymentStatus.refunded,
        amount: 13650.00,
        offsetHoursSubmitted: 120,
        offsetHoursVerified: 115,
        verifiedBy: 'admin@vuelitos.com',
      },
    },
  ];

  for (const b of bookingDefinitions) {
    const hotelData = seededHotels[b.hotelSlug];
    if (!hotelData) continue;

    const room = hotelData.rooms[b.roomIndex] || hotelData.rooms[0];
    const checkInDate = new Date(now.getTime() + b.checkInOffsetDays * MS_PER_DAY);
    const checkOutDate = new Date(checkInDate.getTime() + b.durationNights * MS_PER_DAY);

    // Calculate totalsByMethod matching methodTotalSchema
    const baseAmount = b.basePriceTotal;
    const bcvRate = 45.00;
    const isSoloDivisas = hotelData.hotel.isSoloDivisas;
    const ivaRate = isSoloDivisas ? 0 : 0.16;

    const totalsByMethod = [
      {
        method: 'zelle',
        currency: 'USD',
        amount: Math.round(baseAmount * 100) / 100,
        iva_rate: 0,
        iva_amount: 0,
        exchange_rate_used: null,
        is_lowest: true,
      },
      {
        method: 'stripe_card',
        currency: 'USD',
        amount: Math.round(baseAmount * (1 + ivaRate) * 1.03 * 100) / 100,
        iva_rate: ivaRate,
        iva_amount: Math.round(baseAmount * ivaRate * 100) / 100,
        exchange_rate_used: null,
        is_lowest: false,
      },
      {
        method: 'pago_movil',
        currency: 'VES',
        amount: Math.round(baseAmount * (1 + ivaRate) * bcvRate * 100) / 100,
        iva_rate: ivaRate,
        iva_amount: Math.round(baseAmount * ivaRate * bcvRate * 100) / 100,
        exchange_rate_used: bcvRate,
        is_lowest: false,
      },
      {
        method: 'bs_transfer',
        currency: 'VES',
        amount: Math.round(baseAmount * (1 + ivaRate) * bcvRate * 100) / 100,
        iva_rate: ivaRate,
        iva_amount: Math.round(baseAmount * ivaRate * bcvRate * 100) / 100,
        exchange_rate_used: bcvRate,
        is_lowest: false,
      },
      {
        method: 'usdt_binance',
        currency: 'USDT',
        amount: Math.round(baseAmount * 100) / 100,
        iva_rate: 0,
        iva_amount: 0,
        exchange_rate_used: null,
        is_lowest: true,
      },
      {
        method: 'cash_usd',
        currency: 'USD',
        amount: Math.round(baseAmount * 100) / 100,
        iva_rate: 0,
        iva_amount: 0,
        exchange_rate_used: null,
        is_lowest: true,
      },
    ];

    const fxSnapshot = {
      bcv_usd: 45.00,
      bcv_eur: 49.00,
      binance_usdt: 46.80,
      bcv_value_date: '2026-10-30',
    };

    const slaDueAt = b.slaHoursLeft !== null
      ? new Date(now.getTime() + b.slaHoursLeft * MS_PER_HOUR)
      : null;

    const accessKey = crypto.randomUUID();

    const createdBooking = await prisma.booking.create({
      data: {
        code: b.code,
        status: b.status,
        userId: b.userId,
        accessKey,
        locale: 'es',
        contactName: b.contactName,
        contactEmail: b.contactEmail,
        contactPhone: b.contactPhone,
        notes: b.notes,
        paymentMethodPref: b.paymentMethodPref,
        termsAcceptedAt: new Date(now.getTime() - 2 * MS_PER_HOUR),
        totalsByMethod: totalsByMethod as any,
        fxSnapshot: fxSnapshot as any,
        slaDueAt,
        createdAt: new Date(now.getTime() - 2 * MS_PER_HOUR),
      },
    });

    // Booking Item
    await prisma.bookingItem.create({
      data: {
        bookingId: createdBooking.id,
        type: 'hotel_stay',
        hotelId: hotelData.hotel.id,
        checkIn: checkInDate,
        checkOut: checkOutDate,
        mealPlan: b.mealPlan,
        roomSelections: [
          {
            room_type_id: room.id,
            adults: b.adults,
            children: b.children,
            child_ages: b.children > 0 ? [5] : [],
          },
        ] as any,
        priceSnapshot: {
          total: {
            base: baseAmount,
            bs: Math.round(baseAmount * bcvRate * 100) / 100,
            usdt: baseAmount,
          },
          rooms: [
            {
              room_type_id: room.id,
              guests: b.adults + b.children,
              price: {
                base: baseAmount,
                bs: Math.round(baseAmount * bcvRate * 100) / 100,
                usdt: baseAmount,
              },
            },
          ],
        } as any,
      },
    });

    // Availability Check
    let checkStatus: CheckStatus = CheckStatus.pending;
    let checkedBy: string | null = null;
    let checkedAt: Date | null = null;
    let checkNote = 'En espera de respuesta del hotel';

    if (
      b.status === BookingStatus.awaiting_payment ||
      b.status === BookingStatus.payment_submitted ||
      b.status === BookingStatus.payment_verified ||
      b.status === BookingStatus.confirmed ||
      b.status === BookingStatus.refund_pending ||
      b.status === BookingStatus.refunded
    ) {
      checkStatus = CheckStatus.available;
      checkedBy = 'agent@vuelitos.com';
      checkedAt = new Date(now.getTime() - 1.5 * MS_PER_HOUR);
      checkNote = 'Habitaciones verificadas y bloqueadas con recepción';
    } else if (b.status === BookingStatus.cancelled) {
      checkStatus = CheckStatus.available;
      checkedBy = 'agent@vuelitos.com';
      checkedAt = new Date(now.getTime() - 10 * MS_PER_HOUR);
      checkNote = 'Verificado previamente antes de cancelación';
    }

    await prisma.availabilityCheck.create({
      data: {
        bookingId: createdBooking.id,
        hotelId: hotelData.hotel.id,
        checkIn: checkInDate,
        checkOut: checkOutDate,
        status: checkStatus,
        checkedBy,
        checkedAt,
        note: checkNote,
      },
    });

    // Timeline Events
    const eventsToCreate: Array<{
      event: string;
      fromStatus: BookingStatus | null;
      toStatus: BookingStatus;
      actorType: string;
      actorId: string | null;
      note: string;
      createdAt: Date;
    }> = [];

    // Initial event: requested
    eventsToCreate.push({
      event: 'requested',
      fromStatus: null,
      toStatus: BookingStatus.requested,
      actorType: 'customer',
      actorId: b.userId,
      note: 'Solicitud creada por el cliente',
      createdAt: new Date(now.getTime() - 2 * MS_PER_HOUR),
    });

    if (
      b.status === BookingStatus.checking_availability ||
      b.status === BookingStatus.awaiting_payment ||
      b.status === BookingStatus.payment_submitted ||
      b.status === BookingStatus.payment_verified ||
      b.status === BookingStatus.confirmed ||
      b.status === BookingStatus.refund_pending ||
      b.status === BookingStatus.refunded
    ) {
      eventsToCreate.push({
        event: 'start_check',
        fromStatus: BookingStatus.requested,
        toStatus: BookingStatus.checking_availability,
        actorType: 'agent',
        actorId: 'agent@vuelitos.com',
        note: 'Equipo inició consulta de disponibilidad con el hotel',
        createdAt: new Date(now.getTime() - 1.8 * MS_PER_HOUR),
      });
    }

    if (
      b.status === BookingStatus.awaiting_payment ||
      b.status === BookingStatus.payment_submitted ||
      b.status === BookingStatus.payment_verified ||
      b.status === BookingStatus.confirmed ||
      b.status === BookingStatus.refund_pending ||
      b.status === BookingStatus.refunded
    ) {
      eventsToCreate.push({
        event: 'hotel_confirmed',
        fromStatus: BookingStatus.checking_availability,
        toStatus: BookingStatus.awaiting_payment,
        actorType: 'agent',
        actorId: 'agent@vuelitos.com',
        note: 'Hotel confirmó disponibilidad. Ventana de pago activada.',
        createdAt: new Date(now.getTime() - 1.5 * MS_PER_HOUR),
      });
    }

    if (
      b.status === BookingStatus.payment_submitted ||
      b.status === BookingStatus.payment_verified ||
      b.status === BookingStatus.confirmed ||
      b.status === BookingStatus.refund_pending ||
      b.status === BookingStatus.refunded
    ) {
      eventsToCreate.push({
        event: 'submit_payment',
        fromStatus: BookingStatus.awaiting_payment,
        toStatus: BookingStatus.payment_submitted,
        actorType: 'customer',
        actorId: b.userId,
        note: `Cliente reportó pago referencia ${b.payment?.reference || 'N/A'}`,
        createdAt: new Date(now.getTime() - (b.payment?.offsetHoursSubmitted || 1) * MS_PER_HOUR),
      });
    }

    if (
      b.status === BookingStatus.payment_verified ||
      b.status === BookingStatus.confirmed ||
      b.status === BookingStatus.refund_pending ||
      b.status === BookingStatus.refunded
    ) {
      eventsToCreate.push({
        event: 'verify_payment',
        fromStatus: BookingStatus.payment_submitted,
        toStatus: BookingStatus.payment_verified,
        actorType: 'agent',
        actorId: b.payment?.verifiedBy || 'agent@vuelitos.com',
        note: 'Reporte de pago conciliado y verificado en cuentas',
        createdAt: new Date(now.getTime() - (b.payment?.offsetHoursVerified || 0.8) * MS_PER_HOUR),
      });
    }

    if (
      b.status === BookingStatus.confirmed ||
      b.status === BookingStatus.refund_pending ||
      b.status === BookingStatus.refunded
    ) {
      eventsToCreate.push({
        event: 'confirm_booking',
        fromStatus: BookingStatus.payment_verified,
        toStatus: BookingStatus.confirmed,
        actorType: 'agent',
        actorId: 'agent@vuelitos.com',
        note: 'Reserva confirmada con el hotel y vouchers emitidos',
        createdAt: new Date(now.getTime() - 0.5 * MS_PER_HOUR),
      });
    }

    if (b.status === BookingStatus.cancelled) {
      eventsToCreate.push({
        event: 'cancel',
        fromStatus: BookingStatus.requested,
        toStatus: BookingStatus.cancelled,
        actorType: 'customer',
        actorId: b.userId,
        note: 'Cancelado por solicitud del cliente',
        createdAt: new Date(now.getTime() - 0.5 * MS_PER_HOUR),
      });
    }

    if (b.status === BookingStatus.refund_pending) {
      eventsToCreate.push({
        event: 'cancel',
        fromStatus: BookingStatus.confirmed,
        toStatus: BookingStatus.refund_pending,
        actorType: 'customer',
        actorId: b.userId,
        note: 'Cancelación solicitada por el cliente con reembolso pendiente',
        createdAt: new Date(now.getTime() - 0.4 * MS_PER_HOUR),
      });
    }

    if (b.status === BookingStatus.refunded) {
      eventsToCreate.push({
        event: 'cancel',
        fromStatus: BookingStatus.confirmed,
        toStatus: BookingStatus.refund_pending,
        actorType: 'customer',
        actorId: b.userId,
        note: 'Cancelación solicitada con reembolso pendiente',
        createdAt: new Date(now.getTime() - 20 * MS_PER_HOUR),
      });
      eventsToCreate.push({
        event: 'complete_refund',
        fromStatus: BookingStatus.refund_pending,
        toStatus: BookingStatus.refunded,
        actorType: 'admin',
        actorId: 'admin@vuelitos.com',
        note: 'Reembolso liquidado al cliente en su cuenta bancaria',
        createdAt: new Date(now.getTime() - 5 * MS_PER_HOUR),
      });
    }

    for (const ev of eventsToCreate) {
      await prisma.bookingEvent.create({
        data: {
          bookingId: createdBooking.id,
          event: ev.event,
          fromStatus: ev.fromStatus,
          toStatus: ev.toStatus,
          actorType: ev.actorType,
          actorId: ev.actorId,
          note: ev.note,
          createdAt: ev.createdAt,
        },
      });
    }

    // Payment Record
    if (b.payment) {
      await prisma.payment.create({
        data: {
          bookingId: createdBooking.id,
          method: b.payment.method,
          currency: b.payment.currency,
          amountQuoted: b.payment.amount,
          reference: b.payment.reference,
          status: b.payment.status,
          submittedAt: new Date(now.getTime() - b.payment.offsetHoursSubmitted * MS_PER_HOUR),
          verifiedAt: b.payment.offsetHoursVerified
            ? new Date(now.getTime() - b.payment.offsetHoursVerified * MS_PER_HOUR)
            : null,
          verifiedBy: b.payment.verifiedBy || null,
        },
      });
    }
  }

  console.log('✅ Database successfully seeded with:');
  console.log(`   - ${hotelsToSeed.length} Hotels across major destinations`);
  console.log(`   - ${bookingDefinitions.length} Dummy Bookings with full lifecycles`);
  console.log('   - Staff users (admin@vuelitos.com, agent@vuelitos.com)');
  console.log('   - Venezuelan Holidays and Exchange Rates');
}

export { main as seed };

const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith('seed.ts') ||
    process.argv[1].endsWith('seed.js') ||
    (typeof import.meta.url === 'string' && import.meta.url.includes(process.argv[1])));

if (isDirectRun) {
  main()
    .catch((e) => {
      console.error('❌ Error seeding database:', e);
      process.exit(1);
    })
    .finally(async () => {
      try {
        const { redis } = await import('../src/lib/redis.js');
        redis.disconnect();
      } catch {}
      await prisma.$disconnect();
      process.exit(0);
    });
}
